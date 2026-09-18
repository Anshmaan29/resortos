import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  addDays, BOOKING_SOURCE_LABELS, Decimal, ERROR_CODES, formatDate, formatINR, formatReference, money, nightsBetween, toMoneyString,
  type BookingSource, type CancelReservationInput, type CreateReservationInput, type IsoDate, type ReservationEstimateInput,
  type ReservationStatus, type UpdateReservationInput,
} from '@resortos/shared';
import { OwnerAuthorisationService, type Authorisation, type AuthorisationReason } from '../auth/owner-authorisation.service';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { CountRow, IdRow, NightRow, ReservationRoomRow, ReservationRow } from '../db/rows';
import { GuestsService } from '../guests/guests.service';
import { PropertyService } from '../property/property.service';
import { RatesService, type Quote } from '../rates/rates.service';

type RoomInput = CreateReservationInput['rooms'][number];
type BookingInput = Omit<CreateReservationInput, 'rebookedFromId'>;

interface TypeNight { room_type_id: string; room_type_name: string; night: string; capacity: number; booked: number }
interface ExistingLine { row: ReservationRoomRow; nights: NightRow[] }
interface PricedRooms { quotes: Quote[]; reused: boolean[]; existing: Map<string, ExistingLine> }

const sameAges = (a: (number | string)[], b: number[]) => a.length === b.length && a.every((x, i) => Number(x) === b[i]);

@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly guests: GuestsService,
    private readonly rates: RatesService,
    private readonly property: PropertyService,
    private readonly ownerAuth: OwnerAuthorisationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  /** Capacity vs booked per room type per night. Sellable capacity excludes inactive and out-of-order rooms. */
  private async typeNights(q: Queryable, propertyId: string, arrival: IsoDate, departure: IsoDate, roomTypeIds?: string[]): Promise<TypeNight[]> {
    const { rows } = await q.query<{ room_type_id: string; room_type_name: string; night: string; capacity: string; booked: string }>(
      `WITH nights AS (
         SELECT d::date AS night FROM generate_series($2::date, $3::date - 1, interval '1 day') d
       )
       SELECT t.id AS room_type_id, t.name AS room_type_name, to_char(n.night, 'YYYY-MM-DD') AS night,
              (SELECT count(*) FROM rooms r
                WHERE r.room_type_id = t.id AND r.is_active
                  AND NOT EXISTS (SELECT 1 FROM room_out_of_order o WHERE o.room_id = r.id AND o.status = 'active'
                                    AND o.start_date <= n.night AND o.end_date > n.night)) AS capacity,
              (SELECT count(*) FROM reservation_rooms rr
                WHERE rr.room_type_id = t.id AND rr.status IN ('reserved', 'checked_in')
                  AND rr.arrival <= n.night AND rr.departure > n.night) AS booked
         FROM room_types t CROSS JOIN nights n
        WHERE t.property_id = $1 AND t.is_active AND ($4::uuid[] IS NULL OR t.id = ANY($4::uuid[]))
        ORDER BY t.sort_order, t.name, n.night`,
      [propertyId, arrival, departure, roomTypeIds ?? null],
    );
    return rows.map((r) => ({ ...r, capacity: Number(r.capacity), booked: Number(r.booked) }));
  }

  async availability(propertyId: string, arrival: IsoDate, departure: IsoDate, roomTypeId?: string) {
    const nights = await this.typeNights(this.db, propertyId, arrival, departure, roomTypeId ? [roomTypeId] : undefined);
    const { rows: freeRooms } = await this.db.query<{ id: string; number: string; room_type_id: string; view: string | null; building: string | null; floor: string | null; housekeeping_status: string; service_status: string }>(
      `SELECT r.id, r.number, r.room_type_id, r.view, r.building, r.floor, r.housekeeping_status, r.service_status
         FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
        WHERE r.property_id = $1 AND r.is_active AND ($4::uuid IS NULL OR r.room_type_id = $4)
          AND NOT EXISTS (SELECT 1 FROM room_allocations a WHERE a.room_id = r.id AND a.status IN ('reserved','checked_in')
                            AND daterange(a.start_date, a.end_date, '[)') && daterange($2::date, $3::date, '[)'))
          AND NOT EXISTS (SELECT 1 FROM room_out_of_order o WHERE o.room_id = r.id AND o.status = 'active'
                            AND daterange(o.start_date, o.end_date, '[)') && daterange($2::date, $3::date, '[)'))
        ORDER BY rt.sort_order, r.sort_order, r.number`,
      [propertyId, arrival, departure, roomTypeId ?? null],
    );

    const byType = new Map<string, { roomTypeId: string; roomTypeName: string; available: number; nights: { date: string; capacity: number; booked: number; available: number }[] }>();
    for (const n of nights) {
      const entry = byType.get(n.room_type_id) ?? { roomTypeId: n.room_type_id, roomTypeName: n.room_type_name, available: Number.MAX_SAFE_INTEGER, nights: [] };
      const available = Math.max(0, n.capacity - n.booked);
      entry.nights.push({ date: n.night, capacity: n.capacity, booked: n.booked, available });
      entry.available = Math.min(entry.available, available);
      byType.set(n.room_type_id, entry);
    }
    return {
      arrival, departure, nights: nightsBetween(arrival, departure),
      roomTypes: [...byType.values()].map((t) => ({
        ...t,
        freeRooms: freeRooms.filter((r) => r.room_type_id === t.roomTypeId).map((r) => ({
          id: r.id, number: r.number, view: r.view, building: r.building, floor: r.floor, housekeeping: r.housekeeping_status, service: r.service_status,
        })),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Shared booking pipeline: create, edit and rebook all run exactly this
  // ---------------------------------------------------------------------------

  /** Locks the room types involved so availability check + write cannot interleave (spec §13). */
  private async lockRoomTypes(q: Queryable, propertyId: string, typeIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(typeIds)].sort();
    const { rows } = await q.query<{ id: string; name: string }>(
      `SELECT id, name FROM room_types WHERE property_id = $1 AND is_active AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
      [propertyId, ids],
    );
    if (rows.length !== ids.length) throw notFound('Room type');
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async assertCapacity(q: Queryable, propertyId: string, arrival: IsoDate, departure: IsoDate, rooms: RoomInput[], typeNames: Map<string, string>) {
    const typeIds = [...new Set(rooms.map((r) => r.roomTypeId))];
    const nights = await this.typeNights(q, propertyId, arrival, departure, typeIds);
    for (const typeId of typeIds) {
      const requested = rooms.filter((r) => r.roomTypeId === typeId).length;
      const short = nights.filter((n) => n.room_type_id === typeId && n.booked + requested > n.capacity);
      if (short.length) {
        throw new AppError(
          ERROR_CODES.ROOM_UNAVAILABLE,
          `Not enough ${typeNames.get(typeId)} rooms free on ${short.map((s) => formatDate(s.night, { year: false })).join(', ')}.`,
          { roomTypeId: typeId, dates: short.map((s) => s.night) },
        );
      }
    }
  }

  private async existingLines(q: Queryable, reservationId: string): Promise<Map<string, ExistingLine>> {
    const { rows } = await q.query<ReservationRoomRow>(
      `SELECT * FROM reservation_rooms WHERE reservation_id = $1 AND status = 'reserved' ORDER BY created_at`, [reservationId],
    );
    const { rows: nights } = await q.query<NightRow>(
      `SELECT * FROM reservation_room_nights WHERE reservation_room_id = ANY($1::uuid[])`, [rows.map((r) => r.id)],
    );
    return new Map(rows.map((r) => [r.id, { row: r, nights: nights.filter((n) => n.reservation_room_id === r.id) }]));
  }

  /**
   * Prices every room. A room line that an edit leaves unchanged keeps the nightly rates already
   * agreed (and any owner approval they carried) instead of being re-priced from today's calendar.
   */
  private async priceRooms(q: Queryable, propertyId: string, arrival: IsoDate, departure: IsoDate, rooms: RoomInput[], existing: Map<string, ExistingLine>): Promise<PricedRooms> {
    const quotes: Quote[] = [];
    const reused: boolean[] = [];
    for (const room of rooms) {
      const ex = room.reservationRoomId ? existing.get(room.reservationRoomId) : undefined;
      if (room.reservationRoomId && !ex) throw new AppError(ERROR_CODES.VALIDATION, 'A room on this booking was changed by someone else. Reload and try again.');
      const unchanged = !!ex && room.nightlyRate === undefined && ex.row.room_type_id === room.roomTypeId && ex.row.adults === room.adults
        && sameAges(ex.row.child_ages, room.childAges) && ex.row.meal_plan === room.mealPlan
        && (room.ratePlanId ?? ex.row.rate_plan_id) === ex.row.rate_plan_id && ex.row.arrival === arrival && ex.row.departure === departure;
      if (unchanged) {
        quotes.push(await this.rates.quoteFromStoredNights(q, propertyId, room.roomTypeId, ex.row.rate_plan_id, ex.nights));
        reused.push(true);
      } else {
        quotes.push(await this.rates.quote(q, propertyId, {
          roomTypeId: room.roomTypeId, arrival, departure, adults: room.adults, childAges: room.childAges,
          ratePlanId: room.ratePlanId, mealPlan: room.mealPlan, manualRate: room.nightlyRate,
        }));
        reused.push(false);
      }
    }
    return { quotes, reused, existing };
  }

  /** What exceeds receptionist limits, in the words shown on the PIN pad and the booking. */
  private exceptions(priced: PricedRooms, typeNames: Map<string, string>): AuthorisationReason[] {
    const reasons: AuthorisationReason[] = [];
    const single = priced.quotes.length === 1;
    priced.quotes.forEach((quote, i) => {
      if (priced.reused[i] || !quote.belowFloor) return;
      const lowest = quote.nights.filter((n) => n.belowFloor).reduce((min, n) => (money(n.roomRate).lt(min) ? money(n.roomRate) : min), money(quote.minRate));
      const text = `rate ${formatINR(lowest)} is below the minimum ${formatINR(quote.minRate)}`;
      reasons.push({ action: 'rate_below_floor', description: single ? `Rate ${formatINR(lowest)} is below the minimum ${formatINR(quote.minRate)}` : `Room ${i + 1} (${typeNames.get(quote.roomTypeId)}): ${text}` });
    });
    const minStay = Math.max(...priced.quotes.map((qt, i) => (priced.reused[i] ? 1 : qt.minStay)));
    const nights = priced.quotes[0]?.nightCount ?? 0;
    if (nights < minStay) reasons.push({ action: 'min_stay_override', description: `Minimum stay for these dates is ${minStay} nights; booked ${nights}` });
    return reasons;
  }

  /** The exact values an owner approval is bound to. Any change needs a fresh approval. */
  private scope(input: BookingInput, extra: { reservationId?: string; rebookedFromId?: string }, reasons: AuthorisationReason[]) {
    return {
      ...extra,
      guest: input.guestId ?? { mobile: input.guest?.mobile, firstName: input.guest?.firstName, lastName: input.guest?.lastName },
      source: input.source,
      otaReference: input.otaReference ?? null,
      arrival: input.arrival,
      departure: input.departure,
      rooms: input.rooms.map((r) => ({
        reservationRoomId: r.reservationRoomId ?? null, roomTypeId: r.roomTypeId, roomId: r.roomId ?? null, adults: r.adults,
        childAges: r.childAges, mealPlan: r.mealPlan, ratePlanId: r.ratePlanId ?? null, nightlyRate: r.nightlyRate ?? null,
      })),
      exceptions: reasons.map((r) => r.description),
    };
  }

  private async resolveGuest(q: Queryable, actor: Actor, input: BookingInput): Promise<string> {
    if (input.guestId) {
      const { rows } = await q.query<{ id: string; merged_into_id: string | null }>(
        `SELECT id, merged_into_id FROM guests WHERE id = $1 AND property_id = $2`, [input.guestId, actor.user.propertyId],
      );
      if (!rows[0]) throw notFound('Guest');
      return rows[0].merged_into_id ?? rows[0].id;
    }
    return (await this.guests.createInTx(q, actor, input.guest!)).id;
  }

  private async writeRooms(q: Queryable, actor: Actor, reservationId: string, input: BookingInput, priced: PricedRooms, auth: Authorisation | null) {
    for (const [i, room] of input.rooms.entries()) {
      const quote = priced.quotes[i]!;
      const previous = room.reservationRoomId ? priced.existing.get(room.reservationRoomId)?.row : undefined;
      const rateAuthorisedBy = priced.reused[i] ? previous?.rate_authorised_by ?? null : quote.belowFloor ? auth?.authorisedBy ?? null : null;
      const { rows } = await q.query<IdRow>(
        `INSERT INTO reservation_rooms (property_id, reservation_id, room_type_id, arrival, departure, adults, child_ages,
                                        rate_plan_id, meal_plan, nightly_rate, rate_authorised_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [actor.user.propertyId, reservationId, room.roomTypeId, input.arrival, input.departure, room.adults, room.childAges,
          quote.ratePlanId, room.mealPlan, quote.averageRoomRate, rateAuthorisedBy, actor.user.id],
      );
      const rrId = rows[0]!.id;
      for (const n of quote.nights) {
        await q.query(
          `INSERT INTO reservation_room_nights (reservation_room_id, night_date, property_id, room_rate, extra_person_amount, meal_amount, rate_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [rrId, n.date, actor.user.propertyId, n.roomRate, n.extraPersonAmount, n.mealAmount, n.rateSource],
        );
      }
      if (room.roomId) await this.allocateRoom(q, actor, rrId, room.roomId);
    }
  }

  private summary(input: BookingInput, priced: PricedRooms) {
    return {
      guestId: input.guestId, source: input.source, otaReference: input.otaReference, arrival: input.arrival, departure: input.departure, status: input.status,
      rooms: input.rooms.map((r, i) => ({
        roomTypeId: r.roomTypeId, roomId: r.roomId, adults: r.adults, children: r.childAges.length, mealPlan: r.mealPlan,
        total: priced.quotes[i]!.total, keptAgreedRates: priced.reused[i],
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Create / rebook
  // ---------------------------------------------------------------------------

  async create(q: Queryable, actor: Actor, input: CreateReservationInput) {
    const propertyId = actor.user.propertyId;
    const id = randomUUID();
    const businessDate = await this.property.businessDate(q, propertyId);
    if (input.arrival < businessDate) {
      throw new AppError(ERROR_CODES.VALIDATION, `Arrival cannot be before the business date (${formatDate(businessDate)}).`, {
        fields: [{ path: 'arrival', message: 'Arrival is in the past' }],
      });
    }

    let rebookedFrom: { id: string; number: string } | null = null;
    if (input.rebookedFromId) {
      const { rows } = await q.query<Pick<ReservationRow, 'id' | 'number' | 'status'>>(
        `SELECT id, number, status FROM reservations WHERE id = $1 AND property_id = $2 FOR SHARE`, [input.rebookedFromId, propertyId],
      );
      if (!rows[0]) throw notFound('Original booking');
      if (!['cancelled', 'no_show'].includes(rows[0].status)) {
        throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Only cancelled or no-show bookings can be rebooked.');
      }
      rebookedFrom = { id: rows[0].id, number: rows[0].number };
    }

    const typeNames = await this.lockRoomTypes(q, propertyId, input.rooms.map((r) => r.roomTypeId));
    await this.assertCapacity(q, propertyId, input.arrival, input.departure, input.rooms, typeNames);
    if (input.rooms.some((r) => r.reservationRoomId)) throw new AppError(ERROR_CODES.VALIDATION, 'New bookings cannot reference existing rooms.');
    const priced = await this.priceRooms(q, propertyId, input.arrival, input.departure, input.rooms, new Map());
    const reasons = this.exceptions(priced, typeNames);
    const auth = await this.ownerAuth.require(q, actor,
      { operation: 'reservation.create', scope: this.scope(input, { rebookedFromId: input.rebookedFromId }, reasons), reasons },
      input.ownerAuthorisationId, { type: 'reservation', id });

    const guestId = await this.resolveGuest(q, actor, input);
    const { rows: numRows } = await q.query<{ n: string }>(`SELECT next_reference($1, 'reservation') AS n`, [propertyId]);
    const number = formatReference('BK', Number(numRows[0]!.n));
    const isGroup = input.rooms.length > 1;

    await q.query(
      `INSERT INTO reservations (id, property_id, number, primary_guest_id, source, ota_reference, arrival, departure, status,
                                 group_name, group_leader_guest_id, billing_mode, special_requests, internal_notes, rebooked_from_id, created_by, purpose)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, propertyId, number, guestId, input.source, input.otaReference ?? null, input.arrival, input.departure, input.status,
        isGroup ? input.groupName : null, isGroup ? guestId : null, isGroup ? 'master' : 'separate',
        input.specialRequests ?? null, input.internalNotes ?? null, input.rebookedFromId ?? null, actor.user.id, input.purpose ?? null],
    );
    await this.writeRooms(q, actor, id, input, priced, auth);
    if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'reservation', id });

    await this.audit.record(q, actor, {
      action: rebookedFrom ? 'reservation.rebooked' : 'reservation.created', entityType: 'reservation', entityId: id,
      authorisedBy: auth?.authorisedBy ?? null, reason: rebookedFrom ? `Rebook of ${rebookedFrom.number}` : null,
      after: { number, rebookedFromId: input.rebookedFromId, ...this.summary({ ...input, guestId }, priced) },
    });
    await this.outbox.emit(q, propertyId, 'reservation.created', { type: 'reservation', id });
    await this.outbox.emit(q, propertyId, 'inventory.changed', { type: 'reservation', id }, { from: input.arrival, to: input.departure, roomTypeIds: [...typeNames.keys()] });
    return this.detail(q, propertyId, id);
  }

  // ---------------------------------------------------------------------------
  // Edit: same validation, limits, authorisation and audit as create
  // ---------------------------------------------------------------------------

  async update(q: Queryable, actor: Actor, id: string, input: UpdateReservationInput) {
    const propertyId = actor.user.propertyId;
    const { rows } = await q.query<ReservationRow>(`SELECT * FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, propertyId]);
    const res = rows[0];
    if (!res) throw notFound('Booking');
    if (!['tentative', 'confirmed'].includes(res.status)) {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Only bookings that have not checked in can be edited.');
    }
    if (res.version !== input.version) throw staleVersion();
    if (res.status === 'confirmed' && input.status === 'tentative') {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'A confirmed booking cannot be changed back to tentative.');
    }

    const businessDate = await this.property.businessDate(q, propertyId);
    if (input.arrival !== res.arrival && input.arrival < businessDate) {
      throw new AppError(ERROR_CODES.VALIDATION, `Arrival cannot be before the business date (${formatDate(businessDate)}).`, { fields: [{ path: 'arrival', message: 'Arrival is in the past' }] });
    }
    if (input.departure <= businessDate) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Departure must be after the business date.', { fields: [{ path: 'departure', message: 'Departure is in the past' }] });
    }

    const before = await this.detail(q, propertyId, id);
    const existing = await this.existingLines(q, id);
    const typeNames = await this.lockRoomTypes(q, propertyId, [...input.rooms.map((r) => r.roomTypeId), ...[...existing.values()].map((e) => e.row.room_type_id)]);

    // Old lines become history first, so the capacity check does not count this booking against itself.
    const oldIds = [...existing.keys()];
    await q.query(`UPDATE reservation_rooms SET status = 'replaced', replaced_by_edit_at = now() WHERE id = ANY($1::uuid[])`, [oldIds]);
    await q.query(
      `UPDATE room_allocations SET status = 'released', release_reason = 'booking_edited' WHERE reservation_room_id = ANY($1::uuid[]) AND status = 'reserved'`,
      [oldIds],
    );

    await this.assertCapacity(q, propertyId, input.arrival, input.departure, input.rooms, typeNames);
    const priced = await this.priceRooms(q, propertyId, input.arrival, input.departure, input.rooms, existing);
    const reasons = this.exceptions(priced, typeNames);
    const auth = await this.ownerAuth.require(q, actor,
      { operation: 'reservation.update', scope: this.scope(input, { reservationId: id }, reasons), reasons },
      input.ownerAuthorisationId, { type: 'reservation', id });

    const guestId = await this.resolveGuest(q, actor, input);
    const isGroup = input.rooms.length > 1;
    await q.query(
      `UPDATE reservations SET primary_guest_id = $2, source = $3, ota_reference = $4, arrival = $5, departure = $6, status = $7,
              group_name = $8, group_leader_guest_id = $9, billing_mode = CASE WHEN $10 THEN billing_mode ELSE 'separate' END,
              special_requests = $11, internal_notes = $12, updated_by = $13, purpose = $14
        WHERE id = $1`,
      [id, guestId, input.source, input.otaReference ?? null, input.arrival, input.departure, input.status,
        isGroup ? input.groupName : null, isGroup ? guestId : null, isGroup, input.specialRequests ?? null, input.internalNotes ?? null, actor.user.id, input.purpose ?? null],
    );
    await this.writeRooms(q, actor, id, input, priced, auth);
    if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'reservation', id });

    await this.audit.record(q, actor, {
      action: 'reservation.updated', entityType: 'reservation', entityId: id, authorisedBy: auth?.authorisedBy ?? null,
      before: {
        guestId: before.guest.id, source: before.source, otaReference: before.otaReference, arrival: before.arrival, departure: before.departure, status: before.status,
        rooms: before.rooms.map((r) => ({ roomTypeId: r.roomTypeId, roomId: r.roomId, adults: r.adults, children: r.childAges.length, mealPlan: r.mealPlan, total: r.total })),
      },
      after: this.summary({ ...input, guestId }, priced),
    });
    await this.outbox.emit(q, propertyId, 'reservation.updated', { type: 'reservation', id });
    await this.outbox.emit(q, propertyId, 'inventory.changed', { type: 'reservation', id },
      { from: input.arrival < before.arrival ? input.arrival : before.arrival, to: input.departure > before.departure ? input.departure : before.departure });
    return this.detail(q, propertyId, id);
  }

  /** Read-only price + GST estimate, computed by the same code path as saving. */
  async estimate(q: Queryable, propertyId: string, input: ReservationEstimateInput) {
    const existing = input.reservationId ? await this.existingLines(q, input.reservationId) : new Map<string, ExistingLine>();
    const priced = await this.priceRooms(q, propertyId, input.arrival, input.departure, input.rooms, existing);
    const tax = await this.rates.estimateTax(q, propertyId, priced.quotes);
    return {
      rooms: priced.quotes.map((qt, i) => ({
        roomTypeId: qt.roomTypeId, nightCount: qt.nightCount, roomTotal: qt.roomTotal, extrasTotal: qt.extrasTotal, mealTotal: qt.mealTotal,
        total: qt.total, averageRoomRate: qt.averageRoomRate, minRate: qt.minRate, belowFloor: qt.belowFloor && !priced.reused[i],
        keptAgreedRates: priced.reused[i]!, minStay: qt.minStay, minStayViolated: qt.minStayViolated && !priced.reused[i],
        labels: [...new Set(qt.nights.map((n) => n.label).filter((l): l is string => !!l))],
      })),
      tax,
    };
  }

  // ---------------------------------------------------------------------------
  // Room assignment
  // ---------------------------------------------------------------------------

  /** Assigns a specific room. The exclusion constraint is the final judge (spec §13). */
  private async allocateRoom(q: Queryable, actor: Actor, reservationRoomId: string, roomId: string) {
    const { rows } = await q.query<{ arrival: string; departure: string; room_type_id: string; room_room_type_id: string; number: string; is_active: boolean }>(
      `SELECT rr.arrival, rr.departure, rr.room_type_id, r.room_type_id AS room_room_type_id, r.number, r.is_active
         FROM reservation_rooms rr, rooms r
        WHERE rr.id = $1 AND r.id = $2 AND rr.property_id = $3 AND r.property_id = $3`,
      [reservationRoomId, roomId, actor.user.propertyId],
    );
    const row = rows[0];
    if (!row || !row.is_active) throw notFound('Room');
    if (row.room_room_type_id !== row.room_type_id) {
      throw new AppError(ERROR_CODES.VALIDATION, `Room ${row.number} is a different room type from this booking.`);
    }
    const { rows: ooo } = await q.query<{ one: number }>(
      `SELECT 1 AS one FROM room_out_of_order WHERE room_id = $1 AND status = 'active'
          AND daterange(start_date, end_date, '[)') && daterange($2::date, $3::date, '[)') LIMIT 1`,
      [roomId, row.arrival, row.departure],
    );
    if (ooo[0]) throw new AppError(ERROR_CODES.ROOM_UNAVAILABLE, `Room ${row.number} is out of order during these dates.`);

    await q.query(
      `INSERT INTO room_allocations (property_id, reservation_room_id, room_id, start_date, end_date, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor.user.propertyId, reservationRoomId, roomId, row.arrival, row.departure, actor.user.id],
    );
    await q.query(`UPDATE reservation_rooms SET room_id = $2 WHERE id = $1`, [reservationRoomId, roomId]);
  }

  async assignRoom(q: Queryable, actor: Actor, reservationRoomId: string, roomId: string | null) {
    const { rows } = await q.query<ReservationRoomRow>(
      `SELECT rr.* FROM reservation_rooms rr WHERE rr.id = $1 AND rr.property_id = $2 FOR UPDATE`,
      [reservationRoomId, actor.user.propertyId],
    );
    const rr = rows[0];
    if (!rr) throw notFound('Booking room');
    if (rr.status !== 'reserved') {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Rooms of guests already checked in are changed with Room Shift.');
    }
    await q.query(
      `UPDATE room_allocations SET status = 'released', release_reason = 'reassigned' WHERE reservation_room_id = $1 AND status = 'reserved'`,
      [reservationRoomId],
    );
    await q.query(`UPDATE reservation_rooms SET room_id = NULL WHERE id = $1`, [reservationRoomId]);
    if (roomId) await this.allocateRoom(q, actor, reservationRoomId, roomId);

    await this.audit.record(q, actor, {
      action: 'reservation.room_assigned', entityType: 'reservation', entityId: rr.reservation_id,
      before: { reservationRoomId, roomId: rr.room_id }, after: { reservationRoomId, roomId },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'reservation.updated', { type: 'reservation', id: rr.reservation_id });
    return this.detail(q, actor.user.propertyId, rr.reservation_id);
  }

  // ---------------------------------------------------------------------------
  // Cancel (spec §15)
  // ---------------------------------------------------------------------------

  /**
   * Money already received on the booking. Payments are recorded by the billing module;
   * until it exists no payment can be stored, so this is truthfully zero.
   */
  private async advancePaid(_q: Queryable, _reservationId: string): Promise<Decimal> {
    return new Decimal(0);
  }

  async cancel(q: Queryable, actor: Actor, id: string, input: CancelReservationInput) {
    const { rows } = await q.query<ReservationRow>(`SELECT * FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId]);
    const res = rows[0];
    if (!res) throw notFound('Booking');
    if (!['tentative', 'confirmed'].includes(res.status)) {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, res.status === 'cancelled' ? 'This booking is already cancelled.' : 'Only bookings that have not checked in can be cancelled.');
    }

    const paid = await this.advancePaid(q, id);
    let moneyOption = 'none';
    if (paid.gt(0)) {
      if (!input.moneyOption) {
        throw new AppError(ERROR_CODES.VALIDATION, `An advance of ${formatINR(paid)} was paid. Choose what happens to this money.`, {
          fields: [{ path: 'moneyOption', message: 'Choose what happens to the advance' }], advancePaid: toMoneyString(paid),
        });
      }
      moneyOption = input.moneyOption;
    } else if (input.moneyOption) {
      throw new AppError(ERROR_CODES.VALIDATION, 'No money was paid on this booking, so there is nothing to refund or keep.');
    }

    await q.query(
      `UPDATE reservations SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, cancel_note = $4,
              cancel_money_option = $5, updated_by = $2
        WHERE id = $1`,
      [id, actor.user.id, input.reason, input.note ?? null, moneyOption],
    );
    await q.query(`UPDATE reservation_rooms SET status = 'cancelled' WHERE reservation_id = $1 AND status = 'reserved'`, [id]);
    await q.query(
      `UPDATE room_allocations SET status = 'released', release_reason = 'cancelled'
        WHERE status = 'reserved' AND reservation_room_id IN (SELECT id FROM reservation_rooms WHERE reservation_id = $1)`,
      [id],
    );
    await this.audit.record(q, actor, {
      action: 'reservation.cancelled', entityType: 'reservation', entityId: id, reason: [input.reason, input.note].filter(Boolean).join(': '),
      before: { status: res.status }, after: { status: 'cancelled', moneyOption, advancePaid: toMoneyString(paid) },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'reservation.cancelled', { type: 'reservation', id });
    await this.outbox.emit(q, actor.user.propertyId, 'inventory.changed', { type: 'reservation', id }, { from: res.arrival, to: res.departure });
    return this.detail(q, actor.user.propertyId, id);
  }

  async confirm(q: Queryable, actor: Actor, id: string) {
    const { rows } = await q.query<Pick<ReservationRow, 'status'>>(`SELECT status FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId]);
    if (!rows[0]) throw notFound('Booking');
    if (rows[0].status !== 'tentative') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Only tentative bookings can be confirmed.');
    await q.query(`UPDATE reservations SET status = 'confirmed', updated_by = $2 WHERE id = $1`, [id, actor.user.id]);
    await this.audit.record(q, actor, { action: 'reservation.confirmed', entityType: 'reservation', entityId: id, before: { status: 'tentative' }, after: { status: 'confirmed' } });
    await this.outbox.emit(q, actor.user.propertyId, 'reservation.confirmed', { type: 'reservation', id });
    return this.detail(q, actor.user.propertyId, id);
  }

  // ---------------------------------------------------------------------------
  // Read models
  // ---------------------------------------------------------------------------

  async detail(q: Queryable, propertyId: string, id: string) {
    const { rows } = await q.query<ReservationRow & { first_name: string; last_name: string; mobile: string; email: string | null; is_vip: boolean; city: string | null; created_by_name: string | null }>(
      `SELECT r.*, g.first_name, g.last_name, g.mobile, g.email, g.is_vip, g.city, u.full_name AS created_by_name
         FROM reservations r JOIN guests g ON g.id = r.primary_guest_id LEFT JOIN users u ON u.id = r.created_by
        WHERE r.id = $1 AND r.property_id = $2`,
      [id, propertyId],
    );
    const r = rows[0];
    if (!r) throw notFound('Booking');

    const [roomRows, overrides, related, bd] = await Promise.all([
      q.query<ReservationRoomRow & { room_type_name: string; room_number: string | null; room_total: string; extras_total: string; meal_total: string }>(
        `SELECT rr.*, rt.name AS room_type_name, rm.number AS room_number,
                COALESCE(sum(n.room_rate), 0) AS room_total, COALESCE(sum(n.extra_person_amount), 0) AS extras_total, COALESCE(sum(n.meal_amount), 0) AS meal_total
           FROM reservation_rooms rr
           JOIN room_types rt ON rt.id = rr.room_type_id
           LEFT JOIN rooms rm ON rm.id = rr.room_id
           LEFT JOIN reservation_room_nights n ON n.reservation_room_id = rr.id
          WHERE rr.reservation_id = $1 AND rr.status <> 'replaced'
          GROUP BY rr.id, rt.name, rm.number
          ORDER BY rr.created_at, rm.number`,
        [id],
      ),
      q.query<{ action: string; description: string; created_at: Date; performed_by: string; authorised_by: string; authorised_by_role: string }>(
        `SELECT o.action, o.description, o.created_at, p.full_name AS performed_by, a.full_name AS authorised_by, a.role AS authorised_by_role
           FROM owner_overrides o JOIN users p ON p.id = o.performed_by JOIN users a ON a.id = o.authorised_by
          WHERE o.entity_type = 'reservation' AND o.entity_id = $1 ORDER BY o.created_at`,
        [id],
      ),
      q.query<{ id: string; number: string; status: ReservationStatus; relation: 'from' | 'as' }>(
        `SELECT id, number, status, 'from' AS relation FROM reservations WHERE id = $1
         UNION ALL
         SELECT id, number, status, 'as' AS relation FROM reservations WHERE rebooked_from_id = $2`,
        [r.rebooked_from_id, id],
      ),
      this.property.businessDate(q, propertyId),
    ]);

    const stayRows = await q.query<{ id: string; room_number: string; status: string }>(
      `SELECT s.id, rm.number AS room_number, s.status FROM stays s JOIN rooms rm ON rm.id = s.room_id WHERE s.reservation_id = $1 ORDER BY s.checked_in_at`, [id],
    );
    const nightsByRoom = await q.query<NightRow>(
      `SELECT * FROM reservation_room_nights WHERE reservation_room_id = ANY($1::uuid[])`, [roomRows.rows.map((x) => x.id)],
    );
    const quotes = await Promise.all(roomRows.rows.map((x) => this.rates.quoteFromStoredNights(q, propertyId, x.room_type_id, x.rate_plan_id,
      nightsByRoom.rows.filter((n) => n.reservation_room_id === x.id))));
    const estimate = await this.rates.estimateTax(q, propertyId, quotes);

    const rooms = roomRows.rows.map((x) => ({
      id: x.id, roomTypeId: x.room_type_id, roomTypeName: x.room_type_name, roomId: x.room_id, roomNumber: x.room_number,
      adults: x.adults, childAges: x.child_ages.map(Number), mealPlan: x.meal_plan, nightlyRate: x.nightly_rate,
      roomTotal: toMoneyString(x.room_total), extrasTotal: toMoneyString(x.extras_total), mealTotal: toMoneyString(x.meal_total),
      total: toMoneyString(money(x.room_total).plus(x.extras_total).plus(x.meal_total)), status: x.status, rateAuthorisedBy: x.rate_authorised_by,
    }));

    // Why check-in is (not yet) possible, in words for the front desk.
    const checkInBlockers: string[] = [];
    const checkInNotes: string[] = [];
    const waiting = rooms.filter((x) => x.status === 'reserved');
    if (r.status === 'tentative') checkInBlockers.push('Confirm the booking first');
    if (['tentative', 'confirmed', 'checked_in'].includes(r.status) && waiting.length) {
      if (r.arrival > bd) checkInBlockers.push(`Check-in opens on the arrival day, ${formatDate(r.arrival)}`);
      if (r.departure <= bd) checkInBlockers.push('The stay dates have already passed');
      const unassigned = waiting.filter((x) => !x.roomId).length;
      // Rooms can be assigned inside the check-in screens, so this does not block.
      if (unassigned) checkInNotes.push(unassigned === 1 && rooms.length === 1 ? 'Assign a room first — you can do this during check-in' : `${unassigned} room(s) not assigned yet — you can assign them during check-in`);
    }

    const rebookedFrom = related.rows.find((x) => x.relation === 'from');
    return {
      id: r.id, number: r.number, status: r.status, source: r.source, sourceLabel: BOOKING_SOURCE_LABELS[r.source as BookingSource],
      otaReference: r.ota_reference, arrival: r.arrival, departure: r.departure, nights: nightsBetween(r.arrival, r.departure),
      groupName: r.group_name, billingMode: r.billing_mode, purpose: r.purpose, specialRequests: r.special_requests, internalNotes: r.internal_notes,
      guest: { id: r.primary_guest_id, firstName: r.first_name, lastName: r.last_name, fullName: `${r.first_name} ${r.last_name}`.trim(), mobile: r.mobile, email: r.email, isVip: r.is_vip, city: r.city },
      rooms,
      estimate,
      advancePaid: '0.00',
      overrides: overrides.rows.map((o) => ({
        action: o.action, description: o.description, at: o.created_at, performedBy: o.performed_by,
        authorisedBy: o.authorised_by, authorisedByRole: o.authorised_by_role,
      })),
      rebookedFrom: rebookedFrom ? { id: rebookedFrom.id, number: rebookedFrom.number } : null,
      rebookedAs: related.rows.filter((x) => x.relation === 'as').map((x) => ({ id: x.id, number: x.number, status: x.status })),
      checkIn: {
        ready: ['confirmed', 'checked_in'].includes(r.status) && waiting.length > 0 && checkInBlockers.length === 0,
        blockers: checkInBlockers,
        notes: checkInNotes,
      },
      stays: stayRows.rows.map((x) => ({ id: x.id, roomNumber: x.room_number, status: x.status })),
      canEdit: ['tentative', 'confirmed'].includes(r.status),
      canRebook: ['cancelled', 'no_show'].includes(r.status),
      businessDate: bd,
      cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason, cancelNote: r.cancel_note,
      createdAt: r.created_at, createdBy: r.created_by_name, version: r.version,
    };
  }

  async list(propertyId: string, filter: { from?: IsoDate; to?: IsoDate; status?: string; source?: string; q?: string; limit: number }) {
    const { rows } = await this.db.query<{
      id: string; number: string; status: ReservationStatus; source: string; ota_reference: string | null; arrival: string; departure: string;
      group_name: string | null; created_at: Date; guest_name: string; mobile: string; is_vip: boolean; room_count: string;
      room_numbers: string | null; room_types: string | null; total: string;
    }>(
      `SELECT r.id, r.number, r.status, r.source, r.ota_reference, r.arrival, r.departure, r.group_name, r.created_at,
              trim(g.first_name || ' ' || g.last_name) AS guest_name, g.mobile, g.is_vip,
              count(rr.id) AS room_count,
              string_agg(DISTINCT rm.number, ', ') AS room_numbers,
              string_agg(DISTINCT rt.name, ', ') AS room_types,
              COALESCE(sum((SELECT sum(room_rate + extra_person_amount + meal_amount) FROM reservation_room_nights n WHERE n.reservation_room_id = rr.id)), 0) AS total
         FROM reservations r
         JOIN guests g ON g.id = r.primary_guest_id
         LEFT JOIN reservation_rooms rr ON rr.reservation_id = r.id AND rr.status <> 'replaced'
         LEFT JOIN rooms rm ON rm.id = rr.room_id
         LEFT JOIN room_types rt ON rt.id = rr.room_type_id
        WHERE r.property_id = $1
          AND ($2::date IS NULL OR r.departure > $2::date)
          AND ($3::date IS NULL OR r.arrival <= $3::date)
          AND ($4::text IS NULL OR r.status = $4)
          AND ($5::text IS NULL OR r.source = $5)
          AND ($6::text IS NULL OR r.number ILIKE '%' || $6 || '%' OR r.ota_reference = $6
               OR lower(g.first_name || ' ' || g.last_name) LIKE '%' || lower($6) || '%'
               OR (length(regexp_replace($6, '\\D', '', 'g')) >= 4 AND g.mobile LIKE '%' || regexp_replace($6, '\\D', '', 'g')))
        GROUP BY r.id, g.id
        ORDER BY r.arrival, r.number
        LIMIT $7`,
      [propertyId, filter.from ?? null, filter.to ?? null, filter.status ?? null, filter.source ?? null, filter.q?.trim() || null, filter.limit],
    );
    return rows.map((r) => ({
      id: r.id, number: r.number, status: r.status, source: r.source, sourceLabel: BOOKING_SOURCE_LABELS[r.source as BookingSource],
      otaReference: r.ota_reference, arrival: r.arrival, departure: r.departure, nights: nightsBetween(r.arrival, r.departure),
      groupName: r.group_name, guestName: r.guest_name, mobile: r.mobile, isVip: r.is_vip, roomCount: Number(r.room_count),
      roomNumbers: r.room_numbers, roomTypes: r.room_types, total: toMoneyString(r.total), createdAt: r.created_at,
    }));
  }

  /** Timeline data for the reservation calendar (spec §14). */
  async calendar(propertyId: string, from: IsoDate, days: number) {
    const to = addDays(from, days);
    const [rooms, allocations, unassigned, outOfOrder] = await Promise.all([
      this.db.query<{ id: string; number: string; room_type_id: string; room_type_name: string; housekeeping_status: string; service_status: string }>(
        `SELECT r.id, r.number, r.room_type_id, rt.name AS room_type_name, r.housekeeping_status, r.service_status
           FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
          WHERE r.property_id = $1 AND r.is_active ORDER BY rt.sort_order, rt.name, r.sort_order, r.number`,
        [propertyId],
      ),
      this.db.query<{
        id: string; room_id: string; start_date: string; end_date: string; allocation_status: string; reservation_room_id: string; reservation_id: string;
        number: string; status: ReservationStatus; source: string; group_name: string | null; guest_name: string; is_vip: boolean; adults: number; children: number;
      }>(
        `SELECT a.id, a.room_id, a.start_date, a.end_date, a.status AS allocation_status, rr.id AS reservation_room_id,
                res.id AS reservation_id, res.number, res.status, res.source, res.group_name,
                trim(g.first_name || ' ' || g.last_name) AS guest_name, g.is_vip, rr.adults, cardinality(rr.child_ages) AS children
           FROM room_allocations a
           JOIN reservation_rooms rr ON rr.id = a.reservation_room_id
           JOIN reservations res ON res.id = rr.reservation_id
           JOIN guests g ON g.id = res.primary_guest_id
          WHERE a.property_id = $1 AND a.status IN ('reserved','checked_in','completed')
            AND a.start_date < $3::date AND a.end_date > $2::date`,
        [propertyId, from, to],
      ),
      this.db.query<{ reservation_room_id: string; room_type_id: string; room_type_name: string; arrival: string; departure: string; reservation_id: string; number: string; status: ReservationStatus; guest_name: string }>(
        `SELECT rr.id AS reservation_room_id, rr.room_type_id, rt.name AS room_type_name, rr.arrival, rr.departure,
                res.id AS reservation_id, res.number, res.status, trim(g.first_name || ' ' || g.last_name) AS guest_name
           FROM reservation_rooms rr
           JOIN reservations res ON res.id = rr.reservation_id
           JOIN room_types rt ON rt.id = rr.room_type_id
           JOIN guests g ON g.id = res.primary_guest_id
          WHERE rr.property_id = $1 AND rr.room_id IS NULL AND rr.status = 'reserved'
            AND rr.arrival < $3::date AND rr.departure > $2::date
          ORDER BY rr.arrival`,
        [propertyId, from, to],
      ),
      this.db.query<{ id: string; room_id: string; start_date: string; end_date: string; reason: string }>(
        `SELECT id, room_id, start_date, end_date, reason FROM room_out_of_order
          WHERE property_id = $1 AND status = 'active' AND start_date < $3::date AND end_date > $2::date`,
        [propertyId, from, to],
      ),
    ]);
    return {
      from, to, days,
      rooms: rooms.rows.map((r) => ({ id: r.id, number: r.number, roomTypeId: r.room_type_id, roomTypeName: r.room_type_name, housekeeping: r.housekeeping_status, service: r.service_status })),
      bookings: allocations.rows.map((a) => ({
        allocationId: a.id, roomId: a.room_id, start: a.start_date, end: a.end_date, allocationStatus: a.allocation_status,
        reservationRoomId: a.reservation_room_id, reservationId: a.reservation_id, number: a.number, status: a.status,
        source: a.source, groupName: a.group_name, guestName: a.guest_name, isVip: a.is_vip, adults: a.adults, children: Number(a.children),
      })),
      unassigned: unassigned.rows.map((u) => ({
        reservationRoomId: u.reservation_room_id, roomTypeId: u.room_type_id, roomTypeName: u.room_type_name, start: u.arrival, end: u.departure,
        reservationId: u.reservation_id, number: u.number, status: u.status, guestName: u.guest_name,
      })),
      outOfOrder: outOfOrder.rows.map((o) => ({ id: o.id, roomId: o.room_id, start: o.start_date, end: o.end_date, reason: o.reason })),
    };
  }

  /** Reception home (spec §70.1). */
  async frontDesk(propertyId: string) {
    const businessDate = await this.property.businessDate(this.db, propertyId);
    const [arrivals, departures, inHouse, rooms] = await Promise.all([
      this.list(propertyId, { from: businessDate, to: businessDate, limit: 200 }).then((l) =>
        l.filter((r) => r.arrival === businessDate && ['tentative', 'confirmed'].includes(r.status))),
      this.db.query<{ id: string; number: string; departure: string; guest_name: string; is_vip: boolean; room_numbers: string | null }>(
        `SELECT r.id, r.number, r.departure, trim(g.first_name || ' ' || g.last_name) AS guest_name, g.is_vip,
                string_agg(DISTINCT rm.number, ', ') AS room_numbers
           FROM reservations r JOIN guests g ON g.id = r.primary_guest_id
           JOIN reservation_rooms rr ON rr.reservation_id = r.id AND rr.status = 'checked_in'
           LEFT JOIN rooms rm ON rm.id = rr.room_id
          WHERE r.property_id = $1 AND r.status = 'checked_in' AND r.departure <= $2::date
          GROUP BY r.id, g.id ORDER BY r.departure, r.number`,
        [propertyId, businessDate],
      ),
      this.db.query<CountRow>(`SELECT count(*) AS n FROM reservation_rooms WHERE property_id = $1 AND status = 'checked_in'`, [propertyId]),
      this.property.listRooms(propertyId, businessDate),
    ]);
    const counts = rooms.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.displayState]: (acc[r.displayState] ?? 0) + 1 }), {});
    return {
      businessDate,
      arrivals,
      departures: departures.rows.map((d) => ({ id: d.id, number: d.number, departure: d.departure, guestName: d.guest_name, isVip: d.is_vip, roomNumbers: d.room_numbers, overdue: d.departure < businessDate })),
      inHouseRooms: Number(inHouse.rows[0]!.n),
      roomCounts: counts,
      totalRooms: rooms.length,
    };
  }
}
