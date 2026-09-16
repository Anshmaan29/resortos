import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, formatDate, formatINR, type RoomShiftInput } from '@resortos/shared';
import { OwnerAuthorisationService } from '../auth/owner-authorisation.service';
import { AuditService } from '../common/audit.service';
import { AppError, notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { GuestDocumentRow, ReservationRoomRow, RoomRow, StayRow } from '../db/rows';
import { PropertyService } from '../property/property.service';
import { RatesService } from '../rates/rates.service';
import { documentView } from './capture.service';
import { applySteps, CHECKOUT_STEPS, collectBlockers, type CheckoutStep } from './checkout-pipeline';

@Injectable()
export class StaysService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly property: PropertyService,
    private readonly rates: RatesService,
    private readonly ownerAuth: OwnerAuthorisationService,
    @Inject(CHECKOUT_STEPS) private readonly checkoutSteps: CheckoutStep[],
  ) {}

  private async lockStay(q: Queryable, actor: Actor, stayId: string): Promise<StayRow> {
    const { rows } = await q.query<StayRow>(`SELECT * FROM stays WHERE id = $1 AND property_id = $2 FOR UPDATE`, [stayId, actor.user.propertyId]);
    if (!rows[0]) throw notFound('Stay');
    return rows[0];
  }

  async detail(q: Queryable, propertyId: string, stayId: string) {
    const { rows } = await q.query<StayRow & { room_number: string; room_type_name: string; reservation_number: string; guest_first: string; guest_last: string }>(
      `SELECT s.*, rm.number AS room_number, rt.name AS room_type_name, r.number AS reservation_number, g.first_name AS guest_first, g.last_name AS guest_last
         FROM stays s JOIN rooms rm ON rm.id = s.room_id JOIN room_types rt ON rt.id = rm.room_type_id
         JOIN reservations r ON r.id = s.reservation_id JOIN guests g ON g.id = s.primary_guest_id
        WHERE s.id = $1 AND s.property_id = $2`,
      [stayId, propertyId],
    );
    const s = rows[0];
    if (!s) throw notFound('Stay');
    const [occupants, vehicles, documents, shifts] = await Promise.all([
      q.query<{ occupant_key: string; full_name: string; is_primary: boolean; is_child: boolean; age: number | null; nationality: string; id_type: string; id_last4: string | null }>(
        `SELECT occupant_key, full_name, is_primary, is_child, age, nationality, id_type, id_last4 FROM stay_occupants WHERE stay_id = $1 ORDER BY is_primary DESC, is_child, created_at`, [stayId]),
      q.query<{ registration: string; vehicle_type: string; parking_slot: string | null }>(`SELECT registration, vehicle_type, parking_slot FROM stay_vehicles WHERE stay_id = $1`, [stayId]),
      q.query<GuestDocumentRow>(`SELECT * FROM guest_documents WHERE stay_id = $1 ORDER BY created_at`, [stayId]),
      q.query<{ from_number: string; to_number: string; business_date: string; reason: string; rate_decision: string; created_at: Date; by_name: string }>(
        `SELECT f.number AS from_number, t.number AS to_number, sh.business_date, sh.reason, sh.rate_decision, sh.created_at, u.full_name AS by_name
           FROM room_shifts sh JOIN rooms f ON f.id = sh.from_room_id JOIN rooms t ON t.id = sh.to_room_id JOIN users u ON u.id = sh.created_by
          WHERE sh.stay_id = $1 ORDER BY sh.created_at`, [stayId]),
    ]);
    return {
      id: s.id, status: s.status, reservationId: s.reservation_id, reservationNumber: s.reservation_number,
      guestName: `${s.guest_first} ${s.guest_last}`.trim(), roomId: s.room_id, roomNumber: s.room_number, roomTypeName: s.room_type_name,
      checkedInAt: s.checked_in_at, businessDateIn: s.business_date_in, expectedDeparture: s.expected_departure,
      checkedOutAt: s.checked_out_at, businessDateOut: s.business_date_out, earlyDeparture: s.early_departure, version: s.version,
      occupants: occupants.rows.map((o) => ({ key: o.occupant_key, fullName: o.full_name, isPrimary: o.is_primary, isChild: o.is_child, age: o.age, nationality: o.nationality, idType: o.id_type, idLast4: o.id_last4 })),
      vehicles: vehicles.rows.map((v) => ({ registration: v.registration, vehicleType: v.vehicle_type, parkingSlot: v.parking_slot })),
      documents: documents.rows.map(documentView),
      shifts: shifts.rows.map((x) => ({ from: x.from_number, to: x.to_number, businessDate: x.business_date, reason: x.reason, rateDecision: x.rate_decision, at: x.created_at, by: x.by_name })),
    };
  }

  // ---------------------------------------------------------------------------
  // Room shift (spec §21)
  // ---------------------------------------------------------------------------

  async shiftRoom(q: Queryable, actor: Actor, stayId: string, input: RoomShiftInput) {
    const stay = await this.lockStay(q, actor, stayId);
    if (stay.status !== 'in_house') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Only guests who are in house can change rooms.');
    if (stay.room_id === input.toRoomId) throw new AppError(ERROR_CODES.VALIDATION, 'Choose a different room.');
    const bd = await this.property.businessDate(q, actor.user.propertyId);
    if (bd >= stay.expected_departure) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'The guest is due to check out; room shift is not possible.');

    const { rows: rrRows } = await q.query<ReservationRoomRow>(`SELECT * FROM reservation_rooms WHERE id = $1 FOR UPDATE`, [stay.reservation_room_id]);
    const rr = rrRows[0]!;
    const { rows: roomRows } = await q.query<RoomRow & { type_name: string }>(
      `SELECT r.*, rt.name AS type_name FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.id = ANY($1::uuid[]) AND r.property_id = $2`,
      [[stay.room_id, input.toRoomId], actor.user.propertyId],
    );
    const from = roomRows.find((r) => r.id === stay.room_id)!;
    const to = roomRows.find((r) => r.id === input.toRoomId);
    if (!to || !to.is_active) throw notFound('Room');
    if (to.service_status !== 'in_service') throw new AppError(ERROR_CODES.ROOM_UNAVAILABLE, `Room ${to.number} is not in service.`);

    // Changing room type moves the booking's inventory to the new type; check it under lock.
    if (to.room_type_id !== rr.room_type_id) {
      await q.query(`SELECT id FROM room_types WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[rr.room_type_id, to.room_type_id].sort()]);
      const { rows: cap } = await q.query<{ night: string; capacity: string; booked: string }>(
        `WITH nights AS (SELECT d::date AS night FROM generate_series($2::date, $3::date - 1, interval '1 day') d)
         SELECT to_char(n.night, 'YYYY-MM-DD') AS night,
                (SELECT count(*) FROM rooms r WHERE r.room_type_id = $1 AND r.is_active
                   AND NOT EXISTS (SELECT 1 FROM room_out_of_order o WHERE o.room_id = r.id AND o.status = 'active' AND o.start_date <= n.night AND o.end_date > n.night)) AS capacity,
                (SELECT count(*) FROM reservation_rooms x WHERE x.room_type_id = $1 AND x.status IN ('reserved','checked_in') AND x.arrival <= n.night AND x.departure > n.night) AS booked
           FROM nights n`,
        [to.room_type_id, bd, stay.expected_departure],
      );
      const short = cap.filter((c) => Number(c.booked) + 1 > Number(c.capacity));
      if (short.length) throw new AppError(ERROR_CODES.ROOM_UNAVAILABLE, `No ${to.type_name} room is free on ${short.map((c) => formatDate(c.night, { year: false })).join(', ')}.`);
    }

    let authorisedBy: string | null = null;
    if (input.rateDecision === 'new_room_type_rate') {
      const quote = await this.rates.quote(q, actor.user.propertyId, {
        roomTypeId: to.room_type_id, arrival: bd, departure: stay.expected_departure, adults: rr.adults, childAges: rr.child_ages.map(Number), mealPlan: rr.meal_plan,
      });
      const reasons = quote.belowFloor ? [{ action: 'rate_below_floor' as const, description: `Rate ${formatINR(quote.nights.find((n) => n.belowFloor)!.roomRate)} is below the minimum ${formatINR(quote.minRate)}` }] : [];
      const auth = await this.ownerAuth.require(q, actor, { operation: 'stay.shift_room', scope: { stayId, toRoomId: to.id, businessDate: bd, rates: quote.nights.map((n) => n.roomRate) }, reasons },
        input.ownerAuthorisationId, { type: 'stay', id: stayId });
      authorisedBy = auth?.authorisedBy ?? null;
      for (const n of quote.nights) {
        await q.query(
          `UPDATE reservation_room_nights SET room_rate = $3, extra_person_amount = $4, meal_amount = $5, rate_source = $6 WHERE reservation_room_id = $1 AND night_date = $2`,
          [rr.id, n.date, n.roomRate, n.extraPersonAmount, n.mealAmount, n.rateSource],
        );
      }
      if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'reservation', id: stay.reservation_id });
    }

    // Close the old allocation at the shift date (or release it if shifting on the arrival day).
    const { rows: oldAlloc } = await q.query<{ id: string; start_date: string }>(
      `SELECT id, start_date FROM room_allocations WHERE reservation_room_id = $1 AND status = 'checked_in' FOR UPDATE`, [rr.id],
    );
    const old = oldAlloc[0];
    if (!old) throw new AppError(ERROR_CODES.CONFLICT, 'The room allocation changed. Reload and try again.');
    if (old.start_date < bd) {
      await q.query(`UPDATE room_allocations SET end_date = $2, status = 'completed' WHERE id = $1`, [old.id, bd]);
    } else {
      await q.query(`UPDATE room_allocations SET status = 'released', release_reason = 'room_shift' WHERE id = $1`, [old.id]);
    }
    // The exclusion constraint decides whether the new room is really free.
    await q.query(
      `INSERT INTO room_allocations (property_id, reservation_room_id, room_id, start_date, end_date, status, created_by) VALUES ($1,$2,$3,$4,$5,'checked_in',$6)`,
      [actor.user.propertyId, rr.id, to.id, bd, stay.expected_departure, actor.user.id],
    );
    await q.query(`UPDATE reservation_rooms SET room_id = $2, room_type_id = $3 WHERE id = $1`, [rr.id, to.id, to.room_type_id]);
    await q.query(`UPDATE stays SET room_id = $2 WHERE id = $1`, [stayId, to.id]);
    await q.query(`SELECT set_config('resortos.reason', $1, true)`, [`Room shift to ${to.number}: ${input.reason}`]);
    await q.query(`UPDATE rooms SET housekeeping_status = 'dirty', updated_by = $2 WHERE id = $1`, [from.id, actor.user.id]);
    await q.query(
      `INSERT INTO room_shifts (property_id, stay_id, from_room_id, to_room_id, business_date, reason, rate_decision, authorised_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [actor.user.propertyId, stayId, from.id, to.id, bd, input.reason, input.rateDecision, authorisedBy, actor.user.id],
    );
    await this.audit.record(q, actor, {
      action: 'stay.room_shifted', entityType: 'stay', entityId: stayId, reason: input.reason, authorisedBy,
      before: { roomId: from.id, roomNumber: from.number }, after: { roomId: to.id, roomNumber: to.number, rateDecision: input.rateDecision },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'stay.room_shifted', { type: 'stay', id: stayId }, { from: from.id, to: to.id });
    return this.detail(q, actor.user.propertyId, stayId);
  }

  // ---------------------------------------------------------------------------
  // Checkout (spec §22) — status change only; billing steps plug in via CHECKOUT_STEPS
  // ---------------------------------------------------------------------------

  async checkoutPreview(actor: Actor, stayId: string) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<StayRow>(`SELECT * FROM stays WHERE id = $1 AND property_id = $2`, [stayId, actor.user.propertyId]);
      const stay = rows[0];
      if (!stay) throw notFound('Stay');
      const bd = await this.property.businessDate(q, actor.user.propertyId);
      const blockers = stay.status === 'in_house' ? await collectBlockers(this.checkoutSteps, { q, actor, stay, businessDate: bd, input: {} }) : [];
      return {
        stayId, status: stay.status, businessDate: bd, expectedDeparture: stay.expected_departure,
        earlyDeparture: stay.status === 'in_house' && bd < stay.expected_departure,
        steps: [...this.checkoutSteps].sort((a, b) => a.order - b.order).map((s) => s.name),
        blockers,
      };
    });
  }

  async checkout(q: Queryable, actor: Actor, stayId: string, input: Record<string, unknown>) {
    const stay = await this.lockStay(q, actor, stayId);
    if (stay.status !== 'in_house') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This guest has already checked out.');
    const bd = await this.property.businessDate(q, actor.user.propertyId);
    const ctx = { q, actor, stay, businessDate: bd, input };

    const blockers = await collectBlockers(this.checkoutSteps, ctx);
    if (blockers.length) throw new AppError(ERROR_CODES.VALIDATION, blockers[0]!.message, { blockers });
    const applied = await applySteps(this.checkoutSteps, ctx);

    const early = bd < stay.expected_departure;
    const { rows: alloc } = await q.query<{ id: string; start_date: string }>(
      `SELECT id, start_date FROM room_allocations WHERE reservation_room_id = $1 AND status = 'checked_in' FOR UPDATE`, [stay.reservation_room_id],
    );
    if (!alloc[0]) throw new AppError(ERROR_CODES.CONFLICT, 'The room allocation changed. Reload and try again.');
    if (early && alloc[0].start_date < bd) {
      // Early departure frees the room from today onwards.
      await q.query(`UPDATE room_allocations SET end_date = $2, status = 'completed' WHERE id = $1`, [alloc[0].id, bd]);
    } else if (early) {
      await q.query(`UPDATE room_allocations SET status = 'released', release_reason = 'departed_on_arrival_day' WHERE id = $1`, [alloc[0].id]);
    } else {
      await q.query(`UPDATE room_allocations SET status = 'completed' WHERE id = $1`, [alloc[0].id]);
    }
    await q.query(`UPDATE reservation_rooms SET status = 'checked_out' WHERE id = $1`, [stay.reservation_room_id]);
    await q.query(
      `UPDATE stays SET status = 'checked_out', checked_out_at = now(), checked_out_by = $2, business_date_out = $3, early_departure = $4 WHERE id = $1`,
      [stayId, actor.user.id, bd, early],
    );
    await q.query(`SELECT set_config('resortos.reason', 'Checkout', true)`);
    await q.query(`UPDATE rooms SET housekeeping_status = 'dirty', updated_by = $2 WHERE id = $1`, [stay.room_id, actor.user.id]);

    // The booking is checked out when no room is still waiting or in house.
    const { rows: open } = await q.query<{ n: string }>(
      `SELECT count(*) AS n FROM reservation_rooms WHERE reservation_id = $1 AND status IN ('reserved', 'checked_in')`, [stay.reservation_id],
    );
    if (Number(open[0]!.n) === 0) {
      await q.query(`UPDATE reservations SET status = 'checked_out', updated_by = $2 WHERE id = $1 AND status = 'checked_in'`, [stay.reservation_id, actor.user.id]);
    }

    await this.audit.record(q, actor, {
      action: 'stay.checked_out', entityType: 'stay', entityId: stayId,
      before: { status: 'in_house' }, after: { status: 'checked_out', businessDate: bd, earlyDeparture: early, stepsApplied: applied },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'stay.checked_out', { type: 'stay', id: stayId }, { roomId: stay.room_id, earlyDeparture: early });
    await this.outbox.emit(q, actor.user.propertyId, 'housekeeping.task_needed', { type: 'room', id: stay.room_id }, { reason: 'checkout' });
    return this.detail(q, actor.user.propertyId, stayId);
  }
}
