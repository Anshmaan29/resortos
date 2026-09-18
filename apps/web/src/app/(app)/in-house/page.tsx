'use client';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BedDouble, Crown, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate, formatMobile, VISIT_PURPOSE_LABELS } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { Input } from '@/components/ui/field';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Property, RoomShiftLogItem, StayListItem } from '@/lib/types';

type Status = 'in_house' | 'checked_out' | 'all';
const STATUS_LABEL: Record<Status, string> = { in_house: 'In house', checked_out: 'Checked out', all: 'All' };

/** The old software's "Check In List" and "Room Shift Log", in one place. */
export default function InHousePage() {
  const [tab, setTab] = useState<'stays' | 'shifts'>('stays');
  const [status, setStatus] = useState<Status>('in_house');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');

  const property = useQuery({ queryKey: ['property'], queryFn: () => api<Property>('/property') });
  const range = { from: from || undefined, to: to || undefined };

  const stays = useQuery({
    queryKey: ['stays', status, from, to, q],
    enabled: tab === 'stays',
    queryFn: () => api<StayListItem[]>('/stays', { query: { status, ...range, q: q.trim() || undefined } }),
  });
  const shifts = useQuery({
    queryKey: ['room-shifts', from, to],
    enabled: tab === 'shifts',
    queryFn: () => api<RoomShiftLogItem[]>('/room-shifts', { query: range }),
  });

  const filtered = from || to || q.trim() || status !== 'in_house';
  const clear = () => { setFrom(''); setTo(''); setQ(''); setStatus('in_house'); };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="In house"
        description={property.data ? `Business date ${formatDate(property.data.businessDate, { weekday: true })}` : undefined}
      />

      <div className="flex gap-2" role="tablist" aria-label="View">
        {(['stays', 'shifts'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn('rounded-md px-3 py-2 text-sm font-medium', tab === t ? 'bg-ink text-surface' : 'text-text-2 hover:bg-surface-2')}
            style={tab === t ? { background: 'var(--text)', color: 'var(--surface)' } : undefined}
          >
            {t === 'stays' ? 'Guests' : 'Room changes'}
          </button>
        ))}
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          {tab === 'stays' && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-2">Status</span>
              <div className="flex gap-1.5">
                {(['in_house', 'checked_out', 'all'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus(s)}
                    aria-pressed={status === s}
                    className={cn('h-11 rounded-md border px-3 text-sm',
                      status === s ? 'border-brand bg-brand-soft font-medium text-brand' : 'border-border text-text-2 hover:bg-surface-2')}
                  >
                    {STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <DateField label="From" value={from} onChange={setFrom} />
          <DateField label="To" value={to} onChange={setTo} />
          {tab === 'stays' && (
            <div className="relative min-w-[200px] flex-1">
              <span className="mb-1.5 block text-sm font-medium text-text-2">Find</span>
              <Search className="pointer-events-none absolute bottom-3.5 left-3 h-4 w-4 text-text-3" aria-hidden />
              <Input className="pl-10" placeholder="Room, guest or booking" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a stay" />
            </div>
          )}
          {filtered && <Button variant="ghost" onClick={clear}>Clear</Button>}
        </div>
        <p className="mt-3 text-xs text-text-3">
          Dates match any stay that overlaps the range, so a guest who arrived before it still appears.
        </p>
      </Card>

      {tab === 'stays' ? (
        <StaysTable query={stays} />
      ) : (
        <ShiftsTable query={shifts} />
      )}
    </div>
  );
}

function StaysTable({ query }: { query: ReturnType<typeof useQuery<StayListItem[]>> }) {
  if (query.isLoading) return <Skeleton className="h-64" />;
  if (query.isError) return <ErrorBanner message={(query.error as Error).message} onRetry={() => query.refetch()} />;
  const rows = query.data ?? [];
  if (rows.length === 0) {
    return <Card><EmptyState icon={<BedDouble className="h-5 w-5" />} title="Nobody here" description="No stay matches these filters." /></Card>;
  }
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
            <tr>
              <th className="px-5 py-2.5 font-medium">Room</th>
              <th className="px-3 py-2.5 font-medium">Guest</th>
              <th className="px-3 py-2.5 font-medium">Guests</th>
              <th className="px-3 py-2.5 font-medium">Stay</th>
              <th className="px-3 py-2.5 font-medium">Purpose</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((s) => (
              <tr key={s.id} className="hover:bg-surface-2">
                <td className="px-5 py-3">
                  <Link href={`/stays/${s.id}`} className="num font-medium text-brand hover:underline">{s.roomNumber}</Link>
                  <span className="block text-xs text-text-3">{s.roomTypeName}</span>
                </td>
                <td className="px-3 py-3">
                  <Link href={`/guests/${s.guestId}`} className="flex items-center gap-1.5 font-medium hover:underline">
                    {s.isVip && <Crown className="h-3.5 w-3.5 text-warning" aria-label="VIP" />}{s.guestName}
                  </Link>
                  <span className="block num text-xs text-text-3">{formatMobile(s.mobile)}</span>
                </td>
                <td className="px-3 py-3 num text-text-2">{s.adults}{s.children ? ` + ${s.children}` : ''}</td>
                <td className="px-3 py-3 text-text-2">
                  {formatDate(s.checkedIn, { year: false })} → {formatDate(s.checkedOut ?? s.dueOut, { year: false })}
                </td>
                <td className="px-3 py-3 text-text-2">{s.purpose ? VISIT_PURPOSE_LABELS[s.purpose] : '—'}</td>
                <td className="px-3 py-3">
                  <Pill tone={s.status === 'in_house' ? 'info' : 'neutral'}>{s.status === 'in_house' ? 'In house' : 'Checked out'}</Pill>
                  {s.earlyDeparture && <span className="ml-1.5 text-xs text-text-3">left early</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-5 py-3 text-xs text-text-3">{rows.length} stay{rows.length === 1 ? '' : 's'}</p>
    </Card>
  );
}

function ShiftsTable({ query }: { query: ReturnType<typeof useQuery<RoomShiftLogItem[]>> }) {
  if (query.isLoading) return <Skeleton className="h-64" />;
  if (query.isError) return <ErrorBanner message={(query.error as Error).message} onRetry={() => query.refetch()} />;
  const rows = query.data ?? [];
  if (rows.length === 0) {
    return <Card><EmptyState icon={<ArrowRight className="h-5 w-5" />} title="No room changes" description="Nobody has been moved in this period." /></Card>;
  }
  return (
    <Card>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
            <span className="num font-medium">{r.from}</span>
            <ArrowRight className="h-4 w-4 text-text-3" aria-hidden />
            <Link href={`/stays/${r.stayId}`} className="num font-medium text-brand hover:underline">{r.to}</Link>
            <span className="text-text-2">{r.guestName}</span>
            <span className="text-text-2">· {r.reason}</span>
            {r.rateDecision === 'new_room_type_rate' && <Pill tone="warning">Rate changed</Pill>}
            {r.authorisedBy && <Pill tone="info">Authorised by {r.authorisedBy}</Pill>}
            <span className="ml-auto text-xs text-text-3">{formatDate(r.businessDate, { year: false })} · {r.by}</span>
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-5 py-3 text-xs text-text-3">{rows.length} room change{rows.length === 1 ? '' : 's'}</p>
    </Card>
  );
}
