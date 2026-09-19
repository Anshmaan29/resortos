'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Receipt, Undo2 } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  ADDABLE_LINE_TYPES, FOLIO_LINE_TYPE_LABELS, formatDate, formatINR, money, toMoneyString,
  type AddableLineType,
} from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Card, CardHeader, EmptyState, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, newIdempotencyKey, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Bill, BillLine, ChargeItem } from '@/lib/types';

/** Staff word is "Bill", never "folio" (CLAUDE.md conventions). */
export function BillPanel({ stayId, canEdit }: { stayId: string; canEdit: boolean }) {
  const [addOpen, setAddOpen] = useState(false);
  const [voiding, setVoiding] = useState<BillLine | null>(null);

  const bill = useQuery({ queryKey: ['bill', stayId], queryFn: () => api<Bill>(`/stays/${stayId}/bill`) });

  if (bill.isLoading) return <Skeleton className="h-64" />;
  if (bill.isError) return <ErrorBanner message={(bill.error as Error).message} onRetry={() => bill.refetch()} />;
  const b = bill.data!;

  return (
    <Card>
      <CardHeader
        title="Bill"
        description={`${b.number} · charges are added against the business date they belong to`}
        action={canEdit && b.status === 'open' ? (
          <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />Add charge
          </Button>
        ) : undefined}
      />

      {b.lines.length === 0 ? (
        <EmptyState
          icon={<Receipt className="h-5 w-5" />}
          title="Nothing on the bill yet"
          description="Room charges are posted by night audit each night. Anything else is added here."
        />
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">Charges on bill {b.number}</caption>
            <thead className="text-left text-text-3">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-2 font-medium">Date</th>
                <th scope="col" className="px-4 py-2 font-medium">Charge</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Qty</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Rate</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                {canEdit && <th scope="col" className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody>
              {b.lines.map((line) => (
                <tr key={line.id} className={cn('border-b border-border last:border-0', line.voided && 'text-text-3')}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDate(line.businessDate, { year: false })}</td>
                  <td className="px-4 py-2">
                    <span className={cn(line.voided && 'line-through')}>{line.name}</span>
                    {line.lineType !== 'other' && (
                      <span className="ml-2 text-xs text-text-3">{FOLIO_LINE_TYPE_LABELS[line.lineType]}</span>
                    )}
                    {line.voided && (
                      // Removed lines stay on the bill with the reason: the record of what happened
                      // is the point, not a tidy list.
                      <p className="mt-0.5 text-xs">Removed by {line.voidedBy} — {line.voidReason}</p>
                    )}
                    {line.note && !line.voided && <p className="mt-0.5 text-xs text-text-3">{line.note}</p>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{line.quantity}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatINR(line.unitRate)}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', line.voided && 'line-through')}>{formatINR(line.amount)}</td>
                  {canEdit && (
                    <td className="px-4 py-2 text-right">
                      {!line.voided && b.status === 'open' && (
                        <Button size="sm" variant="ghost" onClick={() => setVoiding(line)} aria-label={`Remove ${line.name}`}>
                          <Undo2 className="h-4 w-4" aria-hidden />Remove
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="flex flex-col gap-1.5 border-t border-border p-4 text-sm">
        <Row k="Charges before GST" v={formatINR(b.charges)} />
        {b.tax.available ? (
          <>
            {b.tax.groups.map((g) => (
              <Row key={g.ratePercent} k={`GST at ${Number(g.ratePercent)}% (estimated)`} v={formatINR(toMoneyString(money(g.cgst).plus(g.sgst).plus(g.igst)))} muted />
            ))}
            {Number(b.tax.roundOff) !== 0 && <Row k="Round off" v={formatINR(b.tax.roundOff!)} muted />}
          </>
        ) : (
          <p className="text-warning">{b.tax.message}</p>
        )}
        <Row k="Paid" v={formatINR(b.paid)} muted />
        <Row k="Balance" v={b.balance ? formatINR(b.balance) : '—'} strong />
      </dl>

      {b.tax.usesPlaceholderRates && (
        <p className="border-t border-border px-4 py-2 text-xs text-warning">
          GST here uses placeholder rates. The real rates must be confirmed before any guest is billed.
        </p>
      )}

      <AddChargeDialog bill={b} stayId={stayId} open={addOpen} onClose={() => setAddOpen(false)} />
      <VoidLineDialog line={voiding} stayId={stayId} onClose={() => setVoiding(null)} />
    </Card>
  );
}

function Row({ k, v, muted, strong }: { k: string; v: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4', strong && 'border-t border-border pt-2 text-base font-semibold')}>
      <dt className={cn(muted ? 'text-text-3' : 'text-text-2')}>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}

function AddChargeDialog({ bill, stayId, open, onClose }: { bill: Bill; stayId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const [lineType, setLineType] = useState<AddableLineType>('food');
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitRate, setUnitRate] = useState('');
  const [note, setNote] = useState('');
  const [chargeItemId, setChargeItemId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  const items = useQuery({ queryKey: ['charge-items'], enabled: open, queryFn: () => api<ChargeItem[]>('/charge-items') });

  const reset = () => {
    key.current = newIdempotencyKey();
    setName(''); setQuantity('1'); setUnitRate(''); setNote(''); setChargeItemId(undefined); setError(null);
  };

  const add = useMutation({
    mutationFn: () => api<Bill>(`/folios/${bill.id}/charges`, {
      method: 'POST', idempotencyKey: key.current,
      body: { lineType, name: name.trim(), quantity: Number(quantity), unitRate, chargeItemId, note: note || undefined },
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['bill', stayId], updated);
      toast('success', `${name.trim()} added to the bill`);
      reset();
      onClose();
    },
    onError: (err) => {
      setError((err as Error).message);
      toast('error', (err as Error).message);
    },
  });

  const total = unitRate && quantity ? money(unitRate).times(Number(quantity) || 0) : money(0);
  const fields = add.error instanceof ApiError ? add.error.fields : {};

  /** Picking a saved item fills the form in; the name stays editable, because it is what the invoice shows. */
  const pick = (id: string) => {
    const item = items.data?.find((i) => i.id === id);
    if (!item) { setChargeItemId(undefined); return; }
    setChargeItemId(item.id);
    setLineType(item.lineType);
    setName(item.name);
    setUnitRate(item.defaultRate);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add charge"
      description={`On ${formatDate(bill.businessDate, { weekday: true })} — today's business date`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={add.isPending} disabled={!name.trim() || !unitRate} onClick={() => add.mutate()}>
            Add {Number(total) > 0 ? formatINR(toMoneyString(total)) : ''} to bill
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}

        {(items.data?.length ?? 0) > 0 && (
          <Field label="Saved item">
            {(id) => (
              <Select id={id} value={chargeItemId ?? ''} onChange={(e) => pick(e.target.value)}>
                <option value="">Type a new charge instead</option>
                {items.data!.map((item) => (
                  <option key={item.id} value={item.id}>{item.name} — {formatINR(item.defaultRate)}</option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <Field label="Type" required>
          {(id) => (
            <Select id={id} value={lineType} onChange={(e) => setLineType(e.target.value as AddableLineType)}>
              {ADDABLE_LINE_TYPES.map((t) => <option key={t} value={t}>{FOLIO_LINE_TYPE_LABELS[t]}</option>)}
            </Select>
          )}
        </Field>

        <Field label="What it is for" required hint="This is what the guest sees on the invoice" error={fields.name}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Paneer Tikka" maxLength={120} />}
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Quantity" required error={fields.quantity}>
            {(id) => <Input id={id} type="number" min="0.001" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
          </Field>
          <Field label="Rate" required error={fields.unitRate}>
            {(id) => <Input id={id} inputMode="decimal" value={unitRate} onChange={(e) => setUnitRate(e.target.value)} placeholder="280" />}
          </Field>
        </div>

        <Field label="Note" hint="Optional — for staff, not shown on the invoice">
          {(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}
        </Field>

        <p className="text-xs text-text-3">GST is worked out from the type and the date — you never pick a rate.</p>
      </div>
    </Dialog>
  );
}

function VoidLineDialog({ line, stayId, onClose }: { line: BillLine | null; stayId: string; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => api<Bill>(`/folio-lines/${line!.id}/void`, {
      method: 'POST', idempotencyKey: key.current, body: { reason: reason.trim() },
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['bill', stayId], updated);
      key.current = newIdempotencyKey();
      setReason(''); setError(null);
      toast('success', 'Charge removed from the bill');
      onClose();
    },
    onError: (err) => {
      setError((err as Error).message);
      toast('error', (err as Error).message);
    },
  });

  return (
    <Dialog
      open={Boolean(line)}
      onClose={onClose}
      title={line ? `Remove ${line.name}?` : 'Remove charge'}
      description="The line stays on the bill, crossed out, with your reason. Nothing is deleted."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Keep it</Button>
          <Button variant="danger" loading={remove.isPending} disabled={reason.trim().length < 3} onClick={() => remove.mutate()}>
            Remove charge
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}
        <Field label="Why" required hint="Shown on the bill next to the removed line">
          {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Added to the wrong room" maxLength={300} />}
        </Field>
      </div>
    </Dialog>
  );
}
