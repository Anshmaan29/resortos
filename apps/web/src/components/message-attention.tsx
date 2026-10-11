'use client';
import { useQuery } from '@tanstack/react-query';
import { MessageCircleWarning } from 'lucide-react';
import Link from 'next/link';
import { useMe } from '@/lib/session';
import { api } from '@/lib/api';
import { Card, CardHeader, ErrorBanner } from '@/components/ui/surface';

interface Attention {
  total: number;
  items: { id: string; channel: 'email' | 'whatsapp'; templateLabel: string; status: string; bookingNumber: string | null; href: string }[];
}

export function MessageAttention() {
  const me = useMe();
  const alerts = useQuery({ enabled: me.data?.role === 'owner' || me.data?.role === 'receptionist', queryKey: ['message-attention'], queryFn: () => api<Attention>('/messages/attention'), refetchInterval: 15_000 });
  if (alerts.isError) return <ErrorBanner message="Could not check guest message delivery. Open the booking’s Messages panel to review it." onRetry={() => alerts.refetch()} />;
  if (!alerts.data?.total) return null;
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><MessageCircleWarning className="h-5 w-5 text-warning" aria-hidden />Guest messages need attention ({alerts.data.total})</span>}
        description="These messages need a delivery check. Bookings and payments are saved. Open the record to check the reason before sending again." />
      <ul className="divide-y divide-border">
        {alerts.data.items.map(m => <li key={m.id}>
          <Link className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-surface-2" href={m.href}>
            <span>{m.channel === 'whatsapp' ? 'WhatsApp' : 'Email'} · {m.templateLabel}{m.bookingNumber ? ' · ' + m.bookingNumber : ''}</span>
            <span className="font-medium text-brand">Review message →</span>
          </Link>
        </li>)}
      </ul>
    </Card>
  );
}
