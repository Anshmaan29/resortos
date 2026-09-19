'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { formatDate, formatINR, money } from '@resortos/shared';
import { ShiftView } from '@/components/cashier/shift-view';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Card, CardHeader, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, newIdempotencyKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/session';
import type { CurrentShift, Shift, ShiftListItem } from '@/lib/types';

/** My shift, and for the owner every shift (spec §34). */
export default function ShiftsPage() {
  const me = useMe();
  const current = useQuery({ queryKey: ['shift-current'], queryFn: () => api<CurrentShift>('/shifts/current') });
  const isOwner = me.data?.role === 'owner';
  const list = useQuery({ queryKey: ['shifts'], enabled: isOwner, queryFn: () => api<ShiftListItem[]>('/shifts') });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Cashier shift" description="Every payment you take belongs to your open shift. Cash is counted when it closes." />

      {current.isLoading ? <Skeleton className="h-48" /> : current.isError ? (
        <ErrorBanner message={(current.error as Error).message} onRetry={() => current.refetch()} />
      ) : current.data!.shift ? (
        <ShiftView shift={current.data!.shift} canClose />
      ) : (
        <OpenShift last={current.data!.lastClosed} />
      )}

      {isOwner && (
        <Card>
          <CardHeader title="All shifts" description="Newest first. A cash difference above the threshold is shown in red." />
          {list.isLoading ? <Skeleton className="m-4 h-24" /> : (list.data ?? []).length === 0 ? (
            <EmptyState icon={<Wallet className="h-5 w-5" />} title="No shifts yet" />
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-sm">
                <thead className="text-left text-text-3">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-4 py-2 font-medium">Date</th>
                    <th scope="col" className="px-4 py-2 font-medium">Who</th>
                    <th scope="col" className="px-4 py-2 font-medium">Status</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Cash difference</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data!.map((s) => (
                    <tr key={s.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="px-4 py-2"><Link href={`/shifts/${s.id}`} className="underline-offset-2 hover:underline">{formatDate(s.businessDate)}</Link></td>
                      <td className="px-4 py-2">{s.openedBy}</td>
                      <td className="px-4 py-2"><Pill tone={s.status === 'open' ? 'brand' : 'neutral'}>{s.status === 'open' ? 'Open' : 'Closed'}</Pill></td>
                      <td className={cn('px-4 py-2 text-right tabular-nums', s.cashDifference && !money(s.cashDifference).isZero() && 'text-danger')}>
                        {s.cashDifference === null ? '—' : formatINR(s.cashDifference)}
                        {s.differenceReason && <p className="text-xs text-text-3">{s.differenceReason}</p>}
                      </td>
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

function OpenShift({ last }: { last: CurrentShift['lastClosed'] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const [cash, setCash] = useState(last?.countedCash ?? '');
  const open = useMutation({
    mutationFn: () => api<Shift>('/shifts/open', { method: 'POST', idempotencyKey: key.current, body: { openingCash: cash } }),
    onSuccess: () => {
      key.current = newIdempotencyKey();
      void qc.invalidateQueries({ queryKey: ['shift-current'] });
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      toast('success', 'Shift opened');
    },
  });
  return (
    <Card className="p-4">
      <h2 className="text-base font-semibold">Open your shift</h2>
      <p className="mt-1 text-sm text-text-3">Count the cash in the drawer first.</p>
      {last && (
        <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-sm">
          The last shift closed with {formatINR(last.countedCash)} counted by {last.closedBy}.
          {last.handoverNote && <><br /><span className="text-text-3">Handover:</span> {last.handoverNote}</>}
        </p>
      )}
      {open.error && <div className="mt-3"><ErrorBanner message={(open.error as Error).message} /></div>}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Cash in the drawer now" required className="w-56">
          {(id) => <Input id={id} inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} />}
        </Field>
        <Button loading={open.isPending} disabled={cash === ''} onClick={() => open.mutate()}>Open shift</Button>
      </div>
    </Card>
  );
}
