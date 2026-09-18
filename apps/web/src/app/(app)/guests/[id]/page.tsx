'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, BedDouble, Car, Crown, Eye, FileText, Mail, MapPin, Phone } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { formatDate, formatDateTime, formatMobile, ID_TYPE_LABELS, VISIT_PURPOSE_LABELS } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill, ReservationBadge } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { GuestProfile } from '@/lib/types';

const DOC_LABELS: Record<string, string> = {
  guest_photo: 'Guest photo', id_front: 'ID front', id_back: 'ID back', id_extra: 'Extra page', signature: 'Signature', other: 'Document',
};

/** Guest profile (spec §16): every visit, what is still to come, their vehicles and their documents. */
export default function GuestProfilePage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const guest = useQuery({ queryKey: ['guest', id], queryFn: () => api<GuestProfile>(`/guests/${id}`) });

  const view = useMutation({
    mutationFn: (documentId: string) => api<{ url: string }>(`/documents/${documentId}/view-url`),
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
    onError: (e) => toast('error', (e as Error).message),
  });

  if (guest.isLoading) return <div className="flex flex-col gap-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-32" /><Skeleton className="h-60" /></div>;
  if (guest.isError || !guest.data) return <ErrorBanner message={(guest.error as Error)?.message ?? 'Guest not found'} onRetry={() => guest.refetch()} />;
  const g = guest.data;

  const address = [g.addressLine, g.city, g.state, g.pinCode].filter(Boolean).join(', ');
  const past = g.history.filter((h) => !g.upcoming.some((u) => u.id === h.id));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/guests" className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text"><ArrowLeft className="h-4 w-4" />Guests</Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {g.isVip && <Crown className="h-5 w-5 text-warning" aria-label="VIP" />}
            {g.fullName}
          </h1>
          {g.companyName && <Pill tone="info">{g.companyName}</Pill>}
        </div>
        <p className="mt-1 text-sm text-text-2">
          {g.history.length} booking{g.history.length === 1 ? '' : 's'} · {g.stays.length} stay{g.stays.length === 1 ? '' : 's'}
        </p>
      </div>

      {g.specialNote && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">{g.specialNote}</div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-6">
          {g.upcoming.length > 0 && (
            <Card>
              <CardHeader title="Coming up" description={`${g.upcoming.length} booking${g.upcoming.length === 1 ? '' : 's'} still ahead`} />
              <ul className="divide-y divide-border">
                {g.upcoming.map((b) => (
                  <li key={b.id}>
                    <Link href={`/reservations/${b.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm hover:bg-surface-2">
                      <span className="num font-medium">{b.number}</span>
                      <ReservationBadge status={b.status} />
                      <span className="text-text-2">{formatDate(b.arrival)} → {formatDate(b.departure)}</span>
                      {b.rooms && <span className="ml-auto num text-text-3">Room {b.rooms}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="Stays" description="Every visit, newest first" />
            {g.stays.length === 0 ? (
              <EmptyState icon={<BedDouble className="h-5 w-5" />} title="No stay yet" description="This guest has not checked in before." />
            ) : (
              <ul className="divide-y divide-border">
                {g.stays.map((s) => (
                  <li key={s.id}>
                    <Link href={`/stays/${s.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm hover:bg-surface-2">
                      <span className="num font-medium">Room {s.roomNumber}</span>
                      <Pill tone={s.status === 'in_house' ? 'info' : 'neutral'}>{s.status === 'in_house' ? 'In house' : 'Checked out'}</Pill>
                      <span className="text-text-2">{formatDate(s.checkedIn)} → {formatDate(s.checkedOut ?? s.dueOut)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Bookings" description="Including cancelled and no-shows — nothing is removed from history" />
            {past.length === 0 ? (
              <EmptyState
                icon={<BedDouble className="h-5 w-5" />}
                title={g.upcoming.length > 0 ? 'Nothing past yet' : 'No bookings'}
                description={g.upcoming.length > 0 ? 'Every booking for this guest is still ahead — see “Coming up”.' : undefined}
              />
            ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                  <tr><th className="px-5 py-2.5 font-medium">Booking</th><th className="px-3 py-2.5 font-medium">Dates</th><th className="px-3 py-2.5 font-medium">Rooms</th><th className="px-3 py-2.5 font-medium">Purpose</th><th className="px-3 py-2.5 font-medium">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {past.map((h) => (
                    <tr key={h.id} className="hover:bg-surface-2">
                      <td className="px-5 py-2.5"><Link href={`/reservations/${h.id}`} className="num font-medium text-brand hover:underline">{h.number}</Link></td>
                      <td className="px-3 py-2.5 text-text-2">{formatDate(h.arrival, { year: false })} → {formatDate(h.departure, { year: false })}</td>
                      <td className="px-3 py-2.5 num text-text-2">{h.rooms ?? '—'}</td>
                      <td className="px-3 py-2.5 text-text-2">{h.purpose ? VISIT_PURPOSE_LABELS[h.purpose] : '—'}</td>
                      <td className="px-3 py-2.5"><ReservationBadge status={h.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Contact" />
            <div className="flex flex-col gap-2.5 p-5 text-sm">
              <a href={`tel:${g.mobile}`} className="flex items-center gap-2 text-brand num hover:underline"><Phone className="h-4 w-4" />{formatMobile(g.mobile)}</a>
              {g.email && <a href={`mailto:${g.email}`} className="flex items-center gap-2 text-brand hover:underline"><Mail className="h-4 w-4" />{g.email}</a>}
              {address && <p className="flex items-start gap-2 text-text-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0" />{address}{g.country && g.country !== 'IN' ? `, ${g.country}` : ''}</p>}
              {g.companyGstin && <p className="text-text-2">GSTIN <span className="num">{g.companyGstin}</span></p>}
              {g.preferences && <p className="border-t border-border pt-2.5 text-text-2">{g.preferences}</p>}
            </div>
          </Card>

          <Card>
            <CardHeader title="Vehicles" />
            {g.vehicles.length === 0 ? (
              <p className="px-5 py-4 text-sm text-text-3">No vehicle recorded.</p>
            ) : (
              <ul className="divide-y divide-border">
                {g.vehicles.map((v) => (
                  <li key={v.registration} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <Car className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                    <span className="num font-medium">{v.registration}</span>
                    <span className="text-text-3">{v.vehicleType}{v.parkingSlot ? ` · slot ${v.parkingSlot}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Documents" description={`${g.documents.length} verified`} />
            {g.documents.length === 0 ? (
              <p className="px-5 py-4 text-sm text-text-3">
                {g.documentsRestricted
                  ? 'No documents from a current stay. Documents of past stays can only be opened by the owner.'
                  : 'No documents recorded.'}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {g.documents.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <FileText className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {DOC_LABELS[d.docType] ?? d.docType}
                        {d.idType && <span className="font-normal text-text-3"> · {ID_TYPE_LABELS[d.idType as keyof typeof ID_TYPE_LABELS] ?? d.idType}</span>}
                      </span>
                      <span className="block text-xs text-text-3">Room {d.roomNumber} · {formatDateTime(d.at)}</span>
                    </span>
                    <Button variant="ghost" size="sm" loading={view.isPending} onClick={() => view.mutate(d.id)}><Eye className="h-4 w-4" />View</Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-border px-5 py-3 text-xs text-text-3">
              Documents open through a link that lasts one minute, and every view is recorded.
              {g.documentsRestricted && ' Documents of past stays are owner-only.'}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
