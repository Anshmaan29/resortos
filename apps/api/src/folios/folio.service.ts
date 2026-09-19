import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  computeTax, DEFAULT_TAX_CATEGORY, DISCOUNT_REASON_LABELS, ERROR_CODES, round2, type DiscountInput, formatDate, formatINR, formatReference, money, TaxRuleError, toMoneyString,
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

type Decimal = ReturnType<typeof money>;

interface FolioRow {
  id: string; property_id: string; number: string; stay_id: string | null; reservation_id: string;
  kind: string; status: string; opened_at: Date; closed_at: Date | null; version: number;
}

interface LineRow {
  id: string; business_date: string; line_type: FolioLineType; name: string; quantity: string;
  unit_rate: string; amount: string; tax_category: string; source: string; room_id: string | null;
  note: string | null; created_at: Date; created_by_name: string;
  voided_at: Date | null; void_reason: string | null; voided_by_name: string | null;
  applies_to_line_id: string | null; discount_group_id: string | null; discount_percent: string | null;
  discount_reason: string | null;
}

export interface BillTax {
  available: boolean; message: string | null; taxTotal: string | null; roundOff: string | null;
  grandTotal: string | null; groups: { ratePercent: string; taxableValue: string; cgst: string; sgst: string; igst: string }[];
  usesPlaceholderRates: boolean;
  /** Per charge: net of its discounts, and the GST rate that net attracts. */
  lines: { lineId: string; net: string; ratePercent: string; sac: string }[];
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
    const tax = await this.billTax(q, propertyId, live);

    // Recalculated from the payment rows every time — there is no stored balance to drift (§49).
    const [payments, paidTotal, depositHeld] = await gather(q, [
      () => this.payments.forFolio(q, propertyId, folioId),
      () => this.payments.paidOnFolio(q, folioId),
      () => this.payments.depositHeld(q, folioId),
    ]);
    const paid = money(paidTotal);

    // Once invoiced, what the guest owes is what the documents say — the invoice keeps the rates it
    // was issued at even if a rule changes later — plus an estimate for anything added since, which
    // is waiting for a debit note.
    const { rows: docs } = await q.query<{ id: string; number: string; document_type: string; grand_total: string; invoice_date: string }>(
      `SELECT id, number, document_type, grand_total, invoice_date FROM invoices WHERE folio_id = $1 ORDER BY finalized_at`, [folioId],
    );
    let total: ReturnType<typeof money> | null = tax.grandTotal ? money(tax.grandTotal) : null;
    let pendingInvoice = false;
    if (docs.length) {
      const invoiced = docs.reduce((t, d) => (d.document_type === 'credit_note' ? t.minus(d.grand_total) : t.plus(d.grand_total)), money(0));
      const { rows: onInvoice } = await q.query<{ id: string }>(
        `SELECT folio_line_id AS id FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
          WHERE i.folio_id = $1 AND il.folio_line_id IS NOT NULL`, [folioId],
      );
      const invoicedIds = new Set(onInvoice.map((r) => r.id));
      const later = live.filter((l) => !invoicedIds.has(l.applies_to_line_id ?? l.id));
      pendingInvoice = later.some((l) => l.line_type !== 'discount');
      const laterTax = later.length ? await this.billTax(q, propertyId, later) : null;
      total = laterTax && !laterTax.available ? null : invoiced.plus(laterTax?.grandTotal ?? 0);
    }
    const balance = total ? total.minus(paid) : null;

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
        appliesToLineId: l.applies_to_line_id, discountGroupId: l.discount_group_id,
        discountPercent: l.discount_percent, discountReason: l.discount_reason,
        hasDiscount: live.some((d) => d.applies_to_line_id === l.id),
        net: tax.lines.find((t) => t.lineId === l.id)?.net ?? null,
        gstRate: tax.lines.find((t) => t.lineId === l.id)?.ratePercent ?? null,
      })),
      charges: toMoneyString(charges),
      tax: { ...tax, lines: undefined },
      total: total ? toMoneyString(total) : null,
      documents: docs.map((d) => ({ id: d.id, number: d.number, documentType: d.document_type, grandTotal: d.grand_total, invoiceDate: d.invoice_date })),
      // Charges added after the invoice, waiting for a debit note (§22).
      pendingInvoice,
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
    // A closed bill has been invoiced. A charge found afterwards — the minibar, a damage — is the
    // owner's to add, and goes on a debit note; the invoice itself is never touched (§22).
    if (folio.status === 'closed' && actor.user.role !== 'owner') {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This bill is closed. Only the owner can add a late charge, which goes on a debit note.');
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
      id: string; folio_id: string; business_date: string; name: string; amount: string; line_type: string;
      voided_at: Date | null; folio_status: string; discount_group_id: string | null;
    }>(
      `SELECT l.id, l.folio_id, l.business_date, l.name, l.amount, l.line_type, l.voided_at, l.discount_group_id,
              f.status AS folio_status
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
    const { rows: discounted } = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM folio_lines WHERE applies_to_line_id = $1 AND voided_at IS NULL`, [lineId],
    );
    if (discounted[0]!.n > 0) {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, `${line.name} has a discount on it. Remove the discount first, then the charge.`);
    }

    // A discount spread over several charges was given as one and is removed as one.
    const { rows: group } = line.discount_group_id
      ? await q.query<{ id: string; business_date: string; amount: string }>(
        `SELECT id, business_date, amount FROM folio_lines WHERE discount_group_id = $1 AND voided_at IS NULL FOR UPDATE`,
        [line.discount_group_id],
      )
      : { rows: [{ id: line.id, business_date: line.business_date, amount: line.amount }] };
    const total = group.reduce((t, g) => t.plus(g.amount), money(0));

    const { rows: closed } = await q.query<{ closed: boolean }>(
      `SELECT bool_or(is_business_date_closed($1, d)) AS closed FROM unnest($2::date[]) AS d`,
      [actor.user.propertyId, group.map((g) => g.business_date)],
    );
    let authorisedBy: string | null = null;
    if (closed[0]!.closed) {
      const auth = await this.ownerAuth.require(
        q, actor,
        {
          operation: 'folio.void_line',
          scope: { lineId, amount: toMoneyString(total) },
          reasons: [{
            action: 'discount_above_limit',
            description: `${line.name} for ${formatINR(toMoneyString(total))} is on ${formatDate(line.business_date)}, which night audit has closed`,
          }],
        },
        input.ownerAuthorisationId, { type: 'folio', id: line.folio_id },
      );
      authorisedBy = auth?.authorisedBy ?? null;
      if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'folio', id: line.folio_id });
    }

    await q.query(
      `UPDATE folio_lines SET voided_at = now(), voided_by = $2, void_reason = $3, void_authorised_by = $4
        WHERE id = ANY($1::uuid[])`,
      [group.map((g) => g.id), actor.user.id, input.reason, authorisedBy],
    );
    await this.audit.record(q, actor, {
      action: line.line_type === 'discount' ? 'folio.discount_removed' : 'folio.line_voided',
      entityType: 'folio', entityId: line.folio_id, reason: input.reason, authorisedBy,
      before: { lineId, name: line.name, amount: toMoneyString(total), businessDate: line.business_date, lines: group.length },
      after: { voided: true },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'folio.changed', { type: 'folio', id: line.folio_id }, { reason: 'line_voided' });
    return this.detail(q, actor.user.propertyId, line.folio_id);
  }

  /**
   * GST on a set of live bill lines (spec §30). A discount is not taxed on its own: it reduces the
   * charge it points at, and that charge is taxed on what is left — which is what lets a discount
   * move a room night across the ₹7,500 slab (§30.2).
   */
  async billTax(q: Queryable, propertyId: string, live: Pick<LineRow, 'id' | 'line_type' | 'amount' | 'tax_category' | 'business_date' | 'applies_to_line_id'>[]): Promise<BillTax> {
    const discounts = new Map<string, Decimal>();
    for (const d of live) {
      if (d.line_type === 'discount' && d.applies_to_line_id) {
        discounts.set(d.applies_to_line_id, (discounts.get(d.applies_to_line_id) ?? money(0)).plus(d.amount));
      }
    }
    const taxable: TaxableLine[] = live.filter((l) => l.line_type !== 'discount').map((l) => {
      const net = toMoneyString(money(l.amount).plus(discounts.get(l.id) ?? 0));
      return {
        key: l.id,
        taxCategory: l.tax_category as TaxableLine['taxCategory'],
        dateOfSupply: l.business_date,
        taxableValue: net,
        // Accommodation is slab-rated per room per night on the value actually charged, so the unit
        // value is this one night's value after discount, not the running total.
        ...(l.tax_category === 'accommodation' ? { unitValue: net } : {}),
      };
    });

    const { rules, placeholderIds } = await this.rates.taxRules(q, propertyId);
    try {
      const computed = computeTax(rules, taxable);
      return {
        available: true, message: null, taxTotal: computed.taxTotal, roundOff: computed.roundOff,
        grandTotal: computed.grandTotal, groups: computed.groups,
        usesPlaceholderRates: computed.lines.some((l) => placeholderIds.has(l.ruleId)),
        lines: computed.lines.map((l) => ({ lineId: l.key, net: l.taxableValue, ratePercent: l.ratePercent, sac: l.sac })),
      };
    } catch (err) {
      if (!(err instanceof TaxRuleError)) throw err;
      return {
        available: false, taxTotal: null, roundOff: null, grandTotal: null, groups: [], lines: [],
        message: 'GST cannot be worked out: tax rates are not set up for these dates.', usesPlaceholderRates: false,
      };
    }
  }

  private async liveLines(q: Queryable, folioId: string): Promise<LineRow[]> {
    const { rows } = await q.query<LineRow>(
      `SELECT l.*, '' AS created_by_name, NULL AS voided_by_name FROM folio_lines l
        WHERE l.folio_id = $1 AND l.voided_at IS NULL ORDER BY l.business_date, l.created_at`,
      [folioId],
    );
    return rows;
  }

  /**
   * Work out a discount without saving it (spec §28): how much comes off each charge, what share of
   * the bill that is, whether it needs the owner, and what it does to GST — including a room night
   * that moves into a different slab. Shown before anything is saved.
   */
  private async planDiscount(q: Queryable, actor: Actor, folioId: string, input: DiscountInput) {
    const live = await this.liveLines(q, folioId);
    const net = new Map<string, Decimal>();
    for (const l of live) if (l.line_type !== 'discount') net.set(l.id, money(l.amount));
    for (const d of live) if (d.line_type === 'discount' && d.applies_to_line_id) net.set(d.applies_to_line_id, net.get(d.applies_to_line_id)!.plus(d.amount));

    let targets = live.filter((l) => l.line_type !== 'discount' && net.get(l.id)!.gt(0));
    if (input.scope === 'line') {
      const target = live.find((l) => l.id === input.lineId);
      if (!target) throw notFound('Charge');
      if (target.line_type === 'discount') throw new AppError(ERROR_CODES.VALIDATION, 'A discount cannot be discounted.');
      if (!net.get(target.id)!.gt(0)) throw new AppError(ERROR_CODES.VALIDATION, 'This charge is already fully discounted.');
      targets = [target];
    }
    if (!targets.length) throw new AppError(ERROR_CODES.VALIDATION, 'There is nothing on this bill to discount.');

    const base = targets.reduce((t, l) => t.plus(net.get(l.id)!), money(0));
    const value = money(input.value);
    if (input.kind === 'amount' && value.gt(base)) {
      throw new AppError(ERROR_CODES.VALIDATION, `The discount cannot be more than ${formatINR(toMoneyString(base))}.`, {
        fields: [{ path: 'value', message: 'More than what is being discounted' }],
      });
    }
    // Spread across the charges in proportion to what each is worth; any paisa left over by rounding
    // goes on the largest, so the parts add up to exactly what was asked for.
    const wanted = input.kind === 'percent' ? round2(base.times(value).dividedBy(100)) : value;
    const parts = targets.map((l) => ({ line: l, amount: round2(net.get(l.id)!.times(wanted).dividedBy(base)) }));
    const drift = wanted.minus(parts.reduce((t, p) => t.plus(p.amount), money(0)));
    if (!drift.isZero()) {
      const largest = parts.reduce((a, b) => (net.get(b.line.id)!.gt(net.get(a.line.id)!) ? b : a));
      largest.amount = largest.amount.plus(drift);
    }
    const allocations = parts.filter((p) => p.amount.gt(0));
    const percent = round2(wanted.dividedBy(base).times(100));

    const after = [
      ...live,
      ...allocations.map((p) => ({
        id: `new-${p.line.id}`, line_type: 'discount' as FolioLineType, amount: toMoneyString(p.amount.negated()),
        tax_category: p.line.tax_category, business_date: p.line.business_date, applies_to_line_id: p.line.id,
      })),
    ];
    const [taxBefore, taxAfter] = [await this.billTax(q, actor.user.propertyId, live), await this.billTax(q, actor.user.propertyId, after)];
    const slabChanges = taxAfter.lines.flatMap((a) => {
      const b = taxBefore.lines.find((x) => x.lineId === a.lineId);
      const line = live.find((l) => l.id === a.lineId)!;
      return b && b.ratePercent !== a.ratePercent
        ? [{ lineId: a.lineId, name: line.name, businessDate: line.business_date, fromRate: b.ratePercent, toRate: a.ratePercent }]
        : [];
    });
    const limit = money(actor.user.discountLimitPercent);
    return {
      live, allocations, wanted, base, percent, slabChanges, taxBefore, taxAfter,
      needsOwner: actor.user.role !== 'owner' && percent.gt(limit),
      limit,
    };
  }

  async previewDiscount(q: Queryable, actor: Actor, folioId: string, input: DiscountInput) {
    await this.assertOpen(q, actor.user.propertyId, folioId);
    const plan = await this.planDiscount(q, actor, folioId, input);
    return {
      discount: toMoneyString(plan.wanted), percentOfCharges: toMoneyString(plan.percent),
      needsOwner: plan.needsOwner, yourLimitPercent: toMoneyString(plan.limit),
      parts: plan.allocations.map((p) => ({ lineId: p.line.id, name: p.line.name, amount: toMoneyString(p.amount) })),
      before: { taxTotal: plan.taxBefore.taxTotal, grandTotal: plan.taxBefore.grandTotal },
      after: { taxTotal: plan.taxAfter.taxTotal, grandTotal: plan.taxAfter.grandTotal },
      slabChanges: plan.slabChanges,
    };
  }

  private async assertOpen(q: Queryable, propertyId: string, folioId: string) {
    const { rows } = await q.query<{ status: string }>(
      `SELECT status FROM folios WHERE id = $1 AND property_id = $2 FOR UPDATE`, [folioId, propertyId],
    );
    if (!rows[0]) throw notFound('Bill');
    if (rows[0].status === 'closed') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This bill is closed. A correction needs a credit note.');
  }

  /**
   * Give a discount (spec §28). Beyond the receptionist's limit it needs Owner PIN, approved against
   * the exact amount and charges — so what the owner approved is what gets saved.
   */
  async applyDiscount(q: Queryable, actor: Actor, folioId: string, input: DiscountInput) {
    // The bill row is locked first, so two discounts given at once are planned one after the other.
    await this.assertOpen(q, actor.user.propertyId, folioId);
    const plan = await this.planDiscount(q, actor, folioId, input);

    let authorisedBy: string | null = null;
    if (plan.needsOwner) {
      const auth = await this.ownerAuth.require(
        q, actor,
        {
          operation: 'folio.discount',
          scope: { folioId, parts: plan.allocations.map((p) => [p.line.id, toMoneyString(p.amount)]), reason: input.reason },
          reasons: [{
            action: 'discount_above_limit',
            description: `Discount of ${formatINR(toMoneyString(plan.wanted))} (${toMoneyString(plan.percent)}%) is above the ${toMoneyString(plan.limit)}% limit`,
          }],
        },
        input.ownerAuthorisationId, { type: 'folio', id: folioId },
      );
      authorisedBy = auth?.authorisedBy ?? null;
      if (auth) await this.ownerAuth.recordOverrides(q, actor, auth, { type: 'folio', id: folioId });
    }

    const businessDate = await this.property.businessDate(q, actor.user.propertyId);
    const groupId = randomUUID();
    const reason = `${DISCOUNT_REASON_LABELS[input.reason]}${input.note ? ` — ${input.note}` : ''}`;
    for (const p of plan.allocations) {
      const name = input.scope === 'bill'
        ? `Discount ${input.kind === 'percent' ? `${Number(input.value)}% ` : ''}on ${p.line.name}`
        : `Discount on ${p.line.name}`;
      await q.query(
        `INSERT INTO folio_lines (property_id, folio_id, business_date, line_type, name, quantity, unit_rate, amount,
                                  tax_category, source, room_id, note, created_by, authorised_by,
                                  applies_to_line_id, discount_group_id, discount_percent, discount_reason)
         VALUES ($1,$2,$3::date,'discount',$4,1,$5,$5,$6,'manual',$7,$8,$9,$10,$11,$12,$13,$14)`,
        [actor.user.propertyId, folioId, businessDate, name.slice(0, 120), toMoneyString(p.amount.negated()),
          p.line.tax_category, p.line.room_id, input.note ?? null, actor.user.id, authorisedBy,
          p.line.id, groupId, toMoneyString(plan.percent), reason],
      );
    }

    await this.audit.record(q, actor, {
      action: 'folio.discount_given', entityType: 'folio', entityId: folioId, reason, authorisedBy,
      after: {
        groupId, scope: input.scope, kind: input.kind, value: input.value, total: toMoneyString(plan.wanted),
        percent: toMoneyString(plan.percent), parts: plan.allocations.length, slabChanges: plan.slabChanges.length,
      },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'folio.changed', { type: 'folio', id: folioId }, { reason: 'discount_given' });
    return this.detail(q, actor.user.propertyId, folioId);
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
