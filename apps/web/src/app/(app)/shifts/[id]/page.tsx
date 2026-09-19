'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ShiftView } from '@/components/cashier/shift-view';
import { ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';
import type { Shift } from '@/lib/types';

export default function ShiftPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const shift = useQuery({ queryKey: ['shift', id], queryFn: () => api<Shift>(`/shifts/${id}`) });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Shift" />
      {shift.isLoading ? <Skeleton className="h-48" /> : shift.isError ? (
        <ErrorBanner message={(shift.error as Error).message} onRetry={() => shift.refetch()} />
      ) : (
        <ShiftView shift={shift.data!} canClose={me.data?.role === 'owner' || me.data?.id === shift.data!.openedById} />
      )}
    </div>
  );
}
