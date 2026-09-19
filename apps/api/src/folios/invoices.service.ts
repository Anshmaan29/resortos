import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES, financialYearLabel, formatDocumentNumber, formatINR, money, round2, roundRupee, sum,
  toMoneyString, type CreditNoteInput, type DocumentSeries, type InvoiceBuyerInput,
} from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, gather, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';
import type { FolioLineType } from '@resortos/shared';
import { FolioService } from './folio.service';

type DocumentType = 'tax_invoice' | 'bill_of_supply' | 'credit_note' | 'debit_note';

interface LiveLine {
  id: string; business_date: string; line_type: FolioLineType; name: string; quantity: string; unit_rate: string;
  amount: string; tax_category: string; applies_to_line_id: string | null; room_number: string | null;
}

interface Parties {
  seller: { legalName: string; address: string; gstin: string | null; stateCode: string };
  buyer: { name: string; gstin: string | null; address: string | null; stateCode: string | null; mobile: string | null };
  stay: { from: string | null; to: string | null; rooms: string | null; reservationNumber: string | null };
  registered: boolean;
}

interface InvoiceRow {
  id: string; folio_id: string; document_type: DocumentType; series: DocumentSeries; number: string; invoice_date: string;
  original_invoice_id: string | null; original_number: string | null; reason: string | null;
  seller_legal_name: string; seller_address: string; seller_gstin: string | null; seller_state_code: string;
  buyer_name: string; buyer_gstin: string | null; buyer_address: string | null; buyer_state_code: string | null; buyer_mobile: string | null;
  place_of_supply: string; supply_type: string; stay_from: string | null; stay_to: string | null; room_numbers: string | null;
  reservation_number: string | null;
  taxable_total: string; cgst_total: string; sgst_total: string; igst_total: string; round_off: string; grand_total: string;
  paid_at_issue: string; finalized_at: Date; finalized_by_name: string; authorised_by: string | null;
}

export interface InvoiceDraftLine {
  folioLineId: string | null; creditsLineId: string | null; businessDate: string; description: string; sac: string;
  quantity: string; rate: string; gross: string; discount: string; taxable: string; gstRate: string;
}

/**
 * GST invoices (spec §29–§31). An invoice is written once, whole, at the moment it is final — the
 * draft is the bill itself, and `preview` computes exactly what `finalize` would write. The number
 * comes from `document_counters` inside the same transaction, so a rollback releases it and the
 * series never skips (§31).
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: DbService,
    private readonly property: PropertyService,
    private readonly folios: FolioService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Live bill lines not yet on an invoice or debit note, with the room they were for. */
  private async uninvoiced(q: Queryable, folioId: string): Promise<LiveLine[]> {
    const { rows } = await q.query<LiveLine>(
      `SELECT l.id, l.business_date, l.line_type, l.name, l.quantity, l.unit_rate, l.amount, l.tax_category,
              l.applies_to_line_id, rm.number AS room_number
         FROM folio_lines l
         LEFT JOIN rooms rm ON rm.id = l.room_id
        WHERE l.folio_id = $1 AND l.voided_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM invoice_lines il
             WHERE il.series IN ('INV', 'BOS', 'DN')
               AND il.folio_line_id = COALESCE(l.applies_to_line_id, l.id)
          )
        ORDER BY l.business_date, l.created_at`,
      [folioId],
    );
    return rows;
  }

  /**
   * What an invoice for these lines says: one row per charge, net of its discounts, at the GST rate
   * that net attracts on its date of supply. A property without a GSTIN issues a bill of supply,
   * which carries no tax (§29.1).
   */
  private async compose(q: Queryable, propertyId: string, lines: LiveLine[], registered: boolean) {
    const tax = await this.folios.billTax(q, propertyId, lines);
    if (!tax.available) throw new AppError(ERROR_CODES.CONFLICT, tax.message ?? 'GST cannot be worked out for this bill.');
    const discounts = new Map<string, ReturnType<typeof money>>();
    for (const d of lines) {
      if (d.line_type === 'discount' && d.applies_to_line_id) {
        discounts.set(d.applies_to_line_id, (discounts.get(d.applies_to_line_id) ?? money(0)).plus(money(d.amount).negated()));
      }
    }
    const draft: InvoiceDraftLine[] = lines.filter((l) => l.line_type !== 'discount').map((l) => {
      const t = tax.lines.find((x) => x.lineId === l.id)!;
      const discount = discounts.get(l.id) ?? money(0);
      return {
        folioLineId: l.id, creditsLineId: null, businessDate: l.business_date,
        description: `${l.name}${l.room_number && l.line_type === 'room_night' ? ` · Room ${l.room_number}` : ''}`,
        sac: t.sac, quantity: l.quantity, rate: l.unit_rate, gross: toMoneyString(l.amount),
        discount: toMoneyString(discount), taxable: t.net, gstRate: registered ? t.ratePercent : '0.00',
      };
    });
    return this.totals(draft);
  }

  /** Tax groups and totals from invoice lines, rounded the way §30.5 says. */
  private totals(lines: InvoiceDraftLine[]) {
    const byRate = new Map<string, InvoiceDraftLine[]>();
    for (const l of lines) byRate.set(l.gstRate, [...(byRate.get(l.gstRate) ?? []), l]);
    const groups = [...byRate.entries()]
      .sort(([a], [b]) => money(a).comparedTo(money(b)))
      .map(([rate, group]) => {
        const taxable = round2(sum(group.map((l) => l.taxable)));
        const half = round2(taxable.times(rate).dividedBy(200));
        return { ratePercent: rate, taxableValue: toMoneyString(taxable), cgst: toMoneyString(half), sgst: toMoneyString(half), igst: '0.00' };
      });
    const taxable = sum(groups.map((g) => g.taxableValue));
    const cgst = sum(groups.map((g) => g.cgst));
    const sgst = sum(groups.map((g) => g.sgst));
    const gross = taxable.plus(cgst).plus(sgst);
    const grand = roundRupee(gross);
    return {
      lines, groups,
      taxableTotal: toMoneyString(taxable), cgstTotal: toMoneyString(cgst), sgstTotal: toMoneyString(sgst), igstTotal: '0.00',
      roundOff: toMoneyString(grand.minus(gross)), grandTotal: toMoneyString(grand),
    };
  }

  /** The seller, the buyer and the stay, as the invoice will print them. */
  private async parties(q: Queryable, propertyId: string, folioId: string, buyer?: InvoiceBuyerInput): Promise<Parties> {
    const [prop, stay] = await gather(q, [
      () => q.query<{ legal_name: string; address_line1: string; address_line2: string | null; city: string; state_code: string; pin_code: string; gstin: string | null }>(
        `SELECT legal_name, address_line1, address_line2, city, state_code, pin_code, gstin FROM properties WHERE id = $1`, [propertyId],
      ),
      () => q.query<{ guest_name: string; mobile: string; address: string | null; company_name: string | null; company_gstin: string | null;
        stay_from: string | null; stay_to: string | null; room_number: string | null; reservation_number: string }>(
        `SELECT trim(g.first_name || ' ' || g.last_name) AS guest_name, g.mobile,
                NULLIF(concat_ws(', ', g.address_line, g.city, g.state, g.pin_code), '') AS address,
                g.company_name, g.company_gstin,
                s.business_date_in AS stay_from, COALESCE(s.business_date_out, s.expected_departure) AS stay_to,
                rm.number AS room_number, r.number AS reservation_number
           FROM folios f
           JOIN reservations r ON r.id = f.reservation_id
           JOIN guests g ON g.id = r.primary_guest_id
           LEFT JOIN stays s ON s.id = f.stay_id
           LEFT JOIN rooms rm ON rm.id = s.room_id
          WHERE f.id = $1`,
        [folioId],
      ),
    ]);
    const p = prop.rows[0]!;
    const s = stay.rows[0]!;
    const gstin = buyer?.gstin ?? null;
    return {
      seller: {
        legalName: p.legal_name,
        address: [p.address_line1, p.address_line2, `${p.city} ${p.pin_code}`].filter(Boolean).join(', '),
        gstin: p.gstin, stateCode: p.state_code,
      },
      buyer: {
        name: buyer?.name ?? s.guest_name,
        gstin,
        address: buyer?.address ?? s.address,
        // A registered buyer's state is the first two digits of their GSTIN.
        stateCode: gstin ? gstin.slice(0, 2) : null,
        mobile: s.mobile,
      },
      stay: { from: s.stay_from, to: s.stay_to, rooms: s.room_number, reservationNumber: s.reservation_number },
      registered: Boolean(p.gstin),
    };
  }

  /** Exactly what `finalize` would write, without a number. The desk reviews this at checkout. */
  async preview(q: Queryable, actor: Actor, folioId: string, buyer?: InvoiceBuyerInput) {
    const lines = await this.uninvoiced(q, folioId);
    const parties = await this.parties(q, actor.user.propertyId, folioId, buyer);
    const composed = lines.length ? await this.compose(q, actor.user.propertyId, lines, parties.registered) : null;
    const { rows: existing } = await q.query<{ id: string; number: string }>(
      `SELECT id, number FROM invoices WHERE folio_id = $1 AND series IN ('INV', 'BOS')`, [folioId],
    );
    return {
      documentType: existing[0] ? 'debit_note' : parties.registered ? 'tax_invoice' : 'bill_of_supply',
      invoiced: existing[0] ?? null,
      ...parties,
      ...(composed ?? { lines: [], groups: [], taxableTotal: '0.00', cgstTotal: '0.00', sgstTotal: '0.00', igstTotal: '0.00', roundOff: '0.00', grandTotal: '0.00' }),
    };
  }

  private async write(
    q: Queryable, actor: Actor,
    doc: {
      folioId: string; type: DocumentType; series: DocumentSeries; originalInvoiceId?: string; reason?: string; authorisedBy?: string | null;
      parties: Parties;
      composed: ReturnType<InvoicesService['totals']>;
      paid: { method: string; amount: string }[];
    },
  ): Promise<string> {
    const propertyId = actor.user.propertyId;
    const invoiceDate = await this.property.businessDate(q, propertyId);
    const fy = financialYearLabel(invoiceDate);
    const { rows: n } = await q.query<{ n: number }>(`SELECT next_document_number($1, $2, $3) AS n`, [propertyId, doc.series, fy]);
    const seq = n[0]!.n;
    const number = formatDocumentNumber(doc.series, fy, seq);
    const c = doc.composed;
    const paidTotal = sum(doc.paid.map((p) => p.amount));

    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO invoices (property_id, folio_id, document_type, series, financial_year, seq, number, invoice_date,
                             original_invoice_id, reason, seller_legal_name, seller_address, seller_gstin, seller_state_code,
                             buyer_name, buyer_gstin, buyer_address, buyer_state_code, buyer_mobile, place_of_supply, supply_type,
                             stay_from, stay_to, room_numbers, reservation_number,
                             taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, paid_at_issue,
                             finalized_by, authorised_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'intra_state',
               $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
       RETURNING id`,
      [propertyId, doc.folioId, doc.type, doc.series, fy, seq, number, invoiceDate,
        doc.originalInvoiceId ?? null, doc.reason ?? null,
        doc.parties.seller.legalName, doc.parties.seller.address, doc.parties.seller.gstin, doc.parties.seller.stateCode,
        doc.parties.buyer.name, doc.parties.buyer.gstin, doc.parties.buyer.address, doc.parties.buyer.stateCode, doc.parties.buyer.mobile,
        // Accommodation and what goes with it are supplied where the property is (§29.2).
        doc.parties.seller.stateCode,
        doc.parties.stay.from, doc.parties.stay.to, doc.parties.stay.rooms, doc.parties.stay.reservationNumber,
        c.taxableTotal, c.cgstTotal, c.sgstTotal, c.igstTotal, c.roundOff, c.grandTotal, toMoneyString(paidTotal),
        actor.user.id, doc.authorisedBy ?? null],
    );
    const id = rows[0]!.id;
    let no = 0;
    for (const l of c.lines) {
      no += 1;
      await q.query(
        `INSERT INTO invoice_lines (invoice_id, series, line_no, folio_line_id, credits_line_id, business_date, description, sac,
                                    quantity, rate, gross_amount, discount_amount, taxable_value, gst_rate)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, doc.series, no, l.folioLineId, l.creditsLineId, l.businessDate, l.description, l.sac, l.quantity, l.rate,
          l.gross, l.discount, l.taxable, l.gstRate],
      );
    }
    for (const g of c.groups) {
      await q.query(
        `INSERT INTO invoice_tax_groups (invoice_id, rate_percent, taxable_value, cgst, sgst, igst) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, g.ratePercent, g.taxableValue, g.cgst, g.sgst, g.igst],
      );
    }
    for (const p of doc.paid) {
      await q.query(`INSERT INTO invoice_payments (invoice_id, method, amount) VALUES ($1,$2,$3)`, [id, p.method, p.amount]);
    }

    await this.audit.record(q, actor, {
      action: `invoice.${doc.type}_issued`, entityType: 'invoice', entityId: id, reason: doc.reason ?? null, authorisedBy: doc.authorisedBy ?? null,
      after: { number, folioId: doc.folioId, grandTotal: c.grandTotal, taxable: c.taxableTotal, lines: c.lines.length, originalInvoiceId: doc.originalInvoiceId ?? null },
    });
    await this.outbox.emit(q, propertyId, 'invoice.issued', { type: 'invoice', id }, { number, documentType: doc.type, folioId: doc.folioId });
    return id;
  }

  /** What has been paid on the bill, by method, for the "Paid" line (§29.2). */
  private async paidByMethod(q: Queryable, folioId: string) {
    const { rows } = await q.query<{ method: string; amount: string }>(
      `SELECT p.method, sum(p.bill_effect)::numeric(14,2) AS amount
         FROM payment_folios pf JOIN payments p ON p.id = pf.payment_id
        WHERE pf.folio_id = $1 GROUP BY p.method HAVING sum(p.bill_effect) <> 0 ORDER BY p.method`,
      [folioId],
    );
    return rows;
  }

  /**
   * Issue the tax invoice (or bill of supply) for a bill and close the bill. Called from checkout,
   * inside the checkout transaction (§22: "Invoice → Finalized" happens with the stay closing).
   * A bill with nothing on it gets no invoice — there was no supply.
   */
  async finalize(q: Queryable, actor: Actor, folioId: string, buyer?: InvoiceBuyerInput): Promise<string | null> {
    const { rows: folio } = await q.query<{ status: string }>(
      `SELECT status FROM folios WHERE id = $1 AND property_id = $2 FOR UPDATE`, [folioId, actor.user.propertyId],
    );
    if (!folio[0]) throw notFound('Bill');
    if (folio[0].status === 'closed') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This bill is already closed.');
    const { rows: existing } = await q.query<{ number: string }>(`SELECT number FROM invoices WHERE folio_id = $1 AND series IN ('INV', 'BOS')`, [folioId]);
    if (existing[0]) throw new AppError(ERROR_CODES.CONFLICT, `This bill already has invoice ${existing[0].number}.`);

    const lines = await this.uninvoiced(q, folioId);
    let invoiceId: string | null = null;
    if (lines.some((l) => l.line_type !== 'discount')) {
      const parties = await this.parties(q, actor.user.propertyId, folioId, buyer);
      invoiceId = await this.write(q, actor, {
        folioId, type: parties.registered ? 'tax_invoice' : 'bill_of_supply', series: parties.registered ? 'INV' : 'BOS',
        parties, composed: await this.compose(q, actor.user.propertyId, lines, parties.registered),
        paid: await this.paidByMethod(q, folioId),
      });
    }
    await q.query(`UPDATE folios SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1`, [folioId, actor.user.id]);
    return invoiceId;
  }

  /**
   * A debit note for charges added after the invoice (§22 "late charges"). The invoice itself is
   * never touched; the late lines go on a new document that points at it.
   */
  async debitNote(q: Queryable, actor: Actor, folioId: string, reason: string) {
    await q.query(`SELECT id FROM folios WHERE id = $1 AND property_id = $2 FOR UPDATE`, [folioId, actor.user.propertyId]);
    const { rows: original } = await q.query<{ id: string; series: string }>(
      `SELECT id, series FROM invoices WHERE folio_id = $1 AND property_id = $2 AND series IN ('INV', 'BOS')`,
      [folioId, actor.user.propertyId],
    );
    const lines = await this.uninvoiced(q, folioId);
    if (!lines.some((l) => l.line_type !== 'discount')) throw new AppError(ERROR_CODES.VALIDATION, 'There are no charges on this bill that are not already invoiced.');
    const parties = await this.parties(q, actor.user.propertyId, folioId);
    if (!original[0]) {
      // The guest left with nothing on the bill, so there was no invoice to add to: the late
      // charges are the whole supply, and get an invoice of their own.
      const { rows: open } = await q.query<{ status: string }>(`SELECT status FROM folios WHERE id = $1`, [folioId]);
      if (open[0]!.status !== 'closed') throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This bill is still open. It is invoiced at checkout.');
      const id = await this.write(q, actor, {
        folioId, type: parties.registered ? 'tax_invoice' : 'bill_of_supply', series: parties.registered ? 'INV' : 'BOS', reason,
        parties, composed: await this.compose(q, actor.user.propertyId, lines, parties.registered), paid: await this.paidByMethod(q, folioId),
      });
      return this.detail(q, actor.user.propertyId, id);
    }
    const { rows: buyer } = await q.query<{ buyer_name: string; buyer_gstin: string | null; buyer_address: string | null }>(
      `SELECT buyer_name, buyer_gstin, buyer_address FROM invoices WHERE id = $1`, [original[0].id],
    );
    // A debit note is to the same buyer as the invoice it adds to.
    const same = { ...parties, buyer: { ...parties.buyer, name: buyer[0]!.buyer_name, gstin: buyer[0]!.buyer_gstin, address: buyer[0]!.buyer_address, stateCode: buyer[0]!.buyer_gstin?.slice(0, 2) ?? null } };
    const id = await this.write(q, actor, {
      folioId, type: 'debit_note', series: 'DN', originalInvoiceId: original[0].id, reason,
      parties: same, composed: await this.compose(q, actor.user.propertyId, lines, original[0].series === 'INV'), paid: [],
    });
    return this.detail(q, actor.user.propertyId, id);
  }

  /**
   * A credit note (§29.4): owner only, reason required. Either the whole invoice — which is how an
   * invoice is cancelled — or chosen lines, each by up to what is left of it. Credits are taxed at
   * the rate the original line was taxed at, never at today's rules: the invoice keeps its rates.
   */
  async creditNote(q: Queryable, actor: Actor, invoiceId: string, input: CreditNoteInput) {
    // Corrections to one bill are made one at a time: the bill row is the lock (the application
    // cannot lock an invoice row — it has no UPDATE privilege on invoices at all).
    await q.query(
      `SELECT f.id FROM folios f JOIN invoices i ON i.folio_id = f.id WHERE i.id = $1 AND i.property_id = $2 FOR UPDATE OF f`,
      [invoiceId, actor.user.propertyId],
    );
    const { rows: inv } = await q.query<InvoiceRow>(
      `SELECT i.*, '' AS finalized_by_name, NULL AS original_number FROM invoices i WHERE i.id = $1 AND i.property_id = $2`,
      [invoiceId, actor.user.propertyId],
    );
    const original = inv[0];
    if (!original) throw notFound('Invoice');
    if (original.series === 'CN') throw new AppError(ERROR_CODES.VALIDATION, 'A credit note cannot itself be credited.');

    const { rows: lines } = await q.query<{ id: string; business_date: string; description: string; sac: string; quantity: string; rate: string; taxable_value: string; gst_rate: string; credited: string }>(
      `SELECT l.id, l.business_date, l.description, l.sac, l.quantity, l.rate, l.taxable_value, l.gst_rate,
              COALESCE((SELECT sum(c.taxable_value) FROM invoice_lines c WHERE c.credits_line_id = l.id), 0)::numeric(14,2) AS credited
         FROM invoice_lines l WHERE l.invoice_id = $1 ORDER BY l.line_no`,
      [invoiceId],
    );
    const wanted = input.lines ?? lines.map((l) => ({ invoiceLineId: l.id, amount: undefined as string | undefined }));
    const draft: InvoiceDraftLine[] = [];
    for (const w of wanted) {
      const l = lines.find((x) => x.id === w.invoiceLineId);
      if (!l) throw notFound('Invoice line');
      const left = money(l.taxable_value).minus(l.credited);
      const amount = w.amount ? money(w.amount) : left;
      if (amount.lte(0)) continue;
      if (amount.gt(left)) {
        throw new AppError(ERROR_CODES.VALIDATION, `Only ${formatINR(toMoneyString(left))} of "${l.description}" is left to credit.`);
      }
      draft.push({
        folioLineId: null, creditsLineId: l.id, businessDate: l.business_date, description: l.description, sac: l.sac,
        quantity: amount.eq(l.taxable_value) ? l.quantity : '1', rate: amount.eq(l.taxable_value) ? l.rate : toMoneyString(amount),
        gross: toMoneyString(amount), discount: '0.00', taxable: toMoneyString(amount), gstRate: l.gst_rate,
      });
    }
    if (!draft.length) throw new AppError(ERROR_CODES.VALIDATION, 'Everything on this invoice has already been credited.');

    const parties = {
      seller: { legalName: original.seller_legal_name, address: original.seller_address, gstin: original.seller_gstin, stateCode: original.seller_state_code },
      buyer: { name: original.buyer_name, gstin: original.buyer_gstin, address: original.buyer_address, stateCode: original.buyer_state_code, mobile: original.buyer_mobile },
      stay: { from: original.stay_from, to: original.stay_to, rooms: original.room_numbers, reservationNumber: original.reservation_number },
      registered: Boolean(original.seller_gstin),
    };
    const id = await this.write(q, actor, {
      folioId: original.folio_id, type: 'credit_note', series: 'CN', originalInvoiceId: invoiceId, reason: input.reason,
      authorisedBy: actor.user.id, parties, composed: this.totals(draft), paid: [],
    });
    return this.detail(q, actor.user.propertyId, id);
  }

  async detail(q: Queryable, propertyId: string, invoiceId: string) {
    const { rows } = await q.query<InvoiceRow>(
      `SELECT i.*, u.full_name AS finalized_by_name, o.number AS original_number
         FROM invoices i JOIN users u ON u.id = i.finalized_by LEFT JOIN invoices o ON o.id = i.original_invoice_id
        WHERE i.id = $1 AND i.property_id = $2`,
      [invoiceId, propertyId],
    );
    const i = rows[0];
    if (!i) throw notFound('Invoice');
    const [lines, groups, paid, corrections] = await gather(q, [
      () => q.query<{ id: string; line_no: number; business_date: string; description: string; sac: string; quantity: string; rate: string; gross_amount: string; discount_amount: string; taxable_value: string; gst_rate: string; credits_line_id: string | null }>(
        `SELECT id, line_no, business_date, description, sac, quantity, rate, gross_amount, discount_amount, taxable_value, gst_rate, credits_line_id
           FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`, [invoiceId]),
      () => q.query<{ rate_percent: string; taxable_value: string; cgst: string; sgst: string; igst: string }>(
        `SELECT rate_percent, taxable_value, cgst, sgst, igst FROM invoice_tax_groups WHERE invoice_id = $1 ORDER BY rate_percent`, [invoiceId]),
      () => q.query<{ method: string; amount: string }>(`SELECT method, amount FROM invoice_payments WHERE invoice_id = $1 ORDER BY method`, [invoiceId]),
      () => q.query<{ id: string; number: string; document_type: string; grand_total: string; invoice_date: string }>(
        `SELECT id, number, document_type, grand_total, invoice_date FROM invoices WHERE original_invoice_id = $1 ORDER BY finalized_at`, [invoiceId]),
    ]);
    return {
      id: i.id, folioId: i.folio_id, documentType: i.document_type, series: i.series, number: i.number, invoiceDate: i.invoice_date,
      original: i.original_invoice_id ? { id: i.original_invoice_id, number: i.original_number } : null, reason: i.reason,
      seller: { legalName: i.seller_legal_name, address: i.seller_address, gstin: i.seller_gstin, stateCode: i.seller_state_code },
      buyer: { name: i.buyer_name, gstin: i.buyer_gstin, address: i.buyer_address, stateCode: i.buyer_state_code, mobile: i.buyer_mobile },
      placeOfSupply: i.place_of_supply, supplyType: i.supply_type,
      stay: { from: i.stay_from, to: i.stay_to, rooms: i.room_numbers, reservationNumber: i.reservation_number },
      lines: lines.rows.map((l) => ({
        id: l.id, lineNo: l.line_no, businessDate: l.business_date, description: l.description, sac: l.sac, quantity: l.quantity,
        rate: l.rate, gross: l.gross_amount, discount: l.discount_amount, taxable: l.taxable_value, gstRate: l.gst_rate,
        creditsLineId: l.credits_line_id,
      })),
      groups: groups.rows.map((g) => ({ ratePercent: g.rate_percent, taxableValue: g.taxable_value, cgst: g.cgst, sgst: g.sgst, igst: g.igst })),
      taxableTotal: i.taxable_total, cgstTotal: i.cgst_total, sgstTotal: i.sgst_total, igstTotal: i.igst_total,
      roundOff: i.round_off, grandTotal: i.grand_total, paidAtIssue: i.paid_at_issue,
      balanceAtIssue: toMoneyString(money(i.grand_total).minus(i.paid_at_issue)),
      paid: paid.rows,
      corrections: corrections.rows.map((c) => ({ id: c.id, number: c.number, documentType: c.document_type, grandTotal: c.grand_total, invoiceDate: c.invoice_date })),
      finalizedAt: i.finalized_at, finalizedBy: i.finalized_by_name,
    };
  }

  async forFolio(q: Queryable, propertyId: string, folioId: string) {
    const { rows } = await q.query<{ id: string; number: string; document_type: string; invoice_date: string; grand_total: string; original_invoice_id: string | null }>(
      `SELECT id, number, document_type, invoice_date, grand_total, original_invoice_id FROM invoices
        WHERE folio_id = $1 AND property_id = $2 ORDER BY finalized_at`,
      [folioId, propertyId],
    );
    return rows.map((r) => ({ id: r.id, number: r.number, documentType: r.document_type, invoiceDate: r.invoice_date, grandTotal: r.grand_total, originalInvoiceId: r.original_invoice_id }));
  }

  /** The invoice register — every document in a period, for the owner and for GSTR-1 later. */
  async register(propertyId: string, range: { from?: string; to?: string }) {
    const { rows } = await this.db.query<{ id: string; number: string; document_type: string; invoice_date: string; buyer_name: string; buyer_gstin: string | null; taxable_total: string; cgst_total: string; sgst_total: string; igst_total: string; grand_total: string; original_number: string | null }>(
      `SELECT i.id, i.number, i.document_type, i.invoice_date, i.buyer_name, i.buyer_gstin, i.taxable_total, i.cgst_total,
              i.sgst_total, i.igst_total, i.grand_total, o.number AS original_number
         FROM invoices i LEFT JOIN invoices o ON o.id = i.original_invoice_id
        WHERE i.property_id = $1
          AND ($2::date IS NULL OR i.invoice_date >= $2::date)
          AND ($3::date IS NULL OR i.invoice_date <= $3::date)
        ORDER BY i.invoice_date, i.series, i.seq`,
      [propertyId, range.from ?? null, range.to ?? null],
    );
    return rows.map((r) => ({
      id: r.id, number: r.number, documentType: r.document_type, invoiceDate: r.invoice_date, buyerName: r.buyer_name,
      buyerGstin: r.buyer_gstin, taxable: r.taxable_total, cgst: r.cgst_total, sgst: r.sgst_total, igst: r.igst_total,
      total: r.grand_total, originalNumber: r.original_number,
    }));
  }

}
