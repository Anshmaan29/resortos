'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { formatINR, PAYMENT_ACCOUNT_KIND_LABELS } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { DateField } from '@/components/ui/date-field';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ErrorBanner } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import type { PaymentAccount } from '@/lib/types';
import {
  ACCOUNT_KINDS_FOR_EXPENSE, EXPENSE_METHODS, EXPENSE_METHOD_LABELS,
  type ExpenseCategory, type ExpenseEntry, type ExpenseMethod,
} from './expenses-shared';

/**
 * Money paid out (spec §39). Recorded the way payments are: into a payment account, never edited —
 * a wrong entry is corrected (a reversal and the right entry, written together) or reversed.
 */
export function ExpenseEntryDialog({ expense, businessDate, onClose }: { expense?: ExpenseEntry; businessDate?: string; onClose: () => void }) {
  const correcting = Boolean(expense);
  const toast = useToast();
  const invalidate = useInvalidateExpenses();
  const key = useRef(newIdempotencyKey());
  const [error, setError] = useState<string | null>(null);
  const [needsShift, setNeedsShift] = useState(false);
  const [reason, setReason] = useState('');
  const [f, setF] = useState({
    date: expense?.expenseDate ?? businessDate ?? '',
    categoryId: expense?.categoryId ?? '',
    amount: expense?.amount ?? '',
    accountId: expense?.paymentAccountId ?? '',
    method: expense?.method ?? ('cash' as ExpenseMethod),
    paidTo: expense?.paidTo ?? '',
    note: expense?.note ?? '',
  });

  const categories = useQuery({ queryKey: ['expense-categories'], queryFn: () => api<ExpenseCategory[]>('/expense-categories') });
  const accounts = useQuery({ queryKey: ['payment-accounts'], queryFn: () => api<PaymentAccount[]>('/payment-accounts') });

  // The dialog can be opened before the property loads — fill the date in as soon as it is known.
  useEffect(() => {
    if (!f.date && businessDate) setF((p) => ({ ...p, date: businessDate }));
  }, [businessDate, f.date]);

  // Only the methods that can leave through the chosen account — the same pairs the database enforces,
  // so the desk is never offered a combination that will be refused.
  const account = (accounts.data ?? []).find((a) => a.id === f.accountId);
  const methodsForAccount = account ? EXPENSE_METHODS.filter((m) => ACCOUNT_KINDS_FOR_EXPENSE[m].includes(account.kind)) : EXPENSE_METHODS;
  const methodOk = !account || methodsForAccount.includes(f.method);
  const amountOk = /^\d{1,9}(\.\d{1,2})?$/.test(f.amount.trim()) && !/^0*(\.0+)?$/.test(f.amount.trim());

  const setAccount = (id: string) => {
    const a = (accounts.data ?? []).find((x) => x.id === id);
    const allowed = a ? EXPENSE_METHODS.filter((m) => ACCOUNT_KINDS_FOR_EXPENSE[m].includes(a.kind)) : EXPENSE_METHODS;
    setF(allowed.includes(f.method) || !a ? { ...f, accountId: id } : { ...f, accountId: id, method: allowed[0] ?? 'cash' });
  };

  const body = {
    categoryId: f.categoryId,
    expenseDate: f.date,
    method: f.method,
    paymentAccountId: f.accountId,
    amount: f.amount.trim(),
    paidTo: f.paidTo.trim(),
    note: f.note.trim() || undefined,
  };

  const save = useMutation({
    mutationFn: (): Promise<{ id: string; number: string; reversalNumber?: string }> =>
      expense
        ? api(`/expenses/${expense.id}/correct`, { method: 'POST', idempotencyKey: key.current, body: { ...body, reason: reason.trim() } })
        : api('/expenses', { method: 'POST', idempotencyKey: key.current, body }),
    onSuccess: (r) => {
      key.current = newIdempotencyKey();
      invalidate();
      toast('success', correcting ? `Corrected — reversal ${r.reversalNumber}, new entry ${r.number} recorded` : `Expense of ${formatINR(body.amount)} recorded`);
      onClose();
    },
    onError: (err) => {
      // Paying cash out needs the payer's own open shift, as everywhere else in ResortOS.
      setNeedsShift(err instanceof ApiError && err.details?.action === 'open_shift');
      setError((err as Error).message);
    },
  });
  const fields = save.error instanceof ApiError ? save.error.fields : {};

  const ready = Boolean(f.date) && Boolean(f.categoryId) && Boolean(f.accountId) && amountOk && methodOk && f.paidTo.trim().length >= 2
    && (!correcting || reason.trim().length >= 3);

  return (
    <Dialog
      open
      onClose={onClose}
      title={correcting ? `Correct ${expense!.number}` : 'Record an expense'}
      description={correcting
        ? `Writes a reversal of ${expense!.number} and the corrected entry. The ledger keeps both.`
        : 'Money paid out of one of your accounts — supplies, repairs, rent.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} disabled={!ready} onClick={() => save.mutate()}>
            {correcting ? 'Record correction' : `Record ${f.amount && amountOk ? formatINR(f.amount.trim()) : 'expense'}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}
        {needsShift && <Link href="/shifts" className="text-sm font-medium text-brand underline underline-offset-2">Open your shift</Link>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" required error={fields.expenseDate}>
            {(id) => (
              <DateField
                id={id}
                label="Date"
                value={f.date}
                onChange={(iso) => setF({ ...f, date: iso })}
                max={businessDate || undefined}
                today={businessDate || undefined}
              />
            )}
          </Field>
          <Field label="Amount" required error={fields.amount}>
            {(id) => <Input id={id} inputMode="decimal" placeholder="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="num" />}
          </Field>
        </div>

        <Field label="Category" required error={fields.categoryId}>
          {(id) => (
            <Select id={id} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
              <option value="">Choose…</option>
              {expense && !(categories.data ?? []).some((c) => c.id === expense.categoryId) && (
                <option value={expense.categoryId}>{expense.categoryName} (no longer in use)</option>
              )}
              {(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </Field>

        <Field label="Paid from" required hint="Which account the money leaves" error={fields.paymentAccountId}>
          {(id) => (
            <Select id={id} value={f.accountId} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Choose…</option>
              {expense && !(accounts.data ?? []).some((a) => a.id === expense.paymentAccountId) && (
                <option value={expense.paymentAccountId}>{expense.accountName} (no longer in use)</option>
              )}
              {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name} · {PAYMENT_ACCOUNT_KIND_LABELS[a.kind]}</option>)}
            </Select>
          )}
        </Field>

        <Field
          label="How"
          required
          error={fields.method}
          hint={account && methodsForAccount.length === 0
            ? 'The card machine only takes money in — pay this out from a bank account or cash.'
            : undefined}
        >
          {(id) => (
            <Select id={id} value={f.method} disabled={methodsForAccount.length === 0} onChange={(e) => setF({ ...f, method: e.target.value as ExpenseMethod })}>
              {methodsForAccount.length === 0
                ? <option value={f.method}>—</option>
                : methodsForAccount.map((m) => <option key={m} value={m}>{EXPENSE_METHOD_LABELS[m]}</option>)}
            </Select>
          )}
        </Field>

        <Field label="Who was paid" required error={fields.paidTo}>
          {(id) => <Input id={id} value={f.paidTo} onChange={(e) => setF({ ...f, paidTo: e.target.value })} maxLength={120} placeholder="e.g. Sharma Traders" />}
        </Field>

        <Field label="Note" error={fields.note}>
          {(id) => <Textarea id={id} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={500} placeholder="Optional — what this was for" />}
        </Field>

        {expense && (
          <Field label="Why is it being corrected" required hint="Kept with the reversal, for the records" error={fields.reason}>
            {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
          </Field>
        )}
      </div>
    </Dialog>
  );
}

/** Recorded by mistake and nothing to put in its place — one negative entry, the original kept. */
export function ReverseExpenseDialog({ expense, onClose }: { expense: ExpenseEntry; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateExpenses();
  const key = useRef(newIdempotencyKey());
  const [reason, setReason] = useState('');

  const reverse = useMutation({
    mutationFn: () => api<{ id: string; number: string }>(`/expenses/${expense.id}/reverse`, {
      method: 'POST', idempotencyKey: key.current, body: { reason: reason.trim() },
    }),
    onSuccess: (r) => {
      key.current = newIdempotencyKey();
      invalidate();
      toast('success', `Reversal ${r.number} recorded — ${formatINR(expense.amount)} no longer counts`);
      onClose();
    },
  });
  const fields = reverse.error instanceof ApiError ? reverse.error.fields : {};

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reverse ${expense.number}`}
      description={`${formatINR(expense.amount)} paid to ${expense.paidTo} gets a negative entry. The original stays in the ledger — this cannot be undone.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={reverse.isPending} disabled={reason.trim().length < 3} onClick={() => reverse.mutate()}>Record reversal</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {reverse.error && <ErrorBanner message={(reverse.error as Error).message} />}
        <Field label="Why is it being reversed" required hint="At least 3 characters — it is kept with the reversal" error={fields.reason}>
          {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Recorded twice by mistake" />}
        </Field>
      </div>
    </Dialog>
  );
}

/** Refresh everything an expense touches: the lists, the month's report and the accounts' balances. */
export function useInvalidateExpenses() {
  const qc = useQueryClient();
  return () => {
    for (const k of [['expenses'], ['expenses-monthly'], ['expense-categories'], ['account-balances'], ['shift-current']]) {
      void qc.invalidateQueries({ queryKey: k });
    }
  };
}
