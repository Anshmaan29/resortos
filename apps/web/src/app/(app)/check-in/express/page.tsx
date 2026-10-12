'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Zap } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { addDays, formatDate, nightsBetween, MEAL_PLAN_CODES, MEAL_PLAN_LABELS, type MealPlanCode } from '@resortos/shared';
import { EstimateBreakdown } from '@/components/booking/booking-form';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { Field, Input, Select } from '@/components/ui/field';
import { useOwnerApproval } from '@/components/ui/owner-pin';
import { Card, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useProperty } from '@/lib/session';
import type { Availability, BookingEstimate, ReservationDetail } from '@/lib/types';

/**
 * Express check-in for a walk-in (spec §18, PHASES "Before the pilot"): the booking and the check-in
 * on one screen, for experienced staff. It creates the booking and the check-in draft through the
 * same endpoints as the normal flow — same validation, limits, Owner PIN, audit and idempotency —
 * and then continues on one page instead of five steps. The wizard stays the default.
 */
export default function ExpressCheckInPage() {
  const router = useRouter();
  const property = useProperty();
  const today = property.data?.today ?? '';
  const [departure, setDeparture] = useState('');
  const [guest, setGuest] = useState({ firstName: '', lastName: '', mobile: '', email: '', preferredLanguage: 'en' as 'en' | 'hi' });
  const [roomTypeId, setRoomTypeId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [adults, setAdults] = useState('2');
  const [mealPlan, setMealPlan] = useState<MealPlanCode>('EP');
  const [rate, setRate] = useState('');
  const [gstRate, setGstRate] = useState('');
  const [extraRate, setExtraRate] = useState('');
  const [whatsappOptedIn, setWhatsappOptedIn] = useState(true);
  const key = useRef<{ body: string; key: string } | null>(null);
  const validMoney = (v: string) => /^\d+(\.\d{1,2})?$/.test(v);
  const pricesValid = validMoney(rate) && (!gstRate || validMoney(gstRate) && Number(gstRate) <= 100) && (!extraRate || validMoney(extraRate));
  const roomInput = { roomTypeId, roomId, adults: Number(adults), mealPlan, nightlyRate: rate, includesMealPlan: true, gstRate: gstRate || null, extraPersonRate: extraRate || undefined };
  useEffect(() => { if (today && !departure) setDeparture(addDays(today, 1)); }, [today, departure]);

  const availability = useQuery({
    queryKey: ['availability', today, departure], enabled: Boolean(today && departure && departure > today),
    queryFn: () => api<Availability>('/availability', { query: { arrival: today, departure } }),
  });
  const quote = useQuery({
    queryKey: ['express-estimate', roomTypeId, today, departure, adults, mealPlan, rate, gstRate, extraRate], enabled: Boolean(roomTypeId && departure > today && pricesValid),
    queryFn: () => api<BookingEstimate>('/reservations/estimate', { method: 'POST', body: { arrival: today, departure, rooms: [roomInput] } }), retry: false,
  });
  const type = availability.data?.roomTypes.find((t) => t.roomTypeId === roomTypeId);
  // A walk-in goes into a room that is free and clean now.
  const rooms = (type?.freeRooms ?? []).filter((r) => ['clean', 'inspected'].includes(r.housekeeping));

  const start = useMutation({
    mutationFn: async (ownerAuthorisationId?: string) => {
      const body = { guest: { ...guest, email: guest.email || undefined }, source: 'walk_in', arrival: today, departure,
        rooms: [roomInput], ownerAuthorisationId, whatsappOptedIn };
      const json = JSON.stringify(body);
      if (!key.current || key.current.body !== json) key.current = { body: json, key: newIdempotencyKey() };
      const reservation = await api<ReservationDetail>('/reservations', {
        method: 'POST', idempotencyKey: key.current.key, body,
      });
      return api<{ id: string }>('/check-in-drafts', { method: 'POST', body: { reservationId: reservation.id } });
    },
    onSuccess: (draft) => router.push(`/check-in/express/${draft.id}`),
    onError: (err) => { approval.handleError(err); },
  });
  const approval = useOwnerApproval((id) => start.mutate(id));
  const fields = start.error instanceof ApiError ? start.error.fields : {};
  const ready = guest.firstName && guest.mobile && roomTypeId && roomId && departure > today && pricesValid;

  if (!property.data) return <Skeleton className="h-96" />;
  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader title="Express check-in" description={`Walk-in arriving today, ${formatDate(today, { weekday: true })}. Booking and check-in on one screen.`} />
      {start.error && !(start.error instanceof ApiError && ['OWNER_PIN_REQUIRED', 'OWNER_AUTHORISATION_INVALID'].includes(start.error.code)) && (
        <ErrorBanner message={(start.error as Error).message} />
      )}
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-5">
          <Card className="p-4">
            <h2 className="mb-3 font-semibold">Guest</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" required error={fields['guest.firstName']}>{(id) => <Input id={id} value={guest.firstName} onChange={(e) => setGuest({ ...guest, firstName: e.target.value })} autoFocus />}</Field>
              <Field label="Last name">{(id) => <Input id={id} value={guest.lastName} onChange={(e) => setGuest({ ...guest, lastName: e.target.value })} />}</Field>
              <Field label="Mobile" required error={fields['guest.mobile']}>{(id) => <Input id={id} inputMode="tel" value={guest.mobile} onChange={(e) => setGuest({ ...guest, mobile: e.target.value })} />}</Field>
              <Field label="Email" hint="For the welcome message and invoice" error={fields['guest.email']}>{(id) => <Input id={id} type="email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} />}</Field>
              <Field label="Messages in">{(id) => (
                <Select id={id} value={guest.preferredLanguage} onChange={(e) => setGuest({ ...guest, preferredLanguage: e.target.value as 'en' | 'hi' })}>
                  <option value="en">English</option><option value="hi">हिन्दी</option>
                </Select>)}</Field>
            </div>
          </Card>
          <Card className="p-4">
            <h2 className="mb-3 font-semibold">Stay</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Leaving on" required error={fields.departure}>{(id) => <DateField id={id} value={departure} onChange={setDeparture} min={addDays(today, 1)} />}</Field>
              <Field label="Adults" required>{(id) => <Input id={id} inputMode="numeric" value={adults} onChange={(e) => setAdults(e.target.value.replace(/\D/g, ''))} />}</Field>
            </div>
            <p className="mb-2 mt-5 text-sm font-medium text-text-2">Room type</p>
            {availability.isLoading ? <Skeleton className="h-20" /> : (
              <div className="grid gap-2 sm:grid-cols-2">
                {(availability.data?.roomTypes ?? []).map((t) => (
                  <button key={t.roomTypeId} type="button" disabled={t.available < 1} onClick={() => { setRoomTypeId(t.roomTypeId); setRoomId(''); setRate(''); }}
                    className={cn('rounded-lg border px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-40', roomTypeId === t.roomTypeId ? 'border-brand bg-brand-soft' : 'border-border hover:border-border-strong')}>
                    <span className="font-medium">{t.roomTypeName}</span><span className="block text-xs text-text-3">{t.available} free for these nights</span>
                  </button>
                ))}
              </div>
            )}
            {type && (
              <>
                <p className="mb-2 mt-5 text-sm font-medium text-text-2">Room <span className="font-normal text-text-3">(clean and free)</span></p>
                {rooms.length ? (
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Clean free rooms">{rooms.map((r) => (
                    <button key={r.id} type="button" onClick={() => setRoomId(r.id)} aria-pressed={roomId === r.id}
                      className={cn('min-w-16 rounded-lg border px-3 py-2 text-sm font-medium', roomId === r.id ? 'border-brand bg-brand text-brand-contrast' : 'border-border hover:border-border-strong')}>{r.number}</button>
                  ))}</div>
                ) : <p className="text-sm text-warning">No clean room of this type is free. Choose another type or have a room cleaned.</p>}
              </>
            )}
          </Card>
        </div>
        <Card className="self-start p-4 lg:sticky lg:top-20">
          <h2 className="font-semibold">Price</h2>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="Meal plan">{(id) => <Select id={id} value={mealPlan} onChange={(e) => setMealPlan(e.target.value as MealPlanCode)}>{MEAL_PLAN_CODES.map((plan) => <option key={plan} value={plan}>{plan} · {MEAL_PLAN_LABELS[plan]}</option>)}</Select>}</Field>
            <div className="grid grid-cols-[2fr_1fr] gap-3">
              <Field label="Room price per night" required hint="Includes the chosen meal plan; before GST." error={fields['rooms.0.nightlyRate']}>{(id) => <Input id={id} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Agreed amount" />}</Field>
              <Field label="GST %" hint="Blank = hotel setting" error={gstRate && (!validMoney(gstRate) || Number(gstRate) > 100) ? 'Enter 0–100%' : fields['rooms.0.gstRate']}>{(id) => <Input id={id} inputMode="decimal" value={gstRate} onChange={(e) => setGstRate(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Hotel setting" />}</Field>
            </div>
            <Field label="Extra guest price per night" hint="Total extra adult / child charges. Blank = standard; 0 = included." error={fields['rooms.0.extraPersonRate']}>{(id) => <Input id={id} inputMode="decimal" value={extraRate} onChange={(e) => setExtraRate(e.target.value.replace(/[^\d.]/g, ''))} />}</Field>
            {quote.isError ? <ErrorBanner message={(quote.error as Error).message} /> : pricesValid && roomTypeId ? <EstimateBreakdown estimate={quote.data} loading={quote.isFetching} /> : <p className="text-sm text-text-2">Enter the room price to calculate the total.</p>}
            <p className="text-xs text-text-2">{whatsappOptedIn ? 'By continuing, you confirm the guest agreed to receive booking, stay and payment messages from this hotel on WhatsApp.' : 'WhatsApp is off for this guest. Email messages still send automatically.'}</p>
            <details><summary className="cursor-pointer text-sm text-brand">Change WhatsApp preference</summary><Field label="WhatsApp messages">{(id) => <Select id={id} value={whatsappOptedIn ? 'agreed' : 'declined'} onChange={(e) => setWhatsappOptedIn(e.target.value === 'agreed')}><option value="agreed">Guest agreed — send automatically</option><option value="declined">Guest declined — email only</option></Select>}</Field></details>
          </div>
          <Button size="lg" className="mt-4 w-full" loading={start.isPending} disabled={!ready} onClick={() => start.mutate(undefined)}>
            <Zap className="h-4 w-4" aria-hidden />Continue to IDs and signature<ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
          <p className="mt-2 text-xs text-text-3">{departure > today ? `${nightsBetween(today, departure)} night${nightsBetween(today, departure) > 1 ? 's' : ''}, ${formatDate(today, { year: false })} to ${formatDate(departure, { year: false })}` : ''}</p>
        </Card>
      </div>
      {approval.dialog}
    </div>
  );
}
