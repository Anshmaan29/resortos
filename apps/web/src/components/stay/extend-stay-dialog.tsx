'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { ACCOUNT_KINDS_FOR_METHOD, addDays, extendStaySchema, formatDate, nightsBetween, PAYMENT_METHOD_LABELS, PAYMENT_REFERENCE_LABEL, type PaymentMethod } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { DateField } from '@/components/ui/date-field';
import { Field, Input, Select } from '@/components/ui/field';
import { ErrorBanner } from '@/components/ui/surface';
import { useOwnerApproval } from '@/components/ui/owner-pin';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import type { PaymentAccount, StayDetail } from '@/lib/types';

/** One transaction saves the extra nights and, when supplied, money already received. */
export function ExtendStayDialog({ stay, onClose, onDone }: {
  stay: StayDetail; onClose: () => void; onDone: (message: string) => void;
}) {
  const [departure, setDeparture] = useState(addDays(stay.expectedDeparture > stay.businessDate ? stay.expectedDeparture : stay.businessDate, 1));
  const [total, setTotal] = useState('');
  const [paidNow, setPaidNow] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsShift, setNeedsShift] = useState(false);
  const key = useRef(newIdempotencyKey());
  const nights = departure > stay.expectedDeparture ? nightsBetween(stay.expectedDeparture, departure) : 0;
  const accounts = useQuery({ queryKey: ['payment-accounts'], enabled: paidNow, queryFn: () => api<PaymentAccount[]>('/payment-accounts') });
  const usable = (accounts.data ?? []).filter(a => ACCOUNT_KINDS_FOR_METHOD[method]?.includes(a.kind));
  const approval = useOwnerApproval(id => extend.mutate(id));
  const close = () => { if (!extend.isPending) onClose(); };
  const extend = useMutation({
    mutationFn: (ownerAuthorisationId?: string) => {
      const parsed = extendStaySchema.safeParse({
        newDeparture: departure, expectedDeparture: stay.expectedDeparture, totalRoomAmount: total,
        ownerAuthorisationId,
        ...(paidNow ? { payment: { method, paymentAccountId: accountId || undefined, amount, reference: reference || undefined } } : {}),
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check the dates and amount.');
      return api<StayDetail>(`/stays/${stay.id}/extend`, { method: 'POST', idempotencyKey: key.current, body: parsed.data });
    },
    onSuccess: updated => onDone(`Stay extended to ${formatDate(updated.expectedDeparture)}${paidNow ? ' and payment recorded' : ''}`),
    onError: err => {
      if (approval.handleError(err)) return;
      setNeedsShift(err instanceof ApiError && err.details?.action === 'open_shift');
      setError((err as Error).message);
    },
  });
  return <>
    <Dialog open onClose={close} title={`Extend stay · Room ${stay.roomNumber}`} description={`${stay.guestName} · currently due out ${formatDate(stay.expectedDeparture)}`}
      footer={<><Button variant="ghost" onClick={close} disabled={extend.isPending}>Cancel</Button>
        <Button loading={extend.isPending} disabled={!nights || !total || (paidNow && (!amount || !accountId || Boolean(PAYMENT_REFERENCE_LABEL[method] && !reference)))}
          onClick={() => { setError(null); extend.mutate(undefined); }}>{paidNow ? 'Extend & record payment' : 'Extend stay'}</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}
        {needsShift && <Link href="/shifts" className="text-sm text-brand underline">Open your cash shift, then retry. Nothing has been changed.</Link>}
        <Field label="New checkout date" required>{(id, hint) => <DateField id={id} aria-describedby={hint} label="New checkout date" value={departure} onChange={setDeparture} min={addDays(stay.expectedDeparture > stay.businessDate ? stay.expectedDeparture : stay.businessDate, 1)} today={stay.businessDate} />}</Field>
        <Field label="Total for extra nights before GST" required hint={`Combined price for ${nights} extra night${nights === 1 ? '' : 's'}, including extra guests and the existing meal plan. The original stay price is kept.`}>
          {id => <Input id={id} inputMode="decimal" value={total} onChange={e => setTotal(e.target.value)} placeholder="Enter agreed amount" />}
        </Field>
        <p className="text-xs text-text-3">The booking’s GST rate still applies. Room availability is checked before saving.</p>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={paidNow} onChange={e => setPaidNow(e.target.checked)} />Payment received now</label>
        {paidNow && <>
          <Field label="Amount received, including any GST" required>{id => <Input id={id} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />}</Field>
          <Field label="Paid by" required>{id => <Select id={id} value={method} onChange={e => { setMethod(e.target.value as PaymentMethod); setAccountId(''); setReference(''); }}>
            {(['cash','upi','card','bank_transfer'] as const).map(m => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
          </Select>}</Field>
          {accounts.isError && <ErrorBanner message="Could not load payment accounts." onRetry={() => accounts.refetch()} />}
          <Field label="Payment account" required>{id => <Select id={id} value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">{accounts.isLoading ? 'Loading…' : 'Choose account'}</option>
            {usable.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>}</Field>
          {PAYMENT_REFERENCE_LABEL[method] && <Field label={PAYMENT_REFERENCE_LABEL[method]!} required>{id => <Input id={id} value={reference} onChange={e => setReference(e.target.value)} maxLength={80} />}</Field>}
          <p className="text-xs text-text-3">This records money already received; it does not charge the guest.</p>
        </>}
        {!paidNow && <p className="text-xs text-text-3">No payment is recorded. Reception can record it later on the bill.</p>}
      </div>
    </Dialog>
    {approval.dialog}
  </>;
}
