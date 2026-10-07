'use client';
import { useQuery } from '@tanstack/react-query';
import { Car, Crown, Phone, Search, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate, formatMobile } from '@resortos/shared';
import { Input } from '@/components/ui/field';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import type { Guest } from '@/lib/types';

/** Guest details (spec §16) — the old software's "Customers". */
export default function GuestsPage() {
  const [term, setTerm] = useState('');
  const q = term.trim();

  const results = useQuery({
    queryKey: ['guests', q],
    enabled: q.length === 0 || q.length >= 2,
    queryFn: () => api<Guest[]>('/guests', { query: { q } }),
  });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Guests" description="Recent guests. Search by name, mobile, booking number or vehicle number." />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
        <Input
          id="guest-search"
          className="pl-10"
          placeholder="Name, mobile, BK-000123 or RJ14CX1234"
          value={term}
          autoFocus
          onChange={(e) => setTerm(e.target.value)}
          aria-label="Search guests"
        />
      </div>

      {q.length > 0 && q.length < 2 && <p className="text-sm text-text-3">Type at least two characters.</p>}

      {results.isLoading && (q.length === 0 || q.length >= 2) && <div className="flex flex-col gap-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>}
      {results.isError && <ErrorBanner message={(results.error as Error).message} onRetry={() => results.refetch()} />}

      {results.data && results.data.length === 0 && (
        <Card>
          <EmptyState
            icon={<UserRound className="h-5 w-5" />}
            title="No guest found"
            description="Nobody matches that. A guest appears here once they have a booking."
          />
        </Card>
      )}

      {results.data && results.data.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {results.data.map((g) => (
              <li key={g.id}>
                <Link href={`/guests/${g.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4 hover:bg-surface-2">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-2">
                    <UserRound className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      {g.isVip && <Crown className="h-4 w-4 text-warning" aria-label="VIP" />}
                      {g.fullName}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-3 text-sm text-text-2">
                      <span className="num">{formatMobile(g.mobile)}</span>
                      {g.city && <span>{g.city}</span>}
                    </span>
                  </span>
                  <span className="text-sm text-text-3">
                    {g.stays ? `${g.stays} stay${g.stays > 1 ? 's' : ''}` : 'No stay yet'}
                    {g.lastStay ? ` · last ${formatDate(g.lastStay, { year: false })}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {q.length < 2 && (
        <Card>
          <EmptyState
            icon={<Car className="h-5 w-5" />}
            title="Find anyone quickly"
            description="A mobile number, part of a name, a booking number, or the car they arrived in — any of them works. Press Ctrl+K anywhere in ResortOS for the same search."
          />
        </Card>
      )}
    </div>
  );
}
