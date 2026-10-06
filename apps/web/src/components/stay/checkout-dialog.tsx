'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, IndianRupee, Lock } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatDate, formatINR, isValidGstin, money } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { useOwnerApproval } from '@/components/ui/owner-pin';
import { useToast } from '@/components/ui/toast';
import { api, newIdempotencyKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Bill, CheckoutPreview, InvoicePreview, StayDetail } from '@/lib/types';
import { DepositDialog, RecordPaymentDialog } from './payment-dialogs';

/**
 * Checkout (spec §22): settle, invoice, leave — in one transaction on the server.
 *
 * The screen is laid out around the server's checkout pipeline. `checkout-preview` returns what
 * each registered step says is blocking (a deposit still held, money still owed), and each blocker
 * comes with the action that clears it, on this same screen. The invoice shown here is the exact
 * one checkout will issue, less its number, which is only taken at the moment it is final (§31).
 */
export function CheckoutDialog({ stay, open, onClose, onDone }: {
  stay: StayDetail; open: boolean; onClose: () => void; onDone: (message: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [business, setBusiness] = useState(false);
  const [buyerName, setBuyerName] = useState('');
  const [buyerGstin, setBuyerGstin] = useState('');
  const [buyerAddress, setBuyerAddress] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const key = useRef(newIdempotencyKey());
  const approval = useOwnerApproval((authorisationId) => checkout.mutate(authorisationId));

  const preview = useQuery({
    queryKey: ['checkout-preview', stay.id],
    enabled: open,
    queryFn: async () => {
      const result = await api<CheckoutPreview>(`/stays/${stay.id}/checkout-preview`);
      // The server has now completed any missing elapsed room charges. Refresh the same bill
      // used by payment and invoice preview before allowing the guest's final settlement.
      const updated = await api<Bill>(`/stays/${stay.id}/bill`);
      qc.setQueryData(['bill', stay.id], updated);
      return result;
    },
  });
  const bill = useQuery({ queryKey: ['bill', stay.id], enabled: open && preview.isSuccess && !preview.isFetching, queryFn: () => api<Bill>(`/stays/${stay.id}/bill`) });
  const gstinOk = !buyerGstin || isValidGstin(buyerGstin.trim().toUpperCase());
  const buyer = business && buyerName.trim().length >= 2 && gstinOk
    ? { name: buyerName.trim(), gstin: buyerGstin.trim().toUpperCase() || undefined, address: buyerAddress.trim() || undefined }
    : undefined;
  const invoice = useQuery({
    queryKey: ['invoice-preview', bill.data?.id, buyer],
    enabled: open && preview.isSuccess && !preview.isFetching && Boolean(bill.data?.id),
    queryFn: () => api<InvoicePreview>(`/folios/${bill.data!.id}/invoice/preview`, { method: 'POST', body: { buyer } }),
  });

  const refresh = () => {
    void preview.refetch();
    void qc.invalidateQueries({ queryKey: ['invoice-preview'] });
  };

  const checkout = useMutation({
    mutationFn: (ownerAuthorisationId?: string) => api<StayDetail>(`/stays/${stay.id}/checkout`, {
      method: 'POST',
      idempotencyKey: key.current,
      // Each billing step reads its own input from this object, keyed by step name.
      body: { steps: { settlement: { pendingBalance: pending, ownerAuthorisationId }, invoice: { buyer } } },
    }),
    onSuccess: () => {
      key.current = newIdempotencyKey();
      setFormError(null);
      void qc.invalidateQueries({ queryKey: ['bill', stay.id] });
      onDone(`Room ${stay.roomNumber} checked out${invoice.data?.lines.length ? ' and the invoice issued' : ''}`);
    },
    onError: (err) => {
      if (approval.handleError(err)) return;
      setFormError((err as Error).message);
      toast('error', (err as Error).message);
      void preview.refetch();
    },
  });

  const b = bill.data;
  const balance = b?.balance ? money(b.balance) : null;
  // Leaving with money owed is a real option, but only the owner can allow it (§22).
  const blockers = (preview.data?.blockers ?? []).filter((x) => !(x.step === 'settlement' && pending && balance?.gt(0)));
  const early = preview.data?.earlyDeparture ?? false;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Check out room ${stay.roomNumber}?`}
      description={`${stay.guestName} · booking ${stay.reservationNumber}`}
      footer={<>
        <Button variant="outline" onClick={onClose}>Not yet</Button>
        <Button disabled={!preview.isSuccess || preview.isFetching || invoice.isFetching || bill.isFetching || !invoice.isSuccess || blockers.length > 0 || (business && !buyer)} loading={checkout.isPending}
          onClick={() => { setFormError(null); checkout.mutate(undefined); }}>
          {invoice.data?.lines.length ? 'Issue invoice and check out' : 'Check out'}
        </Button>
      </>}
    >
      <div className="flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-3 gap-3">
          <div><dt className="text-text-3">Checked in</dt><dd className="mt-0.5 font-medium num">{formatDate(stay.businessDateIn)}</dd></div>
          <div><dt className="text-text-3">Due out</dt><dd className="mt-0.5 font-medium num">{formatDate(stay.expectedDeparture)}</dd></div>
          <div><dt className="text-text-3">Balance</dt><dd className={cn('mt-0.5 font-semibold num', balance?.gt(0) && 'text-warning')}>{b?.balance ? formatINR(b.balance) : '—'}</dd></div>
        </dl>

        {early && (
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-warning">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              The guest is leaving early — {formatDate(stay.expectedDeparture)} was the expected departure. Only the nights
              actually stayed are on the bill, with a minimum of one night for same-day checkout. Unused future nights are not charged automatically.
            </span>
          </p>
        )}

        {!preview.isSuccess || preview.isFetching || bill.isFetching ? (
          <p role="status" className="text-text-2">Checking the complete bill before checkout…</p>
        ) : blockers.length > 0 ? (
          <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5">
            <p className="font-medium text-text">Before checkout</p>
            <ul className="mt-1 flex flex-col gap-2 text-text-2">
              {blockers.map((x) => (
                <li key={`${x.step}:${x.message}`} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{x.message}</span>
                  {x.step === 'settlement' && balance?.gt(0) && (
                    <Button size="sm" onClick={() => setPayOpen(true)}><IndianRupee className="h-4 w-4" aria-hidden />Record payment</Button>
                  )}
                  {x.step === 'settlement' && balance?.isNegative() && (
                    <Button size="sm" variant="outline" onClick={() => setPayOpen(true)}>Record refund</Button>
                  )}
                  {x.step === 'deposit' && <Button size="sm" onClick={() => setDepositOpen(true)}>Settle deposit</Button>}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="flex items-start gap-2 rounded-md border border-success/30 bg-success-soft px-3 py-2.5 text-success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{pending ? 'The owner will be asked to allow checkout with the balance pending.' : 'Nothing is blocking this checkout.'}</span>
          </p>
        )}

        {balance?.gt(0) && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={pending} onChange={(e) => setPending(e.target.checked)} />
            <span>Let the guest leave with {formatINR(b!.balance!)} still to pay — recorded as owed, needs the owner</span>
          </label>
        )}

        {invoice.data && invoice.data.lines.length > 0 && (
          <div className="rounded-lg border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <p className="font-medium">{invoice.data.documentType === 'bill_of_supply' ? 'Bill of supply' : 'Tax invoice'} to be issued</p>
              <label className="flex items-center gap-2 text-text-2">
                <input type="checkbox" className="h-4 w-4" checked={business} onChange={(e) => setBusiness(e.target.checked)} />
                Bill a business (GSTIN)
              </label>
            </div>
            {business && (
              <div className="grid gap-3 border-b border-border p-3 sm:grid-cols-2">
                <Field label="Business name" required>
                  {(id) => <Input id={id} value={buyerName} onChange={(e) => setBuyerName(e.target.value)} maxLength={120} />}
                </Field>
                <Field label="GSTIN" error={gstinOk ? undefined : 'This GSTIN is not valid'}>
                  {(id) => <Input id={id} value={buyerGstin} onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())} maxLength={15} />}
                </Field>
                <Field label="Billing address" className="sm:col-span-2">
                  {(id) => <Input id={id} value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} maxLength={300} />}
                </Field>
              </div>
            )}
            <dl className="flex flex-col gap-1 p-3">
              <Line k={`Billed to ${invoice.data.buyer.name}${invoice.data.buyer.gstin ? ` · ${invoice.data.buyer.gstin}` : ''}`} v="" />
              <Line k="Taxable value" v={formatINR(invoice.data.taxableTotal)} />
              {invoice.data.groups.filter((g) => Number(g.ratePercent) > 0).map((g) => (
                <Line key={g.ratePercent} k={`${Number(g.igst) ? 'IGST' : 'CGST + SGST'} at ${Number(g.ratePercent)}%`} v={formatINR(money(g.cgst).plus(g.sgst).plus(g.igst).toFixed(2))} />
              ))}
              {Number(invoice.data.roundOff) !== 0 && <Line k="Round off" v={formatINR(invoice.data.roundOff)} />}
              <Line k="Invoice total" v={formatINR(invoice.data.grandTotal)} strong />
            </dl>
          </div>
        )}

        <p className="flex items-start gap-2 text-text-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            After checkout the stay and the invoice cannot be changed, and room {stay.roomNumber} becomes dirty for housekeeping.
            A mistake on the invoice is corrected with a credit note.
          </span>
        </p>

        {(formError || preview.error || bill.error || invoice.error) && <p role="alert" className="text-danger">{formError ?? (preview.error || bill.error || invoice.error)?.message}</p>}
        {approval.dialog}
      </div>

      {b && payOpen && <RecordPaymentDialog bill={b} stayId={stay.id} open={payOpen} onClose={() => { setPayOpen(false); refresh(); }} />}
      {b && depositOpen && <DepositDialog bill={b} stayId={stay.id} open={depositOpen} onClose={() => { setDepositOpen(false); refresh(); }} />}
    </Dialog>
  );
}

function Line({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4', strong && 'border-t border-border pt-1.5 font-semibold')}>
      <dt className="text-text-2">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}
