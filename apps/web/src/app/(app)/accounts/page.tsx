'use client';
import { useQuery } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { useState } from 'react';
import { formatDate, formatINR, PAYMENT_ACCOUNT_KIND_LABELS } from '@resortos/shared';
import { DateField } from '@/components/ui/date-field';
import { Card, CardHeader, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { AccountBalance, AccountLedger } from '@/lib/types';

/**
 * Where the money is (the old software's account-wise "Ledger Entries"). Every figure is summed from
 * the rows on the server each time it is asked for — nothing here is a stored balance.
 */
export default function AccountsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const balances = useQuery({ queryKey: ['account-balances'], queryFn: () => api<AccountBalance[]>('/payment-accounts/balances') });
  const accountId = selected ?? balances.data?.[0]?.id ?? null;
  const ledger = useQuery({
    queryKey: ['ledger', accountId, from, to],
    enabled: Boolean(accountId),
    queryFn: () => api<AccountLedger>(`/payment-accounts/${accountId}/ledger`, { query: { from: from || undefined, to: to || undefined } }),
  });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Accounts" description="Cash counter, bank, UPI and card machine — what each should hold, from every recorded entry." />
      {balances.isLoading ? <Skeleton className="h-32" /> : balances.isError ? (
        <ErrorBanner message={(balances.error as Error).message} onRetry={() => balances.refetch()} />
      ) : balances.data!.length === 0 ? (
        <EmptyState icon={<Landmark className="h-5 w-5" />} title="No accounts yet" description="Add the cash counter, bank account, UPI and card machine in settings." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {balances.data!.map((a) => (
            <button key={a.id} type="button" onClick={() => setSelected(a.id)}
              className={cn('rounded-xl border bg-surface p-4 text-left transition-colors', accountId === a.id ? 'border-brand' : 'border-border hover:bg-surface-2')}>
              <p className="text-xs text-text-3">{PAYMENT_ACCOUNT_KIND_LABELS[a.kind]}</p>
              <p className="mt-0.5 font-medium">{a.name}</p>
              <p className="mt-2 text-xl font-semibold tabular-nums">{formatINR(a.balance)}</p>
              <p className="text-xs text-text-3">{a.entries} entr{a.entries === 1 ? 'y' : 'ies'}</p>
            </button>
          ))}
        </div>
      )}

      {accountId && (
        <Card>
          <CardHeader
            title={ledger.data ? `Ledger — ${ledger.data.account.name}` : 'Ledger'}
            description={ledger.data ? `Opening ${formatINR(ledger.data.openingBalance)} · closing ${formatINR(ledger.data.closingBalance)}` : undefined}
            action={
              <div className="flex flex-wrap items-end gap-2">
                <DateField label="From" value={from} onChange={setFrom} />
                <DateField label="To" value={to} onChange={setTo} />
              </div>
            }
          />
          {ledger.isLoading ? <Skeleton className="m-4 h-24" /> : ledger.isError ? (
            <div className="p-4"><ErrorBanner message={(ledger.error as Error).message} /></div>
          ) : ledger.data!.lines.length === 0 ? (
            <p className="border-t border-border px-4 py-6 text-sm text-text-3">Nothing in this period.</p>
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-sm">
                <thead className="text-left text-text-3">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-4 py-2 font-medium">Date</th>
                    <th scope="col" className="px-4 py-2 font-medium">Entry</th>
                    <th scope="col" className="px-4 py-2 font-medium">By</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.data!.lines.map((l) => (
                    <tr key={`${l.source}:${l.sourceId}`} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDate(l.businessDate, { year: false })}</td>
                      <td className="px-4 py-2">{l.reference} <span className="text-xs text-text-3">{l.description.replace(/_/g, ' ')}</span></td>
                      <td className="px-4 py-2 text-text-2">{l.by}</td>
                      <td className={cn('px-4 py-2 text-right tabular-nums', Number(l.amount) < 0 && 'text-danger')}>{formatINR(l.amount)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatINR(l.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
