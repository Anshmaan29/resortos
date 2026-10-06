'use client';
import { useQuery } from '@tanstack/react-query';
import { formatDate } from '@resortos/shared';
import { HousekeepingBoard } from '@/components/housekeeping/housekeeping-board';
import { MyTasks } from '@/components/housekeeping/my-tasks';
import type { HousekeepingBoardData, MyTask } from '@/components/housekeeping/types';
import { Pill } from '@/components/ui/status';
import { ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';

/** Housekeeping: the full board for owner and reception, a simple task list for cleaners (spec §37, §70.3). */
export default function HousekeepingPage() {
  const me = useMe();
  const role = me.data?.role;

  const myTasks = useQuery({
    queryKey: ['housekeeping-my-tasks'],
    queryFn: () => api<MyTask[]>('/housekeeping/my-tasks'),
    enabled: !!role,
  });
  const board = useQuery({
    queryKey: ['housekeeping-board'],
    queryFn: () => api<HousekeepingBoardData>('/housekeeping/board'),
    enabled: !!role && role !== 'cleaner',
  });

  if (!role) {
    if (me.isError) {
      return (
        <div className="flex flex-col gap-5">
          <PageHeader title="Housekeeping" description="Rooms to clean today." />
          <ErrorBanner message={me.error.message} onRetry={() => me.refetch()} />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Housekeeping" description="Rooms to clean today." />
        <Skeleton className="h-24" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} className="h-44" />)}
        </div>
      </div>
    );
  }

  // Cleaners get a plain list of their own rooms — no guest names, no money (spec §70.3).
  if (role === 'cleaner') {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="My tasks" description="Your rooms to clean today. Start when you begin, complete when the room is done." />
        <MyTasks query={myTasks} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Housekeeping"
        description={board.data
          ? `Rooms to clean for ${formatDate(board.data.businessDate, { weekday: true })}.${board.data.inspection ? ' Cleaned rooms are marked ready after inspection.' : ''}`
          : 'Rooms to clean today.'}
        actions={board.data && (
          <Pill tone="brand">
            <span className="num">{board.data.doneToday}</span>&nbsp;{board.data.doneToday === 1 ? 'room' : 'rooms'} done today
          </Pill>
        )}
      />
      {board.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} className="h-44" />)}
        </div>
      ) : board.isError ? (
        <ErrorBanner message={board.error.message} onRetry={() => board.refetch()} />
      ) : (
        <HousekeepingBoard data={board.data!} meId={me.data!.id} myTasks={myTasks} />
      )}
    </div>
  );
}
