'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ErrorBanner } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Room } from '@/lib/types';
import { useInvalidateMaintenance, useOutOfOrder, usePatchTicket } from './use-maintenance-mutations';
import { PRIORITY_LABEL, type MaintenanceStaff, type MaintenanceTicket, type TicketPriority } from './types';

const MONEY = /^\d{1,9}(\.\d{1,2})?$/;

/** Room / Area toggle shared by the report and schedule dialogs — a ticket is about one or the other, never both. */
export function TargetToggle({ value, onChange }: { value: 'room' | 'area'; onChange: (v: 'room' | 'area') => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-text-2">It is about<span className="ml-0.5 text-danger" aria-hidden>*</span></span>
      <div role="group" aria-label="It is about" className="flex gap-1.5">
        {([['room', 'A room'], ['area', 'An area']] as const).map(([v, label]) => (
          <button key={v} type="button" onClick={() => onChange(v)} aria-pressed={value === v}
            className={cn('h-11 flex-1 rounded-md border px-3 text-sm transition-colors',
              value === v ? 'border-brand bg-brand-soft font-medium text-brand' : 'border-border text-text-2 hover:bg-surface-2')}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Report a problem (spec §38.2): a room or an area, what needs fixing, how urgent, and who should look at it.
 * Errors show inline — the desk should still see what they typed when the server refuses.
 */
export function ReportProblemDialog({ staff, onClose }: { staff: MaintenanceStaff[]; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateMaintenance();
  const key = useRef(newIdempotencyKey());
  const [target, setTarget] = useState<'room' | 'area'>('room');
  const [f, setF] = useState({ roomId: '', area: '', title: '', description: '', priority: 'normal' as TicketPriority, assignedTo: '' });

  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => api<Room[]>('/rooms') });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string }>('/maintenance/tickets', { method: 'POST', idempotencyKey: key.current, body }),
    onSuccess: () => {
      key.current = newIdempotencyKey();
      invalidate();
      toast('success', 'Ticket opened');
      onClose();
    },
  });
  const fields = create.error instanceof ApiError ? create.error.fields : {};

  const targetOk = target === 'room' ? f.roomId !== '' : f.area.trim().length >= 2;
  const ready = f.title.trim().length >= 3 && targetOk;

  const save = () =>
    create.mutate({
      ...(target === 'room' ? { roomId: f.roomId } : { area: f.area.trim() }),
      title: f.title.trim(),
      ...(f.description.trim() ? { description: f.description.trim() } : {}),
      priority: f.priority,
      ...(f.assignedTo ? { assignedTo: f.assignedTo } : {}),
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Report a problem"
      description="Something broken — in a room or around the resort. The ticket walks from open to closed."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={create.isPending} disabled={!ready} onClick={save}>Open ticket</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {create.error && <ErrorBanner message={(create.error as Error).message} />}

        <TargetToggle value={target} onChange={(v) => setTarget(v)} />

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
          <Field label="Area" required hint="Wherever the problem is — generator, water pump, pool, restaurant" error={fields.area}>
            {(id) => <Input id={id} value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} maxLength={120} placeholder="e.g. Generator" />}
          </Field>
        )}

        <Field label="What needs fixing" required error={fields.title}>
          {(id) => <Input id={id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={160} placeholder="e.g. AC not cooling" />}
        </Field>

        <Field label="Details" error={fields.description}>
          {(id) => <Textarea id={id} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={2000} placeholder="Optional — what happened, since when" />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority" error={fields.priority}>
            {(id) => (
              <Select id={id} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as TicketPriority })}>
                {(['low', 'normal', 'high'] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Assign to" error={fields.assignedTo}>
            {(id) => (
              <Select id={id} value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}>
                <option value="">Leave unassigned</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Mark resolved (spec §38.3): what was done is required, what it cost is not. */
export function ResolveDialog({ ticket, onClose }: { ticket: MaintenanceTicket; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [cost, setCost] = useState('');
  const patch = usePatchTicket();
  const fields = patch.error instanceof ApiError ? patch.error.fields : {};

  const costOk = cost.trim() === '' || MONEY.test(cost.trim());
  const ready = note.trim().length >= 3 && costOk;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Mark resolved"
      description={ticket.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={patch.isPending} disabled={!ready}
            onClick={() =>
              patch.mutate({
                id: ticket.id,
                version: ticket.version,
                body: { status: 'resolved', resolutionNote: note.trim(), ...(cost.trim() ? { cost: cost.trim() } : {}) },
                success: 'Ticket resolved',
              })
            }
          >
            Mark resolved
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="What was done" required hint="Kept on the ticket for the records" error={fields.resolutionNote}>
          {(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="e.g. Replaced the AC filter and refilled gas" />}
        </Field>
        <Field label="What it cost" hint="Repairs, parts, the electrician — leave empty if nothing was spent" error={fields.cost ?? (costOk ? undefined : 'Enter the cost as a number, e.g. 1250')}>
          {(id) => <Input id={id} inputMode="decimal" className="num" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" />}
        </Field>
      </div>
    </Dialog>
  );
}

/** Assign or reassign the ticket to a member of staff (spec §38.2). */
export function AssignDialog({ ticket, staff, onClose }: { ticket: MaintenanceTicket; staff: MaintenanceStaff[]; onClose: () => void }) {
  const [assignedTo, setAssignedTo] = useState(ticket.assignedTo?.id ?? '');
  const patch = usePatchTicket();
  const fields = patch.error instanceof ApiError ? patch.error.fields : {};
  const chosen = staff.find((s) => s.id === assignedTo);

  return (
    <Dialog
      open
      onClose={onClose}
      title={ticket.assignedTo ? 'Reassign the ticket' : 'Assign the ticket'}
      description={ticket.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={patch.isPending}
            onClick={() =>
              patch.mutate({
                id: ticket.id,
                version: ticket.version,
                body: { assignedTo: assignedTo || null },
                success: assignedTo && chosen ? `Ticket assigned to ${chosen.name}` : 'Ticket left unassigned',
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Assign to" error={fields.assignedTo}>
          {(id) => (
            <Select id={id} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Leave unassigned</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

export function PriorityDialog({ ticket, onClose }: { ticket: MaintenanceTicket; onClose: () => void }) {
  const [priority, setPriority] = useState<TicketPriority>(ticket.priority);
  const patch = usePatchTicket();
  const fields = patch.error instanceof ApiError ? patch.error.fields : {};

  return (
    <Dialog
      open
      onClose={onClose}
      title="Set priority"
      description={ticket.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={patch.isPending}
            onClick={() =>
              patch.mutate({ id: ticket.id, version: ticket.version, body: { priority }, success: `Priority set to ${PRIORITY_LABEL[priority]}` })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Priority" error={fields.priority}>
          {(id) => (
            <Select id={id} value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
              {(['low', 'normal', 'high'] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </Select>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

/** Owner only: take the room out of sellable inventory for a stretch of nights (spec §38.4). */
export function OutOfOrderDialog({ roomId, roomNumber, businessDate, onClose }: { roomId: string; roomNumber: string; businessDate?: string; onClose: () => void }) {
  const [f, setF] = useState({ startDate: businessDate ?? '', endDate: '', reason: '' });
  // The dialog can be opened before the property loads — fill the date in as soon as it is known.
  useEffect(() => {
    if (!f.startDate && businessDate) setF((p) => ({ ...p, startDate: businessDate }));
  }, [businessDate, f.startDate]);

  const ooo = useOutOfOrder();
  const fields = ooo.error instanceof ApiError ? ooo.error.fields : {};
  const datesOk = f.startDate !== '' && f.endDate !== '' && f.endDate > f.startDate;
  const ready = datesOk && f.reason.trim().length >= 3;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Room ${roomNumber} out of order`}
      description="The room cannot be sold for these nights — it leaves availability until the end date."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={ooo.isPending} disabled={!ready}
            onClick={() => ooo.mutate({ roomId, roomNumber, startDate: f.startDate, endDate: f.endDate, reason: f.reason.trim() })}
          >
            Mark out of order
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From" required error={fields.startDate}>
            {(id) => <DateField id={id} label="From" value={f.startDate} onChange={(iso) => setF({ ...f, startDate: iso })} today={businessDate || undefined} />}
          </Field>
          <Field label="To" required error={fields.endDate ?? (datesOk ? undefined : 'Choose a date after the start date')}>
            {(id) => <DateField id={id} label="To" value={f.endDate} onChange={(iso) => setF({ ...f, endDate: iso })} min={f.startDate || undefined} />}
          </Field>
        </div>
        <Field label="Reason" required error={fields.reason}>
          {(id) => <Input id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={200} placeholder="e.g. Bathroom renovation" />}
        </Field>
      </div>
    </Dialog>
  );
}
