import { Injectable } from '@nestjs/common';
import {
  computeTax, DEFAULT_TAX_CATEGORY, ERROR_CODES, formatDate, formatINR, formatReference, money, TaxRuleError, toMoneyString,
  type AddChargeInput, type ChargeItemInput, type FolioLineType, type TaxableLine, type VoidLineInput,
} from '@resortos/shared';
import { OwnerAuthorisationService } from '../auth/owner-authorisation.service';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, gather, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';
import { RatesService } from '../rates/rates.service';
import { PaymentsService } from './payments.service';

interface FolioRow {
  id: string; property_id: string; number: string; stay_id: string | null; reservation_id: string;
  kind: string; status: string; opened_at: Date; closed_at: Date | null; version: number;
}

interface LineRow {
  id: string; business_date: string; line_type: FolioLineType; name: string; quantity: string;
  unit_rate: string; amount: string; tax_category: string; source: string; room_id: string | null;
  note: string | null; created_at: Date; created_by_name: string;
  voided_at: Date | null; void_reason: string | null; voided_by_name: string | null;
}

interface ChargeItemRow {
  id: string; name: string; line_type: string; default_rate: string; tax_category: string;
  is_active: boolean; sort_order: number; version: number;
}

const mapItem = (r: ChargeItemRow) => ({
  id: r.id, name: r.name, lineType: r.line_type, defaultRate: r.default_rate,
  taxCategory: r.tax_category, isActive: r.is_active, sortOrder: r.sort_order, version: r.version,
});

@Injectable()
export class FolioService {
  constructor(
    private readonly db: DbService,
    private readonly property: PropertyService,
    private readonly rates: RatesService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly ownerAuth: OwnerAuthorisationService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * The bill for a stay, created if it does not exist yet.
   *
   * Created on demand rather than only at check-in, so that stays made before this milestone — and
   * any made by a path that forgets — still have somewhere for their charges to go. The unique
   * constraint on `stay_id` is what makes "create if missing" safe under concurrency: two requests
   * racing to open the same bill cannot both win.
   */
  async ensureForStay(q: Queryable, actor: Actor, stayId: string): Promise<FolioRow> {
    const { rows: existing } = await q.query<FolioRow>(
      `SELECT * FROM folios WHERE stay_id = $1 AND property_id = $2`, [stayId, actor.user.propertyId],
    );
    if (existing[0]) return existing[0];

    // Serialise on the stay, then look again. Without the lock two first looks both find no bill,
    // both insert, and the loser is refused by `folios_one_per_stay` — correct, but a 409 on what is
    // only a read to the person at the desk. NO KEY UPDATE, so it does not block the foreign-key
    // share lock that inserting the bill itself takes.
    const { rows: stay } = await q.query<{ reservation_id: string }>(
      `SELECT reservation_id FROM stays WHERE id = $1 AND property_id = $2 FOR NO KEY UPDATE`, [stayId, actor.user.propertyId],
    );
    if (!stay[0]) throw notFound('Stay');
    const { rows: again } = await q.query<FolioRow>(`SELECT * FROM folios WHERE stay_id = $1`, [stayId]);
    if (again[0]) return again[0];

    const { rows: n } = await q.query<{ next_reference: string }>(
      `SELECT next_reference($1, 'folio')`, [actor.user.propertyId],
    );
    const { rows } = await q.query<FolioRow>(
      `INSERT INTO folios (property_id, number, stay_id, reservation_id, kind, opened_by)
       VALUES ($1, $2, $3, $4, 'stay', $5) RETURNING *`,
      [actor.user.propertyId, formatReference('F', Number(n[0]!.next_reference)), stayId, stay[0].reservation_id, actor.user.id],
    );
    return rows[0]!;
  }

  private async load(q: Queryable, propertyId: string, folioId: string): Promise<FolioRow> {
    const { rows } = await q.query<FolioRow>(`SELECT * FROM folios WHERE id = $1 AND property_id = $2`, [folioId, propertyId]);
    if (!rows[0]) throw notFound('Bill');
    return rows[0];
  }

  /**
   * The bill as staff and the guest see it: every line including the voided ones, with GST computed
   * from the dated rules.
   *
   * **No total is stored.** Charges, tax and balance are all derived here, every time, so there is
   * no cached number to disagree with the lines (spec §49). The nightly integrity check in 2.4b
   * compares and reports; it never repairs.
   */
  async detail(q: Queryable, propertyId: string, folioId: string) {
    const folio = await this.load(q, propertyId, folioId);
    const [lineRows, businessDate, guest] = await gather(q, [
      () => q.query<LineRow>(
        `SELECT l.*, u.full_name AS created_by_name, v.full_name AS voided_by_name
           FROM folio_lines l
           JOIN users u ON u.id = l.created_by
           LEFT JOIN users v ON v.id = l.voided_by
          WHERE l.folio_id = $1
          ORDER BY l.business_date, l.created_at`,
        [folioId],
      ),
      () => this.property.businessDate(q, propertyId),
      () => q.query<{ guest_name: string; room_number: string | null; reservation_number: string }>(
        `SELECT trim(g.first_name || ' ' || g.last_name) AS guest_name, rm.number AS room_number, r.number AS reservation_number
           FROM folios f
           JOIN reservations r ON r.id = f.reservation_id
           JOIN guests g ON g.id = r.primary_guest_id
           LEFT JOIN stays s ON s.id = f.stay_id
           LEFT JOIN rooms rm ON rm.id = s.room_id
          WHERE f.id = $1`,
        [folioId],
      ),
    ]);

    const live = lineRows.rows.filter((l) => !l.voided_at);
    const charges = live.reduce((total, l) => total.plus(l.amount), money(0));

    // Tax is an estimate until the invoice is finalised (2.6), and is never written to a line:
    // storing it would be a second place for it to be wrong when a dated rule changes.
    const taxable: TaxableLine[] = live.map((l) => ({
      key: l.id,
      taxCategory: l.tax_category as TaxableLine['taxCategory'],
      dateOfSupply: l.business_date,
      taxableValue: l.amount,
      // Accommodation is slab-rated per room per night, so the unit value is this one night's
      // value, not the running total.
      ...(l.tax_category === 'accommodation' ? { unitValue: l.amount } : {}),
    }));

    const { rules, placeholderIds } = await this.rates.taxRules(q, propertyId);
    let tax: { taxTotal: string | null; grandTotal: string | null; roundOff: string | null; groups: unknown[]; available: boolean; message: string | null; usesPlaceholderRates: boolean };
    try {
      const computed = computeTax(rules, taxable);
      tax = {
        available: true, message: null, taxTotal: computed.taxTotal, roundOff: computed.roundOff,
        grandTotal: computed.grandTotal, groups: computed.groups,
        usesPlaceholderRates: computed.lines.some((l) => placeholderIds.has(l.ruleId)),
      };
    } catch (err) {
      if (!(err instanceof TaxRuleError)) throw err;
      tax = {
        available: false, taxTotal: null, roundOff: null, grandTotal: null, groups: [],
        message: 'GST cannot be worked out: tax rates are not set up for these dates.', usesPlaceholderRates: false,
      };
    }

    // Recalculated from the payment rows every time — there is no stored balance to drift (§49).
    const [payments, paidTotal, depositHeld] = await gather(q, [
      () => this.payments.forFolio(q, propertyId, folioId),
      () => this.payments.paidOnFolio(q, folioId),
      () => this.payments.depositHeld(q, folioId),
    ]);
    const paid = money(paidTotal);
    const balance = tax.grandTotal ? money(tax.grandTotal).minus(paid) : null;

    return {
      id: folio.id, number: folio.number, stayId: folio.stay_id, reservationId: folio.reservation_id,
      status: folio.status, kind: folio.kind, version: folio.version, businessDate,
      guestName: guest.rows[0]?.guest_name ?? '', roomNumber: guest.rows[0]?.room_number ?? null,
      reservationNumber: guest.rows[0]?.reservation_number ?? '',
      lines: lineRows.rows.map((l) => ({
        id: l.id, businessDate: l.business_date, lineType: l.line_type, name: l.name,
        quantity: Number(l.quantity), unitRate: l.unit_rate, amount: l.amount,
        taxCategory: l.tax_category, source: l.source, note: l.note,
        at: l.created_at, by: l.created_by_name,
        voided: Boolean(l.voided_at), voidedAt: l.voided_at, voidReason: l.void_reason, voidedBy: l.voided_by_name,
      })),
      charges: toMoneyString(charges),
      tax,
      payments,
      paid: toMoneyString(paid),
      // Held for the guest, not income and not part of "paid" (§27).
      depositHeld: toMoneyString(depositHeld),
      balance: balance ? toMoneyString(balance) : null,
    };
  }

  /** The bill for a stay, opening it if this is the first time anyone looked. */
  async forStay(actor: Actor, stayId: string) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const folio = await this.ensureForStay(q, actor, stayId);
      return this.detail(q, actor.user.propertyId, folio.id);
    });
  }

  /**
   * Add a charge (spec §24.1). The name is stored exactly as typed, because that is what appears on
   * the invoice — a saved item only fills the form in, it is not a foreign key the invoice reads.
   */
  async addCharge(q: Queryable, actor: Actor, folioId: string, input: AddChargeInput) {
    const folio = await this.load(q, actor.user.propertyId, folioId);
    if (folio.status === 'closed') {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This bill is closed. Charges cannot be added to it.');
    }
    const businessDate = await this.property.businessDate(q, actor.user.propertyId);
    const on = input.businessDate ?? businessDate;
    if (on > businessDate) {
      throw new AppError(ERROR_CODES.VALIDATION, `${formatDate(on)} has not happened yet.`, {
        fields: [{ path: 'businessDate', message: 'Cannot be in the future' }],
      });
    }
    // A closed day has been summarised and reported; a new charge belongs on today's date instead.
    const { rows: closed } = await q.query<{ closed: boolean }>(
      `SELECT is_business_date_closed($1, $2::date) AS closed`, [actor.user.propertyId, on],
    );
    if (closed[0]!.closed) {
      throw new AppError(
        ERROR_CODES.INVALID_TRANSITION,
        `Night audit has closed ${formatDate(on)}. Add this charge on ${formatDate(businessDate)} instead.`,
        { fields: [{ path: 'businessDate', message: 'That day is closed' }] },
      );
    }

    let taxCategory: string = DEFAULT_TAX_CATEGORY[input.lineType];
    if (input.chargeItemId) {
      const { rows } = await q.query<{ tax_category: string }>(
        `SELECT tax_category FROM charge_items WHERE id = $1 AND property_id = $2 AND is_active`,
        [input.chargeItemId, actor.user.propertyId],
      );
      if (!rows[0]) throw notFound('Charge item');
      taxCategory = rows[0].tax_category;
    }

    const amount = money(input.unitRate).times(input.quantity);
    const { rows: roomRows } = await q.query<{ room_id: string | null }>(
      `SELECT s.room_id FROM folios f LEFT JOIN stays s ON s.id = f.stay_id WHERE f.id = $1`, [folioId],
    );
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO folio_lines (property_id, folio_id, business_date, line_type, name, quantity, unit_rate, amount,
                                tax_category, source, room_id, charge_item_id, note, created_by)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,'manual',$10,$11,$12,$13) RETURNING id`,
      [actor.user.propertyId, folioId, on, input.lineType, input.name.trim(), input.quantity, input.unitRate,
        toMoneyString(amount), taxCategory, roomRows[0]?.room_id ?? null, input.chargeItemId ?? null,
        input.note ?? null, actor.user.id],
    );

    await this.audit.record(q, actor, {
      action: 'folio.charge_added', entityType: 'folio', entityId: folioId,
      after: { lineId: rows[0]!.id, name: input.name.trim(), lineType: input.lineType, quantity: input.quantity, amount: toMoneyString(amount), businessDate: on },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'folio.changed', { type: 'folio', id: folioId }, { reason: 'charge_added' });
    return this.detail(q, actor.user.propertyId, folioId);
  }

  /**
   * Void a line (spec §23, §4.5). Nothing is edited and nothing is deleted: the line stays on the
   * bill, struck through, with the reason and who did it.
   *
   * A receptionist may void a line on a business date night audit has not closed. Once the day has
   * been summarised and reported, only the owner can — which is the same rule as the old software's
   * "after day audit, owner only", and the reason 2.1 shipped `is_business_date_closed()`.
   */
  async voidLine(q: Queryable, actor: Actor, lineId: string, input: VoidLineInput) {
    const { rows } = await q.query<{
      id: string; folio_id: string; business_date: string; name: string; amount: string;
      voided_at: Date | null; folio_status: string;
    }>(
      `SELECT l.id, l.folio_id, l.business_date, l.name, l.amount, l.voided_at, f.status AS folio_status
         FROM folio_lines l JOIN folios f ON f.id = l.folio_id
        WHERE l.id = $1 AND l.property_id = $2 FOR UPDATE OF l`,
      [lineId, actor.user.propertyId],
    );
    const line = rows[0];
    if (!line) throw notFound('Bill line');
    if (line.voided_at) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This line has already been removed.');
    if (line.folio_status === 'closed') {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This bill is closed. A correction needs a credit note.');
    }

    const { rows: closed } = await q.query<{ closed: boolean }>(
      `SELECT is_business_date_closed($1, $2::date) AS closed`, [actor.user.propertyId, line.business_date],
    );
    let authorisedBy: string | null = null;
    if (closed[0]!.closed) {
      const auth = await this.ownerAuth.require(
        q, actor,
        {
          operation: 'folio.void_line',
          scope: { lineId, amount: line.amount },
          reasons: [{
            action: 'discount_above_limit',
            description: `${line.name} for ${formatINR(line.amount)} is on ${formatDate(line.business_date)}, which night audit has closed`,
          }],
        },
        input.ownerAuthorisationId, { type: 'folio', id: line.folio_id },
      );
      authorisedBy = auth?.authorisedBy ?? null;
      if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'folio', id: line.folio_id });
    }

    await q.query(
      `UPDATE folio_lines SET voided_at = now(), voided_by = $2, void_reason = $3, authorised_by = $4 WHERE id = $1`,
      [lineId, actor.user.id, input.reason, authorisedBy],
    );
    await this.audit.record(q, actor, {
      action: 'folio.line_voided', entityType: 'folio', entityId: line.folio_id, reason: input.reason, authorisedBy,
      before: { lineId, name: line.name, amount: line.amount, businessDate: line.business_date },
      after: { voided: true },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'folio.changed', { type: 'folio', id: line.folio_id }, { reason: 'line_voided' });
    return this.detail(q, actor.user.propertyId, line.folio_id);
  }

  // ---------------- saved charge items (spec §24.2) ----------------

  async listChargeItems(propertyId: string, includeInactive = false) {
    const { rows } = await this.db.query<ChargeItemRow>(
      `SELECT * FROM charge_items WHERE property_id = $1 AND ($2 OR is_active) ORDER BY sort_order, name`,
      [propertyId, includeInactive],
    );
    return rows.map(mapItem);
  }

  async createChargeItem(q: Queryable, actor: Actor, input: ChargeItemInput) {
    const { rows } = await q.query<ChargeItemRow>(
      `INSERT INTO charge_items (property_id, name, line_type, default_rate, tax_category, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [actor.user.propertyId, input.name.trim(), input.lineType, input.defaultRate,
        input.taxCategory ?? DEFAULT_TAX_CATEGORY[input.lineType], input.sortOrder, actor.user.id],
    );
    const created = mapItem(rows[0]!);
    await this.audit.record(q, actor, { action: 'charge_item.created', entityType: 'charge_item', entityId: created.id, after: created });
    return created;
  }

  async updateChargeItem(q: Queryable, actor: Actor, id: string, input: ChargeItemInput, expectedVersion: number) {
    const { rows: before } = await q.query<ChargeItemRow>(
      `SELECT * FROM charge_items WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId],
    );
    if (!before[0]) throw notFound('Charge item');
    const { rows } = await q.query<ChargeItemRow>(
      `UPDATE charge_items SET name=$4, line_type=$5, default_rate=$6, tax_category=$7, sort_order=$8,
              is_active = COALESCE($9, is_active), updated_by=$10
        WHERE id=$1 AND property_id=$2 AND version=$3 RETURNING *`,
      [id, actor.user.propertyId, expectedVersion, input.name.trim(), input.lineType, input.defaultRate,
        input.taxCategory ?? DEFAULT_TAX_CATEGORY[input.lineType], input.sortOrder, input.isActive ?? null, actor.user.id],
    );
    if (!rows[0]) throw staleVersion();
    const after = mapItem(rows[0]);
    await this.audit.record(q, actor, { action: 'charge_item.updated', entityType: 'charge_item', entityId: id, before: mapItem(before[0]), after });
    return after;
  }
}
