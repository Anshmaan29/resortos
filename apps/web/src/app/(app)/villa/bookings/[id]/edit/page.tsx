'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { VillaBookingForm } from '@/components/villa/booking-form';
import type { VillaBooking } from '@/components/villa/bookings';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
export default function Page() {
  const { id } = useParams<{ id: string }>();
  const b = useQuery({
    queryKey: ['villa-booking', id],
    queryFn: () => api<VillaBooking>(`/villa/bookings/${id}`),
  });
  if (b.isError) return <ErrorBanner message={b.error.message} />;
  return b.data ? <VillaBookingForm key={b.data.id} initial={b.data} /> : <Skeleton className="h-72" />;
}
