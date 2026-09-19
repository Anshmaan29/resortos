'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatDate, formatINR, money, PAYMENT_ACCOUNT_KIND_LABELS, PAYMENT_ENTRY_TYPE_LABELS, PAYMENT_METHOD_LABELS, toMoneyString } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Card, CardHeader, ErrorBanner } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, apiUrl, newIdempotencyKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Shift } from '@/lib/types';

/**
 * One cashier shift (spec §34): what it opened with, what came in per account, and — while it is
 * open — the close form. The expected figures come from the server, summed from the ledger rows;
 * the screen only ever shows the difference against what was counted.
 */
export function ShiftView({ shift, canClose }: { shift: Shift; canClose: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const [counted, setCounted] = useState('');
  const [pos, setPos] = useState('');
  const [reason, setReason] = useState('');
  const [handover, setHandover] = useState('');

  const cashDiff = counted ? money(counted).minus(shift.expectedCash) : null;
  const cardDiff = pos ? money(pos).minus(shift.expectedCard) : null;
  const needsReason = Boolean((cashDiff && cashDiff.abs().gt(shift.cashDifferenceThreshold)) || (cardDiff && !cardDiff.isZero()));
  const hasCard = shift.accounts.some((a) => a.kind === 'card_pos');

  const close = useMutation({
    mutationFn: () => api<Shift>(`/shifts/${shift.id}/close`, {
      method: 'POST', idempotencyKey: key.current,
      body: {
        countedCash: counted, posBatchTotal: pos || undefined, differenceReason: reason || undefined,
        handoverNote: handover || undefined, version: shift.version,
      },
    }),
    onSuccess: (closed) => {
      key.current = newIdempotencyKey();
      qc.setQueryData(['shift', shift.id], closed);
      void qc.invalidateQueries({ queryKey: ['shift-current'] });
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      toast('success', 'Shift closed');
    },
  });
  const fields = close.error instanceof ApiError ? close.error.fields : {};

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title={`${shift.openedBy}'s shift`}
          description={`Business date ${formatDate(shift.businessDate)} · opened ${new Date(shift.openedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`
            + (shift.closedAt ? ` · closed ${new Date(shift.closedAt).toLocaleString('en-IN', { timeStyle: 'short' })} by ${shift.closedBy}` : '')}
          action={
            <div className="flex items-center gap-2">
              <Pill tone={shift.status === 'open' ? 'brand' : 'neutral'}>{shift.status === 'open' ? 'Open' : 'Closed'}</Pill>
              {shift.status === 'closed' && (
                <Button size="sm" variant="outline" onClick={() => window.open(apiUrl(`/shifts/${shift.id}/report.pdf`), '_blank')}>
                  <Printer className="h-4 w-4" aria-hidden />Shift report
                </Button>
              )}
            </div>
          }
        />
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">Expected against counted</caption>
            <thead className="text-left text-text-3">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-2 font-medium" />
                <th scope="col" className="px-4 py-2 text-right font-medium">Expected</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Counted</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <th scope="row" className="px-4 py-2 text-left font-medium">Cash <span className="font-normal text-text-3">(opened with {formatINR(shift.openingCash)})</span></th>
                <td className="px-4 py-2 text-right tabular-nums">{formatINR(shift.expectedCash)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{shift.countedCash ? formatINR(shift.countedCash) : counted ? formatINR(toMoneyString(money(counted))) : '—'}</td>
                <Diff value={shift.cashDifference ?? (cashDiff ? toMoneyString(cashDiff) : null)} />
              </tr>
              <tr className="border-b border-border">
                <th scope="row" className="px-4 py-2 text-left font-medium">Card (POS slip)</th>
                <td className="px-4 py-2 text-right tabular-nums">{formatINR(shift.expectedCard)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{shift.posBatchTotal ? formatINR(shift.posBatchTotal) : pos ? formatINR(toMoneyString(money(pos))) : '—'}</td>
                <Diff value={shift.cardDifference ?? (cardDiff ? toMoneyString(cardDiff) : null)} />
              </tr>
              {shift.accounts.filter((a) => a.kind !== 'cash' && a.kind !== 'card_pos').map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <th scope="row" className="px-4 py-2 text-left font-normal text-text-2">{a.name} <span className="text-text-3">({PAYMENT_ACCOUNT_KIND_LABELS[a.kind]})</span></th>
                  <td className="px-4 py-2 text-right tabular-nums">{formatINR(a.amount)}</td>
                  <td className="px-4 py-2 text-right text-text-3">—</td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shift.differenceReason && <p className="border-t border-border px-4 py-3 text-sm"><span className="text-text-3">Reason given:</span> {shift.differenceReason}</p>}
        {shift.handoverNote && <p className="border-t border-border px-4 py-3 text-sm"><span className="text-text-3">Handover:</span> {shift.handoverNote}</p>}
      </Card>

      {shift.status === 'open' && canClose && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">Close shift</h2>
          <div className="flex flex-col gap-4">
            {close.error && <ErrorBanner message={(close.error as Error).message} />}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cash counted in the drawer" required error={fields.countedCash}>
                {(id) => <Input id={id} inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />}
              </Field>
              {hasCard && (
                <Field label="Card machine settlement total" hint="From the POS slip">
                  {(id) => <Input id={id} inputMode="decimal" value={pos} onChange={(e) => setPos(e.target.value)} />}
                </Field>
              )}
            </div>
            {needsReason && (
              <Field label="Why is there a difference" required error={fields.differenceReason}
                hint={`Cash differences over ${formatINR(shift.cashDifferenceThreshold)} are shown to the owner`}>
                {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
              </Field>
            )}
            <Field label="Handover note" hint="For whoever is on the desk next">
              {(id) => <Textarea id={id} rows={2} value={handover} onChange={(e) => setHandover(e.target.value)} maxLength={500} />}
            </Field>
            <div className="flex justify-end">
              <Button loading={close.isPending} disabled={!counted || (needsReason && reason.trim().length < 3)} onClick={() => close.mutate()}>
                Close shift
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Taken in this shift" description={`${shift.payments.length} entr${shift.payments.length === 1 ? 'y' : 'ies'}`} />
        {shift.payments.length > 0 && (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-sm">
              <tbody>
                {shift.payments.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-3">{new Date(p.at).toLocaleTimeString('en-IN', { timeStyle: 'short' })}</td>
                    <td className="px-4 py-2">
                      {p.isReversal ? 'Reversal · ' : ''}{PAYMENT_ENTRY_TYPE_LABELS[p.entryType]} · {PAYMENT_METHOD_LABELS[p.method]}
                      <span className="ml-2 text-xs text-text-3">{p.number}{p.accountName ? ` · ${p.accountName}` : ''}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatINR(p.cashEffect)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Diff({ value }: { value: string | null }) {
  if (value === null) return <td className="px-4 py-2 text-right text-text-3">—</td>;
  const d = money(value);
  return (
    <td className={cn('px-4 py-2 text-right font-medium tabular-nums', d.isZero() ? 'text-success' : d.isNegative() ? 'text-danger' : 'text-warning')}>
      {d.isZero() ? '✓' : `${d.isNegative() ? '−' : '+'}${formatINR(toMoneyString(d.abs()))}`}
    </td>
  );
}
