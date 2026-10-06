import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES, formatReference, money, toMoneyString,
  type ExpenseCategoryInput, type ExpenseCorrectionInput, type ExpenseInput,
} from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, gather, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';

interface ExpenseRow {
  id: string; number: string; category_id: string; category_name: string; expense_date: string; method: string;
  payment_account_id: string; account_name: string; amount: string; paid_to: string; note: string | null;
  business_date: string; paid_at: Date; paid_by_name: string; paid_by: string;
  reverses_expense_id: string | null; reversal_reason: string | null; corrects_expense_id: string | null;
  reversed: boolean;
}

const mapExpense = (r: ExpenseRow) => ({
  id: r.id, number: r.number, categoryId: r.category_id, categoryName: r.category_name, expenseDate: r.expense_date,
  method: r.method, paymentAccountId: r.payment_account_id, accountName: r.account_name, amount: r.amount,
  paidTo: r.paid_to, note: r.note, businessDate: r.business_date, paidAt: r.paid_at, paidBy: r.paid_by_name,
  isReversal: r.reverses_expense_id !== null, reversalReason: r.reversal_reason,
  isCorrection: r.corrects_expense_id !== null, reversed: r.reversed,
});

/**
 * Which account money can leave by each method. Paying *by card* leaves a bank account, not the
 * card machine: the POS terminal only takes money in (§25.1). The database enforces the same pairs
 * (`expenses_account_matches_method`); this is so the desk gets a sentence rather than a constraint.
 */
const ACCOUNT_KINDS_FOR_EXPENSE: Record<ExpenseInput['method'], readonly string[]> = {
  cash: ['cash'], upi: ['upi'], card: ['bank', 'other'], bank_transfer: ['bank'], cheque: ['bank'],
};
const ACCOUNT_KIND_WORDS: Record<string, string> = {
  cash: 'a cash account', upi: 'a UPI account', bank: 'a bank account', card_pos: 'the card machine', other: 'another account',
};

/**
 * Money paid out (spec §39).
 *
 * Recorded exactly the way money taken is: append-only, into a payment account, never edited. An
 * entry with the wrong amount or category is *corrected* — one transaction writes a reversing row
 * and the right entry — so the ledger keeps both and the shift's cash still adds up. Cash comes out
 * of the payer's own open shift, which is what makes a cash expense reduce the expected cash with no
 * special case anywhere: the shift sums `account_ledger`, and expenses are in it (migration 0021).
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly db: DbService,
    private readonly property: PropertyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ---------------- categories ----------------

  async listCategories(propertyId: string, includeInactive = false) {
    const { rows } = await this.db.query<{ id: string; name: string; is_active: boolean; sort_order: number; version: number; used: string }>(
      `SELECT c.*, (SELECT count(*) FROM expenses e WHERE e.category_id = c.id) AS used
         FROM expense_categories c WHERE c.property_id = $1 AND ($2 OR c.is_active)
        ORDER BY c.sort_order, c.name`,
      [propertyId, includeInactive],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, isActive: r.is_active, sortOrder: r.sort_order, version: r.version, used: Number(r.used) }));
  }

  async createCategory(q: Queryable, actor: Actor, input: ExpenseCategoryInput) {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO expense_categories (property_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`,
      [actor.user.propertyId, input.name, input.sortOrder],
    );
    await this.audit.record(q, actor, { action: 'expense_category.created', entityType: 'expense_category', entityId: rows[0]!.id, after: { name: input.name } });
    return { id: rows[0]!.id };
  }

  async updateCategory(q: Queryable, actor: Actor, id: string, input: ExpenseCategoryInput, version: number) {
    const { rows } = await q.query<{ id: string; name: string; is_active: boolean }>(
      `UPDATE expense_categories SET name = $4, is_active = $5, sort_order = $6, updated_by = $7
        WHERE id = $1 AND property_id = $2 AND version = $3 RETURNING id, name, is_active`,
      [id, actor.user.propertyId, version, input.name, input.isActive, input.sortOrder, actor.user.id],
    );
    if (!rows[0]) throw staleVersion();
    await this.audit.record(q, actor, { action: 'expense_category.updated', entityType: 'expense_category', entityId: id, after: { name: input.name, isActive: input.isActive } });
    return { id, name: rows[0].name, isActive: rows[0].is_active };
  }

  // ---------------- expenses ----------------

  async list(propertyId: string, filters: { from: string; to: string; categoryId?: string }) {
    return this.db.tx({}, async (q) => {
      const [rows, byCategory] = await gather(q, [
        () => q.query<ExpenseRow>(
          `SELECT e.*, c.name AS category_name, a.name AS account_name, u.full_name AS paid_by_name,
                  EXISTS (SELECT 1 FROM expenses x WHERE x.reverses_expense_id = e.id) AS reversed
             FROM expenses e
             JOIN expense_categories c ON c.id = e.category_id
             JOIN payment_accounts a ON a.id = e.payment_account_id
             JOIN users u ON u.id = e.paid_by
            WHERE e.property_id = $1 AND e.expense_date BETWEEN $2::date AND $3::date
              AND ($4::uuid IS NULL OR e.category_id = $4)
            ORDER BY e.expense_date DESC, e.paid_at DESC`,
          [propertyId, filters.from, filters.to, filters.categoryId ?? null],
        ),
        () => q.query<{ category_name: string; total: string }>(
          `SELECT c.name AS category_name, sum(-e.cash_effect)::numeric(14,2) AS total
             FROM expenses e JOIN expense_categories c ON c.id = e.category_id
            WHERE e.property_id = $1 AND e.expense_date BETWEEN $2::date AND $3::date
              AND ($4::uuid IS NULL OR e.category_id = $4)
            GROUP BY c.name HAVING sum(-e.cash_effect) <> 0 ORDER BY sum(-e.cash_effect) DESC`,
          [propertyId, filters.from, filters.to, filters.categoryId ?? null],
        ),
      ]);
      // Reversals carry a negative effect, so the total is what was really spent.
      const total = rows.rows.reduce((t, r) => t.plus(money(r.amount).times(r.reverses_expense_id ? -1 : 1)), money(0));
      return {
        from: filters.from, to: filters.to,
        expenses: rows.rows.map(mapExpense),
        total: toMoneyString(total),
        byCategory: byCategory.rows.map((c) => ({ category: c.category_name, total: c.total })),
      };
    });
  }

  private async openShift(q: Queryable, actor: Actor) {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM cashier_shifts WHERE property_id = $1 AND opened_by = $2 AND closed_at IS NULL`,
      [actor.user.propertyId, actor.user.id],
    );
    return rows[0]?.id ?? null;
  }

  private async insert(q: Queryable, actor: Actor, input: ExpenseInput, businessDate: string, links: { reverses?: string; reason?: string; corrects?: string } = {}) {
    const propertyId = actor.user.propertyId;
    const { rows: account } = await q.query<{ kind: string; is_active: boolean }>(
      `SELECT kind, is_active FROM payment_accounts WHERE id = $1 AND property_id = $2`, [input.paymentAccountId, propertyId],
    );
    if (!account[0] || !account[0].is_active) throw notFound('Payment account');
    const { rows: category } = await q.query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM expense_categories WHERE id = $1 AND property_id = $2`, [input.categoryId, propertyId],
    );
    if (!category[0] || !category[0].is_active) throw notFound('Expense category');
    if (!ACCOUNT_KINDS_FOR_EXPENSE[input.method].includes(account[0].kind)) {
      const allowed = ACCOUNT_KINDS_FOR_EXPENSE[input.method].map((k) => ACCOUNT_KIND_WORDS[k]).join(' or ');
      throw new AppError(ERROR_CODES.VALIDATION, `Money paid by ${input.method.replace(/_/g, ' ')} comes out of ${allowed}, not ${ACCOUNT_KIND_WORDS[account[0].kind]}.`);
    }
    if (input.expenseDate > businessDate) throw new AppError(ERROR_CODES.VALIDATION, 'An expense cannot be dated in the future.');

    const shiftId = await this.openShift(q, actor);
    if (input.method === 'cash' && !shiftId) {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'Open your shift before paying cash out.', { action: 'open_shift' });
    }
    const { rows: n } = await q.query<{ next_reference: string }>(`SELECT next_reference($1, 'expense')`, [propertyId]);
    const number = formatReference('EXP', Number(n[0]!.next_reference));
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO expenses (property_id, number, category_id, expense_date, method, payment_account_id, account_kind, amount,
                             paid_to, note, business_date, paid_by, cashier_shift_id, reverses_expense_id, reversal_reason, corrects_expense_id)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15,$16) RETURNING id`,
      [propertyId, number, input.categoryId, input.expenseDate, input.method, input.paymentAccountId, account[0].kind, input.amount,
        input.paidTo, input.note ?? null, businessDate, actor.user.id, input.method === 'cash' ? shiftId : null,
        links.reverses ?? null, links.reason ?? null, links.corrects ?? null],
    );
    return { id: rows[0]!.id, number };
  }

  async record(q: Queryable, actor: Actor, input: ExpenseInput) {
    const businessDate = await this.property.businessDate(q, actor.user.propertyId);
    const created = await this.insert(q, actor, input, businessDate);
    await this.audit.record(q, actor, {
      action: 'expense.recorded', entityType: 'expense', entityId: created.id,
      after: { number: created.number, amount: input.amount, method: input.method, categoryId: input.categoryId, paidTo: input.paidTo },
    });
    await this.outbox.emit(q, actor.user.propertyId, 'expense.recorded', { type: 'expense', id: created.id }, { number: created.number, amount: input.amount });
    return created;
  }

  private async load(q: Queryable, propertyId: string, id: string) {
    const { rows } = await q.query<ExpenseRow>(
      `SELECT e.*, c.name AS category_name, a.name AS account_name, u.full_name AS paid_by_name,
              EXISTS (SELECT 1 FROM expenses x WHERE x.reverses_expense_id = e.id) AS reversed
         FROM expenses e
         JOIN expense_categories c ON c.id = e.category_id
         JOIN payment_accounts a ON a.id = e.payment_account_id
         JOIN users u ON u.id = e.paid_by
        WHERE e.id = $1 AND e.property_id = $2`,
      [id, propertyId],
    );
    if (!rows[0]) throw notFound('Expense');
    return rows[0];
  }

  /**
   * Who may change an entry that has already been recorded (§39): whoever recorded it, while the day
   * is still open; once night audit has closed that day, the owner only.
   */
  private assertMayChange(actor: Actor, original: ExpenseRow, businessDate: string) {
    if (original.reversed || original.reverses_expense_id) {
      throw new AppError(ERROR_CODES.INVALID_TRANSITION, 'This entry has already been corrected or reversed.');
    }
    if (actor.user.role === 'owner') return;
    if (original.business_date < businessDate) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'That day is closed. Only the owner can correct an expense after night audit.');
    }
    if (original.paid_by !== actor.user.id) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the person who recorded this expense, or the owner, can change it.');
    }
  }

  /** A reversing row and the right entry, written together, so the two never exist apart. */
  async correct(q: Queryable, actor: Actor, id: string, input: ExpenseCorrectionInput) {
    const propertyId = actor.user.propertyId;
    const businessDate = await this.property.businessDate(q, propertyId);
    const original = await this.load(q, propertyId, id);
    this.assertMayChange(actor, original, businessDate);

    const reversal = await this.insert(q, actor, {
      categoryId: original.category_id, expenseDate: original.expense_date, method: original.method as ExpenseInput['method'],
      paymentAccountId: original.payment_account_id, amount: original.amount, paidTo: original.paid_to,
      note: `Reverses ${original.number}`,
    }, businessDate, { reverses: id, reason: input.reason });
    const { reason, ...corrected } = input;
    const replacement = await this.insert(q, actor, corrected, businessDate, { corrects: id });

    await this.audit.record(q, actor, {
      action: 'expense.corrected', entityType: 'expense', entityId: id, reason,
      before: { number: original.number, amount: original.amount, categoryId: original.category_id, paidTo: original.paid_to },
      after: { reversalNumber: reversal.number, number: replacement.number, amount: input.amount, categoryId: input.categoryId, paidTo: input.paidTo },
    });
    await this.outbox.emit(q, propertyId, 'expense.corrected', { type: 'expense', id: replacement.id }, { corrects: original.number });
    return { id: replacement.id, number: replacement.number, reversalNumber: reversal.number };
  }

  /** Recorded by mistake and nothing to put in its place. */
  async reverse(q: Queryable, actor: Actor, id: string, reason: string) {
    const propertyId = actor.user.propertyId;
    const businessDate = await this.property.businessDate(q, propertyId);
    const original = await this.load(q, propertyId, id);
    this.assertMayChange(actor, original, businessDate);
    const reversal = await this.insert(q, actor, {
      categoryId: original.category_id, expenseDate: original.expense_date, method: original.method as ExpenseInput['method'],
      paymentAccountId: original.payment_account_id, amount: original.amount, paidTo: original.paid_to,
      note: `Reverses ${original.number}`,
    }, businessDate, { reverses: id, reason });
    await this.audit.record(q, actor, {
      action: 'expense.reversed', entityType: 'expense', entityId: id, reason,
      before: { number: original.number, amount: original.amount }, after: { reversalNumber: reversal.number },
    });
    return reversal;
  }

  /** The month's spending by category, for the owner's records and the monthly report (§39). */
  async monthly(propertyId: string, month: string) {
    const from = `${month}-01`;
    const { rows } = await this.db.query<{ category_name: string; total: string; entries: string }>(
      `SELECT c.name AS category_name, sum(-e.cash_effect)::numeric(14,2) AS total, count(*) FILTER (WHERE e.reverses_expense_id IS NULL) AS entries
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id
        WHERE e.property_id = $1 AND e.expense_date >= $2::date AND e.expense_date < ($2::date + interval '1 month')
        GROUP BY c.name ORDER BY sum(-e.cash_effect) DESC`,
      [propertyId, from],
    );
    const total = rows.reduce((t, r) => t.plus(r.total), money(0));
    return {
      month,
      categories: rows.map((r) => ({ category: r.category_name, total: r.total, entries: Number(r.entries) })),
      total: toMoneyString(total),
    };
  }
}
