'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { Plus, CalendarDays } from 'lucide-react';
import { api } from '@/lib/api';
import { useProperty } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { SetupReminder } from '@/components/setup-reminder';
import { Card, PageHeader, ErrorBanner, Skeleton, EmptyState } from '@/components/ui/surface';
import type { Bill } from '@/lib/types';
export interface VillaBooking {
  id: string;
  number: string;
  useKind: string;
  useLabel: string;
  startsAt: string;
  endsAt: string;
  guestCount: number;
  mealPlan: string;
  price: string;
  gstPercent: string;
  status: string;
  version: number;
  guestId: string;
  guestName: string;
  mobile: string;
  email: string | null;
  notes: string | null;
  dayUse: boolean;
  stayId: string | null;
  folioId: string | null;
  subtotal: string;
  estimatedTotal: string;
  paid: string;
  bill: Bill | null;
}
export const villaTime = (value: string) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
const labels: Record<string, string> = {
  confirmed: 'Booked',
  checked_in: 'In use',
  checked_out: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};
export function VillaBookings({ view = 'home' }: { view?: 'home' | 'all' | 'active' | 'calendar' }) {
  const property = useProperty();
  const [search, setSearch] = useState('');
  const [date, setDate] = useState('');
  const list = useQuery({
    queryKey: ['villa-bookings', date],
    queryFn: () =>
      api<VillaBooking[]>('/villa/bookings', { query: { from: date || undefined, to: date || undefined } }),
    enabled: property.data?.bookingModel === 'private_villa',
    refetchInterval: 15000,
  });
  if (property.data && property.data.bookingModel !== 'private_villa')
    return <ErrorBanner message="Choose Villa Sol to open the villa workspace." />;
  const rows = (list.data ?? [])
    .filter(
      (r) =>
        (view !== 'active' || r.status === 'checked_in') &&
        (view !== 'home' ||
          r.status === 'checked_in' ||
          (r.status === 'confirmed' && new Date(r.endsAt) > new Date())) &&
        [r.guestName, r.mobile, r.number, r.useLabel].join(' ').toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      view === 'all'
        ? b.number.localeCompare(a.number)
        : Number(b.status === 'checked_in') - Number(a.status === 'checked_in') ||
          Date.parse(a.startsAt) - Date.parse(b.startsAt),
    );
  return (
    <div className="space-y-5">
      <PageHeader
        title={
          view === 'active'
            ? 'Villa in use'
            : view === 'calendar'
              ? 'Villa availability'
              : view === 'all'
                ? 'Villa bookings'
                : (property.data?.name ?? 'Villa Sol')
        }
        description="Every booking reserves the whole property exclusively for its dates and times."
        actions={
          <Link href="/villa/new">
            <Button>
              <Plus className="h-4 w-4" />
              New booking
            </Button>
          </Link>
        }
      />
      {view === 'home' && <SetupReminder />}
      {view === 'home' && (
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            [
              'Upcoming',
              list.data?.filter((r) => r.status === 'confirmed' && new Date(r.endsAt) > new Date()).length ??
                0,
            ],
            ['In use', list.data?.filter((r) => r.status === 'checked_in').length ?? 0],
            ['Reception', property.data?.policies.receptionPhone ?? property.data?.phone ?? ''],
          ].map(([name, value]) => (
            <Card key={name} className="p-4">
              <p className="text-sm text-text-2">{name}</p>
              <p className="mt-2 text-2xl font-semibold">{value}</p>
            </Card>
          ))}
        </div>
      )}
      <Card className="flex flex-wrap gap-3 p-3">
        <Input
          aria-label="Search villa bookings"
          placeholder="Guest, mobile or booking number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-[200px] flex-1"
        />
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4" />
          <Input
            aria-label="Filter villa date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          {date && (
            <Button variant="ghost" onClick={() => setDate('')}>
              All dates
            </Button>
          )}
        </div>
      </Card>
      {list.isError && <ErrorBanner message={list.error.message} onRetry={() => list.refetch()} />}
      {list.isLoading ? (
        <Skeleton className="h-60" />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No bookings found"
            description="Choose another date or create a villa booking."
          />
        </Card>
      ) : (
        <div className="grid gap-3">
          {rows.map((r) => (
            <Link key={r.id} href={`/villa/bookings/${r.id}`}>
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4 hover:border-brand">
                <div>
                  <p className="font-semibold">
                    {r.number} · {r.guestName}
                  </p>
                  <p className="mt-1 text-sm text-text-2">
                    {r.useLabel} · {r.guestCount} guests
                  </p>
                  <p className="mt-1 text-sm text-text-2">
                    {villaTime(r.startsAt)} → {villaTime(r.endsAt)}
                  </p>
                </div>
                <span
                  className={
                    r.status === 'checked_in'
                      ? 'rounded-full bg-brand-soft px-3 py-1 text-sm text-brand'
                      : 'rounded-full bg-surface-2 px-3 py-1 text-sm'
                  }
                >
                  {labels[r.status] ?? r.status}
                </span>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
