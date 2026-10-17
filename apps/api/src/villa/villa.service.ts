import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  VILLA_USE_LABELS,
  villaBookingTotal,
  villaDayUse,
  formatReference,
  formatDate,
  money,
  toMoneyString,
  nightsBetween,
  type VillaBookingInput,
  type RecordPaymentInput,
} from '@resortos/shared';
import type { Actor } from '../common/request-context';
import { AppError, notFound, staleVersion } from '../common/errors';
import { DbService, type Queryable } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { OutboxService } from '../common/outbox.service';
import { GuestsService } from '../guests/guests.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PropertyService } from '../property/property.service';
import { FolioService } from '../folios/folio.service';
import { PaymentsService } from '../folios/payments.service';
import { InvoicesService } from '../folios/invoices.service';

export interface VillaRow {
  id: string;
  property_id: string;
  use_kind: keyof typeof VILLA_USE_LABELS;
  starts_at: Date;
  ends_at: Date;
  guest_count: number;
  price: string;
  gst_percent: string;
  meal_plan: string;
  allocation_status: string;
  resource_mask: number;
  room_id: string | null;
  number: string;
  status: string;
  version: number;
  primary_guest_id: string;
  guest_name: string;
  mobile: string;
  whatsapp_opted_in: boolean;
  whatsapp_consent_at: Date | null;
  email: string | null;
  internal_notes: string | null;
}
const localDate = (date: string | Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(date));
const mapped = (r: VillaRow) => ({
  id: r.id,
  number: r.number,
  useKind: r.use_kind,
  useLabel:
    r.use_kind === 'one_bedroom' && r.resource_mask !== 3
      ? `Room ${r.resource_mask}`
      : VILLA_USE_LABELS[r.use_kind],
  resourceMask: r.resource_mask,
  roomId: r.room_id,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  mealPlan: r.meal_plan,
  guestCount: r.guest_count,
  price: r.price,
  gstPercent: r.gst_percent,
  status: r.status,
  version: r.version,
  guestId: r.primary_guest_id,
  guestName: r.guest_name,
  mobile: r.mobile,
  whatsappOptedIn: r.whatsapp_opted_in,
  whatsappConsentAt: r.whatsapp_consent_at?.toISOString() ?? null,
  email: r.email,
  notes: r.internal_notes,
  dayUse: villaDayUse(r.use_kind),
});

@Injectable()
export class VillaService {
  constructor(
    private readonly db: DbService,
    private readonly property: PropertyService,
    private readonly reservations: ReservationsService,
    private readonly guests: GuestsService,
    private readonly folios: FolioService,
    private readonly payments: PaymentsService,
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async assertVilla(q: Queryable, propertyId: string, lock = false) {
    const query = lock
      ? 'SELECT booking_model FROM properties WHERE id=$1 FOR NO KEY UPDATE'
      : 'SELECT booking_model FROM properties WHERE id=$1';
    const { rows } = await q.query<{ booking_model: string }>(query, [propertyId]);
    if (rows[0]?.booking_model !== 'private_villa')
      throw new AppError(
        ERROR_CODES.FORBIDDEN,
        'This action is only available in the villa workspace.',
      );
  }
  private async load(q: Queryable, propertyId: string, id: string, lock = false) {
    await this.assertVilla(q, propertyId);
    if (lock)
      await q.query('SELECT id FROM reservations WHERE id=$1 AND property_id=$2 FOR UPDATE', [
        id,
        propertyId,
      ]);
    const { rows } = await q.query<VillaRow>(
      `SELECT v.*,(SELECT rr.room_id FROM reservation_rooms rr WHERE rr.reservation_id=v.id AND rr.status IN ('reserved','checked_in') ORDER BY rr.created_at LIMIT 1) AS room_id,r.number,r.status,r.version,r.primary_guest_id,r.internal_notes,
      trim(g.first_name||' '||g.last_name) AS guest_name,g.mobile,g.email,g.whatsapp_opted_in,g.whatsapp_consent_at FROM villa_bookings v
      JOIN reservations r ON r.id=v.id JOIN guests g ON g.id=r.primary_guest_id WHERE v.id=$1 AND v.property_id=$2`,
      [id, propertyId],
    );
    if (!rows[0]) throw notFound('Villa booking');
    return rows[0];
  }
  async list(propertyId: string, from?: string, to?: string) {
    await this.assertVilla(this.db, propertyId);
    const { rows } = await this.db.query<VillaRow>(
      `SELECT v.*,(SELECT rr.room_id FROM reservation_rooms rr WHERE rr.reservation_id=v.id AND rr.status IN ('reserved','checked_in') ORDER BY rr.created_at LIMIT 1) AS room_id,r.number,r.status,r.version,r.primary_guest_id,r.internal_notes,
      trim(g.first_name||' '||g.last_name) AS guest_name,g.mobile,g.email,g.whatsapp_opted_in,g.whatsapp_consent_at FROM villa_bookings v
      JOIN reservations r ON r.id=v.id JOIN guests g ON g.id=r.primary_guest_id
      WHERE v.property_id=$1 AND ($2::date IS NULL OR (v.ends_at AT TIME ZONE 'Asia/Kolkata')::date >=$2)
      AND ($3::date IS NULL OR (v.starts_at AT TIME ZONE 'Asia/Kolkata')::date <=$3) ORDER BY v.starts_at DESC LIMIT 500`,
      [propertyId, from ?? null, to ?? null],
    );
    return rows.map(mapped);
  }
  async detail(q: Queryable, propertyId: string, id: string) {
    const row = await this.load(q, propertyId, id);
    const { rows: stays } = await q.query<{ id: string }>(
      `SELECT id FROM stays WHERE reservation_id=$1 AND property_id=$2 ORDER BY checked_in_at DESC`,
      [id, propertyId],
    );
    const { rows: bills } = await q.query<{ id: string }>(
      `SELECT id FROM folios WHERE reservation_id=$1 AND property_id=$2 ORDER BY opened_at LIMIT 1`,
      [id, propertyId],
    );
    const { rows: paid } = await q.query<{ amount: string }>(
      `SELECT COALESCE(sum(bill_effect),0)::numeric(14,2) AS amount FROM payments WHERE reservation_id=$1 AND property_id=$2`,
      [id, propertyId],
    );
    const nights = villaDayUse(row.use_kind)
      ? 1
      : nightsBetween(localDate(row.starts_at), localDate(row.ends_at));
    let subtotal = money(row.price).times(nights);
    if (!villaDayUse(row.use_kind)) {
      const { rows: agreed } = await q.query<{ amount: string }>(
        `SELECT COALESCE(sum(n.room_rate+n.extra_person_amount+n.meal_amount),0)::numeric(14,2) AS amount
        FROM reservation_room_nights n JOIN reservation_rooms rr ON rr.id=n.reservation_room_id WHERE rr.reservation_id=$1 AND rr.property_id=$2`,
        [id, propertyId],
      );
      subtotal = money(agreed[0]!.amount);
    }
    return {
      ...mapped(row),
      stayId: stays[0]?.id ?? null,
      folioId: bills[0]?.id ?? null,
      subtotal: toMoneyString(subtotal),
      estimatedTotal: villaBookingTotal(toMoneyString(subtotal), row.gst_percent),
      paid: paid[0]!.amount,
      bill: bills[0] ? await this.folios.detail(q, propertyId, bills[0].id) : null,
    };
  }
  async available(
    q: Queryable,
    propertyId: string,
    startsAt: string,
    endsAt: string,
    excludeId?: string,
    mask = 3,
  ) {
    await this.assertVilla(q, propertyId);
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM villa_bookings WHERE property_id=$1 AND id IS DISTINCT FROM $4::uuid
      AND (resource_mask & $5)>0 AND allocation_status IN ('reserved','occupied')
      AND (tstzrange(starts_at,ends_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
      OR ($2::timestamptz<=now() AND allocation_status='occupied' AND ends_at<now())) LIMIT 1`,
      [propertyId, startsAt, endsAt, excludeId ?? null, mask],
    );
    const { rows: resources } = await q.query<{ ready: string }>(
      `SELECT count(*) FILTER(WHERE rm.is_active AND rm.service_status='in_service' AND NOT EXISTS(
        SELECT 1 FROM room_out_of_order o WHERE o.room_id=rm.id AND o.status='active'
        AND tstzrange(o.start_date::timestamp AT TIME ZONE 'Asia/Kolkata',o.end_date::timestamp AT TIME ZONE 'Asia/Kolkata','[)')
        && tstzrange($2::timestamptz,$3::timestamptz,'[)'))) AS ready
      FROM rooms rm WHERE rm.property_id=$1
      AND (rm.number=CASE WHEN $4=2 THEN '2' ELSE '1' END OR ($4=3 AND rm.number='2'))
      `,
      [propertyId, startsAt, endsAt, mask],
    );
    const resourcesReady = Number(resources[0]?.ready ?? 0) === (mask === 3 ? 2 : 1);
    return {
      available: rows.length === 0 && resourcesReady,
      message:
        rows.length || !resourcesReady
          ? 'The selected room or property is booked, in maintenance, or awaiting checkout. Choose another room or time.'
          : null,
    };
  }
  async roomOptions(
    q: Queryable,
    propertyId: string,
    startsAt: string,
    endsAt: string,
    excludeId?: string,
  ) {
    await this.assertVilla(q, propertyId);
    const { rows } = await q.query<{ id: string; number: string; room_type_id: string; ready: boolean }>(
      `SELECT id,number,room_type_id,housekeeping_status IN ('clean','inspected') AND service_status='in_service' AS ready FROM rooms WHERE property_id=$1 AND number IN ('1','2') AND is_active ORDER BY number`,
      [propertyId],
    );
    const options = [];
    for (const room of rows) {
      const result = await this.available(q, propertyId, startsAt, endsAt, excludeId, Number(room.number));
      options.push({
        id: room.id,
        number: room.number,
        roomTypeId: room.room_type_id,
        ...result,
        available: result.available && room.ready,
        message: !room.ready ? `Room ${room.number} needs housekeeping or maintenance.` : result.message,
      });
    }
    return options;
  }
  private async resources(q: Queryable, propertyId: string, input: VillaBookingInput) {
    const { rows } = await q.query<{ id: string; number: string; room_type_id: string }>(
      `SELECT id,number,room_type_id FROM rooms WHERE property_id=$1 AND number IN ('1','2') AND is_active ORDER BY number`,
      [propertyId],
    );
    const room =
      input.useKind === 'one_bedroom' ? rows.find((r) => r.id === input.roomId) : rows[0];
    if (!room || (input.useKind !== 'one_bedroom' && rows.length !== 2))
      throw new AppError(ERROR_CODES.VALIDATION, 'Choose an available Room 1 or Room 2.');
    return { mask: input.useKind === 'one_bedroom' ? Number(room.number) : 3, room };
  }
  private async validate(q: Queryable, actor: Actor, input: VillaBookingInput, excludeId?: string) {
    await this.assertVilla(q, actor.user.propertyId, true);
    const { mask, room } = await this.resources(q, actor.user.propertyId, input);
    const arrival = localDate(input.startsAt),
      departure = localDate(input.endsAt);
    if (arrival < (await this.property.today(q, actor.user.propertyId)))
      throw new AppError(ERROR_CODES.VALIDATION, 'Start date cannot be before today.');
    if (!villaDayUse(input.useKind) && departure <= arrival)
      throw new AppError(
        ERROR_CODES.VALIDATION,
        'A bedroom or whole-villa stay needs at least one overnight stay.',
      );
    if (
      !(
        await this.available(
          q,
          actor.user.propertyId,
          input.startsAt,
          input.endsAt,
          excludeId,
          mask,
        )
      ).available
    )
      throw new AppError(
        ERROR_CODES.ROOM_UNAVAILABLE,
        'The selected room or property is unavailable for part of this time. Choose another room or time.',
      );
    if (!villaDayUse(input.useKind)) {
      const options = await this.roomOptions(q, actor.user.propertyId, input.startsAt, input.endsAt, excludeId);
      if (options.some(r => (mask & Number(r.number))>0 && !r.available))
        throw new AppError(ERROR_CODES.ROOM_UNAVAILABLE, 'The selected room(s) need housekeeping or are no longer available.');
    }
    return { arrival, departure, mask, room };
  }
  private async recordConsent(q: Queryable, actor: Actor, id: string, optedIn: boolean | undefined) {
    if (optedIn === undefined) return; // Older callers and edits preserve the recorded preference.
    const { rows } = await q.query<{ id: string }>(
      `UPDATE guests g SET whatsapp_opted_in=$3,whatsapp_consent_at=now(),whatsapp_consent_by=$4
       FROM reservations r WHERE r.id=$2 AND r.property_id=$1 AND g.id=r.primary_guest_id AND g.property_id=$1 RETURNING g.id`,
      [actor.user.propertyId,id,optedIn,actor.user.id]);
    if (!rows[0]) throw notFound('Guest');
    await this.audit.record(q,actor,{action:'guest.whatsapp_consent_recorded',entityType:'guest',entityId:rows[0].id,
      after:{optedIn,source:'booking',reservationId:id}});
  }
  async create(q: Queryable, actor: Actor, input: VillaBookingInput) {
    const { arrival, departure, mask, room } = await this.validate(q, actor, input);
    let id: string;
    if (!villaDayUse(input.useKind)) {
      const booking = await this.reservations.create(
        q,
        actor,
        {
          arrival,
          departure,
          guestId: input.guestId,
          guest: input.guest,
          source: 'direct',
          status: 'confirmed',
          internalNotes: input.notes,
          rooms: [
            {
              roomTypeId: room.room_type_id,
              roomId: room.id,
              adults: input.guestCount,
              childAges: [],
              nightlyRate: input.price,
              extraPersonRate: '0.00',
              gstRate: input.gstPercent,
              includesMealPlan: true,
              mealPlan: input.mealPlan,
            },
          ],
        },
        true,
      );
      id = booking.id;
      await q.query(`UPDATE reservations SET booking_model='private_villa' WHERE id=$1`, [id]);
    } else {
      let guestId = input.guestId;
      if (guestId) {
        const { rows } = await q.query<{ id: string }>(
          `SELECT id FROM guests WHERE id=$1 AND property_id=$2 AND merged_into_id IS NULL`,
          [guestId, actor.user.propertyId],
        );
        if (!rows[0]) throw notFound('Guest');
      } else guestId = (await this.guests.createInTx(q, actor, input.guest!)).id;
      const { rows: num } = await q.query<{ n: string }>(
        `SELECT next_reference($1,'reservation') AS n`,
        [actor.user.propertyId],
      );
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO reservations(property_id,number,primary_guest_id,source,arrival,departure,status,internal_notes,created_by,booking_model)
        VALUES($1,$2,$3,'direct',$4,$5,'confirmed',$6,$7,'private_villa') RETURNING id`,
        [
          actor.user.propertyId,
          formatReference('BK', Number(num[0]!.n)),
          guestId,
          arrival,
          departure,
          input.notes ?? null,
          actor.user.id,
        ],
      );
      id = rows[0]!.id;
      const { rows: fnum } = await q.query<{ n: string }>(
        `SELECT next_reference($1,'folio') AS n`,
        [actor.user.propertyId],
      );
      await q.query(
        `INSERT INTO folios(property_id,number,reservation_id,kind,opened_by) VALUES($1,$2,$3,'villa',$4)`,
        [actor.user.propertyId, formatReference('F', Number(fnum[0]!.n)), id, actor.user.id],
      );
      await this.outbox.emit(q, actor.user.propertyId, 'reservation.created', {
        type: 'reservation',
        id,
      });
    }
    await q.query(
      `INSERT INTO villa_bookings(id,property_id,use_kind,starts_at,ends_at,guest_count,price,gst_percent,meal_plan,resource_mask)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        actor.user.propertyId,
        input.useKind,
        input.startsAt,
        input.endsAt,
        input.guestCount,
        input.price,
        input.gstPercent,
        input.mealPlan,
        mask,
      ],
    );
    await this.recordConsent(q,actor,id,input.whatsappOptedIn);
    await this.audit.record(q, actor, {
      action: 'villa.booking_created',
      entityType: 'reservation',
      entityId: id,
      after: {
        useKind: input.useKind,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        guestCount: input.guestCount,
        price: input.price,
        gstPercent: input.gstPercent,
      },
    });
    return this.detail(q, actor.user.propertyId, id);
  }
  async update(q: Queryable, actor: Actor, id: string, input: VillaBookingInput) {
    const row = await this.load(q, actor.user.propertyId, id, true);
    if (row.version !== input.version) throw staleVersion();
    if (row.status !== 'confirmed')
      throw new AppError(
        ERROR_CODES.INVALID_TRANSITION,
        'Only a booking awaiting arrival can be edited.',
      );
    if (villaDayUse(row.use_kind) !== villaDayUse(input.useKind))
      throw new AppError(
        ERROR_CODES.VALIDATION,
        'Cancel and create a new booking to change between an overnight stay and a pool/garden visit.',
      );
    const { arrival, departure, mask, room } = await this.validate(q, actor, input, id);
    if (!villaDayUse(input.useKind)) {
      const { rows } = await q.query<{ id: string; room_type_id: string; room_id: string | null }>(
        `SELECT id,room_type_id,room_id FROM reservation_rooms WHERE reservation_id=$1 AND status='reserved'`,
        [id],
      );
      if (!rows[0]) throw notFound('Villa bedroom booking');
      await this.reservations.update(
        q,
        actor,
        id,
        {
          version: row.version,
          arrival,
          departure,
          guestId: input.guestId,
          guest: input.guest,
          source: 'direct',
          status: 'confirmed',
          internalNotes: input.notes,
          rooms: [
            {
              reservationRoomId: rows[0].id,
              roomTypeId: room.room_type_id,
              roomId: room.id,
              adults: input.guestCount,
              childAges: [],
              nightlyRate: input.price,
              extraPersonRate: '0.00',
              gstRate: input.gstPercent,
              includesMealPlan: true,
              mealPlan: input.mealPlan,
            },
          ],
        },
        true,
      );
    } else {
      let guestId = input.guestId;
      if (guestId) {
        const { rows } = await q.query<{ id: string }>(
          `SELECT id FROM guests WHERE id=$1 AND property_id=$2 AND merged_into_id IS NULL`,
          [guestId, actor.user.propertyId],
        );
        if (!rows[0]) throw notFound('Guest');
      } else guestId = (await this.guests.createInTx(q, actor, input.guest!)).id;
      await q.query(
        `UPDATE reservations SET arrival=$3,departure=$4,primary_guest_id=$5,internal_notes=$6,updated_by=$7 WHERE id=$1 AND property_id=$2`,
        [
          id,
          actor.user.propertyId,
          arrival,
          departure,
          guestId,
          input.notes ?? null,
          actor.user.id,
        ],
      );
    }
    await q.query(
      `UPDATE villa_bookings SET use_kind=$3,starts_at=$4,ends_at=$5,guest_count=$6,price=$7,gst_percent=$8,meal_plan=$9,resource_mask=$10 WHERE id=$1 AND property_id=$2`,
      [
        id,
        actor.user.propertyId,
        input.useKind,
        input.startsAt,
        input.endsAt,
        input.guestCount,
        input.price,
        input.gstPercent,
        input.mealPlan,
        mask,
      ],
    );
    await this.recordConsent(q,actor,id,input.whatsappOptedIn);
    await this.audit.record(q, actor, {
      action: 'villa.booking_updated',
      entityType: 'reservation',
      entityId: id,
      after: {
        useKind: input.useKind,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        guestCount: input.guestCount,
        price: input.price,
        gstPercent: input.gstPercent,
      },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'villa.updated', { type: 'reservation', id });
    return this.detail(q, actor.user.propertyId, id);
  }
  async refund(q: Queryable, actor: Actor, id: string, input: RecordPaymentInput) {
    const row = await this.load(q, actor.user.propertyId, id, true);
    if (row.status !== 'confirmed' || input.entryType !== 'refund')
      throw new AppError(
        ERROR_CODES.INVALID_TRANSITION,
        'Use this action to record an advance refund before arrival.',
      );
    const { rows } = await q.query<{ paid: string }>(
      `SELECT COALESCE(sum(bill_effect),0)::numeric(14,2) AS paid FROM payments WHERE reservation_id=$1 AND property_id=$2`,
      [id, actor.user.propertyId],
    );
    if (money(input.amount).gt(rows[0]!.paid))
      throw new AppError(
        ERROR_CODES.VALIDATION,
        'The refund cannot exceed the advance held on this booking.',
      );
    await this.payments.record(q, actor, { reservationId: id }, input);
    return this.detail(q, actor.user.propertyId, id);
  }
  async arrive(q: Queryable, actor: Actor, id: string, version: number) {
    const row = await this.load(q, actor.user.propertyId, id, true);
    if (row.version !== version) throw staleVersion();
    if (!villaDayUse(row.use_kind))
      throw new AppError(
        ERROR_CODES.INVALID_TRANSITION,
        'Complete the overnight check-in with guest documents.',
      );
    if (row.status !== 'confirmed')
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This booking is not awaiting arrival.');
    await assertVillaArrival(q, actor.user.propertyId, id);
    const { rows: bill } = await q.query<{ id: string }>(
      `SELECT id FROM folios WHERE reservation_id=$1 AND property_id=$2 FOR UPDATE`,
      [id, actor.user.propertyId],
    );
    const bd = await this.property.businessDate(q, actor.user.propertyId);
    await q.query(
      `INSERT INTO folio_lines(property_id,folio_id,business_date,line_type,name,quantity,unit_rate,amount,tax_category,created_by,gst_rate_override)
      VALUES($1,$2,$3,'activity',$4,1,$5,$5,'activity',$6,$7)`,
      [
        actor.user.propertyId,
        bill[0]!.id,
        bd,
        VILLA_USE_LABELS[row.use_kind] + ' · ' + formatDate(localDate(row.starts_at)),
        row.price,
        actor.user.id,
        row.gst_percent,
      ],
    );
    await q.query(`UPDATE reservations SET status='checked_in',updated_by=$2 WHERE id=$1`, [
      id,
      actor.user.id,
    ]);
    await this.audit.record(q, actor, {
      action: 'villa.arrived',
      entityType: 'reservation',
      entityId: id,
    });
    await this.outbox.emit(q, actor.user.propertyId, 'villa.arrived', { type: 'reservation', id });
    return this.detail(q, actor.user.propertyId, id);
  }
  async depart(q: Queryable, actor: Actor, id: string, version: number) {
    const row = await this.load(q, actor.user.propertyId, id, true);
    if (row.version !== version) throw staleVersion();
    if (!villaDayUse(row.use_kind) || row.status !== 'checked_in')
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This day-use booking is not in use.');
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM folios WHERE reservation_id=$1 AND property_id=$2`,
      [id, actor.user.propertyId],
    );
    const bill = await this.folios.detail(q, actor.user.propertyId, rows[0]!.id);
    if (bill.balance === null || !money(bill.balance).isZero() || !money(bill.depositHeld).isZero())
      throw new AppError(ERROR_CODES.CONFLICT, 'Settle the bill and any deposit before checkout.');
    await this.invoices.finalize(q, actor, rows[0]!.id);
    await q.query(`UPDATE reservations SET status='checked_out',updated_by=$2 WHERE id=$1`, [
      id,
      actor.user.id,
    ]);
    await q.query(
      `UPDATE rooms SET housekeeping_status='dirty',updated_by=$2 WHERE property_id=$1 AND is_active`,
      [actor.user.propertyId, actor.user.id],
    );
    await this.audit.record(q, actor, {
      action: 'villa.departed',
      entityType: 'reservation',
      entityId: id,
    });
    await this.outbox.emit(q, actor.user.propertyId, 'villa.departed', { type: 'reservation', id });
    return this.detail(q, actor.user.propertyId, id);
  }
  async cancel(q: Queryable, actor: Actor, id: string, version: number) {
    const row = await this.load(q, actor.user.propertyId, id, true);
    if (row.version !== version) throw staleVersion();
    if (row.status !== 'confirmed')
      throw new AppError(
        ERROR_CODES.INVALID_TRANSITION,
        'Only bookings awaiting arrival can be cancelled.',
      );
    const { rows } = await q.query<{ paid: string; held: string }>(
      `SELECT COALESCE(sum(bill_effect),0)::numeric(14,2) AS paid,COALESCE(sum(deposit_effect),0)::numeric(14,2) AS held FROM payments WHERE property_id=$1 AND reservation_id=$2`,
      [actor.user.propertyId, id],
    );
    if (!money(rows[0]!.paid).isZero() || !money(rows[0]!.held).isZero())
      throw new AppError(ERROR_CODES.CONFLICT, 'Refund or settle the advance before cancelling.');
    if (!villaDayUse(row.use_kind))
      await this.reservations.cancel(q, actor, id, {
        reason: 'guest_request',
        note: 'Villa booking cancelled',
      });
    else
      await q.query(
        `UPDATE reservations SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancel_reason='guest_request',updated_by=$2 WHERE id=$1`,
        [id, actor.user.id],
      );
    await this.audit.record(q, actor, {
      action: 'villa.cancelled',
      entityType: 'reservation',
      entityId: id,
    });
    await this.outbox.emit(q, actor.user.propertyId, 'villa.cancelled', {
      type: 'reservation',
      id,
    });
    return this.detail(q, actor.user.propertyId, id);
  }
}

/** Shared by standard overnight check-in and the day-use arrival action. */
export async function assertVillaArrival(q: Queryable, propertyId: string, reservationId: string) {
  const { rows } = await q.query<{
    started: boolean;
    ended: boolean;
    other: boolean;
    ready: boolean;
  }>(
    `SELECT
    v.starts_at<=now() AS started,v.ends_at<=now() AS ended,
    EXISTS(SELECT 1 FROM villa_bookings o WHERE o.property_id=v.property_id AND o.id<>v.id AND (o.resource_mask & v.resource_mask)>0 AND o.allocation_status='occupied') AS other,
    (SELECT count(*) FROM rooms rm WHERE rm.property_id=v.property_id AND rm.is_active AND (rm.number=CASE WHEN v.resource_mask=2 THEN '2' ELSE '1' END OR (v.resource_mask=3 AND rm.number='2'))
      AND rm.housekeeping_status IN ('clean','inspected') AND rm.service_status='in_service')=CASE WHEN v.resource_mask=3 THEN 2 ELSE 1 END
    AND NOT EXISTS(SELECT 1 FROM room_out_of_order oo WHERE oo.property_id=v.property_id AND oo.status='active' AND oo.room_id IN (SELECT rm.id FROM rooms rm WHERE rm.property_id=v.property_id AND (rm.number=CASE WHEN v.resource_mask=2 THEN '2' ELSE '1' END OR (v.resource_mask=3 AND rm.number='2')))
      AND tstzrange(oo.start_date::timestamp AT TIME ZONE 'Asia/Kolkata',oo.end_date::timestamp AT TIME ZONE 'Asia/Kolkata','[)') && tstzrange(v.starts_at,v.ends_at,'[)')) AS ready
    FROM villa_bookings v WHERE v.id=$1 AND v.property_id=$2`,
    [reservationId, propertyId],
  );
  const r = rows[0];
  if (!r) return;
  if (!r.started || r.ended)
    throw new AppError(
      ERROR_CODES.INVALID_TRANSITION,
      'Arrival must be within the booked time. Change the booking times before an early or late arrival.',
    );
  if (r.other || !r.ready)
    throw new AppError(
      ERROR_CODES.ROOM_UNAVAILABLE,
      'The villa is still occupied or needs housekeeping/maintenance before arrival.',
    );
}
