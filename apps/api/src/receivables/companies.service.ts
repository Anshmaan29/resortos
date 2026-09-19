import { Injectable } from '@nestjs/common';
import {
  addDays, ERROR_CODES, formatReference, money, nightsBetween, toMoneyString,
  type CompanyInput, type CompanyReceiptInput,
} from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, gather, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';

interface CompanyRow {
  id: string; name: string; gstin: string | null; billing_address: string | null; contact_person: string | null;
  phone: string | null; email: string | null; credit_limit: string | null; payment_terms_days: number;
  is_active: boolean; version: number; outstanding?: string;
}

const mapCompany = (r: CompanyRow) => ({
  id: r.id, name: r.name, gstin: r.gstin, billingAddress: r.billing_address, contactPerson: r.contact_person,
  phone: r.phone, email: r.email, creditLimit: r.credit_limit, paymentTermsDays: r.payment_terms_days,
  isActive: r.is_active, version: r.version, outstanding: r.outstanding ?? null,
});

/** Ageing buckets from spec §32. */
const BUCKETS = [
  { label: '0–30 days', max: 30 }, { label: '31–60 days', max: 60 }, { label: '61–90 days', max: 90 }, { label: '90+ days', max: Infinity },
] as const;

/**
 * Company accounts (spec §32). A company owes what bills were moved to it, less what it has paid —
 * both recalculated from rows (`company_outstanding()`), never stored.
 */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly db: DbService,
    private readonly property: PropertyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(propertyId: string, includeInactive = false) {
    const { rows } = await this.db.query<CompanyRow>(
      `SELECT c.*, company_outstanding(c.id) AS outstanding FROM companies c
        WHERE c.property_id = $1 AND ($2 OR c.is_active) ORDER BY c.name`,
      [propertyId, includeInactive],
    );
    return rows.map(mapCompany);
  }

  async create(q: Queryable, actor: Actor, input: CompanyInput) {
    const { rows } = await q.query<CompanyRow>(
      `INSERT INTO companies (property_id, name, gstin, billing_address, contact_person, phone, email, credit_limit, payment_terms_days, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *, '0.00' AS outstanding`,
      [actor.user.propertyId, input.name, input.gstin ?? null, input.billingAddress ?? null, input.contactPerson ?? null,
        input.phone ?? null, input.email ?? null, input.creditLimit ?? null, input.paymentTermsDays, actor.user.id],
    );
    const created = mapCompany(rows[0]!);
    await this.audit.record(q, actor, { action: 'company.created', entityType: 'company', entityId: created.id, after: { name: created.name, creditLimit: created.creditLimit } });
    return created;
  }

  async update(q: Queryable, actor: Actor, id: string, input: CompanyInput, version: number) {
    const { rows: before } = await q.query<CompanyRow>(`SELECT * FROM companies WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, actor.user.propertyId]);
    if (!before[0]) throw notFound('Company');
    const { rows } = await q.query<CompanyRow>(
      `UPDATE companies SET name=$4, gstin=$5, billing_address=$6, contact_person=$7, phone=$8, email=$9, credit_limit=$10,
              payment_terms_days=$11, is_active = COALESCE($12, is_active), updated_by=$13
        WHERE id=$1 AND property_id=$2 AND version=$3 RETURNING *, company_outstanding(id) AS outstanding`,
      [id, actor.user.propertyId, version, input.name, input.gstin ?? null, input.billingAddress ?? null, input.contactPerson ?? null,
        input.phone ?? null, input.email ?? null, input.creditLimit ?? null, input.paymentTermsDays, input.isActive ?? null, actor.user.id],
    );
    if (!rows[0]) throw staleVersion();
    const after = mapCompany(rows[0]);
    await this.audit.record(q, actor, { action: 'company.updated', entityType: 'company', entityId: id, before: mapCompany(before[0]), after });
    return after;
  }

  /**
   * The company statement (spec §32): every bill moved to it and every payment it made, with a
   * running balance, and what is outstanding by age. Ageing applies payments to the oldest bills
   * first — the usual rule when a company pays against its account rather than a named invoice.
   */
  async statement(propertyId: string, companyId: string) {
    return this.db.tx({}, async (q) => {
      const { rows: company } = await q.query<CompanyRow>(
        `SELECT c.*, company_outstanding(c.id) AS outstanding FROM companies c WHERE c.id = $1 AND c.property_id = $2`, [companyId, propertyId],
      );
      if (!company[0]) throw notFound('Company');
      const [charges, receipts, businessDate] = await gather(q, [
        () => q.query<{ id: string; number: string; business_date: string; received_at: Date; amount: string; guest_name: string; reservation_number: string; invoice_number: string | null; is_reversal: boolean }>(
          `SELECT p.id, p.number, p.business_date, p.received_at, p.bill_effect AS amount,
                  trim(g.first_name || ' ' || g.last_name) AS guest_name, r.number AS reservation_number,
                  (SELECT i.number FROM invoices i JOIN payment_folios pf ON pf.folio_id = i.folio_id
                    WHERE pf.payment_id = p.id AND i.series IN ('INV', 'BOS') LIMIT 1) AS invoice_number,
                  p.reverses_payment_id IS NOT NULL AS is_reversal
             FROM payments p JOIN reservations r ON r.id = p.reservation_id JOIN guests g ON g.id = r.primary_guest_id
            WHERE p.company_id = $1 ORDER BY p.business_date, p.received_at`,
          [companyId],
        ),
        () => q.query<{ id: string; number: string; business_date: string; received_at: Date; amount: string; method: string; reference: string | null; is_reversal: boolean }>(
          `SELECT id, number, business_date, received_at, cash_effect AS amount, method, reference, reverses_receipt_id IS NOT NULL AS is_reversal
             FROM company_receipts WHERE company_id = $1 ORDER BY business_date, received_at`,
          [companyId],
        ),
        () => this.property.businessDate(q, propertyId),
      ]);

      const entries = [
        ...charges.rows.map((c) => ({
          kind: 'bill' as const, id: c.id, reference: c.number, businessDate: c.business_date, at: c.received_at,
          description: `${c.is_reversal ? 'Reversed: ' : ''}${c.guest_name} · ${c.reservation_number}${c.invoice_number ? ` · ${c.invoice_number}` : ''}`,
          debit: toMoneyString(c.amount), credit: '0.00',
        })),
        ...receipts.rows.map((r) => ({
          kind: 'receipt' as const, id: r.id, reference: r.number, businessDate: r.business_date, at: r.received_at,
          description: `${r.is_reversal ? 'Reversed: ' : ''}Payment by ${r.method.replace(/_/g, ' ')}${r.reference ? ` · ${r.reference}` : ''}`,
          debit: '0.00', credit: toMoneyString(r.amount),
        })),
      ].sort((a, b) => a.businessDate.localeCompare(b.businessDate) || new Date(a.at).getTime() - new Date(b.at).getTime());
      let running = money(0);
      const lines = entries.map((e) => {
        running = running.plus(e.debit).minus(e.credit);
        return { ...e, balance: toMoneyString(running) };
      });

      // FIFO ageing: payments settle the oldest bills first.
      let paid = receipts.rows.reduce((t, r) => t.plus(r.amount), money(0));
      const ageing = BUCKETS.map((b) => ({ label: b.label, amount: money(0) }));
      for (const c of charges.rows) {
        let open = money(c.amount);
        if (open.isNegative()) { paid = paid.minus(open); continue; } // a reversal frees up what it reversed
        const used = paid.gt(open) ? open : paid;
        paid = paid.minus(used);
        open = open.minus(used);
        if (open.gt(0)) {
          const age = nightsBetween(c.business_date, businessDate);
          ageing[BUCKETS.findIndex((b) => age <= b.max)]!.amount = ageing[BUCKETS.findIndex((b) => age <= b.max)]!.amount.plus(open);
        }
      }
      const terms = company[0].payment_terms_days;
      const overdue = charges.rows
        .filter((c) => money(c.amount).gt(0) && addDays(c.business_date, terms) < businessDate)
        .reduce((t, c) => t.plus(c.amount), money(0));

      return {
        company: mapCompany(company[0]),
        lines,
        outstanding: toMoneyString(running),
        ageing: ageing.map((a) => ({ label: a.label, amount: toMoneyString(a.amount) })),
        pastTermsGross: toMoneyString(overdue),
        asOf: businessDate,
      };
    });
  }

  async recordReceipt(q: Queryable, actor: Actor, companyId: string, input: CompanyReceiptInput) {
    const propertyId = actor.user.propertyId;
    const { rows: company } = await q.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1 AND property_id = $2`, [companyId, propertyId]);
    if (!company[0]) throw notFound('Company');
    const { rows: account } = await q.query<{ kind: string; is_active: boolean }>(
      `SELECT kind, is_active FROM payment_accounts WHERE id = $1 AND property_id = $2`, [input.paymentAccountId, propertyId],
    );
    if (!account[0] || !account[0].is_active) throw notFound('Payment account');
    const { rows: shift } = await q.query<{ id: string }>(
      `SELECT id FROM cashier_shifts WHERE property_id = $1 AND opened_by = $2 AND closed_at IS NULL`, [propertyId, actor.user.id],
    );
    if (input.method === 'cash' && !shift[0]) {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Open your shift before taking cash.', { action: 'open_shift' });
    }
    const businessDate = await this.property.businessDate(q, propertyId);
    const { rows: n } = await q.query<{ next_reference: string }>(`SELECT next_reference($1, 'company_receipt')`, [propertyId]);
    const number = formatReference('CR', Number(n[0]!.next_reference));
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO company_receipts (property_id, number, company_id, method, payment_account_id, account_kind, amount, reference, note,
                                     business_date, received_by, cashier_shift_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12) RETURNING id`,
      [propertyId, number, companyId, input.method, input.paymentAccountId, account[0].kind, input.amount, input.reference ?? null,
        input.note ?? null, businessDate, actor.user.id, shift[0]?.id ?? null],
    );
    await this.audit.record(q, actor, {
      action: 'company.receipt_recorded', entityType: 'company', entityId: companyId,
      after: { receiptId: rows[0]!.id, number, amount: input.amount, method: input.method, accountId: input.paymentAccountId },
    });
    await this.outbox.emit(q, propertyId, 'company.receipt_recorded', { type: 'company', id: companyId }, { number, amount: input.amount });
    return { id: rows[0]!.id, number };
  }

  /** A receipt is corrected by a reversing row, like a payment (§25.4). Owner only. */
  async reverseReceipt(q: Queryable, actor: Actor, receiptId: string, reason: string) {
    const propertyId = actor.user.propertyId;
    const { rows } = await q.query<{ id: string; number: string; company_id: string; method: string; payment_account_id: string; account_kind: string; amount: string; reverses_receipt_id: string | null; reversed: boolean }>(
      `SELECT r.*, EXISTS (SELECT 1 FROM company_receipts x WHERE x.reverses_receipt_id = r.id) AS reversed
         FROM company_receipts r WHERE r.id = $1 AND r.property_id = $2`,
      [receiptId, propertyId],
    );
    const original = rows[0];
    if (!original) throw notFound('Receipt');
    if (original.reversed || original.reverses_receipt_id) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This receipt cannot be reversed again.');
    const { rows: shift } = await q.query<{ id: string }>(
      `SELECT id FROM cashier_shifts WHERE property_id = $1 AND opened_by = $2 AND closed_at IS NULL`, [propertyId, actor.user.id],
    );
    if (original.method === 'cash' && !shift[0]) throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Open your shift before giving back cash.', { action: 'open_shift' });
    const businessDate = await this.property.businessDate(q, propertyId);
    const { rows: n } = await q.query<{ next_reference: string }>(`SELECT next_reference($1, 'company_receipt')`, [propertyId]);
    const number = formatReference('CR', Number(n[0]!.next_reference));
    await q.query(
      `INSERT INTO company_receipts (property_id, number, company_id, method, payment_account_id, account_kind, amount, reference,
                                     business_date, received_by, cashier_shift_id, reverses_receipt_id, reversal_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13)`,
      [propertyId, number, original.company_id, original.method, original.payment_account_id, original.account_kind, original.amount,
        `Reverses ${original.number}`, businessDate, actor.user.id, shift[0]?.id ?? null, receiptId, reason],
    );
    await this.audit.record(q, actor, {
      action: 'company.receipt_reversed', entityType: 'company', entityId: original.company_id, reason,
      before: { number: original.number, amount: original.amount }, after: { reversalNumber: number },
    });
    return { number };
  }
}
