'use client';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatDate, formatINR, TAX_CATEGORIES } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api, newIdempotencyKey } from '@/lib/api';
import { useProperty } from '@/lib/session';
import { Row, Section, useSave } from './common';

interface TaxRule {
  id: string; taxCategory: string; unitValueAbove: string | null; unitValueUpTo: string | null; ratePercent: string; sac: string;
  effectiveFrom: string; effectiveTo: string | null; note: string | null; isDemoPlaceholder: boolean;
}
const CATEGORY_LABEL: Record<string, string> = { accommodation: 'Rooms', food: 'Food', activity: 'Activities', laundry: 'Laundry', transport: 'Transport', other: 'Other' };

/**
 * Dated GST rules (spec §30.1). A rule is never edited: a new rate is the old rule closed on a date and
 * a new one starting the next day, so every invoice keeps the rule it was issued under. Confirm every
 * rate and SAC with the resort's CA.
 */
export function TaxSettings() {
  const property = useProperty();
  const rules = useQuery({ queryKey: ['tax-rules'], queryFn: () => api<TaxRule[]>('/tax-rules') });
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState<TaxRule | null>(null);
  if (!rules.data) return <Skeleton className="h-96" />;
  const placeholders = rules.data.some((r) => r.isDemoPlaceholder && !r.effectiveTo);
  const band = (r: TaxRule) => (r.unitValueAbove || r.unitValueUpTo)
    ? ` · ${r.unitValueAbove ? `above ${formatINR(r.unitValueAbove)}` : ''}${r.unitValueAbove && r.unitValueUpTo ? ' and ' : ''}${r.unitValueUpTo ? `up to ${formatINR(r.unitValueUpTo)}` : ''} per room per night`
    : '';
  return (
    <div className="flex flex-col gap-5">
      {!rules.data.some((r) => r.taxCategory === 'accommodation' && !r.isDemoPlaceholder &&
        r.effectiveFrom <= (property.data?.businessDate ?? '') && (!r.effectiveTo || r.effectiveTo >= (property.data?.businessDate ?? ''))) &&
        <p role="alert" className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">Room GST rules are missing for the business date. Invoicing and checkout cannot finish until reception adds accountant-confirmed rules. Enter the appropriate value bands and SAC; do not guess a rate.</p>}
      {placeholders && (
        <p className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
          Some rules are demo placeholders. Confirm the real rates and SAC codes with your CA, close each placeholder, and add the confirmed rule — the system will not go live on placeholders.
        </p>
      )}
      <Section title="GST rules" description="Each line on a bill is taxed by the rule valid on its own date. Rules are closed and replaced, never edited."
        action={<Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden />Add rule</Button>}>
        {rules.data.map((r) => (
          <Row key={r.id} muted={Boolean(r.effectiveTo)}>
            <span>
              <span className="font-medium">{CATEGORY_LABEL[r.taxCategory]} · {Number(r.ratePercent)}%</span>
              <span className="text-text-3"> SAC {r.sac}{band(r)} · from {formatDate(r.effectiveFrom)}{r.effectiveTo ? ` to ${formatDate(r.effectiveTo)}` : ''}</span>
              {r.isDemoPlaceholder && <span className="ml-2"><Pill tone="warning">Placeholder</Pill></span>}
              {r.note && <span className="block text-xs text-text-3">{r.note}</span>}
            </span>
            {!r.effectiveTo && <Button size="sm" variant="ghost" onClick={() => setClosing(r)}>Close</Button>}
          </Row>
        ))}
      </Section>
      {adding && <AddRule onClose={() => setAdding(false)} />}
      {closing && <CloseRule rule={closing} onClose={() => setClosing(null)} />}
    </div>
  );
}

function AddRule({ onClose }: { onClose: () => void }) {
  const property = useProperty();
  const key = useRef(newIdempotencyKey());
  const [f, setF] = useState({ taxCategory: 'accommodation', unitValueAbove: '', unitValueUpTo: '', ratePercent: '', sac: '', effectiveFrom: property.data?.businessDate ?? '', effectiveTo: '', note: '' });
  const save = useSave(() => api('/tax-rules', { method: 'POST', idempotencyKey: key.current, body: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')) }),
    { invalidate: [['tax-rules']], success: 'Rule added', onDone: onClose });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onClose={onClose} size="lg" title="Add a GST rule" description="Two rules can never apply to the same line: overlapping dates and value bands are refused."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!f.ratePercent || !f.sac || !f.effectiveFrom} onClick={() => save.mutate(undefined)}>Add rule</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {save.error && <div className="sm:col-span-2"><ErrorBanner message={(save.error as Error).message} /></div>}
        <Field label="For">{(id) => <Select id={id} value={f.taxCategory} onChange={set('taxCategory')}>{TAX_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</Select>}</Field>
        <Field label="GST %" required error={save.fields.ratePercent}>{(id) => <Input id={id} inputMode="decimal" value={f.ratePercent} onChange={set('ratePercent')} />}</Field>
        <Field label="SAC" required error={save.fields.sac}>{(id) => <Input id={id} inputMode="numeric" value={f.sac} onChange={set('sac')} maxLength={8} />}</Field>
        <div />
        {f.taxCategory === 'accommodation' && <>
          <Field label="Room value above (₹)" hint="Per room per night, after discount">{(id) => <Input id={id} inputMode="decimal" value={f.unitValueAbove} onChange={set('unitValueAbove')} />}</Field>
          <Field label="Room value up to (₹)" error={save.fields.unitValueUpTo}>{(id) => <Input id={id} inputMode="decimal" value={f.unitValueUpTo} onChange={set('unitValueUpTo')} />}</Field>
        </>}
        <Field label="From" required>{(id) => <DateField id={id} value={f.effectiveFrom} onChange={(v) => setF({ ...f, effectiveFrom: v })} />}</Field>
        <Field label="Until (optional)" error={save.fields.effectiveTo}>{(id) => <DateField id={id} value={f.effectiveTo} onChange={(v) => setF({ ...f, effectiveTo: v })} min={f.effectiveFrom} />}</Field>
        <Field label="Note" hint="e.g. confirmed by CA on …" className="sm:col-span-2">{(id) => <Input id={id} value={f.note} onChange={set('note')} maxLength={300} />}</Field>
      </div>
    </Dialog>
  );
}

function CloseRule({ rule, onClose }: { rule: TaxRule; onClose: () => void }) {
  const [date, setDate] = useState('');
  const key = useRef(newIdempotencyKey());
  const save = useSave(() => api(`/tax-rules/${rule.id}/close`, { method: 'POST', idempotencyKey: key.current, body: { effectiveTo: date } }), { invalidate: [['tax-rules']], success: 'Rule closed', onDone: onClose });
  return (
    <Dialog open onClose={onClose} title="Close this rule" description="The rule applies up to and including this date. Add the new rule from the next day."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={save.isPending} disabled={!date} onClick={() => save.mutate(undefined)}>Close rule</Button></>}>
      <div className="flex flex-col gap-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        <Field label="Last day it applies" required>{(id) => <DateField id={id} value={date} onChange={setDate} min={rule.effectiveFrom} />}</Field>
      </div>
    </Dialog>
  );
}
