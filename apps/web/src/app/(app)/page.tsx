'use client';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BedDouble, CalendarPlus, Crown, DoorOpen, LogIn, LogOut, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { formatDate, formatINR } from '@resortos/shared';
import { RoomBoard, RoomLegend } from '@/components/front-desk/room-board';
import { Button } from '@/components/ui/button';
import { CountUp } from '@/components/ui/count-up';
import { Card, CardHeader, EmptyState, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { ReservationBadge } from '@/components/ui/status';
import { api } from '@/lib/api';
import { useMe, useProperty } from '@/lib/session';
import type { FrontDesk, Room } from '@/lib/types';

function to12h(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function HomePage() {
  const me = useMe();
  const property = useProperty();
  const desk = useQuery({ queryKey: ['front-desk'], queryFn: () => api<FrontDesk>('/front-desk'), refetchInterval: 30_000 });
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => api<Room[]>('/rooms'), refetchInterval: 30_000 });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting()}, {me.data?.fullName.split(' ')[0]}</h1>
          <p className="mt-1 text-sm text-text-3">{desk.data ? formatDate(desk.data.businessDate, { weekday: true }) : ' '}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/reservations/new"><Button><CalendarPlus className="h-4 w-4" />New booking</Button></Link>
          <Link href="/reservations/new?walkIn=1"><Button variant="outline"><UserPlus className="h-4 w-4" />Walk-in</Button></Link>
        </div>
      </div>

      {desk.isError && <ErrorBanner message={(desk.error as Error).message} onRetry={() => desk.refetch()} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Arrivals today" icon={LogIn} value={desk.data?.arrivals.length} tone="var(--st-arriving)" />
        <Kpi label="Departures today" icon={LogOut} value={desk.data?.departures.length} tone="var(--st-due-out)" />
        <Kpi label="Rooms in house" icon={BedDouble} value={desk.data?.inHouseRooms} tone="var(--st-occupied)" />
        <Kpi label="Ready to sell" icon={DoorOpen} value={desk.data?.roomCounts.ready} tone="var(--st-ready)" suffix={desk.data ? ` of ${desk.data.totalRooms}` : ''} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Arrivals" description="Expected to check in today"
            action={<Link href="/reservations?view=arrivals" className="text-sm font-medium text-brand hover:underline">All</Link>} />
          <ListBody loading={desk.isLoading} empty={desk.data?.arrivals.length === 0} emptyText="No arrivals expected today">
            {desk.data?.arrivals.map((a) => (
              <Row key={a.id} href={`/reservations/${a.id}`}
                title={<>{a.isVip && <Crown className="h-3.5 w-3.5 text-warning" aria-label="VIP" />}{a.guestName}</>}
                meta={`${a.roomNumbers ? `Room ${a.roomNumbers}` : `${a.roomTypes} · room not assigned`} · ${a.nights} night${a.nights > 1 ? 's' : ''} · ${a.sourceLabel}`}
                right={<div className="flex flex-col items-end gap-1"><ReservationBadge status={a.status} /><span className="text-xs text-text-3 num">{formatINR(a.total)}</span></div>} />
            ))}
          </ListBody>
        </Card>
        <Card>
          <CardHeader title="Departures" description="Due to check out today" />
          <ListBody loading={desk.isLoading} empty={desk.data?.departures.length === 0} emptyText="No departures due today">
            {desk.data?.departures.map((d) => (
              <Row key={d.id} href={`/reservations/${d.id}`}
                title={<>{d.isVip && <Crown className="h-3.5 w-3.5 text-warning" aria-label="VIP" />}{d.guestName}</>}
                meta={`Room ${d.roomNumbers ?? '—'} · ${d.number}`}
                right={d.overdue ? <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">Overdue since {formatDate(d.departure, { year: false })}</span> : <span className="text-xs text-text-3">Checkout {property.data ? to12h(property.data.checkOutTime) : ''}</span>} />
            ))}
          </ListBody>
        </Card>
      </div>

      <AvailabilityChanged />

      <Card>
        <CardHeader title="Rooms" description="Tap a room to update its status"
          action={<Link href="/rooms" className="flex items-center gap-1 text-sm font-medium text-brand hover:underline">Room board<ArrowRight className="h-4 w-4" /></Link>} />
        <div className="flex flex-col gap-4 p-5">
          {desk.data && <RoomLegend counts={desk.data.roomCounts} />}
          {rooms.isLoading ? <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-5 xl:grid-cols-8">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="h-[76px]" />)}</div>
            : rooms.data ? <RoomBoard rooms={rooms.data} compact /> : null}
        </div>
      </Card>
    </div>
  );
}

function Kpi({ label, value, icon: Icon, tone, suffix }: { label: string; value?: number; icon: typeof LogIn; tone: string; suffix?: string }) {
  return (
    <Card className="flex items-center gap-3 p-3 sm:gap-4 sm:p-4">
      <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg min-[400px]:flex" style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}><Icon className="h-5 w-5" /></span>
      <div className="min-w-0">
        <p className="text-xs font-medium leading-snug text-text-3">{label}</p>
        {value === undefined ? <Skeleton className="mt-1 h-7 w-12" /> : <p className="text-2xl font-semibold leading-tight"><CountUp value={value} /><span className="text-sm font-normal text-text-3">{suffix}</span></p>}
      </div>
    </Card>
  );
}

function ListBody({ loading, empty, emptyText, children }: { loading: boolean; empty?: boolean; emptyText: string; children: React.ReactNode }) {
  if (loading) return <div className="flex flex-col gap-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (empty) return <EmptyState title={emptyText} />;
  return <ul className="divide-y divide-border">{children}</ul>;
}

function Row({ href, title, meta, right }: { href: string; title: React.ReactNode; meta: string; right: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate font-medium">{title}</p>
          <p className="truncate text-sm text-text-3">{meta}</p>
        </div>
        {right}
      </Link>
    </li>
  );
}

/**
 * Without a channel manager the desk updates OTA extranets by hand (spec §33). This is the list of
 * what changed today — bookings, cancellations, extensions, rooms out of order — so nothing is missed.
 */
function AvailabilityChanged() {
  const changes = useQuery({
    queryKey: ['availability-changes'], refetchInterval: 60_000,
    queryFn: () => api<{ id: string; at: string; what: string; from: string | null; to: string | null }[]>('/availability-changes/today'),
  });
  if (!changes.data?.length) return null;
  return (
    <Card>
      <CardHeader title="Availability changed today" description="Update these dates on the OTA extranets" />
      <ul className="border-t border-border text-sm">
        {changes.data.slice(0, 12).map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-2 last:border-0">
            <span>{c.what}</span>
            <span className="tabular-nums text-text-2">
              {c.from && c.to ? `${formatDate(c.from, { year: false })} – ${formatDate(c.to, { year: false })}` : ''}
              <span className="ml-3 text-xs text-text-3">{new Date(c.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
