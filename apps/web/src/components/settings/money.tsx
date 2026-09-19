'use client';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { ADDABLE_LINE_TYPES, DEFAULT_TAX_CATEGORY, FOLIO_LINE_TYPE_LABELS, formatINR, PAYMENT_ACCOUNT_KIND_LABELS, PAYMENT_ACCOUNT_KINDS, TAX_CATEGORIES, type AddableLineType, type PaymentAccountKind } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import type { ChargeItem, PaymentAccount } from '@/lib/types';
import { Row, Section, Toggle, useSave } from './common';

/** The quick-pick list behind "Add charge" (spec §24.2) — a list, not a menu system. */
export function ChargeItemsSettings() {
  const items = useQuery({ queryKey: ['charge-items', 'all'], queryFn: () => api<ChargeItem[]>('/charge-items', { query: { includeInactive: 'true' } }) });
  const [edit, setEdit] = useState<ChargeItem | 'new' | null>(null);
  if (!items.data) return <Skeleton className="h-64" />;
  return (
    <Section title="Charge items" description="Filled in for the desk when adding a charge. The name is what the invoice shows; GST comes from the tax category."
      action={<Button size="sm" onClick={() => setEdit('new')}><Plus className="h-4 w-4" aria-hidden />Add item</Button>}>
      {items.data.length === 0 && <p className="px-4 py-6 text-sm text-text-3">No items yet. The desk can always type a charge by name.</p>}
      {items.data.map((i) => (
        <Row key={i.id} muted={!i.isActive}>
          <span><span className="font-medium">{i.name}</span> <span className="text-text-3">{FOLIO_LINE_TYPE_LABELS[i.lineType]} · GST as {i.taxCategory}</span>{!i.isActive && <span className="ml-2"><Pill>Off</Pill></span>}</span>
          <span className="flex items-center gap-3"><span className="tabular-nums">{formatINR(i.defaultRate)}</span><Button size="sm" variant="ghost" onClick={() => setEdit(i)}>Edit</Button></span>
        </Row>
      ))}
      {edit && <ItemDialog item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Section>
  );
}

function ItemDialog({ item, onClose }: { item: ChargeItem | null; onClose: () => void }) {
  const [f, setF] = useState({ name: item?.name ?? '', lineType: (item?.lineType ?? 'food') as AddableLineType, defaultRate: item?.defaultRate ?? '', taxCategory: item?.taxCategory ?? DEFAULT_TAX_CATEGORY.food, isActive: item?.isActive ?? true });
  const save = useSave(() => (item
    ? api(`/charge-items/${item.id}`, { method: 'PATCH', body: { ...f, version: item.version } })
    : api('/charge-items', { method: 'POST', body: f })), { invalidate: [['charge-items']], success: 'Item saved', onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={item ? `Edit ${item.name}` : 'Add charge item'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!f.name.trim() || !f.defaultRate} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        <Field label="Name on the invoice" required error={save.fields.name}>{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} />}</Field>
        <Field label="Type">{(id) => (
          <Select id={id} value={f.lineType} onChange={(e) => { const t = e.target.value as AddableLineType; setF({ ...f, lineType: t, taxCategory: DEFAULT_TAX_CATEGORY[t] }); }}>
            {ADDABLE_LINE_TYPES.map((t) => <option key={t} value={t}>{FOLIO_LINE_TYPE_LABELS[t]}</option>)}
          </Select>)}</Field>
        <Field label="Usual rate" required error={save.fields.defaultRate}>{(id) => <Input id={id} inputMode="decimal" value={f.defaultRate} onChange={(e) => setF({ ...f, defaultRate: e.target.value })} />}</Field>
        <Field label="GST category" hint="Decides the rate and SAC from your GST rules">{(id) => (
          <Select id={id} value={f.taxCategory} onChange={(e) => setF({ ...f, taxCategory: e.target.value })}>{TAX_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>)}</Field>
        {item && <Toggle label="In use" checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />}
      </div>
    </Dialog>
  );
}

/** Where money lands (spec §25.1): cash counter, bank, UPI, card machine. Never a full account number. */
export function PaymentAccountsSettings() {
  const accounts = useQuery({ queryKey: ['payment-accounts', 'all'], queryFn: () => api<PaymentAccount[]>('/payment-accounts', { query: { includeInactive: 'true' } }) });
  const [edit, setEdit] = useState<PaymentAccount | 'new' | null>(null);
  if (!accounts.data) return <Skeleton className="h-64" />;
  return (
    <Section title="Payment accounts" description="Every payment is recorded against one. An account that has taken money keeps its kind for ever."
      action={<Button size="sm" onClick={() => setEdit('new')}><Plus className="h-4 w-4" aria-hidden />Add account</Button>}>
      {accounts.data.map((a) => (
        <Row key={a.id} muted={!a.isActive}>
          <span><span className="font-medium">{a.name}</span> <span className="text-text-3">{PAYMENT_ACCOUNT_KIND_LABELS[a.kind]}{a.accountLast4 ? ` · ••${a.accountLast4}` : ''}{a.upiHandle ? ` · ${a.upiHandle}` : ''}{a.posTerminal ? ` · ${a.posTerminal}` : ''}</span>{!a.isActive && <span className="ml-2"><Pill>Off</Pill></span>}</span>
          <Button size="sm" variant="ghost" onClick={() => setEdit(a)}>Edit</Button>
        </Row>
      ))}
      {edit && <AccountDialog account={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Section>
  );
}

function AccountDialog({ account, onClose }: { account: PaymentAccount | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: account?.name ?? '', kind: (account?.kind ?? 'cash') as PaymentAccountKind, bankName: account?.bankName ?? '', accountLast4: account?.accountLast4 ?? '',
    upiHandle: account?.upiHandle ?? '', posTerminal: account?.posTerminal ?? '', openingBalance: account?.openingBalance ?? '0', isActive: account?.isActive ?? true,
  });
  const save = useSave(() => (account
    ? api(`/payment-accounts/${account.id}`, { method: 'PATCH', body: { ...f, version: account.version } })
    : api('/payment-accounts', { method: 'POST', body: f })), { invalidate: [['payment-accounts']], success: 'Account saved', onDone: onClose });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onClose={onClose} title={account ? `Edit ${account.name}` : 'Add payment account'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        <Field label="Name" required error={save.fields.name}>{(id) => <Input id={id} value={f.name} onChange={set('name')} placeholder="Front desk cash" />}</Field>
        <Field label="Kind">{(id) => <Select id={id} value={f.kind} onChange={set('kind')}>{PAYMENT_ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{PAYMENT_ACCOUNT_KIND_LABELS[k]}</option>)}</Select>}</Field>
        {f.kind === 'bank' && <div className="grid grid-cols-2 gap-4">
          <Field label="Bank">{(id) => <Input id={id} value={f.bankName} onChange={set('bankName')} />}</Field>
          <Field label="Last 4 digits only" error={save.fields.accountLast4}>{(id) => <Input id={id} inputMode="numeric" maxLength={4} value={f.accountLast4} onChange={set('accountLast4')} />}</Field>
        </div>}
        {f.kind === 'upi' && <Field label="UPI handle">{(id) => <Input id={id} value={f.upiHandle} onChange={set('upiHandle')} placeholder="resort@okbank" />}</Field>}
        {f.kind === 'card_pos' && <Field label="Terminal">{(id) => <Input id={id} value={f.posTerminal} onChange={set('posTerminal')} />}</Field>}
        <Field label="Opening balance" hint="What it held before ResortOS started recording">{(id) => <Input id={id} inputMode="decimal" value={f.openingBalance} onChange={set('openingBalance')} />}</Field>
        {account && <Toggle label="In use" checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />}
      </div>
    </Dialog>
  );
}
