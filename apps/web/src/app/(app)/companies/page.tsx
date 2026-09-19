'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatDate, formatINR, isValidGstin, money } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Card, CardHeader, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Company, CompanyStatement, PaymentAccount } from '@/lib/types';

/** Company accounts (spec §32): who owes what, for how long, and the statement behind it. */
export default function CompaniesPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Company | 'new' | null>(null);
  const list = useQuery({ queryKey: ['companies', 'all'], queryFn: () => api<Company[]>('/companies', { query: { includeInactive: 'true' } }) });
  const current = selected ?? list.data?.[0]?.id ?? null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Companies" description="Bills moved to a company account, what each company has paid, and what is still owed."
        actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden />Add company</Button>} />
      {list.isLoading ? <Skeleton className="h-40" /> : list.isError ? (
        <ErrorBanner message={(list.error as Error).message} onRetry={() => list.refetch()} />
      ) : list.data!.length === 0 ? (
        <EmptyState icon={<Building2 className="h-5 w-5" />} title="No company accounts yet" description="Add a company to move a guest's bill to it at checkout." />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          <Card className="self-start">
            <ul>
              {list.data!.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setSelected(c.id)}
                    className={cn('flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left text-sm last:border-0', current === c.id ? 'bg-brand-soft' : 'hover:bg-surface-2')}>
                    <span>
                      <span className="font-medium">{c.name}</span>
                      {!c.isActive && <span className="ml-2"><Pill>Inactive</Pill></span>}
                      {c.creditLimit && <span className="block text-xs text-text-3">Limit {formatINR(c.creditLimit)}</span>}
                    </span>
                    <span className={cn('tabular-nums', c.creditLimit && money(c.outstanding ?? 0).gt(c.creditLimit) && 'text-danger')}>{formatINR(c.outstanding ?? '0')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {current && <Statement companyId={current} onEdit={(c) => setEditing(c)} />}
        </div>
      )}
      {editing && <CompanyDialog company={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Statement({ companyId, onEdit }: { companyId: string; onEdit: (c: Company) => void }) {
  const [paying, setPaying] = useState(false);
  const s = useQuery({ queryKey: ['company-statement', companyId], queryFn: () => api<CompanyStatement>(`/companies/${companyId}/statement`) });
  if (s.isLoading) return <Skeleton className="h-64" />;
  if (s.isError) return <ErrorBanner message={(s.error as Error).message} />;
  const st = s.data!;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={st.company.name}
          description={[st.company.gstin && `GSTIN ${st.company.gstin}`, `Pays within ${st.company.paymentTermsDays} days`, st.company.contactPerson].filter(Boolean).join(' · ')}
          action={<div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onEdit(st.company)}>Edit</Button>
            <Button size="sm" onClick={() => setPaying(true)}>Record payment</Button>
          </div>} />
        <div className="grid grid-cols-2 gap-3 border-t border-border p-4 sm:grid-cols-5">
          <div><p className="text-xs text-text-3">Outstanding</p><p className="text-lg font-semibold tabular-nums">{formatINR(st.outstanding)}</p></div>
          {st.ageing.map((a) => (
            <div key={a.label}><p className="text-xs text-text-3">{a.label}</p><p className={cn('tabular-nums', Number(a.amount) > 0 && a.label !== '0–30 days' && 'text-warning')}>{formatINR(a.amount)}</p></div>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader title="Statement" description={`As of ${formatDate(st.asOf)}. Payments settle the oldest bills first.`} />
        {st.lines.length === 0 ? <p className="border-t border-border px-4 py-6 text-sm text-text-3">Nothing yet.</p> : (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-text-3"><tr className="border-b border-border">
                <th scope="col" className="px-4 py-2 font-medium">Date</th><th scope="col" className="px-4 py-2 font-medium">Entry</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Billed</th><th scope="col" className="px-4 py-2 text-right font-medium">Paid</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Balance</th>
              </tr></thead>
              <tbody>
                {st.lines.map((l) => (
                  <tr key={`${l.kind}:${l.id}`} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDate(l.businessDate, { year: false })}</td>
                    <td className="px-4 py-2">{l.reference} <span className="text-xs text-text-3">{l.description}</span></td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(l.debit) ? formatINR(l.debit) : ''}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(l.credit) ? formatINR(l.credit) : ''}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatINR(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {paying && <ReceiptDialog company={st.company} onClose={() => setPaying(false)} />}
    </div>
  );
}

function CompanyDialog({ company, onClose }: { company: Company | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: company?.name ?? '', gstin: company?.gstin ?? '', billingAddress: company?.billingAddress ?? '', contactPerson: company?.contactPerson ?? '',
    phone: company?.phone ?? '', email: company?.email ?? '', creditLimit: company?.creditLimit ?? '', paymentTermsDays: String(company?.paymentTermsDays ?? 30),
    isActive: company?.isActive ?? true,
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, creditLimit: form.creditLimit || undefined, paymentTermsDays: Number(form.paymentTermsDays) };
      return company
        ? api<Company>(`/companies/${company.id}`, { method: 'PATCH', body: { ...body, version: company.version } })
        : api<Company>('/companies', { method: 'POST', body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['companies'] }); void qc.invalidateQueries({ queryKey: ['company-statement'] }); toast('success', 'Company saved'); onClose(); },
  });
  const fields = save.error instanceof ApiError ? save.error.fields : {};
  const gstinBad = form.gstin && !isValidGstin(form.gstin.toUpperCase());
  return (
    <Dialog open onClose={onClose} size="lg" title={company ? `Edit ${company.name}` : 'Add company'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={form.name.trim().length < 2 || Boolean(gstinBad)} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {save.error && <div className="sm:col-span-2"><ErrorBanner message={(save.error as Error).message} /></div>}
        <Field label="Name" required error={fields.name}>{(id) => <Input id={id} value={form.name} onChange={set('name')} maxLength={120} />}</Field>
        <Field label="GSTIN" error={gstinBad ? 'This GSTIN is not valid' : fields.gstin}>{(id) => <Input id={id} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} maxLength={15} />}</Field>
        <Field label="Billing address" className="sm:col-span-2">{(id) => <Input id={id} value={form.billingAddress} onChange={set('billingAddress')} maxLength={300} />}</Field>
        <Field label="Contact person">{(id) => <Input id={id} value={form.contactPerson} onChange={set('contactPerson')} maxLength={80} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} value={form.phone} onChange={set('phone')} maxLength={20} />}</Field>
        <Field label="Email" error={fields.email}>{(id) => <Input id={id} value={form.email} onChange={set('email')} />}</Field>
        <Field label="Credit limit" hint="Above this, moving a bill needs the owner">{(id) => <Input id={id} inputMode="decimal" value={form.creditLimit} onChange={set('creditLimit')} />}</Field>
        <Field label="Pays within (days)">{(id) => <Input id={id} inputMode="numeric" value={form.paymentTermsDays} onChange={set('paymentTermsDays')} />}</Field>
        {company && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />Active</label>
        )}
      </div>
    </Dialog>
  );
}

function ReceiptDialog({ company, onClose }: { company: Company; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = useRef(newIdempotencyKey());
  const [method, setMethod] = useState<'bank_transfer' | 'cheque' | 'upi' | 'cash' | 'card'>('bank_transfer');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const accounts = useQuery({ queryKey: ['payment-accounts'], queryFn: () => api<PaymentAccount[]>('/payment-accounts') });
  const kind = { bank_transfer: 'bank', cheque: 'bank', upi: 'upi', cash: 'cash', card: 'card_pos' }[method];
  const record = useMutation({
    mutationFn: () => api(`/companies/${company.id}/receipts`, { method: 'POST', idempotencyKey: key.current, body: { method, paymentAccountId: accountId, amount, reference: reference || undefined } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['company-statement', company.id] }); void qc.invalidateQueries({ queryKey: ['companies'] }); toast('success', 'Payment recorded'); onClose(); },
  });
  return (
    <Dialog open onClose={onClose} title={`Payment from ${company.name}`} description={`Owes ${formatINR(company.outstanding ?? '0')}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={record.isPending} disabled={!amount || !accountId || (method !== 'cash' && !reference)} onClick={() => record.mutate()}>Record {amount ? formatINR(amount) : 'payment'}</Button></>}>
      <div className="flex flex-col gap-4">
        {record.error && <ErrorBanner message={(record.error as Error).message} />}
        <Field label="How" required>{(id) => (
          <Select id={id} value={method} onChange={(e) => { setMethod(e.target.value as typeof method); setAccountId(''); }}>
            <option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option><option value="upi">UPI</option><option value="card">Card</option><option value="cash">Cash</option>
          </Select>)}</Field>
        <Field label="Into which account" required>{(id) => (
          <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose…</option>
            {(accounts.data ?? []).filter((a) => a.kind === kind).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>)}</Field>
        <Field label="Amount" required>{(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        {method !== 'cash' && <Field label="Reference" required hint="UTR, cheque number…">{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />}</Field>}
      </div>
    </Dialog>
  );
}
