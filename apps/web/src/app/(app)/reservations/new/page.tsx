'use client';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { BookingForm } from '@/components/booking/booking-form';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import type { ReservationDetail } from '@/lib/types';

function NewBooking() {
  const params = useSearchParams();
  const rebookFrom = params.get('rebookFrom');
  const original = useQuery({
    queryKey: ['reservation', rebookFrom], enabled: !!rebookFrom,
    queryFn: () => api<ReservationDetail>(`/reservations/${rebookFrom}`),
  });
  if (!rebookFrom) return <BookingForm mode="create" walkIn={params.get('walkIn') === '1'} />;
  if (original.isError) return <ErrorBanner message={(original.error as Error).message} onRetry={() => original.refetch()} />;
  if (!original.data) return <div className="flex flex-col gap-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-96" /></div>;
  if (!original.data.canRebook) return <ErrorBanner message={`${original.data.number} is not cancelled, so it cannot be rebooked.`} />;
  return <BookingForm mode="rebook" initial={original.data} />;
}

export default function NewBookingPage() {
  return <Suspense><NewBooking /></Suspense>;
}
