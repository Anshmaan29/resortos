'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState } from 'react';
import {
  ACCOUNT_KINDS_FOR_METHOD, DESK_PAYMENT_METHODS, formatDate, formatINR, money, PAYMENT_METHOD_LABELS,
  PAYMENT_REFERENCE_LABEL, toMoneyString, type PaymentMethod,
} from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useOwnerApproval } from '@/components/ui/owner-pin';
import { ErrorBanner } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import type { Bill, BillPayment, PaymentAccount } from '@/lib/types';

/**
 * Recording money the resort has already been given (spec §25). ResortOS never takes a payment —
 * the card goes through the resort's own machine, UPI through its QR — so every field here is about
 * writing down what happened, in the words the desk would use.
 */
export function RecordPaymentDialog({ bill, stayId, open, onClose }: { bill: Bill; stayId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const approval = useOwnerApproval((authorisationId) => record.mutate(authorisationId));
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<'payment' | 'deposit' | 'refund'>('payment');
  const [error, setError] = useState<string | null>(null);
  const [needsShift, setNeedsShift] = useState(false);
  const refund = kind === 'refund';
  // A deposit is real money, so only the methods that move money are offered for it.
  const methods = DESK_PAYMENT_METHODS.filter((m) => kind !== 'deposit' || ACCOUNT_KINDS_FOR_METHOD[m]);

  const accounts = useQuery({ queryKey: ['payment-accounts'], enabled: open, queryFn: () => api<PaymentAccount[]>('/payment-accounts') });

  // Only the accounts this method can legitimately land in — the same rule the database enforces,
  // so the desk is never offered something that will be refused.
  const allowedKinds = ACCOUNT_KINDS_FOR_METHOD[method];
  const usable = (accounts.data ?? []).filter((a) => allowedKinds?.includes(a.kind));
  const referenceLabel = PAYMENT_REFERENCE_LABEL[method];

  const reset = () => {
    key.current = newIdempotencyKey();
    setAmount(''); setReference(''); setNote(''); setError(null); setNeedsShift(false); setKind('payment');
  };

  const record = useMutation({
    mutationFn: (ownerAuthorisationId?: string) => api<Bill>(`/folios/${bill.id}/payments`, {
      method: 'POST', idempotencyKey: key.current,
      body: {
        entryType: kind, method, amount,
        paymentAccountId: allowedKinds ? accountId || undefined : undefined,
        reference: reference || undefined, note: note || undefined, ownerAuthorisationId,
      },
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['bill', stayId], updated);
      toast('success', `${kind === 'refund' ? 'Refund' : kind === 'deposit' ? 'Security deposit' : 'Payment'} of ${formatINR(amount)} recorded`);
      reset();
      onClose();
    },
    onError: (err) => {
      // A refund is the owner's decision, not the receptionist's (spec §4.5).
      if (approval.handleError(err)) return;
      setNeedsShift(err instanceof ApiError && err.details?.action === 'open_shift');
      setError((err as Error).message);
      toast('error', (err as Error).message);
    },
  });

  const fields = record.error instanceof ApiError ? record.error.fields : {};
  const due = bill.balance ? money(bill.balance) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={refund ? 'Give money back' : kind === 'deposit' ? 'Take a security deposit' : 'Record a payment'}
      description={due && due.gt(0) ? `${formatINR(toMoneyString(due))} is still to pay on this bill` : 'This bill is settled'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={record.isPending} disabled={!amount || (Boolean(allowedKinds) && !accountId)} onClick={() => record.mutate(undefined)}>
            {refund ? 'Record refund' : `Record ${amount ? formatINR(amount) : kind === 'deposit' ? 'deposit' : 'payment'}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}
        {needsShift && (
          <Link href="/shifts" className="text-sm font-medium text-brand underline underline-offset-2">Open your shift</Link>
        )}

        <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="What is this">
          {([['payment', 'Payment'], ['deposit', 'Deposit'], ['refund', 'Refund']] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k}
              onClick={() => { setKind(k); if (k === 'deposit' && !ACCOUNT_KINDS_FOR_METHOD[method]) { setMethod('cash'); setAccountId(''); } }}
              className={kind === k ? 'rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-sm' : 'rounded-md px-3 py-2 text-sm text-text-2'}>
              {label}
            </button>
          ))}
        </div>
        {kind === 'deposit' && <p className="text-xs text-text-3">Held for the guest and returned or applied at checkout. It is not income and does not reduce the bill.</p>}
        {kind === 'refund' && <p className="text-xs text-text-3">Money going back to the guest needs the owner.</p>}

        <Field label="How was it paid" required>
          {(id) => (
            <Select id={id} value={method} onChange={(e) => { setMethod(e.target.value as PaymentMethod); setAccountId(''); }}>
              {methods.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
            </Select>
          )}
        </Field>

        {allowedKinds ? (
          <Field label="Where did it go" required hint="The account the money landed in" error={fields.paymentAccountId}>
            {(id) => (
              <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Choose…</option>
                {usable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            )}
          </Field>
        ) : (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-text-2">
            No money changes hands here — this settles the bill against {method === 'company_account' ? 'the company' : method === 'ota_prepaid' ? 'what the OTA will pay out' : "the guest's credit"}.
          </p>
        )}

        <Field label="Amount" required error={fields.amount}>
          {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={due ? toMoneyString(due) : '0'} />}
        </Field>

        {referenceLabel && (
          <Field label={referenceLabel} required error={fields.reference}>
            {(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />}
          </Field>
        )}

        <Field label="Note" hint="Optional — for staff">
          {(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}
        </Field>

        {approval.dialog}
      </div>
    </Dialog>
  );
}

/** Reversing a payment (spec §25.4): a new record, never an edit. */
export function ReversePaymentDialog({ payment, stayId, onClose }: { payment: BillPayment | null; stayId: string; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const approval = useOwnerApproval((authorisationId) => reverse.mutate(authorisationId));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reverse = useMutation({
    mutationFn: (ownerAuthorisationId?: string) =>
      api<{ number: string }>(`/payments/${payment!.id}/reverse`, {
        method: 'POST', idempotencyKey: key.current, body: { reason: reason.trim(), ownerAuthorisationId },
      }),
    onSuccess: () => {
      key.current = newIdempotencyKey();
      setReason(''); setError(null);
      void queryClient.invalidateQueries({ queryKey: ['bill', stayId] });
      toast('success', 'Payment reversed');
      onClose();
    },
    onError: (err) => {
      if (approval.handleError(err)) return;
      setError((err as Error).message);
      toast('error', (err as Error).message);
    },
  });

  return (
    <Dialog
      open={Boolean(payment)}
      onClose={onClose}
      title={payment ? `Reverse ${payment.number}?` : 'Reverse payment'}
      description={payment
        ? `${formatINR(payment.amount)} taken on ${formatDate(payment.businessDate)}. The original stays on the bill; this adds a matching entry that cancels it.`
        : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Keep it</Button>
          <Button variant="danger" loading={reverse.isPending} disabled={reason.trim().length < 3} onClick={() => reverse.mutate(undefined)}>
            Reverse payment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}
        <Field label="Why" required hint="Shown on the bill next to both entries">
          {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Counted twice" maxLength={300} />}
        </Field>
        {approval.dialog}
      </div>
    </Dialog>
  );
}

/**
 * The security deposit decision at checkout (spec §27). The usual answer is pre-filled: apply what
 * the bill still owes and give back the rest. Anything else is the owner's call, and the server asks.
 */
export function DepositDialog({ bill, stayId, open, onClose }: { bill: Bill; stayId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const approval = useOwnerApproval((authorisationId) => settle.mutate(authorisationId));
  const held = money(bill.depositHeld);
  const due = bill.balance && money(bill.balance).gt(0) ? money(bill.balance) : money(0);
  const suggestedAdjust = due.gt(held) ? held : due;
  const [adjust, setAdjust] = useState(toMoneyString(suggestedAdjust));
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [accountId, setAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const accounts = useQuery({ queryKey: ['payment-accounts'], enabled: open, queryFn: () => api<PaymentAccount[]>('/payment-accounts') });
  const usable = (accounts.data ?? []).filter((a) => ACCOUNT_KINDS_FOR_METHOD[method]?.includes(a.kind));
  const refund = held.minus(money(adjust || '0'));

  const settle = useMutation({
    mutationFn: (ownerAuthorisationId?: string) => api<Bill>(`/folios/${bill.id}/deposit/settle`, {
      method: 'POST', idempotencyKey: key.current,
      body: {
        adjust: adjust || '0', refund: toMoneyString(refund),
        ...(refund.gt(0) ? { refundMethod: method, refundAccountId: accountId || undefined, reference: reference || undefined } : {}),
        ownerAuthorisationId,
      },
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['bill', stayId], updated);
      key.current = newIdempotencyKey();
      toast('success', 'Security deposit settled');
      onClose();
    },
    onError: (err) => {
      if (approval.handleError(err)) return;
      setError((err as Error).message);
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Security deposit"
      description={`${formatINR(toMoneyString(held))} held · the bill still owes ${formatINR(toMoneyString(due))}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={settle.isPending} disabled={refund.isNegative() || (refund.gt(0) && !accountId)} onClick={() => settle.mutate(undefined)}>
            {refund.gt(0) ? `Give back ${formatINR(toMoneyString(refund))}` : 'Apply to bill'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}
        <Field label="Apply to the bill" hint="What the bill still owes is filled in for you">
          {(id) => <Input id={id} inputMode="decimal" value={adjust} onChange={(e) => setAdjust(e.target.value)} />}
        </Field>
        <p className="text-sm">Give back to the guest: <strong className="tabular-nums">{refund.isNegative() ? '—' : formatINR(toMoneyString(refund))}</strong></p>
        {refund.gt(0) && (
          <>
            <Field label="How it goes back" required>
              {(id) => (
                <Select id={id} value={method} onChange={(e) => { setMethod(e.target.value as PaymentMethod); setAccountId(''); }}>
                  {(['cash', 'upi', 'card', 'bank_transfer', 'cheque'] as const).map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
                </Select>
              )}
            </Field>
            <Field label="From which account" required>
              {(id) => (
                <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">Choose…</option>
                  {usable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              )}
            </Field>
            {method !== 'cash' && (
              <Field label="Reference">
                {(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />}
              </Field>
            )}
          </>
        )}
        {approval.dialog}
      </div>
    </Dialog>
  );
}
