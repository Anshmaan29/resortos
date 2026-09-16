'use client';
import { CheckCircle2, CircleAlert, Crown, FileCheck2 } from 'lucide-react';
import { formatDate, formatINR, nightsBetween } from '@resortos/shared';
import { Card } from '@/components/ui/surface';
import type { ReservationDetail } from '@/lib/types';
import type { CheckInDraft } from './types';

/** Final review (spec §18.2). */
export function ConfirmStep({ draft, data, reservation }: { draft: CheckInDraft; data: CheckInDraft['data']; reservation?: ReservationDetail }) {
  const r = draft.reservation;
  const verified = draft.documents.filter((d) => d.status === 'verified');
  const adults = data.rooms.flatMap((x) => x.occupants).filter((o) => !o.isChild).length;
  const children = data.rooms.flatMap((x) => x.occupants).filter((o) => o.isChild).length;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <Card className="p-6">
        <p className="flex items-center gap-2 text-xl font-semibold">{r.isVip && <Crown className="h-5 w-5 text-warning" aria-label="VIP" />}{r.guestName}
          <span className="text-base font-normal text-text-2">· {adults} adult{adults !== 1 ? 's' : ''}{children ? `, ${children} child${children > 1 ? 'ren' : ''}` : ''}</span></p>
        <div className="mt-4 flex flex-col gap-2 text-[15px]">
          {data.rooms.map((room) => {
            const info = r.rooms.find((x) => x.reservationRoomId === room.reservationRoomId)!;
            return <p key={room.reservationRoomId} className="num">Room {info.roomNumber ?? '—'} · {info.roomTypeName} · {info.mealPlan}</p>;
          })}
          <p className="num">{formatDate(r.arrival, { year: false })} → {formatDate(r.departure, { year: false })} ({nightsBetween(r.arrival, r.departure)} nights)</p>
        </div>
        <dl className="mt-5 grid max-w-sm grid-cols-2 gap-y-2 text-[15px]">
          <dt className="text-text-2">Estimated total</dt><dd className="text-right font-semibold num">{reservation?.estimate.grandTotal ? formatINR(reservation.estimate.grandTotal) : reservation ? formatINR(reservation.estimate.taxableTotal) : '—'}</dd>
          <dt className="text-text-2">Advance paid</dt><dd className="text-right num">{reservation && Number(reservation.advancePaid) > 0 ? formatINR(reservation.advancePaid) : 'None'}</dd>
        </dl>
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {verified.map((d) => <span key={d.id} className="flex items-center gap-1.5 text-success"><FileCheck2 className="h-4 w-4" />{d.label}</span>)}
          {verified.length === 0 && <span className="text-text-2">No documents received yet</span>}
        </div>
      </Card>
      <Card className="p-5">
        {draft.problems.length === 0 ? (
          <p className="flex items-center gap-2 font-medium text-success"><CheckCircle2 className="h-5 w-5" />Everything is ready.</p>
        ) : (
          <div>
            <p className="flex items-center gap-2 font-medium"><CircleAlert className="h-5 w-5 text-warning" />Still needed</p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-6 text-sm text-text-2">
              {draft.problems.map((p) => <li key={p.path + p.message}>{p.message.replace(/^./, (c) => c.toUpperCase())}</li>)}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
