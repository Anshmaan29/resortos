'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { BookingForm } from '@/components/booking/booking-form';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import type { ReservationDetail } from '@/lib/types';

export default function EditBookingPage() {
  const { id } = useParams<{ id: string }>();
  // Always load fresh: the version sent on save must be the latest.
  const res = useQuery({ queryKey: ['reservation', id, 'edit'], queryFn: () => api<ReservationDetail>(`/reservations/${id}`), staleTime: 0, refetchOnWindowFocus: false });
  if (res.isError) return <ErrorBanner message={(res.error as Error).message} onRetry={() => res.refetch()} />;
  if (!res.data) return <div className="flex flex-col gap-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-96" /></div>;
  if (!res.data.canEdit) return <ErrorBanner message={`${res.data.number} can no longer be edited.`} />;
  return <BookingForm mode="edit" initial={res.data} />;
}
