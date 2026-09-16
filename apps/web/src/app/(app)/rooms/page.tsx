'use client';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { RoomDisplayState } from '@resortos/shared';
import { RoomBoard } from '@/components/front-desk/room-board';
import { ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { ROOM_STATE } from '@/components/ui/status';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Room } from '@/lib/types';

export default function RoomsPage() {
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => api<Room[]>('/rooms'), refetchInterval: 20_000 });
  const [filter, setFilter] = useState<RoomDisplayState | 'all'>('all');
  const [type, setType] = useState<string>('all');

  const types = useMemo(() => [...new Map((rooms.data ?? []).map((r) => [r.roomTypeId, r.roomTypeName])).entries()], [rooms.data]);
  const counts = useMemo(() => (rooms.data ?? []).reduce<Record<string, number>>((a, r) => ({ ...a, [r.displayState]: (a[r.displayState] ?? 0) + 1 }), {}), [rooms.data]);
  const visible = (rooms.data ?? []).filter((r) => (filter === 'all' || r.displayState === filter) && (type === 'all' || r.roomTypeId === type));

  return (
    <div>
      <PageHeader title="Room board" description="Live status of every room. Updates automatically." />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All <span className="num opacity-70">{rooms.data?.length ?? ''}</span></Chip>
        {(Object.keys(ROOM_STATE) as RoomDisplayState[]).filter((k) => counts[k]).map((k) => (
          <Chip key={k} active={filter === k} onClick={() => setFilter(k)} color={ROOM_STATE[k].fg}>{ROOM_STATE[k].label} <span className="num opacity-70">{counts[k]}</span></Chip>
        ))}
      </div>
      {types.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Filter by room type">
          <Chip active={type === 'all'} onClick={() => setType('all')}>All types</Chip>
          {types.map(([id, name]) => <Chip key={id} active={type === id} onClick={() => setType(id)}>{name}</Chip>)}
        </div>
      )}
      {rooms.isError && <ErrorBanner message={(rooms.error as Error).message} onRetry={() => rooms.refetch()} />}
      {rooms.isLoading ? <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>
        : <RoomBoard rooms={visible} />}
    </div>
  );
}

function Chip({ active, onClick, children, color }: { active: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={cn('inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors',
        active ? 'border-text bg-text text-bg' : 'border-border bg-surface text-text-2 hover:border-border-strong')}>
      {color && !active && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
      {children}
    </button>
  );
}
