'use client';
import { ChevronDown, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Card, CardHeader, EmptyState } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { cn } from '@/lib/cn';
import { MyTasks, type MyTasksQuery } from './my-tasks';
import { useRoomHousekeeping, useTaskMutations } from './use-task-mutations';
import {
  HK_STATUS_LABEL,
  KIND_LABEL,
  type HousekeepingBoardData,
  type HousekeepingRoom,
  type HousekeepingStaff,
  type HousekeepingStatus,
} from './types';

type StatusFilter = 'all' | HousekeepingStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'dirty', label: 'Dirty' },
  { value: 'cleaning', label: 'Cleaning' },
  { value: 'clean', label: 'Clean' },
  { value: 'inspected', label: 'Inspected' },
];

const HK_PILL_TONE: Record<Exclude<HousekeepingStatus, 'inspected'>, { color: string; background: string }> = {
  dirty: { color: 'var(--st-dirty)', background: 'var(--st-dirty-bg)' },
  cleaning: { color: 'var(--st-cleaning)', background: 'var(--st-cleaning-bg)' },
  clean: { color: 'var(--st-ready)', background: 'var(--st-ready-bg)' },
};

/** Housekeeping status pill: Dirty=danger, Cleaning=warning, Clean=ok (the ready green), Inspected=brand. */
function HousekeepingPill({ status }: { status: HousekeepingStatus }) {
  if (status === 'inspected') return <Pill tone="brand">{HK_STATUS_LABEL.inspected}</Pill>;
  const tone = HK_PILL_TONE[status];
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ color: tone.color, background: tone.background }}>
      {HK_STATUS_LABEL[status]}
    </span>
  );
}

/** The full housekeeping board for owner and reception (spec §37): rooms grouped by floor
 *  with building as the secondary label, filters, and per-task management actions. */
export function HousekeepingBoard({ data, meId, myTasks }: { data: HousekeepingBoardData; meId: string; myTasks: MyTasksQuery }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [assigned, setAssigned] = useState('all'); // 'all' | 'unassigned' | staff id
  const [mineOnly, setMineOnly] = useState(false);
  const myTaskCount = myTasks.data?.length ?? 0;
  const mineAvailable = myTaskCount > 0;

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: data.rooms.length, dirty: 0, cleaning: 0, clean: 0, inspected: 0 };
    for (const r of data.rooms) c[r.housekeeping] += 1;
    return c;
  }, [data.rooms]);

  const groups = useMemo(() => {
    const filtered = data.rooms.filter((r) => {
      if (status !== 'all' && r.housekeeping !== status) return false;
      if (assigned !== 'all') {
        if (assigned === 'unassigned') {
          if (!r.task || r.task.assignedTo) return false;
        } else if (r.task?.assignedTo?.id !== assigned) {
          return false;
        }
      }
      if (mineOnly && r.task?.assignedTo?.id !== meId) return false;
      return true;
    });
    return groupByFloor(filtered);
  }, [data.rooms, status, assigned, mineOnly, meId]);

  return (
    <div className="flex flex-col gap-5">
      {mineAvailable && <MyTasksSection query={myTasks} count={myTaskCount} />}

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-2">Status</span>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setStatus(f.value)}
                  aria-pressed={status === f.value}
                  className={cn(
                    'h-11 rounded-md border px-3 text-sm',
                    status === f.value ? 'border-brand bg-brand-soft font-medium text-brand' : 'border-border text-text-2 hover:bg-surface-2',
                  )}
                >
                  {f.label}
                  <span className="ml-1.5 num opacity-60">{counts[f.value]}</span>
                </button>
              ))}
            </div>
          </div>
          <Field label="Assigned to" className="w-44">
            {(id) => (
              <Select id={id} value={assigned} onChange={(e) => setAssigned(e.target.value)}>
                <option value="all">All</option>
                <option value="unassigned">Unassigned</option>
                {data.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
          </Field>
          {mineAvailable && (
            <button
              type="button"
              onClick={() => setMineOnly((v) => !v)}
              aria-pressed={mineOnly}
              className={cn(
                'h-11 rounded-md border px-3 text-sm',
                mineOnly ? 'border-brand bg-brand-soft font-medium text-brand' : 'border-border text-text-2 hover:bg-surface-2',
              )}
            >
              My tasks only
            </button>
          )}
        </div>
      </Card>

      {groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Sparkles className="h-5 w-5" />}
            title={data.rooms.length === 0 ? 'No rooms to clean' : 'No rooms match the filters'}
            description={data.rooms.length === 0 ? 'Everything on the board is done for today.' : 'Try another status or assignment filter.'}
          />
        </Card>
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-label={g.label}>
            <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-text-2">
              {g.label}
              <span className="num text-xs font-normal text-text-3">{g.rooms.length} room{g.rooms.length === 1 ? '' : 's'}</span>
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {g.rooms.map((r) => <BoardRoomCard key={r.roomId} room={r} staff={data.staff} />)}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

/** Collapsed "My tasks" for owners/reception who are personally assigned tasks (spec §37). */
function MyTasksSection({ query, count }: { query: MyTasksQuery; count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader
        title={<>My tasks <span className="num font-normal text-text-3">({count})</span></>}
        description="Rooms assigned to you personally."
        action={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium text-text-2 hover:bg-surface-2 hover:text-text"
          >
            {open ? 'Hide' : 'Show'}
            <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        }
      />
      {open && <div className="p-4"><MyTasks query={query} /></div>}
    </Card>
  );
}

function BoardRoomCard({ room, staff }: { room: HousekeepingRoom; staff: HousekeepingStaff[] }) {
  const m = useTaskMutations();
  const roomStatus = useRoomHousekeeping();
  const [skipOpen, setSkipOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const task = room.task;
  const busy = (pending: boolean, id: string | undefined) => pending && id === task?.id;
  const roomBusy = roomStatus.isPending && roomStatus.variables?.roomId === room.roomId;

  return (
    <Card className="flex flex-col gap-2.5 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="num text-lg font-semibold leading-tight text-text">{room.number}</p>
          <p className="truncate text-xs text-text-3">{room.roomTypeName}</p>
        </div>
        <HousekeepingPill status={room.housekeeping} />
      </div>

      <div className="flex flex-wrap gap-1">
        {room.occupied && <Pill tone="neutral">Occupied</Pill>}
        {room.departsToday && <Pill tone="warning">Departs today</Pill>}
        {room.arrivesToday && <Pill tone="info">Arrives today</Pill>}
        {room.service !== 'in_service' && (
          <Pill tone="danger">{room.service === 'out_of_order' ? 'Out of order' : 'Maintenance'}</Pill>
        )}
        {task?.priority === 'high' && <Pill tone="danger">High priority</Pill>}
      </div>

      {task && (
        <div className="rounded-md bg-surface-2 px-3 py-2">
          <p className="text-sm font-medium text-text">
            {KIND_LABEL[task.kind]}
            <span className="ml-1.5 text-xs font-normal text-text-3">{task.status === 'in_progress' ? 'In progress' : 'Not started'}</span>
          </p>
          <p className="mt-0.5 text-xs text-text-3">{task.assignedTo ? `Assigned to ${task.assignedTo.name}` : 'Nobody assigned yet'}</p>
          {task.note && <p className="mt-1.5 text-xs text-text-2">{task.note}</p>}
        </div>
      )}

      {task ? (
        <div className="mt-auto flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {task.status === 'open' && (
              <Button size="sm" loading={busy(m.start.isPending, m.start.variables?.id)} onClick={() => m.start.mutate({ id: task.id, roomNumber: room.number })}>
                Start
              </Button>
            )}
            {task.status === 'in_progress' && (
              <Button size="sm" loading={busy(m.complete.isPending, m.complete.variables?.id)} onClick={() => m.complete.mutate({ id: task.id, roomNumber: room.number })}>
                Complete
              </Button>
            )}
            {task.status === 'in_progress' && (
              <Button size="sm" variant="outline" loading={busy(m.stop.isPending, m.stop.variables?.id)} onClick={() => m.stop.mutate({ id: task.id, roomNumber: room.number })}>
                Stop
              </Button>
            )}
            {task.status === 'open' && (
              <Button size="sm" variant="ghost" onClick={() => { setReason(''); setSkipOpen(true); }}>
                Skip
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              aria-label={`Assignee for room ${room.number}`}
              className="h-9 min-w-0 flex-1 text-sm"
              value={task.assignedTo?.id ?? ''}
              disabled={m.patch.isPending}
              onChange={(e) => {
                const value = e.target.value || null;
                const name = staff.find((s) => s.id === value)?.name;
                m.patch.mutate({
                  id: task.id,
                  version: task.version,
                  body: { assignedTo: value },
                  successMessage: value ? `Room ${room.number} assigned to ${name ?? 'staff'}` : `Room ${room.number} unassigned`,
                });
              }}
            >
              <option value="">Unassigned</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Button size="sm" variant="outline" onClick={() => { setNoteDraft(task.note ?? ''); setNoteOpen(true); }}>
              Note
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={busy(m.patch.isPending, m.patch.variables?.id)}
              onClick={() =>
                m.patch.mutate({
                  id: task.id,
                  version: task.version,
                  body: { priority: task.priority === 'high' ? 'normal' : 'high' },
                  successMessage: task.priority === 'high' ? `Room ${room.number} set back to normal` : `Room ${room.number} marked high priority`,
                })
              }
            >
              {task.priority === 'high' ? 'Set normal' : 'Set high'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-auto flex flex-wrap gap-1.5">
          {(room.housekeeping === 'dirty' || room.housekeeping === 'cleaning') && (
            <Button size="sm" variant="outline" loading={roomBusy} onClick={() => roomStatus.mutate({ roomId: room.roomId, number: room.number, to: 'clean' })}>
              Mark clean
            </Button>
          )}
          {room.housekeeping === 'clean' && (
            <Button size="sm" variant="outline" loading={roomBusy} onClick={() => roomStatus.mutate({ roomId: room.roomId, number: room.number, to: 'inspected' })}>
              Mark inspected
            </Button>
          )}
        </div>
      )}

      <Dialog
        open={skipOpen}
        onClose={() => setSkipOpen(false)}
        title={`Skip room ${room.number}`}
        description="Tell the team why this task will not be done."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSkipOpen(false)}>Cancel</Button>
            <Button
              loading={busy(m.skip.isPending, m.skip.variables?.id)}
              disabled={reason.trim().length < 3}
              onClick={() =>
                task && m.skip.mutate({ id: task.id, roomNumber: room.number, reason: reason.trim(), onDone: () => setSkipOpen(false) })
              }
            >
              Skip task
            </Button>
          </>
        }
      >
        <Field label="Reason" required hint="At least 3 characters.">
          {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Guest is still in the room" />}
        </Field>
      </Dialog>

      <Dialog
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title={`Note for room ${room.number}`}
        description="The cleaner sees this on their task list."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNoteOpen(false)}>Cancel</Button>
            <Button
              loading={busy(m.patch.isPending, m.patch.variables?.id)}
              onClick={() =>
                task &&
                m.patch.mutate({
                  id: task.id,
                  version: task.version,
                  body: { note: noteDraft.trim() || null },
                  successMessage: `Note saved for room ${room.number}`,
                  onDone: () => setNoteOpen(false),
                })
              }
            >
              Save note
            </Button>
          </>
        }
      >
        <Field label="Note" hint="Housekeeping instructions, linen requests, anything the cleaner should know.">
          {(id) => <Textarea id={id} rows={3} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="e.g. Guest asked for cleaning after 2 PM" />}
        </Field>
      </Dialog>
    </Card>
  );
}

interface RoomGroup {
  key: string;
  label: string;
  rooms: HousekeepingRoom[];
}

/** Group rooms by floor, building as the secondary label ("Floor 1 · Block A"); rooms without a floor go last. */
function groupByFloor(rooms: HousekeepingRoom[]): RoomGroup[] {
  const sorted = [...rooms].sort((a, b) => {
    const na = parseInt(a.number, 10);
    const nb = parseInt(b.number, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.number.localeCompare(b.number, undefined, { numeric: true });
  });

  const map = new Map<string, RoomGroup>();
  for (const r of sorted) {
    const floor = r.floor?.trim() ?? '';
    const building = r.building?.trim() ?? '';
    const key = `${floor}|${building}`;
    let g = map.get(key);
    if (!g) {
      const label = [floor ? `Floor ${floor}` : '', building].filter(Boolean).join(' · ') || 'Other rooms';
      g = { key, label, rooms: [] };
      map.set(key, g);
    }
    g.rooms.push(r);
  }

  const numericFloor = (g: RoomGroup): number | null => {
    const floor = g.rooms[0]?.floor ?? null;
    const n = parseInt(floor ?? '', 10);
    return Number.isNaN(n) ? null : n;
  };
  return [...map.values()].sort((a, b) => {
    const fa = numericFloor(a);
    const fb = numericFloor(b);
    if (fa !== null && fb !== null && fa !== fb) return fa - fb;
    if (fa !== null && fb === null) return -1;
    if (fa === null && fb !== null) return 1;
    const af = a.rooms[0]?.floor ?? '';
    const bf = b.rooms[0]?.floor ?? '';
    const ab = a.rooms[0]?.building ?? '';
    const bb = b.rooms[0]?.building ?? '';
    return af.localeCompare(bf) || ab.localeCompare(bb);
  });
}
