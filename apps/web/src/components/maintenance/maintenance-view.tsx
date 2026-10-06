'use client';
import { useQuery } from '@tanstack/react-query';
import { Plus, Wrench } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { formatDateTime, formatDate, formatINR } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMe, useProperty } from '@/lib/session';
import { SchedulesCard } from './schedules-card';
import { AssignDialog, OutOfOrderDialog, PriorityDialog, ReportProblemDialog, ResolveDialog } from './ticket-dialogs';
import { usePatchTicket, useRoomServiceStatus } from './use-maintenance-mutations';
import {
  PRIORITY_LABEL, SERVICE_LABEL, STATUS_LABEL, STATUS_TONE,
  type MaintenanceStaff, type MaintenanceTicket, type TicketStatus,
} from './types';

type Tab = 'attention' | TicketStatus;

const TABS: { value: Tab; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

const EMPTY: Record<Tab, { title: string; description?: string }> = {
  attention: { title: 'Nothing needs fixing', description: 'Reported problems and work in progress will show here.' },
  open: { title: 'No open tickets' },
  in_progress: { title: 'Nothing is being worked on right now' },
  resolved: { title: 'No resolved tickets yet' },
  closed: { title: 'No closed tickets yet' },
};

/**
 * Maintenance (spec §38): report a problem, work it open → in progress → resolved → closed, keep the
 * resort's rooms sellable, and let the owner keep preventive schedules. A ticket is about a room or
 * an area — never both.
 */
export function MaintenanceView() {
  const me = useMe();
  const property = useProperty();
  const isOwner = me.data?.role === 'owner';
  const businessDate = property.data?.businessDate;

  const tickets = useQuery({ queryKey: ['maintenance-tickets'], queryFn: () => api<MaintenanceTicket[]>('/maintenance/tickets') });
  // The people a ticket can be assigned to — the same staff as the housekeeping board (spec §37).
  const staff = useQuery({
    queryKey: ['housekeeping-board'],
    queryFn: () => api<{ staff: MaintenanceStaff[] }>('/housekeeping/board'),
    enabled: me.data?.role !== 'cleaner',
    select: (d) => d.staff,
  });

  const [tab, setTab] = useState<Tab>('attention');
  const [reporting, setReporting] = useState(false);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { attention: 0, open: 0, in_progress: 0, resolved: 0, closed: 0 };
    for (const t of tickets.data ?? []) {
      c[t.status] += 1;
      if (t.status === 'open' || t.status === 'in_progress') c.attention += 1;
    }
    return c;
  }, [tickets.data]);

  // The server already sorts open and in-progress first, high priority and newest within that.
  const visible = useMemo(
    () => (tickets.data ?? []).filter((t) => (tab === 'attention' ? t.status === 'open' || t.status === 'in_progress' : t.status === tab)),
    [tickets.data, tab],
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Maintenance"
        description="Report a problem, start work, and mark what was done and what it cost. Resolved tickets are closed by the owner."
        actions={<Button onClick={() => setReporting(true)}><Plus className="h-4 w-4" aria-hidden />Report a problem</Button>}
      />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter tickets by status">
        {TABS.map((t) => (
          <Chip key={t.value} active={tab === t.value} onClick={() => setTab(t.value)}>
            {t.label} <span className="num opacity-70">{counts[t.value]}</span>
          </Chip>
        ))}
      </div>

      {tickets.isLoading ? (
        <div className="grid gap-3 lg:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-44" />)}</div>
      ) : tickets.isError ? (
        <ErrorBanner message={(tickets.error as Error).message} onRetry={() => tickets.refetch()} />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState icon={<Wrench className="h-5 w-5" />} title={EMPTY[tab].title} description={EMPTY[tab].description} />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {visible.map((t) => (
            <TicketCard key={t.id} ticket={t} isOwner={isOwner} staff={staff.data ?? []} businessDate={businessDate} />
          ))}
        </div>
      )}

      {isOwner && <SchedulesCard businessDate={businessDate} />}

      {reporting && <ReportProblemDialog staff={staff.data ?? []} onClose={() => setReporting(false)} />}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={cn('inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors',
        active ? 'border-text bg-text text-bg' : 'border-border bg-surface text-text-2 hover:border-border-strong')}>
      {children}
    </button>
  );
}

function TicketCard({ ticket, isOwner, staff, businessDate }: { ticket: MaintenanceTicket; isOwner: boolean; staff: MaintenanceStaff[]; businessDate?: string }) {
  const patch = usePatchTicket();
  const roomService = useRoomServiceStatus();
  const [dialog, setDialog] = useState<'resolve' | 'assign' | 'priority' | 'ooo' | null>(null);

  const active = ticket.status === 'open' || ticket.status === 'in_progress';
  const showCost = ticket.status === 'resolved' || ticket.status === 'closed';

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-text">{ticket.title}</p>
          <p className="mt-0.5 text-xs text-text-3">
            Reported {formatDate(ticket.createdAt)}{ticket.createdBy ? ` · by ${ticket.createdBy}` : ''}
          </p>
        </div>
        <Pill tone={STATUS_TONE[ticket.status]}>{STATUS_LABEL[ticket.status]}</Pill>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {ticket.roomId
          ? <Pill tone="brand">Room {ticket.roomNumber}</Pill>
          : ticket.area && <Pill tone="info">{ticket.area}</Pill>}
        <Pill tone={ticket.priority === 'high' ? 'danger' : 'neutral'}>{PRIORITY_LABEL[ticket.priority]} priority</Pill>
        <span className="text-xs text-text-3">
          {ticket.assignedTo ? <>Assigned to <span className="font-medium text-text-2">{ticket.assignedTo.name}</span></> : 'Nobody assigned yet'}
        </span>
      </div>

      {ticket.description && <p className="text-sm text-text-2">{ticket.description}</p>}

      {ticket.roomId && active && (
        <div className="rounded-md bg-surface-2 px-3 py-2.5">
          <p className="text-sm font-medium text-text-2">
            Room status: {ticket.roomServiceStatus ? (SERVICE_LABEL[ticket.roomServiceStatus] ?? ticket.roomServiceStatus) : 'In service'}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {!ticket.roomServiceStatus || ticket.roomServiceStatus === 'in_service' ? (
              <Button size="sm" variant="outline"
                loading={roomService.isPending && roomService.variables?.service === 'maintenance'}
                onClick={() => roomService.mutate({ roomId: ticket.roomId!, roomNumber: ticket.roomNumber ?? '', service: 'maintenance' })}
              >
                Mark under maintenance
              </Button>
            ) : (
              <Button size="sm" variant="outline"
                loading={roomService.isPending && roomService.variables?.service === 'in_service'}
                onClick={() => roomService.mutate({ roomId: ticket.roomId!, roomNumber: ticket.roomNumber ?? '', service: 'in_service' })}
              >
                Back in service
              </Button>
            )}
            {isOwner && <Button size="sm" variant="ghost" onClick={() => setDialog('ooo')}>Out of order…</Button>}
          </div>
        </div>
      )}

      {showCost && (
        <div className="rounded-md bg-surface-2 px-3 py-2.5 text-sm">
          <p><span className="text-text-3">What was done: </span>{ticket.resolutionNote ?? '—'}</p>
          <p className="mt-1"><span className="text-text-3">Cost: </span><span className="tabular-nums">{ticket.cost ? formatINR(ticket.cost) : '—'}</span></p>
          {ticket.resolvedAt && <p className="mt-1 text-xs text-text-3">Resolved {formatDateTime(ticket.resolvedAt)}</p>}
          {ticket.closedAt && <p className="text-xs text-text-3">Closed {formatDateTime(ticket.closedAt)}</p>}
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-1.5">
        {ticket.status === 'open' && (
          <Button size="sm"
            loading={patch.isPending && patch.variables?.body.status === 'in_progress'}
            onClick={() => patch.mutate({ id: ticket.id, version: ticket.version, body: { status: 'in_progress' }, success: 'Work started' })}
          >
            Start work
          </Button>
        )}
        {active && (
          <>
            <Button size="sm" variant="outline" onClick={() => setDialog('resolve')}>Resolve</Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog('assign')}>{ticket.assignedTo ? 'Reassign' : 'Assign'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog('priority')}>Set priority</Button>
          </>
        )}
        {ticket.status === 'resolved' && isOwner && (
          <Button size="sm" variant="outline"
            loading={patch.isPending && patch.variables?.body.status === 'closed'}
            onClick={() => patch.mutate({ id: ticket.id, version: ticket.version, body: { status: 'closed' }, success: 'Ticket closed' })}
          >
            Close ticket
          </Button>
        )}
      </div>

      {dialog === 'resolve' && <ResolveDialog ticket={ticket} onClose={() => setDialog(null)} />}
      {dialog === 'assign' && <AssignDialog ticket={ticket} staff={staff} onClose={() => setDialog(null)} />}
      {dialog === 'priority' && <PriorityDialog ticket={ticket} onClose={() => setDialog(null)} />}
      {dialog === 'ooo' && ticket.roomId && (
        <OutOfOrderDialog roomId={ticket.roomId} roomNumber={ticket.roomNumber ?? ''} businessDate={businessDate} onClose={() => setDialog(null)} />
      )}
    </Card>
  );
}
