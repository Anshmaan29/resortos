'use client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BedDouble, CheckCircle2 } from 'lucide-react';
import { formatDate } from '@resortos/shared';
import { Field, Select } from '@/components/ui/field';
import { Card, CardHeader, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import type { Availability, Room } from '@/lib/types';
import type { CheckInDraft } from './types';

/** Room assignment inside check-in (spec §18). The server assigns under the exclusion constraint at confirmation. */
export function RoomStep({ draft, data, businessDate, onChange }: { draft: CheckInDraft; data: CheckInDraft['data']; businessDate: string; onChange: (d: CheckInDraft['data']) => void }) {
  const { departure } = draft.reservation;
  const availability = useQuery({
    queryKey: ['availability', businessDate, departure, draft.reservationId],
    queryFn: () => api<Availability>('/availability', { query: { arrival: businessDate, departure, reservationId: draft.reservationId } }),
  });
  const board = useQuery({ queryKey: ['rooms'], queryFn: () => api<Room[]>('/rooms') });

  return (
    <div className="flex flex-col gap-6">
      {availability.isError && <ErrorBanner message={(availability.error as Error).message} onRetry={() => availability.refetch()} />}
      {data.rooms.map((room, i) => {
        const info = draft.reservation.rooms.find((r) => r.reservationRoomId === room.reservationRoomId)!;
        const free = availability.data?.rooms ?? [];
        const taken = data.rooms.filter((_, j) => j !== i).map((r) => r.roomId).filter(Boolean);
        const chosenId = room.roomId ?? info.roomId ?? '';
        const chosen = board.data?.find((r) => r.id === chosenId);
        const notReady = !!availability.data && !!chosenId && !free.some((r) => r.id === chosenId);
        return (
          <Card key={room.reservationRoomId}>
            <CardHeader title={data.rooms.length > 1 ? `Room ${i + 1}` : 'Choose a room'}
              description={`${formatDate(businessDate, { year: false })} → ${formatDate(departure, { year: false })} · ${info.mealPlan}`} />
            <div className="flex flex-col gap-4 p-5">
              {availability.isLoading ? <Skeleton className="h-11" /> : (
                <Field label="Room" required hint={info.roomNumber ? `Booked with room ${info.roomNumber}` : 'No room assigned on the booking yet'}>{(id, d) => (
                  <Select id={id} aria-describedby={d} value={chosenId} onChange={(e) => onChange({ ...data, rooms: data.rooms.map((r, j) => (j === i ? { ...r, roomId: e.target.value || undefined } : r)) })}>
                    <option value="">Choose a room</option>
                    {chosenId && !free.some((r) => r.id === chosenId) && <option value={chosenId} disabled>{chosen?.number ?? info.roomNumber ?? 'Selected room'} · not ready or no longer free</option>}
                    {free.filter((r) => !taken.includes(r.id)).sort((a,b) => a.number.localeCompare(b.number,undefined,{numeric:true})).map((r) => (
                      <option key={r.id} value={r.id}>{r.number}{r.id === info.roomId ? ' · booked room' : ''}{r.view ? ` · ${r.view} view` : ''}</option>
                    ))}
                  </Select>
                )}</Field>
              )}
              {chosen && (notReady
                ? <p className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"><AlertTriangle className="h-4 w-4" />Room {chosen.number} is not ready or no longer free. Choose another room, or have reception update its status.</p>
                : <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="h-4 w-4" />Room {chosen.number} is ready.</p>)}
              {!chosenId && <p className="flex items-center gap-2 text-sm text-text-2"><BedDouble className="h-4 w-4" />All clean rooms in service and free for every night of the stay are listed.</p>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
