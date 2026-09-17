'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Lock } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatDate } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { api, newIdempotencyKey } from '@/lib/api';
import type { CheckoutPreview, StayDetail } from '@/lib/types';

/**
 * Checkout (spec §22). Today this is a stay and room status change: the bill, payment and invoice
 * steps arrive with Phase 2.
 *
 * The screen is laid out around the server's checkout pipeline rather than around what exists now.
 * `checkout-preview` returns the registered steps and whatever each one says is blocking; this
 * renders that list. When Phase 2 registers `bill-review`, `settlement`, `security-deposit` and
 * `invoice-finalize`, their blockers ("balance ₹4,500 is unpaid", "record the deposit decision")
 * appear here with no change to this component, and each step gets its own section below the
 * summary — the same pattern as "Before check-in" on the booking screen.
 */
const STEP_TITLES: Record<string, string> = {
  'bill-review': 'Bill',
  settlement: 'Payment',
  'security-deposit': 'Security deposit',
  'invoice-finalize': 'Invoice',
};

export function CheckoutDialog({ stay, open, onClose, onDone }: {
  stay: StayDetail; open: boolean; onClose: () => void; onDone: (message: string) => void;
}) {
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  const preview = useQuery({
    queryKey: ['checkout-preview', stay.id],
    enabled: open,
    queryFn: () => api<CheckoutPreview>(`/stays/${stay.id}/checkout-preview`),
  });

  const checkout = useMutation({
    mutationFn: () => api<StayDetail>(`/stays/${stay.id}/checkout`, {
      method: 'POST',
      idempotencyKey: key.current,
      // Phase 2 steps read their own input from this object, keyed by step name.
      body: { steps: {} },
    }),
    onSuccess: () => {
      key.current = newIdempotencyKey();
      setFormError(null);
      onDone(`Room ${stay.roomNumber} checked out`);
    },
    onError: (err) => {
      setFormError((err as Error).message);
      toast('error', (err as Error).message);
      void preview.refetch();
    },
  });

  const blockers = preview.data?.blockers ?? [];
  const early = preview.data?.earlyDeparture ?? false;
  const steps = preview.data?.steps ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Check out room ${stay.roomNumber}?`}
      description={`${stay.guestName} · booking ${stay.reservationNumber}`}
      footer={<>
        <Button variant="outline" onClick={onClose}>Not yet</Button>
        <Button disabled={preview.isLoading || blockers.length > 0} loading={checkout.isPending} onClick={() => { setFormError(null); checkout.mutate(); }}>
          Check out
        </Button>
      </>}
    >
      <div className="flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-2 gap-3">
          <div><dt className="text-text-3">Checked in</dt><dd className="mt-0.5 font-medium num">{formatDate(stay.businessDateIn)}</dd></div>
          <div><dt className="text-text-3">Due out</dt><dd className="mt-0.5 font-medium num">{formatDate(stay.expectedDeparture)}</dd></div>
        </dl>

        {early && (
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-warning">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              The guest is leaving early — {formatDate(stay.expectedDeparture)} was the expected departure.
              Charges for the nights actually stayed are worked out when billing arrives (Phase 2); the stay is recorded as an early departure.
            </span>
          </p>
        )}

        {blockers.length > 0 ? (
          <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5">
            <p className="font-medium text-text">Before checkout</p>
            <ul className="mt-1 list-disc pl-5 text-text-2">
              {blockers.map((b) => <li key={`${b.step}:${b.message}`}>{b.message}</li>)}
            </ul>
          </div>
        ) : (
          <p className="flex items-start gap-2 rounded-md border border-success/30 bg-success-soft px-3 py-2.5 text-success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>Nothing is blocking this checkout.</span>
          </p>
        )}

        {steps.length > 0 && (
          <ul className="flex flex-col gap-1 text-text-2">
            {steps.map((s) => <li key={s}>{STEP_TITLES[s] ?? s}</li>)}
          </ul>
        )}

        <p className="flex items-start gap-2 text-text-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            After checkout the stay can no longer be changed and room {stay.roomNumber} becomes dirty for housekeeping.
            The booking and every document are kept in history.
          </span>
        </p>

        {formError && <p role="alert" className="text-danger">{formError}</p>}
      </div>
    </Dialog>
  );
}
