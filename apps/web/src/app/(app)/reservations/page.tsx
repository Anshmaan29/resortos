'use client';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, Crown, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useDeferredValue, useState } from 'react';
import { BOOKING_SOURCE_LABELS, BOOKING_SOURCES, formatDate, formatINR, formatMobile, RESERVATION_STATUSES, addDays } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { ReservationBadge } from '@/components/ui/status';
import { api } from '@/lib/api';
import { useProperty } from '@/lib/session';
import type { ReservationListItem } from '@/lib/types';

const STATUS_LABEL: Record<string, string> = { tentative: 'Tentative', confirmed: 'Confirmed', checked_in: 'In house', checked_out: 'Checked out', cancelled: 'Cancelled', no_show: 'No-show' };

function ReservationsList() {
  const router = useRouter();
  const params = useSearchParams();
  const property = useProperty();
  const bd = property.data?.businessDate;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [range, setRange] = useState<'upcoming' | 'arrivals' | 'all'>(params.get('view') === 'arrivals' ? 'arrivals' : 'upcoming');
  const search = useDeferredValue(q);

  const query = {
    q: search.length >= 2 ? search : undefined, status: status || undefined, source: source || undefined,
    from: range === 'all' ? undefined : bd, to: range === 'arrivals' ? bd : range === 'upcoming' && bd ? addDays(bd, 60) : undefined,
  };
  const list = useQuery({
    queryKey: ['reservations', query], enabled: !!bd, placeholderData: (prev) => prev,
    queryFn: () => api<ReservationListItem[]>('/reservations', { query }),
  });
  const rows = range === 'arrivals' ? list.data?.filter((r) => r.arrival === bd) : list.data;

  return (
    <div>
      <PageHeader title="Bookings" description="Search by guest name, mobile, booking number or OTA reference."
        actions={<Link href="/reservations/new"><Button><CalendarPlus className="h-4 w-4" />New booking</Button></Link>} />
      <Card className="mb-4 flex flex-wrap items-center gap-3 p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bookings" className="pl-9" aria-label="Search bookings" />
        </div>
        <Select value={range} onChange={(e) => setRange(e.target.value as typeof range)} className="w-auto" aria-label="Date range">
          <option value="arrivals">Arriving today</option>
          <option value="upcoming">Next 60 days</option>
          <option value="all">All dates</option>
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto" aria-label="Status">
          <option value="">Any status</option>
          {RESERVATION_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </Select>
        <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-auto" aria-label="Source">
          <option value="">Any source</option>
          {BOOKING_SOURCES.map((s) => <option key={s} value={s}>{BOOKING_SOURCE_LABELS[s]}</option>)}
        </Select>
      </Card>

      {list.isError && <ErrorBanner message={(list.error as Error).message} onRetry={() => list.refetch()} />}
      <Card className="overflow-hidden">
        {list.isLoading || !bd ? (
          <div className="flex flex-col gap-2 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : rows && rows.length === 0 ? (
          <EmptyState icon={<Search className="h-5 w-5" />} title="No bookings found" description="Try another search or date range." />
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full text-sm md:table">
              <thead className="bg-surface-2 text-left text-xs font-medium uppercase tracking-wide text-text-2">
                <tr><th className="px-4 py-3">Booking</th><th className="px-4 py-3">Guest</th><th className="px-4 py-3">Stay</th><th className="px-4 py-3">Rooms</th><th className="px-4 py-3">Source</th><th className="px-4 py-3 text-right">Estimate</th><th className="px-4 py-3">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows?.map((r) => (
                  <tr key={r.id} onClick={() => router.push(`/reservations/${r.id}`)} className="cursor-pointer hover:bg-surface-2">
                    <td className="px-4 py-3"><Link href={`/reservations/${r.id}`} className="font-medium num text-brand hover:underline" onClick={(e) => e.stopPropagation()}>{r.number}</Link>{r.groupName && <p className="text-xs text-text-3">{r.groupName}</p>}</td>
                    <td className="px-4 py-3"><p className="flex items-center gap-1 font-medium">{r.isVip && <Crown className="h-3.5 w-3.5 text-warning" aria-label="VIP" />}{r.guestName}</p><p className="text-xs text-text-2 num">{formatMobile(r.mobile)}</p></td>
                    <td className="px-4 py-3 num">{formatDate(r.arrival, { year: false })} → {formatDate(r.departure, { year: false })}<p className="text-xs text-text-3">{r.nights} night{r.nights > 1 ? 's' : ''}</p></td>
                    <td className="px-4 py-3">{r.roomNumbers ?? <span className="text-text-3">Not assigned</span>}<p className="text-xs text-text-3">{r.roomTypes}</p></td>
                    <td className="px-4 py-3">{r.sourceLabel}{r.otaReference && <p className="text-xs text-text-3 num">{r.otaReference}</p>}</td>
                    <td className="px-4 py-3 text-right num">{formatINR(r.total)}</td>
                    <td className="px-4 py-3"><ReservationBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Phone list */}
            <ul className="divide-y divide-border md:hidden">
              {rows?.map((r) => (
                <li key={r.id}>
                  <Link href={`/reservations/${r.id}`} className="flex items-start gap-3 px-4 py-3 active:bg-surface-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1 truncate font-medium">{r.isVip && <Crown className="h-3.5 w-3.5 text-warning" />}{r.guestName}</p>
                      <p className="text-sm text-text-2 num">{formatDate(r.arrival, { year: false })} → {formatDate(r.departure, { year: false })} · {r.roomNumbers ?? r.roomTypes}</p>
                      <p className="text-xs text-text-2 num">{formatMobile(r.mobile)} · {r.number} · {r.sourceLabel}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1"><ReservationBadge status={r.status} /><span className="text-sm num">{formatINR(r.total)}</span></div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

export default function ReservationsPage() {
  return <Suspense><ReservationsList /></Suspense>;
}
