'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Check, CircleDot, History, Lock, MoonStar } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { formatDate, formatDateTime } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, newIdempotencyKey } from '@/lib/api';
import type { NightAuditPreview, NightAuditRun, NightAuditStepView } from '@/lib/types';

/** Staff words for the summary figures, in the order the owner reads them. */
const SUMMARY_LABELS: [string, string, (v: number) => string][] = [
  ['occupancyPercent', 'Occupancy', (v) => `${v}%`],
  ['roomsOccupied', 'Rooms occupied', String],
  ['roomsActive', 'Rooms in service', String],
  ['arrivalsCheckedIn', 'Arrived', String],
  ['departuresCompleted', 'Departed', String],
  ['inHouseAtClose', 'Still in house', String],
  ['noShows', 'No-shows', String],
  ['cancellations', 'Cancelled', String],
];

const ACTION_LABELS: Record<string, string> = {
  no_show: 'Mark no-show',
  extend_arrival: 'Move to tomorrow',
  cancel: 'Cancel booking',
  check_out: 'Check out',
  extend_stay: 'Extend stay',
};

export default function NightAuditPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const [error, setError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['night-audit'],
    queryFn: () => api<NightAuditPreview>('/night-audit'),
    // Blockers are cleared on other screens, so this has to re-read rather than trust a cache.
    refetchOnWindowFocus: true,
  });
  const log = useQuery({ queryKey: ['night-audit-log'], queryFn: () => api<NightAuditRun[]>('/night-audit/log', { query: { limit: 30 } }) });

  const complete = useMutation({
    mutationFn: (businessDate: string) =>
      api<{ alreadyCompleted: boolean; run: NightAuditRun }>('/night-audit/complete', {
        method: 'POST',
        idempotencyKey: key.current,
        // The date the screen is showing: if it has moved, the server refuses rather than closing
        // another day (spec §35.2).
        body: { businessDate },
      }),
    onSuccess: (result) => {
      key.current = newIdempotencyKey();
      setError(null);
      toast(
        'success',
        result.alreadyCompleted
          ? `${formatDate(result.run.businessDate)} was already closed`
          : `${formatDate(result.run.businessDate)} closed — business date is now ${formatDate(preview.data?.nextBusinessDate ?? result.run.businessDate)}`,
      );
      void queryClient.invalidateQueries();
    },
    onError: (err) => {
      setError((err as Error).message);
      toast('error', (err as Error).message);
      void preview.refetch();
    },
  });

  if (preview.isLoading) return <Skeleton className="h-96" />;
  if (preview.isError) return <ErrorBanner message={(preview.error as Error).message} onRetry={() => preview.refetch()} />;
  const data = preview.data!;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Night audit"
        description={
          <span className="flex items-center gap-2">
            <MoonStar className="h-4 w-4 text-text-3" aria-hidden />
            Closing {formatDate(data.businessDate, { weekday: true })} · next day {formatDate(data.nextBusinessDate)}
          </span>
        }
        actions={
          <Button
            size="lg"
            loading={complete.isPending}
            disabled={!data.canComplete || !data.mayRun}
            onClick={() => complete.mutate(data.businessDate)}
          >
            Complete night audit
          </Button>
        }
      />

      {error && <ErrorBanner message={error} />}

      {!data.mayRun && (
        <Card className="flex items-start gap-3 p-4">
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-text-3" aria-hidden />
          <p className="text-sm text-text-2">
            Only the owner can complete the night audit. You can still work through the list below so it is ready.
          </p>
        </Card>
      )}

      {data.blocked ? (
        <Card className="flex items-start gap-3 border-warning p-4" style={{ borderColor: 'var(--warning)' }}>
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
          <p className="text-sm text-text-2">
            The day cannot be closed while anything below is unresolved. Every arrival has to be checked in, marked a
            no-show or moved, and every guest whose departure date has passed has to be checked out or extended.
          </p>
        </Card>
      ) : (
        <Card className="flex items-start gap-3 p-4">
          <Check className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
          <p className="text-sm text-text-2">Nothing is outstanding. Completing the audit records the day and moves the business date forward.</p>
        </Card>
      )}

      <ol className="flex flex-col gap-3">
        {data.steps.map((step, i) => <Step key={step.name} step={step} index={i + 1} />)}
      </ol>

      <Card>
        <CardHeader title={`Summary for ${formatDate(data.businessDate)}`} description="Money joins this once bills and payments are in." />
        <dl className="grid grid-cols-2 gap-4 border-t border-border p-4 sm:grid-cols-4">
          {SUMMARY_LABELS.filter(([k]) => data.summary[k] !== undefined).map(([k, label, fmt]) => (
            <div key={k}>
              <dt className="text-sm text-text-3">{label}</dt>
              <dd className="mt-0.5 text-xl font-semibold tabular-nums">{fmt(Number(data.summary[k]))}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <DayAuditLog query={log} />
    </div>
  );
}

function Step({ step, index }: { step: NightAuditStepView; index: number }) {
  const blocking = step.blocking && step.items.length > 0;
  return (
    <li>
      <Card>
        <div className="flex items-start gap-3 p-4">
          <span
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            style={blocking ? { background: 'var(--warning-soft)', color: 'var(--warning)' } : { background: 'var(--surface-2)', color: 'var(--text-3)' }}
            aria-hidden
          >
            {blocking ? '!' : index}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">{step.title}</h2>
              {blocking ? (
                <Pill tone="warning">{step.items.length} to resolve</Pill>
              ) : step.blocking ? (
                <Pill tone="brand">Clear</Pill>
              ) : null}
            </div>
            {step.willDo && <p className="mt-1 text-sm text-text-3">{step.willDo}</p>}

            {step.items.length > 0 && (
              <ul className="mt-3 flex flex-col gap-2">
                {step.items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2">
                    <span className="text-sm">{item.label}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-text-3">{item.actions.map((a) => ACTION_LABELS[a] ?? a).join(' · ')}</span>
                      {item.href && (
                        <Link href={item.href} className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                          Open <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {step.warnings.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1.5">
                {step.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-2 text-sm text-text-2">
                    <CircleDot className="mt-1 h-3 w-3 shrink-0 text-text-3" aria-hidden />
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>
    </li>
  );
}

/** The old software's Day Audit Log. */
function DayAuditLog({ query }: { query: ReturnType<typeof useQuery<NightAuditRun[]>> }) {
  if (query.isLoading) return <Skeleton className="h-40" />;
  if (query.isError) return <ErrorBanner message={(query.error as Error).message} onRetry={() => query.refetch()} />;
  const runs = query.data ?? [];
  return (
    <Card>
      <CardHeader title="Day audit log" description="Every business date that has been closed, and who closed it." />
      {runs.length === 0 ? (
        <EmptyState icon={<History className="h-5 w-5" />} title="No audit has run yet" description="The first completed night audit appears here." />
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-text-3">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-2 font-medium">Business date</th>
                <th scope="col" className="px-4 py-2 font-medium">Completed</th>
                <th scope="col" className="px-4 py-2 font-medium">By</th>
                <th scope="col" className="px-4 py-2 font-medium">Occupancy</th>
                <th scope="col" className="px-4 py-2 font-medium">No-shows</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium">{formatDate(run.businessDate, { weekday: true })}</td>
                  <td className="px-4 py-2 text-text-2">{formatDateTime(run.completedAt)}</td>
                  <td className="px-4 py-2 text-text-2">{run.completedBy}</td>
                  <td className="px-4 py-2 tabular-nums">{run.summary.occupancyPercent ?? 0}%</td>
                  <td className="px-4 py-2 tabular-nums">{run.summary.noShows ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
