'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BedDouble, CalendarCheck, CheckCircle2, CircleAlert, Crown, LogIn, Pencil, Phone, RotateCcw, ShieldCheck, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { CANCELLATION_REASONS, formatDate, formatDateTime, formatINR, formatMobile, money, VISIT_PURPOSE_LABELS, type CancellationReason } from '@resortos/shared';
import { EstimateBreakdown } from '@/components/booking/booking-form';
import { AdvanceDialog, OtaPanel } from '@/components/booking/booking-money';
import { MessagesPanel } from '@/components/messages-panel';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { Card, CardHeader, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill, ReservationBadge } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import type { Availability, ReservationDetail } from '@/lib/types';

const REASON_LABEL: Record<CancellationReason, string> = {
  guest_request: 'Guest asked to cancel', change_of_plans: 'Change of plans', duplicate_booking: 'Duplicate booking',
  booked_elsewhere: 'Booked elsewhere', payment_not_received: 'Payment not received', resort_request: 'Resort cancelled', other: 'Other',
};

export default function ReservationPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const res = useQuery({ queryKey: ['reservation', id], queryFn: () => api<ReservationDetail>(`/reservations/${id}`) });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const router = useRouter();
  const startCheckIn = useMutation({
    mutationFn: () => api<{ id: string }>('/check-in-drafts', { method: 'POST', body: { reservationId: id } }),
    onSuccess: (draft) => router.push(`/check-in/${draft.id}`),
    onError: (e) => toast('error', (e as Error).message),
  });

  const refreshAll = () => Promise.all(['reservation', 'reservations', 'front-desk', 'rooms', 'availability', 'calendar'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  const confirm = useMutation({
    mutationFn: () => api<ReservationDetail>(`/reservations/${id}/confirm`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => { await refreshAll(); toast('success', 'Booking confirmed'); },
    onError: (e) => toast('error', (e as Error).message),
  });

  if (res.isLoading) return <div className="flex flex-col gap-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-40" /><Skeleton className="h-60" /></div>;
  if (res.isError || !res.data) return <ErrorBanner message={(res.error as Error)?.message ?? 'Booking not found'} onRetry={() => res.refetch()} />;
  const r = res.data;
  const open = r.status === 'tentative' || r.status === 'confirmed';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/reservations" className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text"><ArrowLeft className="h-4 w-4" />Bookings</Link>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight num">{r.number}</h1>
              <ReservationBadge status={r.status} />
              {r.groupName && <Pill tone="info">Group · {r.groupName}</Pill>}
            </div>
            <p className="mt-1 text-sm text-text-2">Created {formatDateTime(r.createdAt)}{r.createdBy ? ` by ${r.createdBy}` : ''} · {r.sourceLabel}{r.otaReference ? ` · ${r.otaReference}` : ''}</p>
            {r.rebookedFrom && <p className="mt-1 text-sm text-text-2">Rebook of <Link href={`/reservations/${r.rebookedFrom.id}`} className="font-medium text-brand hover:underline">{r.rebookedFrom.number}</Link></p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {r.canEdit && <Link href={`/reservations/${r.id}/edit`}><Button variant="outline"><Pencil className="h-4 w-4" />Edit booking</Button></Link>}
            {r.status === 'tentative' && <Button variant="outline" loading={confirm.isPending} onClick={() => confirm.mutate()}><CalendarCheck className="h-4 w-4" />Confirm booking</Button>}
            {open && <Button variant="outline" onClick={() => setCancelOpen(true)}><XCircle className="h-4 w-4" />Cancel booking</Button>}
            {r.canRebook && <Link href={`/reservations/new?rebookFrom=${r.id}`}><Button><RotateCcw className="h-4 w-4" />Rebook</Button></Link>}
            {(r.checkIn.ready || r.checkIn.blockers.length > 0) && (
              <Button disabled={!r.checkIn.ready} loading={startCheckIn.isPending} onClick={() => startCheckIn.mutate()} title={r.checkIn.blockers[0]}>
                <LogIn className="h-4 w-4" />Check in
              </Button>
            )}
          </div>
        </div>
      </div>

      {r.status === 'cancelled' && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          Cancelled {r.cancelledAt ? formatDateTime(r.cancelledAt) : ''} — {REASON_LABEL[r.cancelReason as CancellationReason] ?? r.cancelReason}{r.cancelNote ? `: ${r.cancelNote}` : ''}. The booking is kept in history.
          {r.rebookedAs.length > 0 && <> Rebooked as {r.rebookedAs.map((x, i) => <span key={x.id}>{i > 0 && ', '}<Link href={`/reservations/${x.id}`} className="font-semibold underline">{x.number}</Link></span>)}.</>}
        </div>
      )}

      {r.overrides.length > 0 && (
        <Card className="border-warning/40">
          <div className="flex gap-3 px-5 py-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
            <div className="flex flex-col gap-1.5 text-sm">
              <p className="font-medium">Owner authorisation</p>
              {r.overrides.map((o, i) => (
                <p key={i} className="text-text-2">
                  {o.description}. Authorised by {o.authorisedBy} ({o.authorisedByRole === 'owner' ? 'Owner' : o.authorisedByRole}), {formatDateTime(o.at)}
                  {o.performedBy !== o.authorisedBy ? `, requested by ${o.performedBy}` : ''}.
                </p>
              ))}
            </div>
          </div>
        </Card>
      )}

      {(r.checkIn.ready || r.checkIn.blockers.length > 0) && (
        <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${r.checkIn.ready ? 'border-success/30 bg-success-soft text-success' : 'border-border bg-surface text-text-2'}`}>
          {r.checkIn.ready ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
          <div>
            <p className="font-medium text-text">{r.checkIn.ready ? 'Ready for check-in' : 'Before check-in'}</p>
            {[...r.checkIn.blockers, ...r.checkIn.notes].length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-text-2">{[...r.checkIn.blockers, ...r.checkIn.notes].map((b) => <li key={b}>{b}</li>)}</ul>
            )}
          </div>
        </div>
      )}
      {r.stays.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          {r.stays.map((s) => (
            <Link key={s.id} href={`/stays/${s.id}`} className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 hover:bg-surface-2">
              <BedDouble className="h-4 w-4 text-text-2" />Room {s.roomNumber} · {s.status === 'in_house' ? 'In house' : 'Checked out'}
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Stay" />
            <dl className="grid grid-cols-2 gap-4 p-5 text-sm sm:grid-cols-4">
              <Info k="Arrival" v={formatDate(r.arrival, { weekday: true })} />
              <Info k="Departure" v={formatDate(r.departure, { weekday: true })} />
              <Info k="Nights" v={String(r.nights)} />
              <Info k="Rooms" v={String(r.rooms.length)} />
              {r.purpose && <Info k="Purpose" v={VISIT_PURPOSE_LABELS[r.purpose]} />}
            </dl>
            {r.specialRequests && <div className="border-t border-border px-5 py-4 text-sm"><p className="text-text-2">Special requests</p><p className="mt-1 whitespace-pre-wrap">{r.specialRequests}</p></div>}
          </Card>

          <Card>
            <CardHeader title="Rooms" />
            <ul className="divide-y divide-border">
              {r.rooms.map((room) => <RoomRow key={room.id} reservation={r} room={room} onChanged={refreshAll} />)}
            </ul>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Guest" />
            <div className="flex flex-col gap-2 p-5 text-sm">
              <p className="flex items-center gap-1.5 text-base font-medium">{r.guest.isVip && <Crown className="h-4 w-4 text-warning" aria-label="VIP" />}{r.guest.fullName}</p>
              <a href={`tel:${r.guest.mobile}`} className="flex items-center gap-2 text-brand num hover:underline"><Phone className="h-4 w-4" />{formatMobile(r.guest.mobile)}</a>
              {r.guest.email && <p className="text-text-2">{r.guest.email}</p>}
              {r.guest.city && <p className="text-text-2">{r.guest.city}</p>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Estimate" />
            <div className="flex flex-col gap-2 p-5 text-sm">
              <EstimateBreakdown estimate={{ tax: r.estimate }} />
              <div className="mt-2 flex items-center justify-between border-t border-border pt-3">
                <span className="text-text-2">Advance received</span>
                <span className="flex items-center gap-2">
                  <span className="num">{money(r.advancePaid).gt(0) ? formatINR(r.advancePaid) : 'None'}</span>
                  {['tentative', 'confirmed'].includes(r.status) && <Button size="sm" variant="outline" onClick={() => setAdvanceOpen(true)}>Record advance</Button>}
                </span>
              </div>
            </div>
          </Card>
          <OtaPanel reservationId={r.id} source={r.source} />
          <MessagesPanel reservationId={r.id} />
        </div>
      </div>

      {advanceOpen && <AdvanceDialog reservationId={r.id} onClose={() => { setAdvanceOpen(false); void refreshAll(); }} />}
      <CancelDialog open={cancelOpen} reservation={r} onClose={() => setCancelOpen(false)} onDone={async () => { setCancelOpen(false); await refreshAll(); toast('success', `Booking ${r.number} cancelled`); }} />
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return <div><dt className="text-text-2">{k}</dt><dd className="mt-0.5 font-medium num">{v}</dd></div>;
}

function RoomRow({ reservation, room, onChanged }: { reservation: ReservationDetail; room: ReservationDetail['rooms'][number]; onChanged: () => Promise<unknown> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const canAssign = room.status === 'reserved' && reservation.canEdit;
  const avail = useQuery({
    queryKey: ['availability', reservation.arrival, reservation.departure, room.roomTypeId], enabled: editing,
    queryFn: () => api<Availability>('/availability', { query: { arrival: reservation.arrival, departure: reservation.departure, roomTypeId: room.roomTypeId } }),
  });
  const assign = useMutation({
    mutationFn: (roomId: string | null) => api(`/reservation-rooms/${room.id}/assign`, { method: 'POST', body: { roomId }, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => { setEditing(false); await onChanged(); toast('success', 'Room updated'); },
    onError: (e) => toast('error', (e as ApiError).message),
  });
  const extras = money(room.extrasTotal).gt(0);
  const meals = money(room.mealTotal).gt(0);

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-text-2"><BedDouble className="h-5 w-5" /></span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{room.roomNumber ? `Room ${room.roomNumber}` : 'Room not assigned'} <span className="font-normal text-text-2">· {room.roomTypeName}</span></p>
        <p className="text-sm text-text-2">{room.adults} adult{room.adults > 1 ? 's' : ''}{room.childAges.length ? ` · children ${room.childAges.join(', ')} yrs` : ''} · {room.mealPlan}</p>
        <p className="text-sm text-text-2 num">
          Room {formatINR(room.roomTotal)}{extras ? ` · extra guests ${formatINR(room.extrasTotal)}` : ''}{meals ? ` · ${room.mealPlan === 'CP' ? 'breakfast' : 'meals'} ${formatINR(room.mealTotal)}` : ''}
          {' '}· <span className="font-medium text-text">{formatINR(room.total)}</span> before GST
        </p>
      </div>
      {canAssign && !editing && <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{room.roomNumber ? 'Change room' : 'Assign room'}</Button>}
      {editing && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Select aria-label="Choose room" className="h-9 w-44" defaultValue="" disabled={avail.isLoading || assign.isPending}
            onChange={(e) => e.target.value && assign.mutate(e.target.value === 'none' ? null : e.target.value)}>
            <option value="" disabled>{avail.isLoading ? 'Loading…' : 'Choose room'}</option>
            {avail.data?.roomTypes[0]?.freeRooms.map((fr) => <option key={fr.id} value={fr.id}>{fr.number}{fr.view ? ` · ${fr.view}` : ''}</option>)}
            {room.roomNumber && <option value="none">Unassign</option>}
          </Select>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      )}
    </li>
  );
}

function CancelDialog({ open, reservation, onClose, onDone }: { open: boolean; reservation: ReservationDetail; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<CancellationReason>('guest_request');
  const [note, setNote] = useState('');
  const key = useRef(newIdempotencyKey());
  const cancel = useMutation({
    mutationFn: () => api(`/reservations/${reservation.id}/cancel`, { method: 'POST', body: { reason, note: note || undefined }, idempotencyKey: key.current }),
    onSuccess: () => { key.current = newIdempotencyKey(); onDone(); },
  });
  return (
    <Dialog open={open} onClose={onClose} title={`Cancel ${reservation.number}?`}
      description="The rooms become available again. The booking stays in history and can be rebooked later, but never un-cancelled."
      footer={<>
        <Button variant="outline" onClick={onClose}>Keep booking</Button>
        <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel booking</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <Field label="Reason" required>{(id) => (
          <Select id={id} value={reason} onChange={(e) => setReason(e.target.value as CancellationReason)}>
            {CANCELLATION_REASONS.map((c) => <option key={c} value={c}>{REASON_LABEL[c]}</option>)}
          </Select>
        )}</Field>
        <Field label="Note">{(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />}</Field>
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-text-2">No advance has been received, so there is nothing to refund.</p>
        {cancel.isError && <p role="alert" className="text-sm text-danger">{(cancel.error as Error).message}</p>}
      </div>
    </Dialog>
  );
}
