'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_REFERENCE_LABEL,
  ACCOUNT_KINDS_FOR_METHOD,
  type PaymentMethod,
  formatINR,
} from '@resortos/shared';
import { api, newIdempotencyKey } from '@/lib/api';
import { useOwnerApproval } from '@/components/ui/owner-pin';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { ErrorBanner } from '@/components/ui/surface';
import type { PaymentAccount } from '@/lib/types';
export function VillaRefundDialog({
  bookingId,
  paid,
  onClose,
}: {
  bookingId: string;
  paid: string;
  onClose: () => void;
}) {
  const key = useRef(newIdempotencyKey());
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState(paid);
  const [reference, setReference] = useState('');
  const approval = useOwnerApproval((ownerAuthorisationId) => refund.mutate(ownerAuthorisationId));
  const accounts = useQuery({
    queryKey: ['payment-accounts'],
    queryFn: () => api<PaymentAccount[]>('/payment-accounts'),
  });
  const refund = useMutation({
    mutationFn: (ownerAuthorisationId?: string) =>
      api(`/villa/bookings/${bookingId}/refund`, {
        method: 'POST',
        idempotencyKey: key.current,
        body: {
          entryType: 'refund',
          method,
          paymentAccountId: account,
          amount,
          reference: reference || undefined,
          ownerAuthorisationId,
        },
      }),
    onSuccess: onClose,
    onError: (e) => approval.handleError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record advance refund"
      description="Record money already returned to the guest. ResortOS does not transfer money."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button
            loading={refund.isPending}
            disabled={!account || !amount}
            onClick={() => refund.mutate(undefined)}
          >
            Record refund
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm">Advance held: {formatINR(paid)}</p>
        {refund.isError && <ErrorBanner message={refund.error.message} />}
        <Field label="Refund amount">
          {(id) => (
            <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          )}
        </Field>
        <Field label="Returned by">
          {(id) => (
            <Select
              id={id}
              value={method}
              onChange={(e) => {
                setMethod(e.target.value as PaymentMethod);
                setAccount('');
              }}
            >
              {(['cash', 'upi', 'card', 'bank_transfer', 'cheque'] as const).map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Paid from">
          {(id) => (
            <Select id={id} value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Choose account</option>
              {accounts.data
                ?.filter((a) => ACCOUNT_KINDS_FOR_METHOD[method]?.includes(a.kind))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        {PAYMENT_REFERENCE_LABEL[method] && (
          <Field label={PAYMENT_REFERENCE_LABEL[method]!}>
            {(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} />}
          </Field>
        )}
        {approval.dialog}
      </div>
    </Dialog>
  );
}
