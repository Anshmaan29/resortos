import type { PaymentAccountKind } from '@resortos/shared';

/** The five ways money leaves the resort (spec §39) — what the expenses API accepts. */
export type ExpenseMethod = 'cash' | 'upi' | 'card' | 'bank_transfer' | 'cheque';

export const EXPENSE_METHODS: readonly ExpenseMethod[] = ['cash', 'upi', 'card', 'bank_transfer', 'cheque'];

export const EXPENSE_METHOD_LABELS: Record<ExpenseMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
};

/**
 * Which account kinds money can *leave* by each method — the expenses service's own rule
 * (apps/api/src/expenses/expenses.service.ts, enforced by the `expenses_account_matches_method`
 * database check). Deliberately not the take-money map in @resortos/shared: a card payment goes
 * out of a bank account, never the card machine, which only takes money in.
 */
export const ACCOUNT_KINDS_FOR_EXPENSE: Record<ExpenseMethod, readonly PaymentAccountKind[]> = {
  cash: ['cash'],
  upi: ['upi'],
  card: ['bank', 'other'],
  bank_transfer: ['bank'],
  cheque: ['bank'],
};

/** One row of GET /expenses — the API's mapExpense, field for field. Money stays a string. */
export interface ExpenseEntry {
  id: string;
  number: string;
  categoryId: string;
  categoryName: string;
  expenseDate: string;
  method: ExpenseMethod;
  paymentAccountId: string;
  accountName: string;
  amount: string;
  paidTo: string;
  note: string | null;
  businessDate: string;
  paidAt: string;
  paidBy: string;
  /** This row is itself a reversing entry (its amount counts negative). */
  isReversal: boolean;
  reversalReason: string | null;
  /** This row is the corrected entry written by a correction. */
  isCorrection: boolean;
  /** Some later reversal row undoes this entry. */
  reversed: boolean;
}

export interface ExpenseListResponse {
  from: string;
  to: string;
  total: string;
  byCategory: { category: string; total: string }[];
  expenses: ExpenseEntry[];
}

/** GET /expenses/monthly — owner only (§39). */
export interface ExpenseMonthly {
  month: string;
  total: string;
  categories: { category: string; total: string; entries: number }[];
}

/** GET /expense-categories — `used` counts how many expenses point at it. */
export interface ExpenseCategory {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  version: number;
  used: number;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-09" → "September 2026" */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
}

/** "2026-09" → { from: "2026-09-01", to: "2026-09-30" } */
export function monthRange(month: string): { from: string; to: string } {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** "2026-09" − 1 → "2026-08", + 1 → "2026-10" */
export function shiftMonth(month: string, delta: number): string {
  const n = Number(month.slice(5, 7)) - 1 + delta;
  const m = ((n % 12) + 12) % 12;
  return `${Number(month.slice(0, 4)) + Math.floor(n / 12)}-${String(m + 1).padStart(2, '0')}`;
}
