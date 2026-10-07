'use client';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Receipt } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDate, formatINR, money, toMoneyString } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMe, useProperty } from '@/lib/session';
import { CategoryManagerCard } from './category-manager';
import { ExpenseEntryDialog, ReverseExpenseDialog } from './expense-dialogs';
import { EXPENSE_METHOD_LABELS, monthLabel, monthRange, shiftMonth, type ExpenseEntry, type ExpenseListResponse, type ExpenseMonthly } from './expenses-shared';

/**
 * Money paid out (spec §39). The list is open to everyone at the desk; the month's report and the
 * category manager are the owner's, exactly as the API allows.
 */
export function ExpensesView() {
  const me = useMe();
  const property = useProperty();
  const isOwner = me.data?.role === 'owner';
  const businessDate = property.data?.businessDate;

  // The current business month, one month per page (‹ September 2026 ›).
  const [month, setMonth] = useState<string | null>(null);
  useEffect(() => {
    if (businessDate && !month) setMonth(businessDate.slice(0, 7));
  }, [businessDate, month]);

  const [recordOpen, setRecordOpen] = useState(false);
  const [correcting, setCorrecting] = useState<ExpenseEntry | null>(null);
  const [reversing, setReversing] = useState<ExpenseEntry | null>(null);

  const list = useQuery({
    queryKey: ['expenses', month],
    enabled: Boolean(month),
    queryFn: () => {
      const r = monthRange(month!);
      return api<ExpenseListResponse>('/expenses', { query: { from: r.from, to: r.to } });
    },
  });
  const monthly = useQuery({
    queryKey: ['expenses-monthly', month],
    enabled: Boolean(isOwner && month),
    queryFn: () => api<ExpenseMonthly>('/expenses/monthly', { query: { month: month! } }),
  });

  // Who may fix a recorded entry (§39): the owner whenever it has not already been reversed or
  // corrected; the desk only its own entries while the day is still open. The API decides finally.
  const canChange = (e: ExpenseEntry) => {
    if (e.reversed || e.isReversal) return false;
    if (isOwner) return true;
    return Boolean(businessDate && e.businessDate >= businessDate && e.paidBy === me.data?.fullName);
  };

  const top3 = list.data ? list.data.byCategory.slice(0, 3) : [];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Expenses"
        description="Money paid out — supplies, salaries, repairs. An entry is never edited; it is corrected or reversed."
        actions={
          <>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" disabled={!month} onClick={() => month && setMonth(shiftMonth(month, -1))} aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[9.5rem] text-center text-[15px] font-semibold" aria-live="polite">{month ? monthLabel(month) : '…'}</span>
              <Button variant="outline" size="icon" disabled={!month} onClick={() => month && setMonth(shiftMonth(month, 1))} aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <Button onClick={() => setRecordOpen(true)}><Plus className="h-4 w-4" aria-hidden />Record expense</Button>
          </>
        }
      />

      {/* The month at a glance: the total and the biggest categories, summed on the server. */}
      {!month || list.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" />
        </div>
      ) : list.isError ? (
        <ErrorBanner message={(list.error as Error).message} onRetry={() => list.refetch()} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
            <p className="text-xs text-text-3">Total paid out in {monthLabel(month!)}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{formatINR(list.data!.total)}</p>
            <p className="text-xs text-text-3">{list.data!.expenses.length} entr{list.data!.expenses.length === 1 ? 'y' : 'ies'}</p>
          </div>
          {top3.map((c) => (
            <div key={c.category} className="rounded-xl border border-border bg-surface p-4 shadow-sm">
              <p className="text-xs text-text-3">{c.category}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{formatINR(c.total)}</p>
            </div>
          ))}
        </div>
      )}

      <Card>
        <CardHeader
          title="Money paid out"
          description={month ? `Every entry dated in ${monthLabel(month)}, newest first. Reversed entries stay in the ledger.` : undefined}
        />
        {!month || list.isLoading ? (
          <Skeleton className="m-4 h-48" />
        ) : list.isError ? (
          <div className="p-4"><ErrorBanner message={(list.error as Error).message} onRetry={() => list.refetch()} /></div>
        ) : list.data!.expenses.length === 0 ? (
          <EmptyState
            icon={<Receipt className="h-5 w-5" />}
            title="No expenses this month"
            description={`Money paid out in ${monthLabel(month!)} will show here, day by day.`}
          />
        ) : (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-text-3">
                <tr className="border-b border-border">
                  <th scope="col" className="px-4 py-2 font-medium">Date</th>
                  <th scope="col" className="px-4 py-2 font-medium">Number</th>
                  <th scope="col" className="px-4 py-2 font-medium">Category</th>
                  <th scope="col" className="px-4 py-2 font-medium">Paid to</th>
                  <th scope="col" className="px-4 py-2 font-medium">Method · From</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2 font-medium">Recorded by</th>
                  <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {list.data!.expenses.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDate(e.expenseDate, { year: false })}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-text-2">{e.number}</td>
                    <td className="px-4 py-2">{e.categoryName}</td>
                    <td className="px-4 py-2">
                      {e.paidTo}
                      {e.note && <span className="block text-xs text-text-3">{e.note}</span>}
                      {e.isReversal && e.reversalReason && <span className="block text-xs text-text-3">Reason: {e.reversalReason}</span>}
                    </td>
                    <td className="px-4 py-2">{EXPENSE_METHOD_LABELS[e.method]} <span className="text-text-3">· {e.accountName}</span></td>
                    <td className={cn('whitespace-nowrap px-4 py-2 text-right tabular-nums', e.isReversal && 'text-danger')}>
                      {e.isReversal ? formatINR(toMoneyString(money(e.amount).times(-1))) : formatINR(e.amount)}
                    </td>
                    <td className="px-4 py-2">{(e.reversed || e.isReversal) ? <Pill tone="danger">Reversed</Pill> : <span className="text-text-3">—</span>}</td>
                    <td className="px-4 py-2 text-text-2">{e.paidBy}</td>
                    <td className="px-4 py-2 text-right">
                      {canChange(e) && (
                        <span className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setCorrecting(e)}>Correct</Button>
                          <Button size="sm" variant="ghost" onClick={() => setReversing(e)}>Reverse</Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {isOwner && (
        <Card>
          <CardHeader
            title={month ? `Monthly report — ${monthLabel(month)}` : 'Monthly report'}
            description="What the resort spent, category by category. Reversals are already deducted."
          />
          {!month || monthly.isLoading ? (
            <Skeleton className="m-4 h-24" />
          ) : monthly.isError ? (
            <div className="p-4"><ErrorBanner message={(monthly.error as Error).message} onRetry={() => monthly.refetch()} /></div>
          ) : monthly.data!.categories.length === 0 ? (
            <p className="border-t border-border px-5 py-6 text-sm text-text-3">Nothing recorded for {monthLabel(month!)} yet.</p>
          ) : (
            <div className="border-t border-border">
              {monthly.data!.categories.map((c) => (
                <div key={c.category} className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 text-sm last:border-0">
                  <span>{c.category} <span className="text-text-3">· {c.entries} entr{c.entries === 1 ? 'y' : 'ies'}</span></span>
                  <span className="tabular-nums font-medium">{formatINR(c.total)}</span>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-2 px-5 py-3 text-sm">
                <span className="font-semibold">Total for {monthLabel(month!)}</span>
                <span className="tabular-nums font-semibold">{formatINR(monthly.data!.total)}</span>
              </div>
            </div>
          )}
        </Card>
      )}

      {isOwner && <CategoryManagerCard />}

      {recordOpen && <ExpenseEntryDialog businessDate={businessDate} onClose={() => setRecordOpen(false)} />}
      {correcting && <ExpenseEntryDialog expense={correcting} businessDate={businessDate} onClose={() => setCorrecting(null)} />}
      {reversing && <ReverseExpenseDialog expense={reversing} onClose={() => setReversing(null)} />}
    </div>
  );
}
