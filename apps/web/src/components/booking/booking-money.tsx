'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ACCOUNT_KINDS_FOR_METHOD, formatINR, OTA_SOURCES, PAYMENT_METHOD_LABELS, PAYMENT_REFERENCE_LABEL, type BookingSource } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Card, CardHeader, ErrorBanner } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import type { OtaTerms, PaymentAccount } from '@/lib/types';

/** An advance taken before arrival (spec §26). It carries to the bill at check-in by itself. */
export function AdvanceDialog({ reservationId, onClose }: { reservationId: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const [method, setMethod] = useState<'cash' | 'upi' | 'card' | 'bank_transfer' | 'cheque'>('upi');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const accounts = useQuery({ queryKey: ['payment-accounts'], queryFn: () => api<PaymentAccount[]>('/payment-accounts') });
  const usable = (accounts.data ?? []).filter((a) => ACCOUNT_KINDS_FOR_METHOD[method]?.includes(a.kind));
  const record = useMutation({
    mutationFn: () => api<{ number: string }>(`/reservations/${reservationId}/advance`, {
      method: 'POST', idempotencyKey: key.current, body: { method, paymentAccountId: accountId, amount, reference: reference || undefined },
    }),
    onSuccess: (p) => { void qc.invalidateQueries({ queryKey: ['reservation', reservationId] }); toast('success', `Advance ${p.number} recorded`); onClose(); },
  });
  const fields = record.error instanceof ApiError ? record.error.fields : {};
  const refLabel = PAYMENT_REFERENCE_LABEL[method];
  return (
    <Dialog open onClose={onClose} title="Record advance" description="Money received before arrival. It counts on the bill when the guest checks in."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={record.isPending} disabled={!amount || !accountId || (Boolean(refLabel) && !reference)} onClick={() => record.mutate()}>Record {amount ? formatINR(amount) : 'advance'}</Button></>}>
      <div className="flex flex-col gap-4">
        {record.error && <ErrorBanner message={(record.error as Error).message} />}
        <Field label="How was it paid" required>{(id) => (
          <Select id={id} value={method} onChange={(e) => { setMethod(e.target.value as typeof method); setAccountId(''); }}>
            {(['upi', 'cash', 'card', 'bank_transfer', 'cheque'] as const).map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
          </Select>)}</Field>
        <Field label="Where did it go" required error={fields.paymentAccountId}>{(id) => (
          <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose…</option>{usable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>)}</Field>
        <Field label="Amount" required error={fields.amount}>{(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        {refLabel && <Field label={refLabel} required error={fields.reference}>{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />}</Field>}
      </div>
    </Dialog>
  );
}

/**
 * OTA terms on a booking from an OTA (spec §33): what the OTA sold it for, what it keeps, and so
 * what it should pay out. The guest's invoice still shows the full room value.
 */
export function OtaPanel({ reservationId, source }: { reservationId: string; source: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const terms = useQuery({
    queryKey: ['ota-terms', reservationId], enabled: OTA_SOURCES.includes(source as BookingSource),
    queryFn: () => api<OtaTerms | null>(`/reservations/${reservationId}/ota`),
  });
  const [form, setForm] = useState<{ paymentMode: 'prepaid_to_ota' | 'pay_at_resort'; grossAmount: string; commissionAmount: string; taxWithheld: string } | null>(null);
  const save = useMutation({
    mutationFn: () => api<OtaTerms>(`/reservations/${reservationId}/ota`, { method: 'PUT', body: { ...form, version: terms.data?.version } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ota-terms', reservationId] }); setForm(null); toast('success', 'OTA terms saved'); },
  });
  if (!OTA_SOURCES.includes(source as BookingSource)) return null;
  const t = terms.data;
  const editing = form !== null;
  return (
    <Card>
      <CardHeader title="OTA terms" description="Commission and payout — the guest's invoice still shows the full room value"
        action={!editing ? <Button size="sm" variant="outline" onClick={() => setForm({
          paymentMode: t?.paymentMode ?? 'prepaid_to_ota', grossAmount: t?.grossAmount ?? '', commissionAmount: t?.commissionAmount ?? '0', taxWithheld: t?.taxWithheld ?? '0',
        })}>{t ? 'Edit' : 'Enter terms'}</Button> : undefined} />
      <div className="p-5 text-sm">
        {editing ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {save.error && <div className="sm:col-span-2"><ErrorBanner message={(save.error as Error).message} /></div>}
            <Field label="Guest paid" required>{(id) => (
              <Select id={id} value={form.paymentMode} onChange={(e) => setForm({ ...form, paymentMode: e.target.value as typeof form.paymentMode })}>
                <option value="prepaid_to_ota">The OTA (prepaid)</option><option value="pay_at_resort">At the resort</option>
              </Select>)}</Field>
            <Field label="Booking value" required>{(id) => <Input id={id} inputMode="decimal" value={form.grossAmount} onChange={(e) => setForm({ ...form, grossAmount: e.target.value })} />}</Field>
            <Field label="Commission">{(id) => <Input id={id} inputMode="decimal" value={form.commissionAmount} onChange={(e) => setForm({ ...form, commissionAmount: e.target.value })} />}</Field>
            <Field label="TCS / TDS deducted" hint="As your CA advises">{(id) => <Input id={id} inputMode="decimal" value={form.taxWithheld} onChange={(e) => setForm({ ...form, taxWithheld: e.target.value })} />}</Field>
            <div className="flex gap-2 sm:col-span-2">
              <Button size="sm" loading={save.isPending} disabled={!form.grossAmount} onClick={() => save.mutate()}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </div>
        ) : t ? (
          <dl className="grid grid-cols-2 gap-3">
            <div><dt className="text-text-3">Guest paid</dt><dd>{t.paymentMode === 'prepaid_to_ota' ? 'The OTA' : 'At the resort'}</dd></div>
            <div><dt className="text-text-3">Booking value</dt><dd className="tabular-nums">{formatINR(t.grossAmount)}</dd></div>
            <div><dt className="text-text-3">Commission + deductions</dt><dd className="tabular-nums">{formatINR((Number(t.commissionAmount) + Number(t.taxWithheld)).toFixed(2))}</dd></div>
            <div><dt className="text-text-3">Expected payout · received</dt><dd className="tabular-nums">{formatINR(t.expectedPayout)} · {formatINR(t.received)}</dd></div>
          </dl>
        ) : <p className="text-text-3">Not entered yet. The OTA receivables report lists this booking until it is.</p>}
      </div>
    </Card>
  );
}
