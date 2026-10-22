'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { formatINR } from '@resortos/shared';
import { api, newIdempotencyKey } from '@/lib/api';
import { Card, CardHeader, PageHeader, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { BillPanel } from '@/components/stay/bill-panel';
import { MessagesPanel } from '@/components/messages-panel';
import { VillaRefundDialog } from './refund-dialog';
import { AdvanceDialog } from '@/components/booking/booking-money';
import { villaTime, type VillaBooking } from './bookings';
export function VillaBookingDetail({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const [action, setAction] = useState<'arrive' | 'depart' | 'cancel' | null>(null);
  const [advance, setAdvance] = useState(false);
  const [refund, setRefund] = useState(false);
  const booking = useQuery({
    queryKey: ['villa-booking', id],
    queryFn: () => api<VillaBooking>(`/villa/bookings/${id}`),
    refetchInterval: 5000,
  });
  const mutate = useMutation({
    mutationFn: () =>
      api<VillaBooking>(`/villa/bookings/${id}/${action}`, {
        method: 'POST',
        body: { version: booking.data!.version },
        idempotencyKey: key.current,
      }),
    onSuccess: (r) => {
      qc.setQueryData(['villa-booking', id], r);
      void qc.invalidateQueries({ queryKey: ['villa-bookings'] });
      void qc.invalidateQueries({ queryKey: ['bill'] });
      setAction(null);
      key.current = newIdempotencyKey();
    },
  });
  const checkIn = useMutation({
    mutationFn: () =>
      api<import('@/components/check-in/types').CheckInDraft>('/check-in-drafts', { method: 'POST', body: { reservationId: id } }),
    onSuccess: async (d) => {
      await qc.cancelQueries({ queryKey: ['check-in', d.id] });
      qc.setQueryData(['check-in', d.id], d);
      router.push(`/check-in/${d.id}`);
    },
  });
  if (booking.isError) return <ErrorBanner message={booking.error.message} />;
  if (!booking.data) return <Skeleton className="h-64" />;
  const b = booking.data;
  const active = b.status === 'checked_in',
    upcoming = b.status === 'confirmed';
  return (
    <div className="space-y-5">
      <Link href="/villa/bookings" className="text-sm text-text-2">
        ← Villa bookings
      </Link>
      <PageHeader
        title={`${b.number} · ${b.guestName}`}
        description={b.useLabel}
        actions={
          <div className="flex flex-wrap gap-2">
            {upcoming && (
              <>
                <Link href={`/villa/bookings/${b.id}/edit`}>
                  <Button variant="secondary">Edit booking</Button>
                </Link>
                <Button
                  variant="secondary"
                  onClick={() => {
                    mutate.reset();
                    setAction('cancel');
                  }}
                >
                  Cancel booking
                </Button>
                <Button
                  loading={checkIn.isPending}
                  onClick={() => (b.dayUse ? setAction('arrive') : checkIn.mutate())}
                >
                  {b.dayUse ? 'Mark arrival' : 'Check in & collect ID'}
                </Button>
              </>
            )}
            {active && !b.dayUse && b.stayId && <Link href={`/stays/${b.stayId}?extend=1`}>
              <Button variant="outline">Extend stay</Button>
            </Link>}
            {active &&
              (b.dayUse ? (
                <Button onClick={() => setAction('depart')}>Check out</Button>
              ) : (
                <Link href={`/stays/${b.stayId}?checkout=1`}>
                  <Button>Check out</Button>
                </Link>
              ))}
          </div>
        }
      />
      {checkIn.isError && <ErrorBanner message={checkIn.error.message} />}
      <Card>
        <CardHeader
          title={
            active
              ? 'In use'
              : b.status === 'checked_out'
                ? 'Completed'
                : b.status === 'cancelled'
                  ? 'Cancelled'
                  : 'Booking'
          }
        />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <div>
            <p className="text-sm text-text-2">From</p>
            <p>{villaTime(b.startsAt)}</p>
          </div>
          <div>
            <p className="text-sm text-text-2">Until</p>
            <p>{villaTime(b.endsAt)}</p>
          </div>
          <div>
            <p className="text-sm text-text-2">Guests</p>
            <p>{b.guestCount}</p>
          </div>
          <div>
            <p className="text-sm text-text-2">Estimated booking total including GST</p>
            <p className="font-semibold">
              {formatINR(b.estimatedTotal)} · GST {b.gstPercent}%
            </p>
          </div>
          <div>
            <p className="text-sm text-text-2">Contact</p>
            <p>{b.mobile}</p>
            {b.email && <p>{b.email}</p>}
          </div>
          <div>
            <p className="text-sm text-text-2">Advance / payments received</p>
            <p>{formatINR(b.paid)}</p>
            {upcoming && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setAdvance(true)}>
                  Record advance
                </Button>
                {Number(b.paid) > 0 && (
                  <Button variant="secondary" onClick={() => setRefund(true)}>
                    Record advance refund
                  </Button>
                )}
              </div>
            )}
          </div>
          {b.notes && <p className="whitespace-pre-wrap text-sm sm:col-span-2">{b.notes}</p>}
        </div>
      </Card>
      {b.dayUse && (
        <p className="text-sm text-text-2">
          Pool and garden bookings do not need guest ID, photo or signature.
        </p>
      )}
      {(b.stayId || (b.folioId && !upcoming)) && (
        <BillPanel
          stayId={b.stayId ?? b.id}
          folioId={b.dayUse ? (b.folioId ?? undefined) : undefined}
          canEdit={active}
        />
      )}
      <MessagesPanel reservationId={id} />
      {refund && (
        <VillaRefundDialog
          bookingId={id}
          paid={b.paid}
          onClose={() => {
            setRefund(false);
            void booking.refetch();
          }}
        />
      )}
      {advance && (
        <AdvanceDialog
          reservationId={id}
          onClose={() => {
            setAdvance(false);
            void booking.refetch();
          }}
        />
      )}
      <Dialog
        open={!!action}
        onClose={() => {
          setAction(null);
          mutate.reset();
        }}
        title={
          action === 'cancel'
            ? 'Cancel this booking?'
            : action === 'depart'
              ? 'Complete checkout?'
              : 'Confirm arrival?'
        }
        description={
          action === 'cancel'
            ? 'The booked time becomes available again. Settle any advance before cancellation.'
            : action === 'depart'
              ? 'Settle the bill first. Checkout issues the invoice and marks the villa as needing housekeeping.'
              : 'This starts the booked pool or garden visit. The agreed charge will be added to the bill.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setAction(null)}>
              Back
            </Button>
            <Button loading={mutate.isPending} onClick={() => mutate.mutate()}>
              Confirm {action === 'depart' ? 'checkout' : action === 'cancel' ? 'cancellation' : 'arrival'}
            </Button>
          </>
        }
      >
        {mutate.isError && <ErrorBanner message={mutate.error.message} />}
      </Dialog>
    </div>
  );
}
