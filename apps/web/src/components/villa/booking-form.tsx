'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import {
  VILLA_USES,
  VILLA_BOOKABLE_USES,
  VILLA_USE_LABELS,
  villaBookingSchema,
  villaDayUse,
  villaBookingTotal,
  formatINR,
} from '@resortos/shared';
import { api, newIdempotencyKey } from '@/lib/api';
import { useProperty } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Card, CardHeader, PageHeader, ErrorBanner } from '@/components/ui/surface';
import type { VillaBooking } from './bookings';
export function VillaBookingForm({ initial }: { initial?: VillaBooking }) {
  const property = useProperty();
  const qc = useQueryClient();
  const router = useRouter();
  const key = useRef(newIdempotencyKey());
  const datetime = (s?: string) =>
    s ? new Date(new Date(s).getTime() + 330 * 60000).toISOString().slice(0, 16) : '';
  const [kind, setKind] = useState<(typeof VILLA_USES)[number]>(
    (initial?.useKind as (typeof VILLA_USES)[number]) ?? 'both_bedrooms',
  );
  const [roomId, setRoomId] = useState(initial?.roomId ?? '');
  const [start, setStart] = useState(datetime(initial?.startsAt));
  const [end, setEnd] = useState(datetime(initial?.endsAt));
  const [count, setCount] = useState(initial ? String(initial.guestCount) : '');
  const [price, setPrice] = useState(initial?.price ?? '');
  const [gst, setGst] = useState(initial?.gstPercent ?? '');
  const [meal, setMeal] = useState(initial?.mealPlan ?? 'EP');
  const [name, setName] = useState(initial?.guestName ?? '');
  const [mobile, setMobile] = useState(initial?.mobile ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [guestId, setGuestId] = useState(initial?.guestId ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [error, setError] = useState('');
  const day = villaDayUse(kind);
  const iso = (value: string) => (value ? value + ':00+05:30' : '');
  const validDates = !!start && !!end && Date.parse(iso(end)) > Date.parse(iso(start));
  const availability = useQuery({
    queryKey: ['villa-availability', start, end, initial?.id, kind, roomId],
    queryFn: () =>
      api<{
        available: boolean;
        message: string | null;
        rooms: { id: string; number: string; available: boolean }[];
      }>('/villa/availability', {
        query: {
          startsAt: iso(start),
          endsAt: iso(end),
          excludeId: initial?.id,
          useKind: kind,
          roomId: roomId || undefined,
        },
      }),
    enabled: validDates,
  });
  const guests = useQuery({
    queryKey: ['villa-guest-search', mobile],
    queryFn: () =>
      api<
        { id: string; firstName: string; lastName: string; mobile: string; email: string | null }[]
      >('/guests', { query: { q: mobile } }),
    enabled: mobile.replace(/\D/g, '').length >= 4 && !guestId,
  });
  const save = useMutation({
    mutationFn: async () => {
      const input = villaBookingSchema.safeParse({
        useKind: kind,
        roomId: kind === 'one_bedroom' ? roomId || undefined : undefined,
        startsAt: iso(start),
        endsAt: iso(end),
        guestCount: Number(count),
        price,
        gstPercent: gst,
        ...(guestId ? { guestId } : { guest: { firstName: name, mobile, email } }),
        notes,
        mealPlan: meal,
        version: initial?.version,
      });
      if (!input.success) throw new Error(input.error.issues.map((i) => i.message).join(' · '));
      return api<{ id: string }>(initial ? `/villa/bookings/${initial.id}` : '/villa/bookings', {
        method: initial ? 'PATCH' : 'POST',
        body: input.data,
        idempotencyKey: key.current,
      });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['villa-booking', r.id] });
      void qc.invalidateQueries({ queryKey: ['villa-bookings'] });
      router.push(`/villa/bookings/${r.id}`);
    },
    onError: (e) => setError(e.message),
  });
  const nights = validDates
    ? Math.round((Date.parse(end.slice(0, 10)) - Date.parse(start.slice(0, 10))) / 86400000)
    : 0;
  const validMoney =
    /^\d+(\.\d{1,2})?$/.test(price) && /^\d+(\.\d{1,2})?$/.test(gst) && Number(gst) <= 100;
  const total = validMoney ? villaBookingTotal(price, gst, day ? 1 : Math.max(1, nights)) : null;
  if (property.data && property.data.bookingModel !== 'private_villa')
    return <ErrorBanner message="Choose Villa Sol before creating a villa booking." />;
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={initial ? 'Edit villa booking' : 'New villa booking'}
        description="Select what the guest is booking. Rooms can be booked separately. Pool and garden bookings reserve the entire property."
      />
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          save.mutate();
        }}
      >
        {error && <ErrorBanner message={error} />}
        <Card>
          <CardHeader title="Booking & price" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Book" required hint={kind === 'both_bedrooms' ? 'Room 1 and Room 2, including pool and garden. One combined price.' : undefined}>
              {(id) => (
                <Select
                  id={id}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                >
                  {(initial?.useKind === 'whole_villa' ? VILLA_USES : VILLA_BOOKABLE_USES)
                    .filter((k) => !initial || villaDayUse(k) === initial.dayUse)
                    .map((k) => (
                      <option key={k} value={k}>
                        {VILLA_USE_LABELS[k]}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            {kind === 'one_bedroom' && (
              <Field label="Room" required>
                {(id) => (
                  <Select
                    id={id}
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    required
                  >
                    <option value="">Choose a room</option>
                    {(availability.data?.rooms ?? []).map((r) => (
                      <option key={r.id} value={r.id} disabled={!r.available}>
                        Room {r.number}
                        {r.available ? '' : ' · unavailable'}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label="Number of guests" required>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min="1"
                  max={day ? 1000 : 20}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  required
                />
              )}
            </Field>
            <Field label={day ? 'Start date & time' : 'Check-in date & time'} required>
              {(id) => (
                <Input
                  id={id}
                  type="datetime-local"
                  min={property.data?.today + 'T00:00'}
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  required
                />
              )}
            </Field>
            <Field label={day ? 'End date & time' : 'Checkout date & time'} required>
              {(id) => (
                <Input
                  id={id}
                  type="datetime-local"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  required
                />
              )}
            </Field>
            <Field
              label={
                day
                  ? 'Total slot price before GST'
                  : kind === 'both_bedrooms'
                    ? 'Combined price for both rooms per night before GST'
                    : 'Agreed price per night before GST'
              }
              required
            >
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="Enter agreed amount"
                  required
                />
              )}
            </Field>
            <Field label="GST %" required>
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={gst}
                  onChange={(e) => setGst(e.target.value)}
                  placeholder="Enter GST percentage"
                  required
                />
              )}
            </Field>
            {!day && (
              <Field label="Meal plan included in agreed price">
                {(id) => (
                  <Select id={id} value={meal} onChange={(e) => setMeal(e.target.value)}>
                    {['EP', 'CP', 'MAP', 'AP'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <div className="sm:col-span-2">
              {validDates && availability.data && (
                <p
                  role="status"
                  className={
                    availability.data.available ? 'text-sm text-success' : 'text-sm text-danger'
                  }
                >
                  {availability.data.available
                    ? 'Available for the selected dates and times.'
                    : availability.data.message}
                </p>
              )}
              {availability.isError && <ErrorBanner message={availability.error.message} />}
              {total && (
                <p className="mt-3 rounded-md bg-surface-2 p-3 font-semibold">
                  Estimated total including GST: {formatINR(total)}
                  {!day && ` · ${Math.max(1, nights)} night(s)`}
                </p>
              )}
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Guest contact"
            description={
              day
                ? 'No ID, photo or signature is required for pool and garden visits.'
                : 'Guest documents will be collected during check-in.'
            }
          />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Mobile" required>
              {(id) => (
                <Input
                  id={id}
                  value={mobile}
                  inputMode="tel"
                  onChange={(e) => {
                    setMobile(e.target.value);
                    setGuestId('');
                  }}
                  required
                />
              )}
            </Field>
            <Field label="Guest name" required>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setGuestId('');
                  }}
                  required
                />
              )}
            </Field>
            {!guestId && !!guests.data?.length && (
              <div className="rounded-md border border-border p-3 sm:col-span-2">
                <p className="mb-2 text-sm text-text-2">Existing Villa Sol guests</p>
                {guests.data.map((g) => (
                  <button
                    type="button"
                    key={g.id}
                    className="block w-full rounded-md p-2 text-left text-sm hover:bg-surface-2"
                    onClick={() => {
                      setGuestId(g.id);
                      setName(`${g.firstName} ${g.lastName}`.trim());
                      setMobile(g.mobile);
                      setEmail(g.email ?? '');
                    }}
                  >
                    {g.firstName} {g.lastName} · {g.mobile}
                  </button>
                ))}
              </div>
            )}
            <Field label="Email" hint="Confirmation sends automatically when an email is provided.">
              {(id) => (
                <Input
                  id={id}
                  type="email"
                  value={email}
                  disabled={!!guestId}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            <Field label="Notes">
              {(id) => (
                <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />
              )}
            </Field>
          </div>
        </Card>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={() => router.push('/villa/bookings')}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={save.isPending}
            disabled={!validDates || availability.isFetching || !availability.data?.available}
          >
            {initial ? 'Save booking' : 'Create booking'}
          </Button>
        </div>
      </form>
    </div>
  );
}
