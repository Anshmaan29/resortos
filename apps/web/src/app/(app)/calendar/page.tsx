'use client';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Crown } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { addDays, formatDate, nightsBetween, type ReservationStatus } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { ReservationBadge } from '@/components/ui/status';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useProperty } from '@/lib/session';
import type { CalendarData } from '@/lib/types';

const DAYS = 14;
const COL = 84; // px per day
const ROW = 48;

const BAR: Record<ReservationStatus, string> = {
  tentative: 'bg-warning-soft text-warning border-warning/40 border-dashed',
  confirmed: 'bg-brand-soft text-brand border-brand/40',
  checked_in: 'bg-info-soft text-info border-info/40',
  checked_out: 'bg-surface-3 text-text-2 border-border-strong',
  cancelled: 'bg-danger-soft text-danger border-danger/30',
  no_show: 'bg-surface-3 text-text-3 border-border',
};

export default function CalendarPage() {
  const property = useProperty();
  const bd = property.data?.businessDate;
  const [from, setFrom] = useState<string | null>(null);
  useEffect(() => { if (bd && !from) setFrom(addDays(bd, -1)); }, [bd, from]);

  const cal = useQuery({
    queryKey: ['calendar', from], enabled: !!from, placeholderData: (p) => p,
    queryFn: () => api<CalendarData>('/calendar', { query: { from: from!, days: DAYS } }),
  });

  const days = useMemo(() => (from ? Array.from({ length: DAYS }, (_, i) => addDays(from, i)) : []), [from]);
  const groups = useMemo(() => {
    const m = new Map<string, CalendarData['rooms']>();
    for (const r of cal.data?.rooms ?? []) m.set(r.roomTypeName, [...(m.get(r.roomTypeName) ?? []), r]);
    return [...m.entries()];
  }, [cal.data]);

  const nav = (delta: number) => from && setFrom(addDays(from, delta));

  return (
    <div>
      <PageHeader title="Calendar" description="Bookings by room. Tap a booking to open it."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => nav(-7)} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" onClick={() => bd && setFrom(addDays(bd, -1))}>Today</Button>
            <Button variant="outline" size="icon" onClick={() => nav(7)} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button>
          </div>
        } />

      {cal.isError && <ErrorBanner message={(cal.error as Error).message} onRetry={() => cal.refetch()} />}

      {cal.data && cal.data.unassigned.length > 0 && (
        <Card className="mb-4 p-4">
          <p className="mb-2 text-sm font-medium">Waiting for a room ({cal.data.unassigned.length})</p>
          <div className="flex flex-wrap gap-2">
            {cal.data.unassigned.map((u) => (
              <Link key={u.reservationRoomId} href={`/reservations/${u.reservationId}`} className="rounded-md border border-dashed border-border-strong px-3 py-1.5 text-sm hover:bg-surface-2">
                <span className="font-medium">{u.guestName}</span> <span className="text-text-3">· {u.roomTypeName} · {formatDate(u.start, { year: false })}–{formatDate(u.end, { year: false })}</span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* Desktop / tablet timeline */}
      <Card className="hidden overflow-hidden md:block">
        {!cal.data ? <div className="p-4"><Skeleton className="h-96" /></div> : (
          <div className="overflow-x-auto">
            <div style={{ width: 120 + COL * DAYS }} className="relative">
              {/* Header */}
              <div className="sticky top-0 z-20 flex border-b border-border bg-surface-2">
                <div className="sticky left-0 z-10 w-[120px] shrink-0 border-r border-border bg-surface-2 px-3 py-2 text-xs font-medium uppercase tracking-wide text-text-3">Room</div>
                {days.map((d) => {
                  const weekend = [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
                  return (
                    <div key={d} style={{ width: COL }} className={cn('shrink-0 border-r border-border px-2 py-2 text-center', d === bd && 'bg-brand-soft', weekend && d !== bd && 'bg-surface-3/50')}>
                      <p className={cn('text-[11px] uppercase', d === bd ? 'font-semibold text-brand' : 'text-text-3')}>{formatDate(d, { weekday: true, year: false }).split(' ')[0]}</p>
                      <p className={cn('text-sm font-semibold num', d === bd && 'text-brand')}>{formatDate(d, { year: false })}</p>
                    </div>
                  );
                })}
              </div>
              {/* Today line */}
              {bd && days.includes(bd) && (
                <div className="pointer-events-none absolute bottom-0 top-0 z-[5] w-0.5 bg-brand/60" style={{ left: 120 + COL * days.indexOf(bd) + COL / 2 }} aria-hidden />
              )}
              {groups.map(([typeName, rooms]) => (
                <div key={typeName}>
                  <div className="sticky left-0 flex h-8 items-center border-b border-border bg-surface px-3 text-xs font-semibold uppercase tracking-wide text-text-3">{typeName}</div>
                  {rooms.map((room) => (
                    <div key={room.id} className="relative flex border-b border-border" style={{ height: ROW }}>
                      <div className="sticky left-0 z-20 flex w-[120px] shrink-0 items-center border-r border-border bg-surface px-3 text-sm font-semibold num">{room.number}</div>
                      {days.map((d) => <div key={d} style={{ width: COL }} className={cn('shrink-0 border-r border-border/60', d === bd && 'bg-brand-soft/30')} />)}
                      {cal.data!.outOfOrder.filter((o) => o.roomId === room.id).map((o) => {
                        const pos = span(from!, o.start, o.end);
                        return pos && (
                          <div key={o.id} title={o.reason} className="absolute top-1.5 flex items-center overflow-hidden rounded-md border border-border-strong bg-[repeating-linear-gradient(135deg,var(--surface-3)_0_6px,var(--surface-2)_6px_12px)] px-2 text-xs font-medium text-text-2"
                            style={{ left: 120 + pos.left * COL + 2, width: pos.width * COL - 4, height: ROW - 12 }}>
                            <span className="truncate">Out of order · {o.reason}</span>
                          </div>
                        );
                      })}
                      {cal.data!.bookings.filter((b) => b.roomId === room.id).map((b) => {
                        const pos = span(from!, b.start, b.end);
                        return pos && (
                          <Link key={b.allocationId} href={`/reservations/${b.reservationId}`}
                            title={`${b.guestName} · ${b.number} · ${formatDate(b.start, { year: false })}–${formatDate(b.end, { year: false })}`}
                            className={cn('absolute top-1.5 flex items-center gap-1 overflow-hidden rounded-md border px-2 text-xs font-medium shadow-sm transition-transform duration-150 hover:z-10 hover:-translate-y-px hover:shadow-md',
                              BAR[b.status], pos.clipStart && 'rounded-l-none', pos.clipEnd && 'rounded-r-none')}
                            style={{ left: 120 + pos.left * COL + (pos.clipStart ? 0 : COL / 2), width: pos.width * COL - (pos.clipStart ? 0 : COL / 2) + (pos.clipEnd ? 0 : COL / 2) - 4, height: ROW - 12 }}>
                            {b.isVip && <Crown className="h-3 w-3 shrink-0" />}
                            <span className="truncate">{b.groupName ? `${b.groupName} · ` : ''}{b.guestName}</span>
                          </Link>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Phone: day list view (spec §14) */}
      <div className="md:hidden">
        {!cal.data ? <Skeleton className="h-64" /> : <DayList data={cal.data} days={days} businessDate={bd!} />}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs text-text-3">
        {(['tentative', 'confirmed', 'checked_in', 'checked_out'] as ReservationStatus[]).map((s) => <ReservationBadge key={s} status={s} />)}
      </div>
    </div>
  );
}

/** Position of a [start, end) stay in the visible window. Bars start/end at mid-day like a hotel night. */
function span(from: string, start: string, end: string) {
  const left = Math.max(0, nightsBetween(from, start));
  const right = Math.min(DAYS, nightsBetween(from, end));
  if (right <= 0 || left >= DAYS) return null;
  return { left, width: right - left, clipStart: nightsBetween(from, start) < 0, clipEnd: nightsBetween(from, end) > DAYS };
}

function DayList({ data, days, businessDate }: { data: CalendarData; days: string[]; businessDate: string }) {
  const [day, setDay] = useState(businessDate);
  const roomNo = (id: string) => data.rooms.find((r) => r.id === id)?.number;
  const arriving = data.bookings.filter((b) => b.start === day);
  const staying = data.bookings.filter((b) => b.start < day && b.end > day);
  const leaving = data.bookings.filter((b) => b.end === day);
  return (
    <div className="flex flex-col gap-4">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {days.map((d) => (
          <button key={d} onClick={() => setDay(d)} className={cn('flex min-w-[56px] flex-col items-center rounded-lg border px-2 py-2', d === day ? 'border-brand bg-brand text-brand-contrast' : 'border-border bg-surface')}>
            <span className="text-[11px] uppercase opacity-80">{formatDate(d, { weekday: true, year: false }).split(' ')[0]}</span>
            <span className="text-base font-semibold num">{d.slice(8)}</span>
          </button>
        ))}
      </div>
      {[['Arriving', arriving], ['Staying', staying], ['Leaving', leaving]].map(([title, list]) => (
        <Card key={title as string}>
          <p className="border-b border-border px-4 py-3 text-sm font-semibold">{title as string} <span className="text-text-3 num">{(list as CalendarData['bookings']).length}</span></p>
          {(list as CalendarData['bookings']).length === 0 ? <EmptyState title="None" /> : (
            <ul className="divide-y divide-border">
              {(list as CalendarData['bookings']).map((b) => (
                <li key={b.allocationId}><Link href={`/reservations/${b.reservationId}`} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span><span className="font-medium">{b.guestName}</span><span className="block text-sm text-text-3">Room {roomNo(b.roomId)} · {b.number}</span></span>
                  <ReservationBadge status={b.status} />
                </Link></li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
