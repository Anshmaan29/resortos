'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { BOOKING_SOURCE_LABELS, formatDate, formatINR, type BookingSource } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, newIdempotencyKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { OtaReceivables, PaymentAccount } from '@/lib/types';

type Row = OtaReceivables['items'][number];

/** OTA receivables (spec §33): booked, expected, received, pending — per booking. Owner only. */
export default function OtaPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [paying, setPaying] = useState<Row | null>(null);
  const report = useQuery({
    queryKey: ['ota-receivables', from, to],
    queryFn: () => api<OtaReceivables>('/ota/receivables', { query: { from: from || undefined, to: to || undefined } }),
  });
  const t = report.data?.totals;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="OTA payouts" description="What each OTA should pay out after commission, and what has arrived in the bank."
        actions={<div className="flex items-end gap-2"><DateField label="Arrivals from" value={from} onChange={setFrom} /><DateField label="to" value={to} onChange={setTo} /></div>} />
      {t && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {([['Booked', t.booked], ['Expected payout', t.expected], ['Received', t.received], ['Pending', t.pending]] as const).map(([k, v]) => (
            <Card key={k} className="p-4"><p className="text-xs text-text-3">{k}</p><p className="mt-1 text-lg font-semibold tabular-nums">{formatINR(v)}</p></Card>
          ))}
        </div>
      )}
      {report.isLoading ? <Skeleton className="h-48" /> : report.isError ? (
        <ErrorBanner message={(report.error as Error).message} onRetry={() => report.refetch()} />
      ) : report.data!.items.length === 0 ? (
        <EmptyState icon={<Globe className="h-5 w-5" />} title="No OTA bookings in this period" />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-text-3"><tr className="border-b border-border">
                <th scope="col" className="px-4 py-2 font-medium">Booking</th><th scope="col" className="px-4 py-2 font-medium">Arrival</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Value</th><th scope="col" className="px-4 py-2 text-right font-medium">Expected</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Received</th><th scope="col" className="px-4 py-2 text-right font-medium">Pending</th>
                <th scope="col" className="px-4 py-2" />
              </tr></thead>
              <tbody>
                {report.data!.items.map((r) => (
                  <tr key={r.reservationId} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <Link href={`/reservations/${r.reservationId}`} className="font-medium underline-offset-2 hover:underline">{r.number}</Link>
                      <span className="ml-2 text-xs text-text-3">{BOOKING_SOURCE_LABELS[r.source as BookingSource]} · {r.otaReference} · {r.guestName}</span>
                      {r.termsMissing && <span className="ml-2"><Pill tone="warning">Terms not entered</Pill></span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDate(r.arrival, { year: false })}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.grossAmount ? formatINR(r.grossAmount) : '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.expectedPayout ? formatINR(r.expectedPayout) : '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatINR(r.received)}</td>
                    <td className={cn('px-4 py-2 text-right tabular-nums', r.pending && Number(r.pending) > 0 && 'text-warning')}>{r.pending ? formatINR(r.pending) : '—'}</td>
                    <td className="px-4 py-2 text-right">{!r.termsMissing && r.paymentMode === 'prepaid_to_ota' && <Button size="sm" variant="outline" onClick={() => setPaying(r)}>Payout</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {paying && <PayoutDialog row={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}

function PayoutDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = useRef(newIdempotencyKey());
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState(row.pending ?? '');
  const [reference, setReference] = useState('');
  const accounts = useQuery({ queryKey: ['payment-accounts'], queryFn: () => api<PaymentAccount[]>('/payment-accounts') });
  const record = useMutation({
    mutationFn: () => api(`/reservations/${row.reservationId}/ota/payouts`, { method: 'POST', idempotencyKey: key.current, body: { paymentAccountId: accountId, amount, reference } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ota-receivables'] }); toast('success', 'Payout recorded'); onClose(); },
  });
  return (
    <Dialog open onClose={onClose} title={`Payout for ${row.number}`} description={`Expected ${row.expectedPayout ? formatINR(row.expectedPayout) : '—'} · received so far ${formatINR(row.received)}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={record.isPending} disabled={!accountId || !amount || reference.trim().length < 2} onClick={() => record.mutate()}>Record payout</Button></>}>
      <div className="flex flex-col gap-4">
        {record.error && <ErrorBanner message={(record.error as Error).message} />}
        <Field label="Into which bank account" required>{(id) => (
          <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose…</option>{(accounts.data ?? []).filter((a) => a.kind === 'bank' || a.kind === 'other').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>)}</Field>
        <Field label="Amount received" required>{(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Payout reference" required hint="From the OTA's payout statement">{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />}</Field>
      </div>
    </Dialog>
  );
}
