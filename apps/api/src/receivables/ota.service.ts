import { Injectable } from '@nestjs/common';
import { ERROR_CODES, formatReference, money, OTA_SOURCES, BOOKING_SOURCE_LABELS, toMoneyString, type OtaBookingInput, type OtaPayoutInput } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';

interface TermsRow {
  reservation_id: string; payment_mode: string; gross_amount: string; commission_amount: string; tax_withheld: string;
  expected_payout: string; note: string | null; version: number;
}

const mapTerms = (r: TermsRow) => ({
  reservationId: r.reservation_id, paymentMode: r.payment_mode, grossAmount: r.gross_amount, commissionAmount: r.commission_amount,
  taxWithheld: r.tax_withheld, expectedPayout: r.expected_payout, note: r.note, version: r.version,
});

/**
 * OTA bookings (spec §33): the commission and payout side. ResortOS does not connect to any OTA; it
 * records what the OTA sold, what it keeps, and what actually arrived in the bank.
 */
@Injectable()
export class OtaService {
  constructor(
    private readonly db: DbService,
    private readonly property: PropertyService,
    private readonly audit: AuditService,
  ) {}

  async terms(propertyId: string, reservationId: string) {
    const { rows } = await this.db.query<TermsRow & { received: string }>(
      `SELECT o.*, COALESCE((SELECT sum(cash_effect) FROM ota_payouts p WHERE p.reservation_id = o.reservation_id), 0)::numeric(14,2) AS received
         FROM ota_bookings o WHERE o.reservation_id = $1 AND o.property_id = $2`,
      [reservationId, propertyId],
    );
    return rows[0] ? { ...mapTerms(rows[0]), received: rows[0].received } : null;
  }

  async saveTerms(q: Queryable, actor: Actor, reservationId: string, input: OtaBookingInput) {
    const { rows: res } = await q.query<{ source: string }>(
      `SELECT source FROM reservations WHERE id = $1 AND property_id = $2`, [reservationId, actor.user.propertyId],
    );
    if (!res[0]) throw notFound('Booking');
    if (!OTA_SOURCES.includes(res[0].source as never)) throw new AppError(ERROR_CODES.VALIDATION, 'Only a booking from an OTA has OTA terms.');
    const { rows: before } = await q.query<TermsRow>(`SELECT * FROM ota_bookings WHERE reservation_id = $1 FOR UPDATE`, [reservationId]);
    let saved: TermsRow;
    if (!before[0]) {
      const { rows } = await q.query<TermsRow>(
        `INSERT INTO ota_bookings (reservation_id, property_id, payment_mode, gross_amount, commission_amount, tax_withheld, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [reservationId, actor.user.propertyId, input.paymentMode, input.grossAmount, input.commissionAmount, input.taxWithheld, input.note ?? null, actor.user.id],
      );
      saved = rows[0]!;
    } else {
      const { rows } = await q.query<TermsRow>(
        `UPDATE ota_bookings SET payment_mode=$3, gross_amount=$4, commission_amount=$5, tax_withheld=$6, note=$7, updated_by=$8
          WHERE reservation_id=$1 AND version=$2 RETURNING *`,
        [reservationId, input.version ?? before[0].version, input.paymentMode, input.grossAmount, input.commissionAmount, input.taxWithheld, input.note ?? null, actor.user.id],
      );
      if (!rows[0]) throw staleVersion();
      saved = rows[0];
    }
    await this.audit.record(q, actor, {
      action: 'ota.terms_saved', entityType: 'reservation', entityId: reservationId,
      before: before[0] ? mapTerms(before[0]) : null, after: mapTerms(saved),
    });
    return mapTerms(saved);
  }

  /** An OTA payout into the bank (§33). Owner only: it is the resort's bank statement. */
  async recordPayout(q: Queryable, actor: Actor, reservationId: string, input: OtaPayoutInput) {
    const propertyId = actor.user.propertyId;
    const { rows: terms } = await q.query<{ reservation_id: string }>(
      `SELECT reservation_id FROM ota_bookings WHERE reservation_id = $1 AND property_id = $2 FOR UPDATE`, [reservationId, propertyId],
    );
    if (!terms[0]) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Enter the OTA terms for this booking before recording its payout.');
    const { rows: account } = await q.query<{ kind: string }>(
      `SELECT kind FROM payment_accounts WHERE id = $1 AND property_id = $2 AND is_active`, [input.paymentAccountId, propertyId],
    );
    if (!account[0]) throw notFound('Payment account');
    if (!['bank', 'other'].includes(account[0].kind)) throw new AppError(ERROR_CODES.VALIDATION, 'An OTA pays out into a bank account.');
    const businessDate = await this.property.businessDate(q, propertyId);
    const { rows: n } = await q.query<{ next_reference: string }>(`SELECT next_reference($1, 'ota_payout')`, [propertyId]);
    const number = formatReference('OP', Number(n[0]!.next_reference));
    await q.query(
      `INSERT INTO ota_payouts (property_id, number, reservation_id, payment_account_id, account_kind, amount, reference, business_date, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9)`,
      [propertyId, number, reservationId, input.paymentAccountId, account[0].kind, input.amount, input.reference, businessDate, actor.user.id],
    );
    await this.audit.record(q, actor, {
      action: 'ota.payout_recorded', entityType: 'reservation', entityId: reservationId,
      after: { number, amount: input.amount, reference: input.reference },
    });
    return this.terms(propertyId, reservationId).then((t) => ({ number, terms: t }));
  }

  async reversePayout(q: Queryable, actor: Actor, payoutId: string, reason: string) {
    const propertyId = actor.user.propertyId;
    const { rows } = await q.query<{ id: string; number: string; reservation_id: string; payment_account_id: string; account_kind: string; amount: string; reverses_payout_id: string | null; reversed: boolean }>(
      `SELECT p.*, EXISTS (SELECT 1 FROM ota_payouts x WHERE x.reverses_payout_id = p.id) AS reversed
         FROM ota_payouts p WHERE p.id = $1 AND p.property_id = $2`,
      [payoutId, propertyId],
    );
    const o = rows[0];
    if (!o) throw notFound('Payout');
    if (o.reversed || o.reverses_payout_id) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This payout cannot be reversed again.');
    const businessDate = await this.property.businessDate(q, propertyId);
    const { rows: n } = await q.query<{ next_reference: string }>(`SELECT next_reference($1, 'ota_payout')`, [propertyId]);
    const number = formatReference('OP', Number(n[0]!.next_reference));
    await q.query(
      `INSERT INTO ota_payouts (property_id, number, reservation_id, payment_account_id, account_kind, amount, reference, business_date,
                                received_by, reverses_payout_id, reversal_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11)`,
      [propertyId, number, o.reservation_id, o.payment_account_id, o.account_kind, o.amount, `Reverses ${o.number}`, businessDate, actor.user.id, payoutId, reason],
    );
    await this.audit.record(q, actor, {
      action: 'ota.payout_reversed', entityType: 'reservation', entityId: o.reservation_id, reason,
      before: { number: o.number, amount: o.amount }, after: { reversalNumber: number },
    });
    return { number };
  }

  /**
   * OTA receivables (§33): booked, expected, received, pending and the difference, per booking.
   * A booking whose terms have not been entered still appears, so nothing is missed.
   */
  async receivables(propertyId: string, range: { from?: string; to?: string }) {
    const { rows } = await this.db.query<{
      reservation_id: string; number: string; source: string; ota_reference: string; arrival: string; departure: string; status: string;
      guest_name: string; payment_mode: string | null; gross_amount: string | null; commission_amount: string | null; tax_withheld: string | null;
      expected_payout: string | null; received: string;
    }>(
      `SELECT r.id AS reservation_id, r.number, r.source, r.ota_reference, r.arrival, r.departure, r.status,
              trim(g.first_name || ' ' || g.last_name) AS guest_name,
              o.payment_mode, o.gross_amount, o.commission_amount, o.tax_withheld, o.expected_payout,
              COALESCE((SELECT sum(cash_effect) FROM ota_payouts p WHERE p.reservation_id = r.id), 0)::numeric(14,2) AS received
         FROM reservations r
         JOIN guests g ON g.id = r.primary_guest_id
         LEFT JOIN ota_bookings o ON o.reservation_id = r.id
        WHERE r.property_id = $1 AND r.source IN ('makemytrip', 'goibibo', 'booking_com', 'agoda', 'airbnb')
          AND r.status NOT IN ('cancelled')
          AND ($2::date IS NULL OR r.arrival >= $2::date)
          AND ($3::date IS NULL OR r.arrival <= $3::date)
        ORDER BY r.arrival, r.number`,
      [propertyId, range.from ?? null, range.to ?? null],
    );
    const items = rows.map((r) => {
      const expected = r.expected_payout ? money(r.expected_payout) : null;
      const received = money(r.received);
      return {
        reservationId: r.reservation_id, number: r.number, source: r.source, otaReference: r.ota_reference, arrival: r.arrival,
        departure: r.departure, status: r.status, guestName: r.guest_name, paymentMode: r.payment_mode,
        grossAmount: r.gross_amount, commissionAmount: r.commission_amount, taxWithheld: r.tax_withheld,
        expectedPayout: r.expected_payout, received: toMoneyString(received),
        pending: expected ? toMoneyString(expected.minus(received).isNegative() ? money(0) : expected.minus(received)) : null,
        difference: expected && received.gt(0) ? toMoneyString(received.minus(expected)) : null,
        termsMissing: r.payment_mode === null,
      };
    });
    const total = (key: 'grossAmount' | 'expectedPayout' | 'received' | 'pending') =>
      toMoneyString(items.reduce((t, i) => t.plus(i[key] ?? 0), money(0)));
    return { items, totals: { booked: total('grossAmount'), expected: total('expectedPayout'), received: total('received'), pending: total('pending') } };
  }

  /**
   * "Availability changed today" (§33): without a channel manager the desk updates OTA extranets
   * by hand, and this is the list of what to update. Built from the inventory events every booking,
   * cancellation, extension and out-of-order already writes to the outbox — nothing new to forget.
   */
  async availabilityChangedToday(propertyId: string) {
    const { rows } = await this.db.query<{ id: string; created_at: Date; aggregate_type: string; aggregate_id: string | null; payload: { from?: string; to?: string }; label: string | null; source: keyof typeof BOOKING_SOURCE_LABELS | null }>(
      `SELECT e.id, e.created_at, e.aggregate_type, e.aggregate_id, e.payload,
              (SELECT r.source FROM reservations r WHERE e.aggregate_type='reservation' AND r.id=e.aggregate_id) AS source,
              COALESCE(
                (SELECT r.number FROM reservations r WHERE e.aggregate_type = 'reservation' AND r.id = e.aggregate_id),
                (SELECT 'Room ' || rm.number FROM rooms rm WHERE e.aggregate_type = 'room' AND rm.id = e.aggregate_id),
                (SELECT 'Room ' || rm.number || ' stay' FROM stays s JOIN rooms rm ON rm.id = s.room_id WHERE e.aggregate_type = 'stay' AND s.id = e.aggregate_id)
              ) AS label
         FROM outbox_events e JOIN properties p ON p.id = e.property_id
        WHERE e.property_id = $1 AND e.topic = 'inventory.changed'
          AND e.payload->>'from' IS NOT NULL AND e.payload->>'to' IS NOT NULL
          AND e.created_at >= (date_trunc('day', now() AT TIME ZONE p.timezone) AT TIME ZONE p.timezone)
        ORDER BY e.created_at DESC LIMIT 200`,
      [propertyId],
    );
    return rows.map((r) => ({ id: r.id, at: r.created_at, what: r.source ? `${r.label ?? r.aggregate_type} · ${BOOKING_SOURCE_LABELS[r.source]}` : r.label ?? r.aggregate_type, from: r.payload.from ?? null, to: r.payload.to ?? null }));
  }
}
