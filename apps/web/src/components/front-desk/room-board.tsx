'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Crown } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate, type HousekeepingStatus, type RoomDisplayState, type ServiceStatus } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import { ROOM_STATE, RoomStateBadge } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Room } from '@/lib/types';

export function RoomBoard({ rooms, compact }: { rooms: Room[]; compact?: boolean }) {
  const [selected, setSelected] = useState<Room | null>(null);
  return (
    <>
      <div className={cn('grid gap-2.5', compact ? 'grid-cols-3 sm:grid-cols-5 xl:grid-cols-8' : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6')}>
        {rooms.map((room) => <RoomCard key={room.id} room={room} onClick={() => setSelected(room)} compact={compact} />)}
      </div>
      <RoomDrawer room={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function RoomCard({ room, onClick, compact }: { room: Room; onClick: () => void; compact?: boolean }) {
  const s = ROOM_STATE[room.displayState];
  const Icon = s.icon;
  return (
    <button onClick={onClick}
      className="group relative flex min-h-[76px] flex-col items-start gap-1 overflow-hidden rounded-lg border border-border bg-surface p-3 text-left shadow-sm transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:-translate-y-0.5"
      aria-label={`Room ${room.number}, ${s.label}${room.currentReservation ? `, ${room.currentReservation.guestName}` : ''}`}>
      {/* Status colour cross-fades when state changes (spec §69.1) */}
      <motion.span className="absolute inset-y-0 left-0 w-1" animate={{ backgroundColor: s.fg }} transition={{ duration: 0.25 }} />
      <div className="flex w-full items-center justify-between gap-2">
        <span className="text-base font-semibold num">{room.number}</span>
        <motion.span key={room.displayState} initial={{ scale: 0.85, opacity: 0.4 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.2 }}
          className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: s.bg, color: s.fg }}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </motion.span>
      </div>
      <span className="text-xs font-medium" style={{ color: s.fg }}>{s.label}{room.displayState === 'occupied' && room.housekeeping === 'dirty' ? ' · Dirty' : ''}</span>
      {!compact && (
        <span className="flex w-full items-center gap-1 truncate text-xs text-text-3">
          {room.currentReservation?.isVip && <Crown className="h-3 w-3 shrink-0 text-warning" aria-label="VIP" />}
          {room.currentReservation?.guestName ?? room.roomTypeName}
        </span>
      )}
    </button>
  );
}

const HK_ACTIONS: { to: HousekeepingStatus; label: string }[] = [
  { to: 'dirty', label: 'Mark dirty' }, { to: 'cleaning', label: 'Cleaning started' }, { to: 'clean', label: 'Mark clean' }, { to: 'inspected', label: 'Inspected' },
];

function RoomDrawer({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const change = useMutation({
    mutationFn: (body: { housekeeping?: HousekeepingStatus; service?: ServiceStatus; reason?: string }) =>
      api(`/rooms/${room!.id}/status`, { method: 'POST', body }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['rooms'] }), qc.invalidateQueries({ queryKey: ['front-desk'] })]);
      toast('success', `Room ${room!.number} updated`);
      onClose();
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'Could not update room'),
  });

  return (
    <Drawer open={!!room} onClose={onClose} title={room ? <span className="flex items-center gap-3">Room {room.number}<RoomStateBadge state={room.displayState} /></span> : ''}>
      {room && (
        <div className="flex flex-col gap-6">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Item k="Type" v={room.roomTypeName} />
            <Item k="Unit" v={<span className="capitalize">{room.unitType}{room.view ? ` · ${room.view} view` : ''}</span>} />
            <Item k="Housekeeping" v={<span className="capitalize">{room.housekeeping}</span>} />
            <Item k="Service" v={<span className="capitalize">{room.service.replace(/_/g, ' ')}</span>} />
            {room.building && <Item k="Block / floor" v={`${room.building}${room.floor ? ` · Floor ${room.floor}` : ''}`} />}
          </dl>
          {room.currentReservation && (
            <Link href={`/reservations/${room.currentReservation.id}`} className="block rounded-lg border border-border p-4 hover:bg-surface-2">
              <p className="text-xs text-text-3">{room.occupancy === 'arriving' ? 'Arriving today' : 'Current guest'} · {room.currentReservation.number}</p>
              <p className="mt-1 font-medium">{room.currentReservation.guestName}</p>
              <p className="text-sm text-text-2 num">{formatDate(room.currentReservation.arrival, { year: false })} → {formatDate(room.currentReservation.departure, { year: false })}</p>
            </Link>
          )}
          <div>
            <p className="mb-2 text-sm font-medium text-text-2">Housekeeping</p>
            <div className="grid grid-cols-2 gap-2">
              {HK_ACTIONS.map((a) => (
                <Button key={a.to} variant={room.housekeeping === a.to ? 'secondary' : 'outline'} disabled={room.housekeeping === a.to || change.isPending}
                  onClick={() => change.mutate({ housekeeping: a.to })}>{a.label}</Button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-text-2">Service</p>
            <div className="grid grid-cols-2 gap-2">
              {room.service !== 'in_service'
                ? <Button variant="outline" disabled={change.isPending} onClick={() => change.mutate({ service: 'in_service', reason: 'Back in service' })}>Back in service</Button>
                : <Button variant="outline" disabled={change.isPending} onClick={() => change.mutate({ service: 'maintenance', reason: 'Marked for maintenance' })}>Needs maintenance</Button>}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function Item({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><dt className="text-text-3">{k}</dt><dd className="mt-0.5 font-medium">{v}</dd></div>;
}

export function RoomLegend({ counts }: { counts: Partial<Record<RoomDisplayState, number>> }) {
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(ROOM_STATE) as RoomDisplayState[]).filter((k) => counts[k]).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium" style={{ background: ROOM_STATE[k].bg, color: ROOM_STATE[k].fg }}>
          {ROOM_STATE[k].label}<span className="num opacity-80">{counts[k]}</span>
        </span>
      ))}
    </div>
  );
}
