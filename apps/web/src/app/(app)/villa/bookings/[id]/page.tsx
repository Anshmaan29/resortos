'use client';
import { useParams } from 'next/navigation';
import { VillaBookingDetail } from '@/components/villa/booking-detail';
export default function Page() {
  const p = useParams<{ id: string }>();
  return <VillaBookingDetail id={p.id} />;
}
