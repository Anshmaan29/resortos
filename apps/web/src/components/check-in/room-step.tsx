'use client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BedDouble, CheckCircle2 } from 'lucide-react';
import { formatDate } from '@resortos/shared';
import { Field, Select } from '@/components/ui/field';
import { Card, CardHeader, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import type { Availability, Room } from '@/lib/types';
import type { CheckInDraft } from './types';

/** Room assignment inside check-in (spec §18). The server assigns under the exclusion constraint at confirmation. */
export function RoomStep({ draft, data, businessDate, onChange }: { draft: CheckInDraft; data: CheckInDraft['data']; businessDate: string; onChange: (d: CheckInDraft['data']) => void }) {
  const { departure } = draft.reservation;
  const availability = useQuery({
    queryKey: ['availability', businessDate, departure],
    queryFn: () => api<Availability>('/availability', { query: { arrival: businessDate, departure } }),
  });
  const board = useQuery({ queryKey: ['rooms'], queryFn: () => api<Room[]>('/rooms') });

  return (
    <div className="flex flex-col gap-6">
      {data.rooms.map((room, i) => {
        const info = draft.reservation.rooms.find((r) => r.reservationRoomId === room.reservationRoomId)!;
        const free = availability.data?.roomTypes.find((t) => t.roomTypeId === info.roomTypeId)?.freeRooms ?? [];
        const taken = data.rooms.filter((_, j) => j !== i).map((r) => r.roomId).filter(Boolean);
        const chosenId = room.roomId ?? info.roomId ?? '';
        const chosen = board.data?.find((r) => r.id === chosenId);
        const notReady = chosen && (chosen.housekeeping === 'dirty' || chosen.housekeeping === 'cleaning');
        return (
          <Card key={room.reservationRoomId}>
            <CardHeader title={data.rooms.length > 1 ? `Room ${i + 1} · ${info.roomTypeName}` : info.roomTypeName}
              description={`${formatDate(businessDate, { year: false })} → ${formatDate(departure, { year: false })} · ${info.mealPlan}`} />
            <div className="flex flex-col gap-4 p-5">
              {availability.isLoading ? <Skeleton className="h-11" /> : (
                <Field label="Room" required hint={info.roomNumber ? `Booked with room ${info.roomNumber}` : 'No room assigned on the booking yet'}>{(id, d) => (
                  <Select id={id} aria-describedby={d} value={chosenId} onChange={(e) => onChange({ ...data, rooms: data.rooms.map((r, j) => (j === i ? { ...r, roomId: e.target.value || undefined } : r)) })}>
                    <option value="">Choose a room</option>
                    {info.roomId && <option value={info.roomId}>{info.roomNumber} · booked room</option>}
                    {free.filter((r) => r.id !== info.roomId && !taken.includes(r.id)).map((r) => (
                      <option key={r.id} value={r.id}>{r.number}{r.view ? ` · ${r.view} view` : ''}{r.housekeeping === 'dirty' ? ' · needs cleaning' : r.housekeeping === 'cleaning' ? ' · being cleaned' : ''}</option>
                    ))}
                  </Select>
                )}</Field>
              )}
              {chosen && (notReady
                ? <p className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"><AlertTriangle className="h-4 w-4" />Room {chosen.number} is {chosen.housekeeping === 'dirty' ? 'not cleaned yet' : 'being cleaned'}. You can continue; tell housekeeping.</p>
                : <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="h-4 w-4" />Room {chosen.number} is ready.</p>)}
              {!chosenId && <p className="flex items-center gap-2 text-sm text-text-2"><BedDouble className="h-4 w-4" />Only rooms free for every night of the stay are listed.</p>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
