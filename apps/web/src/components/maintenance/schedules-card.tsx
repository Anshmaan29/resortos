'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, Plus, Repeat } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatDate } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Card, EmptyState, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Room } from '@/lib/types';
import { useCreateSchedule, useInvalidateMaintenance, usePatchSchedule } from './use-maintenance-mutations';
import { TargetToggle } from './ticket-dialogs';
import type { MaintenanceSchedule } from './types';

/** Owner-only preventive maintenance (spec §38.5). The night audit opens a ticket for every schedule that has come due. */
export function SchedulesCard({ businessDate }: { businessDate: string | undefined }) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const schedules = useQuery({ queryKey: ['maintenance-schedules'], queryFn: () => api<MaintenanceSchedule[]>('/maintenance/schedules') });
  const patch = usePatchSchedule();

  const data = schedules.data ?? [];
  const dueCount = data.filter((s) => s.isActive && businessDate && s.nextDue <= businessDate).length;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
            className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left">
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold text-text">
                Preventive schedules
                {dueCount > 0 && <> <Pill tone="danger"><span className="num">{dueCount}</span> due</Pill></>}
              </span>
              <span className="mt-0.5 block text-sm text-text-3">
                Checks the resort must do again and again. The night audit opens a ticket automatically when a schedule is due.
              </span>
            </span>
            <ChevronDown className={cn('mt-1 h-5 w-5 shrink-0 text-text-3 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden />Add schedule</Button>
        </div>

        {open && (
          schedules.isLoading ? (
            <Skeleton className="m-4 h-24" />
          ) : schedules.isError ? (
            <div className="p-4"><ErrorBanner message={(schedules.error as Error).message} onRetry={() => schedules.refetch()} /></div>
          ) : data.length === 0 ? (
            <EmptyState
              icon={<Repeat className="h-5 w-5" />}
              title="No schedules yet"
              description="Add the checks that must never be skipped — generator service, water pump, pool cleaning."
            />
          ) : (
            <div>
              {data.map((s) => {
                const due = s.isActive && businessDate != null && s.nextDue <= businessDate;
                return (
                  <div key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">
                        {s.name}
                        {!s.isActive && <span className="ml-2"><Pill tone="neutral">Off</Pill></span>}
                      </p>
                      <p className="mt-0.5 text-xs text-text-3">
                        {s.roomId ? `Room ${s.roomNumber}` : s.area} · every <span className="num">{s.everyDays}</span> {s.everyDays === 1 ? 'day' : 'days'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('text-sm tabular-nums', due ? 'font-medium text-danger' : 'text-text-2')}>
                        Next due {formatDate(s.nextDue)}
                      </span>
                      {due && <Pill tone="danger">Due</Pill>}
                      <Button size="sm" variant="ghost" loading={patch.isPending && patch.variables?.id === s.id}
                        onClick={() =>
                          patch.mutate({
                            id: s.id, version: s.version, body: { isActive: !s.isActive },
                            success: s.isActive ? 'Schedule turned off' : 'Schedule turned on',
                          })
                        }
                      >
                        {s.isActive ? 'Deactivate' : 'Reactivate'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </Card>

      {adding && <AddScheduleDialog businessDate={businessDate} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddScheduleDialog({ businessDate, onClose }: { businessDate: string | undefined; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateMaintenance();
  const key = useRef(newIdempotencyKey());
  const [target, setTarget] = useState<'room' | 'area'>('area');
  const [f, setF] = useState({ name: '', roomId: '', area: '', everyDays: '', nextDue: businessDate ?? '' });

  // The dialog can be opened before the property loads — fill the date in as soon as it is known.
  useEffect(() => {
    if (!f.nextDue && businessDate) setF((p) => ({ ...p, nextDue: businessDate }));
  }, [businessDate, f.nextDue]);

  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => api<Room[]>('/rooms') });

  const create = useMutation({
    mutationFn: (body: { name: string; roomId?: string; area?: string; everyDays: number; nextDue?: string }) =>
      api<{ id: string }>('/maintenance/schedules', { method: 'POST', idempotencyKey: key.current, body }),
    onSuccess: () => {
      key.current = newIdempotencyKey();
      invalidate();
      toast('success', 'Schedule added');
      onClose();
    },
  });
  const fields = create.error instanceof ApiError ? create.error.fields : {};

  const days = Number(f.everyDays);
  const everyOk = Number.isInteger(days) && days >= 1 && days <= 3650;
  const targetOk = target === 'room' ? f.roomId !== '' : f.area.trim().length >= 2;
  const ready = f.name.trim().length >= 2 && targetOk && everyOk;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a preventive schedule"
      description="The night audit opens a ticket every time the schedule comes due."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={create.isPending} disabled={!ready}
            onClick={() =>
              create.mutate({
                name: f.name.trim(),
                ...(target === 'room' ? { roomId: f.roomId } : { area: f.area.trim() }),
                everyDays: days,
                ...(f.nextDue ? { nextDue: f.nextDue } : {}),
              })
            }
          >
            Add schedule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {create.error && <ErrorBanner message={(create.error as Error).message} />}

        <Field label="What is serviced" required error={fields.name}>
          {(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} placeholder="e.g. Generator service" />}
        </Field>

        <TargetToggle value={target} onChange={setTarget} />

        {target === 'room' ? (
          <Field label="Room" required error={fields.roomId}>
            {(id) => (
              <Select id={id} value={f.roomId} onChange={(e) => setF({ ...f, roomId: e.target.value })}>
                <option value="">Choose…</option>
                {(rooms.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.number} · {r.roomTypeName}</option>)}
              </Select>
            )}
          </Field>
        ) : (
          <Field label="Area" required hint="e.g. Generator, water pump, swimming pool" error={fields.area}>
            {(id) => <Input id={id} value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} maxLength={120} />}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Every" required hint="Days between services" error={fields.everyDays ?? (f.everyDays === '' || everyOk ? undefined : 'Enter 1 to 3650 days')}>
            {(id) => <Input id={id} inputMode="numeric" className="num" value={f.everyDays} onChange={(e) => setF({ ...f, everyDays: e.target.value.replace(/\D/g, '').slice(0, 4) })} placeholder="30" />}
          </Field>
          <Field label="First due on" error={fields.nextDue}>
            {(id) => (
              <DateField
                id={id}
                label="First due on"
                value={f.nextDue}
                onChange={(iso) => setF({ ...f, nextDue: iso })}
                today={businessDate || undefined}
              />
            )}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
