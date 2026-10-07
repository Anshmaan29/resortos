'use client';
import { useQuery } from '@tanstack/react-query';
import { LogIn, Sparkles } from 'lucide-react';
import { formatDateTime } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useTaskMutations } from './use-task-mutations';
import { KIND_LABEL, type MyTask } from './types';

export type MyTasksQuery = ReturnType<typeof useQuery<MyTask[]>>;

/**
 * The cleaner's simple list of assigned rooms (spec §70.3): big room numbers, a kind label,
 * the note and Start / Complete / Stop. No guest names and no money anywhere.
 * Also reused (collapsed) on the board for a receptionist who is personally assigned tasks.
 */
export function MyTasks({ query }: { query: MyTasksQuery }) {
  if (query.isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-44" />)}
      </div>
    );
  }
  if (query.isError) return <ErrorBanner message={query.error.message} onRetry={() => query.refetch()} />;

  const tasks = query.data ?? [];
  if (tasks.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Sparkles className="h-5 w-5" />}
          title="No tasks right now"
          description="When a room is assigned to you it will appear here."
        />
      </Card>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {tasks.map((t) => <MyTaskCard key={t.id} task={t} />)}
    </div>
  );
}

function MyTaskCard({ task }: { task: MyTask }) {
  const m = useTaskMutations();
  const busy = (pending: boolean, id: string | undefined) => pending && id === task.id;
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="num text-3xl font-semibold leading-none text-text">{task.roomNumber}</p>
          <p className="mt-1.5 truncate text-sm text-text-2">{task.roomTypeName}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Pill tone={task.kind === 'checkout' ? 'warning' : task.kind === 'stayover' ? 'info' : 'neutral'}>
            {KIND_LABEL[task.kind]}
          </Pill>
          {task.status === 'in_progress' && <Pill tone="info">In progress</Pill>}
          {task.priority === 'high' && <Pill tone="danger">High priority</Pill>}
        </div>
      </div>
      {task.arrivesToday && (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-info">
          <LogIn className="h-3.5 w-3.5 shrink-0" aria-hidden /> New guest arrives today
        </p>
      )}
      {task.note && <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-sm text-text-2">{task.note}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {task.status === 'open' ? (
          <Button loading={busy(m.start.isPending, m.start.variables?.id)} onClick={() => m.start.mutate({ id: task.id, roomNumber: task.roomNumber })}>
            Start
          </Button>
        ) : (
          <Button loading={busy(m.complete.isPending, m.complete.variables?.id)} onClick={() => m.complete.mutate({ id: task.id, roomNumber: task.roomNumber })}>
            Complete
          </Button>
        )}
        {task.status === 'in_progress' && (
          <Button variant="outline" loading={busy(m.stop.isPending, m.stop.variables?.id)} onClick={() => m.stop.mutate({ id: task.id, roomNumber: task.roomNumber })}>
            Stop
          </Button>
        )}
      </div>
      {task.status === 'in_progress' && task.startedAt && (
        <p className="mt-2 text-xs text-text-3">Started at {formatDateTime(task.startedAt)}</p>
      )}
    </Card>
  );
}
