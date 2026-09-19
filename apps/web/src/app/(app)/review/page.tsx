'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Eye } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate, formatINR } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

interface ReviewItem {
  key: string; kind: 'override' | 'discount' | 'void' | 'reversal' | 'shift' | 'credit_note' | 'pending_balance';
  at: string; businessDate: string | null; who: string; what: string; amount: string | null; href: string | null; seen: boolean;
}

const KIND: Record<ReviewItem['kind'], { label: string; tone: 'neutral' | 'brand' | 'warning' | 'danger' | 'info' }> = {
  override: { label: 'Owner PIN used', tone: 'info' },
  discount: { label: 'Large discount', tone: 'warning' },
  void: { label: 'Charge removed', tone: 'neutral' },
  reversal: { label: 'Payment reversed', tone: 'warning' },
  shift: { label: 'Cash difference', tone: 'danger' },
  credit_note: { label: 'Credit note', tone: 'warning' },
  pending_balance: { label: 'Left owing money', tone: 'danger' },
};

/**
 * Items worth the owner's look (spec §34.4). Rule-based and derived from the records; the owner marks
 * each one Seen, and it stays marked.
 */
export default function ReviewPage() {
  const qc = useQueryClient();
  const [showSeen, setShowSeen] = useState(false);
  const list = useQuery({
    queryKey: ['owner-review', showSeen],
    queryFn: () => api<ReviewItem[]>('/owner-review', { query: { includeSeen: showSeen ? 'true' : undefined } }),
  });
  const seen = useMutation({
    mutationFn: (keys: string[]) => api('/owner-review/seen', { method: 'POST', body: { keys } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['owner-review'] }),
  });
  const unseen = (list.data ?? []).filter((i) => !i.seen);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="To review" description="Overrides, large discounts, removed charges, reversals, cash differences, credit notes and guests who left owing money."
        actions={<>
          <Button variant="outline" onClick={() => setShowSeen(!showSeen)}><Eye className="h-4 w-4" aria-hidden />{showSeen ? 'Hide seen' : 'Show seen'}</Button>
          {unseen.length > 0 && <Button loading={seen.isPending} onClick={() => seen.mutate(unseen.map((i) => i.key))}><Check className="h-4 w-4" aria-hidden />Mark all seen</Button>}
        </>} />
      {list.isLoading ? <Skeleton className="h-48" /> : list.isError ? (
        <ErrorBanner message={(list.error as Error).message} onRetry={() => list.refetch()} />
      ) : list.data!.length === 0 ? (
        <EmptyState icon={<Check className="h-5 w-5" />} title="Nothing to review" description="Everything worth a look has been seen." />
      ) : (
        <Card>
          <ul>
            {list.data!.map((i) => (
              <li key={i.key} className={cn('flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm last:border-0', i.seen && 'opacity-60')}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={KIND[i.kind].tone}>{KIND[i.kind].label}</Pill>
                    <span className="text-xs text-text-3">{i.businessDate ? formatDate(i.businessDate) : new Date(i.at).toLocaleDateString('en-IN')} · {i.who}</span>
                  </div>
                  <p className="mt-1">{i.href ? <Link href={i.href} className="underline-offset-2 hover:underline">{i.what}</Link> : i.what}</p>
                </div>
                <div className="flex items-center gap-3">
                  {i.amount && <span className="tabular-nums">{formatINR(i.amount)}</span>}
                  {!i.seen && <Button size="sm" variant="ghost" onClick={() => seen.mutate([i.key])}>Seen</Button>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
