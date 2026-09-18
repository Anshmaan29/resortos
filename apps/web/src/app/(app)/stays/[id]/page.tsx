'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BedDouble, Car, Crown, DoorOpen, Eye, LogOut, Phone } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatDate, formatDateTime, formatINR, formatMobile, ID_TYPE_LABELS, MEAL_PLAN_LABELS, nightsBetween } from '@resortos/shared';
import { CheckoutDialog } from '@/components/stay/checkout-dialog';
import { RegistrationCard } from '@/components/stay/registration-card';
import { RoomShiftDialog } from '@/components/stay/room-shift-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { StayDetail, StayDocument } from '@/lib/types';

export default function StayPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [shiftOpen, setShiftOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const stay = useQuery({ queryKey: ['stay', id], queryFn: () => api<StayDetail>(`/stays/${id}`) });

  const refreshAll = () => Promise.all(
    ['stay', 'reservation', 'reservations', 'front-desk', 'rooms', 'availability', 'calendar', 'checkout-preview']
      .map((k) => qc.invalidateQueries({ queryKey: [k] })),
  );

  if (stay.isLoading) return <div className="flex flex-col gap-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-32" /><Skeleton className="h-60" /></div>;
  if (stay.isError || !stay.data) return <ErrorBanner message={(stay.error as Error)?.message ?? 'Stay not found'} onRetry={() => stay.refetch()} />;
  const s = stay.data;

  const inHouse = s.status === 'in_house';
  const nights = nightsBetween(s.businessDateIn, s.businessDateOut ?? s.expectedDeparture);
  const dueOut = inHouse && s.businessDate >= s.expectedDeparture;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/reservations/${s.reservationId}`} className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text">
          <ArrowLeft className="h-4 w-4" />Booking {s.reservationNumber}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                {s.isVip && <Crown className="h-5 w-5 text-warning" aria-label="VIP" />}
                Room <span className="num">{s.roomNumber}</span>
              </h1>
              <Pill tone={inHouse ? 'info' : 'neutral'}>{inHouse ? 'In house' : 'Checked out'}</Pill>
              {dueOut && <Pill tone="warning">Due out today</Pill>}
              {s.earlyDeparture && <Pill tone="neutral">Left early</Pill>}
            </div>
            <p className="mt-1 text-sm text-text-2">
              {s.guestName} · {s.roomTypeName} · {MEAL_PLAN_LABELS[s.mealPlan]} · checked in {formatDateTime(s.checkedInAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {inHouse && (
              <Button variant="outline" disabled={!s.canShiftRoom} onClick={() => setShiftOpen(true)}
                title={s.canShiftRoom ? undefined : 'The guest is due to check out, so the room cannot be changed'}>
                <DoorOpen className="h-4 w-4" />Change room
              </Button>
            )}
            {inHouse && <Button onClick={() => setCheckoutOpen(true)}><LogOut className="h-4 w-4" />Check out</Button>}
          </div>
        </div>
      </div>

      {!inHouse && (
        <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-text-2">
          Checked out {s.checkedOutAt ? formatDateTime(s.checkedOutAt) : ''}
          {s.earlyDeparture ? ', earlier than the expected departure' : ''}. A checked-out stay is kept exactly as it was and can no longer be changed.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Stay" />
            <dl className="grid grid-cols-2 gap-4 p-5 text-sm sm:grid-cols-4">
              <Info k="Checked in" v={formatDate(s.businessDateIn, { weekday: true })} />
              <Info k={inHouse ? 'Due out' : 'Checked out'} v={formatDate(s.businessDateOut ?? s.expectedDeparture, { weekday: true })} />
              <Info k="Nights" v={String(nights)} />
              <Info k="Room rate" v={`${formatINR(s.nightlyRate)} / night`} />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Guests" description={`${s.adults} adult${s.adults > 1 ? 's' : ''}${s.childAges.length ? ` · ${s.childAges.length} child${s.childAges.length > 1 ? 'ren' : ''}` : ''}`} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                  <tr><th className="px-5 py-2.5 font-medium">Name</th><th className="px-3 py-2.5 font-medium">Adult / child</th><th className="px-3 py-2.5 font-medium">Nationality</th><th className="px-3 py-2.5 font-medium">ID</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {s.occupants.map((o) => (
                    <tr key={o.key}>
                      <td className="px-5 py-2.5">{o.fullName}{o.isPrimary && <span className="ml-2 text-xs text-text-3">Primary</span>}</td>
                      <td className="px-3 py-2.5 text-text-2">{o.isChild ? `Child${o.age === null ? '' : ` · ${o.age}y`}` : 'Adult'}</td>
                      <td className="px-3 py-2.5 text-text-2">{o.nationality}</td>
                      <td className="px-3 py-2.5 text-text-2">
                        {o.idType === 'none' ? '—' : <>{ID_TYPE_LABELS[o.idType]}{o.idLast4 && <span className="num"> ···· {o.idLast4}</span>}</>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {s.vehicles.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3 text-sm">
                <Car className="h-4 w-4 text-text-3" aria-hidden />
                {s.vehicles.map((v) => (
                  <span key={v.registration} className="num">{v.registration}<span className="text-text-3"> ({v.vehicleType}{v.parkingSlot ? `, slot ${v.parkingSlot}` : ''})</span></span>
                ))}
              </div>
            )}
          </Card>

          {s.shifts.length > 0 && (
            <Card>
              <CardHeader title="Room changes" />
              <ul className="divide-y divide-border">
                {s.shifts.map((sh, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm">
                    <BedDouble className="h-4 w-4 text-text-3" aria-hidden />
                    <span className="num font-medium">{sh.from}</span>
                    <ArrowRight className="h-4 w-4 text-text-3" aria-hidden />
                    <span className="num font-medium">{sh.to}</span>
                    <span className="text-text-2">· {sh.reason}</span>
                    <span className="ml-auto text-text-3">{formatDateTime(sh.at)} · {sh.by}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Guest" />
            <div className="flex flex-col gap-2 p-5 text-sm">
              <p className="text-base font-medium">{s.guestName}</p>
              <a href={`tel:${s.mobile}`} className="flex items-center gap-2 text-brand num hover:underline"><Phone className="h-4 w-4" />{formatMobile(s.mobile)}</a>
            </div>
          </Card>

          <RegistrationCard stay={s} />

          <Card>
            <CardHeader title="Documents" description={`${s.documents.filter((d) => d.status === 'verified').length} verified`} />
            <ul className="divide-y divide-border">
              {s.documents.map((d) => (
                <DocumentRow key={d.id} doc={d} whose={s.occupants.find((o) => o.key === d.occupantKey)?.fullName ?? null} onError={(m) => toast('error', m)} />
              ))}
            </ul>
            <p className="border-t border-border px-5 py-3 text-xs text-text-3">
              Documents open through a link that lasts one minute, and every view is recorded.
            </p>
          </Card>
        </div>
      </div>

      {inHouse && (
        <>
          <RoomShiftDialog stay={s} open={shiftOpen} onClose={() => setShiftOpen(false)}
            onDone={async (message) => { setShiftOpen(false); await refreshAll(); toast('success', message); }} />
          <CheckoutDialog stay={s} open={checkoutOpen} onClose={() => setCheckoutOpen(false)}
            onDone={async (message) => { setCheckoutOpen(false); await refreshAll(); toast('success', message); }} />
        </>
      )}
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return <div><dt className="text-text-2">{k}</dt><dd className="mt-0.5 font-medium num">{v}</dd></div>;
}

function DocumentRow({ doc, whose, onError }: { doc: StayDocument; whose: string | null; onError: (message: string) => void }) {
  const view = useMutation({
    mutationFn: () => api<{ url: string }>(`/documents/${doc.id}/view-url`),
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
    onError: (e) => onError((e as Error).message),
  });
  return (
    <li className="flex items-center gap-3 px-5 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {whose ? `${whose} — ` : ''}{doc.label}
          {doc.idType && <span className="font-normal text-text-3"> · {ID_TYPE_LABELS[doc.idType as keyof typeof ID_TYPE_LABELS] ?? doc.idType}</span>}
        </p>
        <p className="text-xs text-text-3">
          {doc.status === 'verified' ? `Verified ${doc.verifiedAt ? formatDateTime(doc.verifiedAt) : ''}` : doc.status}
        </p>
      </div>
      <Button variant="ghost" size="sm" loading={view.isPending} disabled={doc.status !== 'verified'} onClick={() => view.mutate()}>
        <Eye className="h-4 w-4" />View
      </Button>
    </li>
  );
}
