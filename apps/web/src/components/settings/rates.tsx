'use client';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { addDays, formatDate, formatINR, MEAL_PLAN_CODES, MEAL_PLAN_LABELS, type MealPlanCode } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useProperty } from '@/lib/session';
import type { RoomType } from '@/lib/types';
import { Row, Section, Toggle, useSave } from './common';

interface RatePlan { id: string; code: string; name: string; kind: string; isDefault: boolean; isActive: boolean }
interface MealPlan { id: string; code: MealPlanCode; name: string; adultRate: string; childRate: string; postSeparately: boolean; isActive: boolean }
interface CalendarEntry { id: string; ratePlanName: string; roomTypeName: string; label: string; startDate: string; endDate: string; daysOfWeek: number[]; rate: string; minStay: number | null; priority: number }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Rate plans, seasonal and weekend prices (spec §11.1), and meal plans (§11.2). */
export function RatesSettings() {
  const property = useProperty();
  const plans = useQuery({ queryKey: ['rate-plans'], queryFn: () => api<RatePlan[]>('/rate-plans') });
  const meals = useQuery({ queryKey: ['meal-plans'], queryFn: () => api<MealPlan[]>('/meal-plans') });
  const today = property.data?.businessDate;
  const calendar = useQuery({
    queryKey: ['rate-calendar', today], enabled: Boolean(today),
    queryFn: () => api<CalendarEntry[]>('/rate-calendar', { query: { from: today!, to: addDays(today!, 366) } }),
  });
  const [planEdit, setPlanEdit] = useState<RatePlan | 'new' | null>(null);
  const [adding, setAdding] = useState(false);
  const [meal, setMeal] = useState<MealPlanCode | null>(null);
  const off = useSave((id: string) => api(`/rate-calendar/${id}/deactivate`, { method: 'POST', body: {} }), { invalidate: [['rate-calendar']], success: 'Price switched off' });
  if (!plans.data || !meals.data) return <Skeleton className="h-96" />;
  return (
    <div className="flex flex-col gap-5">
      <Section title="Rate plans" description="The default plan prices every booking unless the desk picks another."
        action={<Button size="sm" onClick={() => setPlanEdit('new')}><Plus className="h-4 w-4" aria-hidden />Add plan</Button>}>
        {plans.data.map((p) => (
          <Row key={p.id} muted={!p.isActive}>
            <span><span className="font-medium">{p.name}</span> <span className="text-text-3">{p.code} · {p.kind.replace('_', ' ')}</span>
              {p.isDefault && <span className="ml-2"><Pill tone="brand">Default</Pill></span>}{!p.isActive && <span className="ml-2"><Pill>Off</Pill></span>}</span>
            <Button size="sm" variant="ghost" onClick={() => setPlanEdit(p)}>Edit</Button>
          </Row>
        ))}
      </Section>

      <Section title="Seasonal and weekend prices" description="Higher priority wins where prices overlap (festival over weekend over season). The next twelve months."
        action={<Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden />Add price</Button>}>
        {!calendar.data?.length ? <p className="px-4 py-6 text-sm text-text-3">No special prices — every night uses the room type’s rate.</p> : calendar.data.map((c) => (
          <Row key={c.id}>
            <span><span className="font-medium">{c.label}</span> <span className="text-text-3">{c.roomTypeName} · {c.ratePlanName} · {formatDate(c.startDate, { year: false })}–{formatDate(addDays(c.endDate, -1), { year: false })}
              {c.daysOfWeek.length ? ` · ${c.daysOfWeek.map((d) => DAYS[d]).join(', ')}` : ''}{c.minStay ? ` · min ${c.minStay} nights` : ''}</span></span>
            <span className="flex items-center gap-3"><span className="tabular-nums">{formatINR(c.rate)}</span>
              <Button size="sm" variant="ghost" loading={off.isPending && off.variables === c.id} onClick={() => off.mutate(c.id)}>Switch off</Button></span>
          </Row>
        ))}
      </Section>

      <Section title="Meal plans" description="Per person per night, added to the room rate.">
        {MEAL_PLAN_CODES.map((code) => {
          const m = meals.data!.find((x) => x.code === code);
          return (
            <Row key={code} muted={m ? !m.isActive : true}>
              <span><span className="font-medium">{m?.name ?? MEAL_PLAN_LABELS[code]}</span> <span className="text-text-3">{code}</span>{!m && <span className="ml-2"><Pill>Not set up</Pill></span>}</span>
              <span className="flex items-center gap-3">
                {m && <span className="tabular-nums">{formatINR(m.adultRate)} adult · {formatINR(m.childRate)} child</span>}
                <Button size="sm" variant="ghost" onClick={() => setMeal(code)}>{m ? 'Edit' : 'Set up'}</Button>
              </span>
            </Row>
          );
        })}
      </Section>

      {planEdit && <RatePlanDialog plan={planEdit === 'new' ? null : planEdit} onClose={() => setPlanEdit(null)} />}
      {adding && today && <CalendarDialog plans={plans.data.filter((p) => p.isActive)} today={today} onClose={() => setAdding(false)} />}
      {meal && <MealDialog code={meal} current={meals.data.find((m) => m.code === meal) ?? null} onClose={() => setMeal(null)} />}
    </div>
  );
}

function RatePlanDialog({ plan, onClose }: { plan: RatePlan | null; onClose: () => void }) {
  const [f, setF] = useState({ code: plan?.code ?? '', name: plan?.name ?? '', kind: plan?.kind ?? 'standard', isActive: plan?.isActive ?? true, isDefault: plan?.isDefault ?? false });
  const save = useSave(() => (plan
    ? api(`/rate-plans/${plan.id}`, { method: 'PATCH', body: { name: f.name, kind: f.kind, isActive: f.isActive, isDefault: f.isDefault } })
    : api('/rate-plans', { method: 'POST', body: { code: f.code, name: f.name, kind: f.kind } })), { invalidate: [['rate-plans']], success: 'Rate plan saved', onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={plan ? `Edit ${plan.name}` : 'Add rate plan'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={f.name.trim().length < 2} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        {!plan && <Field label="Code" required hint="e.g. CORP" error={save.fields.code}>{(id) => <Input id={id} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={16} />}</Field>}
        <Field label="Name" required>{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Kind">{(id) => (
          <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="standard">Standard</option><option value="corporate">Corporate</option><option value="travel_agent">Travel agent</option><option value="package">Package</option>
          </Select>)}</Field>
        {plan && <>
          <Toggle label="In use" checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
          <Toggle label="Default plan" hint="Exactly one plan is the default" checked={f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} />
        </>}
      </div>
    </Dialog>
  );
}

function CalendarDialog({ plans, today, onClose }: { plans: RatePlan[]; today: string; onClose: () => void }) {
  const types = useQuery({ queryKey: ['room-types'], queryFn: () => api<RoomType[]>('/room-types') });
  const [f, setF] = useState({ ratePlanId: plans.find((p) => p.isDefault)?.id ?? plans[0]?.id ?? '', roomTypeIds: [] as string[], label: '', startDate: today, endDate: addDays(today, 7), days: [] as number[], rate: '', minStay: '', priority: '10' });
  const save = useSave(() => api('/rate-calendar', { method: 'POST', body: {
    ratePlanId: f.ratePlanId, roomTypeIds: f.roomTypeIds, label: f.label, startDate: f.startDate, endDate: f.endDate, daysOfWeek: f.days,
    rate: f.rate, minStay: f.minStay ? Number(f.minStay) : undefined, priority: Number(f.priority),
  } }), { invalidate: [['rate-calendar']], success: 'Price added', onDone: onClose });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <Dialog open onClose={onClose} size="lg" title="Add a price" description="For a season, a festival, or particular days of the week. The end date is the first night it no longer applies."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!f.label || !f.rate || !f.roomTypeIds.length} onClick={() => save.mutate(undefined)}>Add price</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {save.error && <div className="sm:col-span-2"><ErrorBanner message={(save.error as Error).message} /></div>}
        <Field label="Name" required hint="e.g. Diwali, Weekend">{(id) => <Input id={id} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={60} />}</Field>
        <Field label="Rate plan">{(id) => <Select id={id} value={f.ratePlanId} onChange={(e) => setF({ ...f, ratePlanId: e.target.value })}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-medium text-text-2">Room types</p>
          <div className="flex flex-wrap gap-2">{(types.data ?? []).map((t) => (
            <button key={t.id} type="button" aria-pressed={f.roomTypeIds.includes(t.id)} onClick={() => setF({ ...f, roomTypeIds: toggle(f.roomTypeIds, t.id) })}
              className={cn('rounded-full border px-3 py-1.5 text-sm', f.roomTypeIds.includes(t.id) ? 'border-brand bg-brand-soft text-brand' : 'border-border text-text-2')}>{t.name}</button>
          ))}</div>
        </div>
        <Field label="From" required>{(id) => <DateField id={id} value={f.startDate} onChange={(v) => setF({ ...f, startDate: v })} min={today} />}</Field>
        <Field label="Until (not including)" required error={save.fields.endDate}>{(id) => <DateField id={id} value={f.endDate} onChange={(v) => setF({ ...f, endDate: v })} min={f.startDate} />}</Field>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-medium text-text-2">Only on these days <span className="font-normal text-text-3">(none chosen = every day)</span></p>
          <div className="flex flex-wrap gap-2">{DAYS.map((d, i) => (
            <button key={d} type="button" aria-pressed={f.days.includes(i)} onClick={() => setF({ ...f, days: toggle(f.days, i) })}
              className={cn('rounded-md border px-3 py-1.5 text-sm', f.days.includes(i) ? 'border-brand bg-brand-soft text-brand' : 'border-border text-text-2')}>{d}</button>
          ))}</div>
        </div>
        <Field label="Rate per night" required error={save.fields.rate}>{(id) => <Input id={id} inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />}</Field>
        <Field label="Minimum stay (nights)">{(id) => <Input id={id} inputMode="numeric" value={f.minStay} onChange={(e) => setF({ ...f, minStay: e.target.value })} />}</Field>
        <Field label="Priority" hint="Higher wins where prices overlap">{(id) => <Input id={id} inputMode="numeric" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

function MealDialog({ code, current, onClose }: { code: MealPlanCode; current: MealPlan | null; onClose: () => void }) {
  const [f, setF] = useState({ name: current?.name ?? MEAL_PLAN_LABELS[code], adultRate: current?.adultRate ?? '0', childRate: current?.childRate ?? '0', postSeparately: current?.postSeparately ?? true, isActive: current?.isActive ?? true });
  const save = useSave(() => api('/meal-plans', { method: 'POST', body: { code, ...f } }), { invalidate: [['meal-plans']], success: 'Meal plan saved', onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={`Meal plan ${code}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Per adult per night">{(id) => <Input id={id} inputMode="decimal" value={f.adultRate} onChange={(e) => setF({ ...f, adultRate: e.target.value })} />}</Field>
          <Field label="Per child per night">{(id) => <Input id={id} inputMode="decimal" value={f.childRate} onChange={(e) => setF({ ...f, childRate: e.target.value })} />}</Field>
        </div>
        <Toggle label="Show meals as their own bill line" hint="Food is taxed differently from the room" checked={f.postSeparately} onChange={(v) => setF({ ...f, postSeparately: v })} />
        <Toggle label="In use" checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
      </div>
    </Dialog>
  );
}
