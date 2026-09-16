import type { ReservationStatus, RoomDisplayState } from '@resortos/shared';
import { BedDouble, CalendarCheck, CheckCircle2, CircleDashed, Clock, LogOut, Sparkles, Wrench, XCircle, Ban, UserX, LogIn } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const ROOM_STATE: Record<RoomDisplayState, { label: string; icon: typeof BedDouble; fg: string; bg: string }> = {
  ready: { label: 'Ready', icon: CheckCircle2, fg: 'var(--st-ready)', bg: 'var(--st-ready-bg)' },
  occupied: { label: 'Occupied', icon: BedDouble, fg: 'var(--st-occupied)', bg: 'var(--st-occupied-bg)' },
  dirty: { label: 'Dirty', icon: CircleDashed, fg: 'var(--st-dirty)', bg: 'var(--st-dirty-bg)' },
  cleaning: { label: 'Cleaning', icon: Sparkles, fg: 'var(--st-cleaning)', bg: 'var(--st-cleaning-bg)' },
  arriving: { label: 'Arriving', icon: LogIn, fg: 'var(--st-arriving)', bg: 'var(--st-arriving-bg)' },
  due_out: { label: 'Due out', icon: LogOut, fg: 'var(--st-due-out)', bg: 'var(--st-due-out-bg)' },
  maintenance: { label: 'Maintenance', icon: Wrench, fg: 'var(--st-maint)', bg: 'var(--st-maint-bg)' },
  out_of_order: { label: 'Out of order', icon: Ban, fg: 'var(--st-ooo)', bg: 'var(--st-ooo-bg)' },
};

export function RoomStateBadge({ state, className }: { state: RoomDisplayState; className?: string }) {
  const s = ROOM_STATE[state];
  const Icon = s.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', className)} style={{ color: s.fg, background: s.bg }}>
      <Icon className="h-3.5 w-3.5" aria-hidden />{s.label}
    </span>
  );
}

const RES: Record<ReservationStatus, { label: string; icon: typeof BedDouble; tone: string }> = {
  tentative: { label: 'Tentative', icon: Clock, tone: 'text-warning bg-warning-soft' },
  confirmed: { label: 'Confirmed', icon: CalendarCheck, tone: 'text-brand bg-brand-soft' },
  checked_in: { label: 'In house', icon: BedDouble, tone: 'text-info bg-info-soft' },
  checked_out: { label: 'Checked out', icon: LogOut, tone: 'text-text-2 bg-surface-2' },
  cancelled: { label: 'Cancelled', icon: XCircle, tone: 'text-danger bg-danger-soft' },
  no_show: { label: 'No-show', icon: UserX, tone: 'text-text-2 bg-surface-3' },
};

export function ReservationBadge({ status }: { status: ReservationStatus }) {
  const s = RES[status];
  const Icon = s.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', s.tone)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />{s.label}
    </span>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' | 'warning' | 'danger' | 'info' }) {
  const tones = { neutral: 'bg-surface-2 text-text-2', brand: 'bg-brand-soft text-brand', warning: 'bg-warning-soft text-warning', danger: 'bg-danger-soft text-danger', info: 'bg-info-soft text-info' };
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}
