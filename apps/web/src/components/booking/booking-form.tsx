'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, BedDouble, Check, Crown, Minus, Plus, Search, Trash2, UserRound, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { uniqueReturningGuest } from '@/lib/returning-guest';
import {
  addDays, BOOKING_SOURCE_LABELS, BOOKING_SOURCES, createReservationSchema, formatDate, formatINR, formatMobile, guestSchema,
  money, nightsBetween, OTA_SOURCES, updateReservationSchema, VISIT_PURPOSE_LABELS, VISIT_PURPOSES, MEAL_PLAN_CODES,
  type BookingSource, type MealPlanCode, type VisitPurpose,
} from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useOwnerApproval } from '@/components/ui/owner-pin';
import { Card, CardHeader, ErrorBanner, PageHeader, Skeleton } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { EASE_OUT } from '@/lib/motion';
import { useProperty } from '@/lib/session';
import type { Availability, BookingEstimate, Guest, ReservationDetail, RoomType } from '@/lib/types';

const MEAL_LABEL: Record<MealPlanCode, string> = { EP: 'EP · Room only', CP: 'CP · Breakfast', MAP: 'MAP · Breakfast + 1 meal', AP: 'AP · All meals' };

interface RoomLine {
  key: string;
  reservationRoomId?: string;
  roomTypeId: string;
  roomId: string;
  adults: number;
  childAges: number[];
  mealPlan: MealPlanCode;
  manualRate: string;
  useCustomPrice: boolean;
  gstRate: string;
  manualExtras: string;
}

type GuestChoice = Pick<Guest, 'id' | 'fullName' | 'mobile' | 'city' | 'isVip' | 'whatsappOptedIn' | 'whatsappConsentAt'> & { stays?: number };

const newLine = (roomTypeId = ''): RoomLine => ({ key: crypto.randomUUID(), roomTypeId, roomId: '', adults: 2, childAges: [], mealPlan: 'EP', manualRate: '', useCustomPrice: true, gstRate: '', manualExtras: '0' });
const validRate = (v: string) => (/^\d+(\.\d{1,2})?$/.test(v) ? v : undefined);
const hasExtraGuests = (line: RoomLine, types: RoomType[]) => line.childAges.length > 0
  || line.adults > (types.find((t) => t.id === line.roomTypeId)?.baseOccupancy ?? 1);

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export type BookingFormMode = 'create' | 'edit' | 'rebook';

export function BookingForm({ mode, initial, walkIn }: { mode: BookingFormMode; initial?: ReservationDetail; walkIn?: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const property = useProperty();
  const bd = property.data?.today;

  // ---------- state (prefilled for edit / rebook) ----------
  const [guest, setGuest] = useState<GuestChoice | null>(initial ? { ...initial.guest } : null);
  const [newGuest, setNewGuest] = useState({ firstName: '', lastName: '', mobile: '', email: '', city: '', preferredLanguage: 'en' as 'en' | 'hi' });
  const [search, setSearch] = useState('');
  const [arrival, setArrival] = useState('');
  const [departure, setDeparture] = useState('');
  const [source, setSource] = useState<BookingSource>((initial?.source as BookingSource) ?? (walkIn ? 'walk_in' : 'phone'));
  const [otaReference, setOtaReference] = useState(initial?.otaReference ?? '');
  const [status, setStatus] = useState<'confirmed' | 'tentative'>(initial?.status === 'tentative' ? 'tentative' : 'confirmed');
  const [groupName, setGroupName] = useState(initial?.groupName ?? '');
  const [specialRequests, setSpecialRequests] = useState(initial?.specialRequests ?? '');
  const [purpose, setPurpose] = useState<VisitPurpose | ''>(initial?.purpose ?? '');
  const [lines, setLines] = useState<RoomLine[]>(() => initial
    ? initial.rooms.filter((r) => mode === 'rebook' || r.status === 'reserved').map((r) => ({
        key: crypto.randomUUID(), reservationRoomId: mode === 'edit' ? r.id : undefined, roomTypeId: r.roomTypeId,
        roomId: mode === 'edit' ? r.roomId ?? '' : '', adults: r.adults, childAges: r.childAges, mealPlan: r.mealPlan, manualRate: '', useCustomPrice: mode !== 'edit', gstRate: r.gstRate ?? '', manualExtras: '',
      }))
    : [newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [whatsappOverride, setWhatsappOverride] = useState<boolean | null>(null);
  const whatsappOptedIn = whatsappOverride ?? !(guest?.whatsappOptedIn === false && guest.whatsappConsentAt);

  useEffect(() => {
    if (!bd || arrival) return;
    if (initial && (mode === 'edit' || initial.arrival >= bd)) { setArrival(initial.arrival); setDeparture(initial.departure); }
    else if (initial) { setArrival(bd); setDeparture(addDays(bd, initial.nights)); }
    else { setArrival(bd); setDeparture(addDays(bd, 1)); }
  }, [bd, arrival, initial, mode]);

  const nights = arrival && departure ? nightsBetween(arrival, departure) : 0;
  const datesValid = nights >= 1;

  // ---------- data ----------
  const roomTypes = useQuery({ queryKey: ['room-types'], queryFn: () => api<RoomType[]>('/room-types') });
  const availability = useQuery({
    queryKey: ['availability', arrival, departure, mode === 'edit' ? initial?.id : null], enabled: datesValid,
    queryFn: () => api<Availability>('/availability', { query: { arrival, departure, reservationId: mode === 'edit' ? initial?.id : undefined } }),
  });
  const debouncedSearch = useDebounced(search || newGuest.mobile, 250);
  const guestResults = useQuery({
    queryKey: ['guest-search', debouncedSearch], enabled: !guest && debouncedSearch.trim().length >= 3,
    queryFn: () => api<Guest[]>('/guests', { query: { q: debouncedSearch } }),
  });
  useEffect(() => {
    if (guest || mode === 'edit' || debouncedSearch !== (search || newGuest.mobile)) return;
    const found = uniqueReturningGuest(guestResults.data ?? [], debouncedSearch,
      search ? '' : `${newGuest.firstName} ${newGuest.lastName}`);
    if (found) { setGuest(found); setSearch(''); setWhatsappOverride(null); }
  }, [guest, mode, debouncedSearch, search, newGuest.mobile, newGuest.firstName, newGuest.lastName, guestResults.data]);

  // Debounce the serialised input: a new object every render would never settle.
  const pricingReady = lines.every((l) => (!l.useCustomPrice || validRate(l.manualRate) !== undefined)
    && (!l.gstRate || validRate(l.gstRate) !== undefined && Number(l.gstRate) <= 100)
    && (!hasExtraGuests(l, roomTypes.data ?? []) || !l.manualExtras || validRate(l.manualExtras) !== undefined));
  const estimateJson = useDebounced(JSON.stringify({
    pricingReady,
    reservationId: mode === 'edit' ? initial?.id : undefined, arrival, departure,
    rooms: lines.map((l) => ({ reservationRoomId: l.reservationRoomId, roomTypeId: l.roomTypeId, adults: l.adults, childAges: l.childAges, mealPlan: l.mealPlan, nightlyRate: l.useCustomPrice ? validRate(l.manualRate) : undefined, includesMealPlan: l.useCustomPrice ? true : undefined, gstRate: validRate(l.gstRate) ?? null, extraPersonRate: hasExtraGuests(l, roomTypes.data ?? []) ? validRate(l.manualExtras) : '0' })),
  }));
  const { pricingReady: estimateReady, ...estimateInput } = JSON.parse(estimateJson) as { pricingReady: boolean; reservationId?: string; arrival: string; departure: string; rooms: { roomTypeId: string }[] };
  const estimate = useQuery({
    queryKey: ['booking-estimate', estimateJson],
    enabled: estimateReady && nightsBetween(estimateInput.arrival || '2000-01-01', estimateInput.departure || '2000-01-01') >= 1 && estimateInput.rooms.every((r) => r.roomTypeId),
    placeholderData: (prev) => prev,
    queryFn: () => api<BookingEstimate>('/reservations/estimate', { method: 'POST', body: estimateInput }),
    retry: false,
  });

  useEffect(() => {
    const defaultPricing = roomTypes.data?.[0];
    if (defaultPricing && lines.some((line) => !line.roomTypeId)) {
      setLines((current) => current.map((line) => line.roomTypeId ? line : { ...line, roomTypeId: defaultPricing.id }));
    }
  }, [roomTypes.data, lines]);

  const startNewGuest = () => {
    const digits = search.replace(/\D/g, '');
    setNewGuest((g) => digits.length >= 10 ? { ...g, mobile: search.trim() } : { ...g, firstName: search.trim().split(' ')[0] ?? '', lastName: search.trim().split(' ').slice(1).join(' ') });
    setSearch('');
  };

  const updateLine = (key: string, patch: Partial<RoomLine>) => setLines((ls) => ls.map((l) => {
    if (l.key !== key) return l;
    const next = { ...l, ...patch };
    // Without an assigned room, the hotel-wide guest limit applies. Pick a compatible
    // internal tariff for pricing rather than retaining an invisible category restriction.
    const guests = next.adults + next.childAges.length;
    const profile = roomTypes.data?.find((t) => t.id === next.roomTypeId);
    if (!next.roomId && profile && guests > profile.maxOccupancy) {
      const compatible = roomTypes.data?.find((t) => t.maxOccupancy >= guests);
      if (compatible) next.roomTypeId = compatible.id;
    }
    return hasExtraGuests(next, roomTypes.data ?? []) ? next : { ...next, manualExtras: '0' };
  }));

  // ---------- submit ----------
  const idempotency = useRef<{ key: string; body: string } | null>(null);

  const buildBody = (ownerAuthorisationId?: string) => ({
    guestId: guest?.id,
    guest: guest ? undefined : { ...newGuest, email: newGuest.email || undefined, city: newGuest.city || undefined },
    source, otaReference: OTA_SOURCES.includes(source) ? otaReference || undefined : undefined, arrival, departure, status,
    groupName: lines.length > 1 ? groupName : undefined,
    purpose: purpose || undefined,
    specialRequests: specialRequests || undefined,
    rooms: lines.map((l) => ({
      reservationRoomId: l.reservationRoomId, roomTypeId: l.roomTypeId, roomId: l.roomId || undefined, adults: l.adults,
      childAges: l.childAges, mealPlan: l.mealPlan, nightlyRate: l.useCustomPrice ? validRate(l.manualRate) : undefined, includesMealPlan: l.useCustomPrice ? true : undefined, gstRate: validRate(l.gstRate) ?? null, extraPersonRate: hasExtraGuests(l, roomTypes.data ?? []) ? validRate(l.manualExtras) : '0',
    })),
    ownerAuthorisationId,
    ...(mode === 'edit' ? { version: initial!.version } : {}),
    ...(mode === 'rebook' ? { rebookedFromId: initial!.id } : {}),
    ...(mode !== 'edit' ? { whatsappOptedIn } : {}),
  });

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof buildBody>) => {
      const json = JSON.stringify(body);
      // Same body → same key (safe retry after a dropped connection). Changed body → new key.
      if (!idempotency.current || idempotency.current.body !== json) idempotency.current = { key: newIdempotencyKey(), body: json };
      return mode === 'edit'
        ? api<ReservationDetail>(`/reservations/${initial!.id}`, { method: 'PATCH', body, idempotencyKey: idempotency.current.key })
        : api<ReservationDetail>('/reservations', { method: 'POST', body, idempotencyKey: idempotency.current.key });
    },
    onSuccess: async (res) => {
      await Promise.all(['front-desk', 'reservations', 'reservation', 'rooms', 'availability', 'calendar', 'check-in'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast('success', mode === 'edit' ? `Booking ${res.number} updated` : mode === 'rebook' ? `Rebooked as ${res.number}` : `Booking ${res.number} saved`);
      router.push(`/reservations/${res.id}`);
    },
    onError: (err) => {
      if (approval.handleError(err)) return;
      const e = err as ApiError;
      setErrors(e.fields ?? {});
      setFormError(e);
      if (e.code === 'ROOM_UNAVAILABLE') void qc.invalidateQueries({ queryKey: ['availability'] });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  });
  const approval = useOwnerApproval((authorisationId) => submit(authorisationId));

  function submit(ownerAuthorisationId?: string) {
    setFormError(null);
    const body = buildBody(ownerAuthorisationId);
    const clientErrors: Record<string, string> = {};
    if (!guest) {
      const g = guestSchema.safeParse(body.guest);
      if (!g.success) for (const i of g.error.issues) clientErrors[`guest.${i.path.join('.')}`] ??= i.message;
    }
    const parsed = (mode === 'edit' ? updateReservationSchema : createReservationSchema).safeParse(body);
    if (!parsed.success) for (const i of parsed.error.issues) clientErrors[i.path.join('.')] ??= i.message;
    lines.forEach((line, i) => {
      if (line.useCustomPrice && validRate(line.manualRate) === undefined) clientErrors[`rooms.${i}.nightlyRate`] = 'Enter the agreed nightly price (up to two decimals)';
      if (hasExtraGuests(line, roomTypes.data ?? []) && line.manualExtras && validRate(line.manualExtras) === undefined) clientErrors[`rooms.${i}.extraPersonRate`] = 'Enter a valid price with up to two decimals';
      if (line.gstRate && (validRate(line.gstRate) === undefined || Number(line.gstRate) > 100)) clientErrors[`rooms.${i}.gstRate`] = 'Enter GST between 0 and 100%';
    });
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;
    save.mutate(body);
  }

  const isOta = OTA_SOURCES.includes(source);
  const title = mode === 'edit' ? `Edit ${initial!.number}` : mode === 'rebook' ? `Rebook ${initial!.number}` : walkIn ? 'Walk-in booking' : 'New booking';
  const description = mode === 'edit'
    ? 'Rooms you do not change keep their agreed rates.'
    : mode === 'rebook' ? `Creates a new booking with the same details. ${initial!.number} stays cancelled.` : 'Prices are estimates. The final bill is prepared at checkout.';

  return (
    <div>
      <PageHeader title={title} description={description} />

      <AnimatePresence>
        {formError && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4">
            <ErrorBanner message={formError.message} code={formError.requestId ? formError.code : undefined} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          {/* ---------- Guest ---------- */}
          <Card>
            <CardHeader title="Guest" description="Search first so returning guests are not added twice." />
            <div className="p-5">
              {guest ? (
                <div className="flex items-center gap-3 rounded-lg border border-brand/40 bg-brand-soft/50 p-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-brand-contrast"><UserRound className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 font-medium">{guest.isVip && <Crown className="h-3.5 w-3.5 text-warning" aria-label="VIP" />}{guest.fullName}</p>
                    <p className="text-sm text-text-2 num">{formatMobile(guest.mobile)}{guest.city ? ` · ${guest.city}` : ''}{guest.stays ? ` · ${guest.stays} past stay${guest.stays > 1 ? 's' : ''}` : ''}</p>
                    <p className="mt-1 text-xs text-text-2">Saved guest details loaded. Available saved ID is added during check-in.</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setGuest(null); setNewGuest(g => ({ ...g, mobile: '' })); setWhatsappOverride(null); }}><X className="h-4 w-4" />Change</Button>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" />
                    <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by mobile number or name" className="pl-9" aria-label="Search existing guests" autoFocus />
                  </div>
                  {search.trim().length >= 3 && (
                    <div className="rounded-lg border border-border">
                      {guestResults.isFetching && !guestResults.data ? <div className="p-3"><Skeleton className="h-10" /></div>
                        : guestResults.data?.length ? (
                          <ul className="divide-y divide-border">
                            {guestResults.data.map((g) => (
                              <li key={g.id}>
                                <button onClick={() => { setGuest(g); setSearch(''); setWhatsappOverride(null); }} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2">
                                  <UserRound className="h-4 w-4 text-text-3" />
                                  <span className="flex-1"><span className="font-medium">{g.fullName}</span><span className="ml-2 text-sm text-text-2 num">{formatMobile(g.mobile)}{g.city ? ` · ${g.city}` : ''}</span></span>
                                  {g.stays ? <span className="text-xs text-text-3">{g.stays} stays</span> : null}
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : <p className="px-3 py-2.5 text-sm text-text-3">No guest found.</p>}
                      <button onClick={startNewGuest} className="flex w-full items-center gap-2 border-t border-border px-3 py-2.5 text-sm font-medium text-brand hover:bg-surface-2"><Plus className="h-4 w-4" />Add as new guest</button>
                    </div>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="First name" required error={errors['guest.firstName']}>{(id) => <Input id={id} value={newGuest.firstName} onChange={(e) => setNewGuest({ ...newGuest, firstName: e.target.value })} autoComplete="off" invalid={!!errors['guest.firstName']} />}</Field>
                    <Field label="Last name">{(id) => <Input id={id} value={newGuest.lastName} onChange={(e) => setNewGuest({ ...newGuest, lastName: e.target.value })} autoComplete="off" />}</Field>
                    <Field label="Mobile" required error={errors['guest.mobile']} hint="10-digit Indian mobile, or +country code">{(id, d) => <Input id={id} aria-describedby={d} inputMode="tel" value={newGuest.mobile} onChange={(e) => setNewGuest({ ...newGuest, mobile: e.target.value })} invalid={!!errors['guest.mobile']} />}</Field>
                    <Field label="City">{(id) => <Input id={id} value={newGuest.city} onChange={(e) => setNewGuest({ ...newGuest, city: e.target.value })} />}</Field>
                    <Field label="Email" error={errors['guest.email']}>{(id) => <Input id={id} type="email" inputMode="email" value={newGuest.email} onChange={(e) => setNewGuest({ ...newGuest, email: e.target.value })} />}</Field>
                    <Field label="Messages in">{(id) => (
                      <Select id={id} value={newGuest.preferredLanguage} onChange={(e) => setNewGuest({ ...newGuest, preferredLanguage: e.target.value as 'en' | 'hi' })}>
                        <option value="en">English</option><option value="hi">हिन्दी</option>
                      </Select>)}</Field>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* ---------- Stay ---------- */}
          <Card>
            <CardHeader title="Stay" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="Arrival" required error={errors.arrival} hint={arrival ? formatDate(arrival, { weekday: true }) : undefined}>{(id, d) => (
                <DateField id={id} label="arrival date" aria-describedby={d} value={arrival} min={mode === 'edit' && initial && initial.arrival < (bd ?? '') ? initial.arrival : bd} today={bd}
                  invalid={!!errors.arrival} onChange={(v) => { setArrival(v); if (v && departure && v >= departure) setDeparture(addDays(v, 1)); }} />
              )}</Field>
              <Field label="Departure" required error={errors.departure} hint={datesValid ? `${formatDate(departure, { weekday: true })} · ${nights} night${nights > 1 ? 's' : ''}` : undefined}>{(id, d) => (
                <DateField id={id} label="departure date" aria-describedby={d} value={departure} min={arrival ? addDays(arrival, 1) : bd} max={arrival ? addDays(arrival, 90) : undefined} today={bd}
                  invalid={!!errors.departure} onChange={setDeparture} />
              )}</Field>
              <Field label="Booking source" required>{(id) => (
                <Select id={id} value={source} onChange={(e) => setSource(e.target.value as BookingSource)}>
                  {BOOKING_SOURCES.map((s) => <option key={s} value={s}>{BOOKING_SOURCE_LABELS[s]}</option>)}
                </Select>
              )}</Field>
              {isOta ? (
                <Field label={`${BOOKING_SOURCE_LABELS[source]} booking ID`} required error={errors.otaReference}>{(id) => <Input id={id} value={otaReference} onChange={(e) => setOtaReference(e.target.value)} invalid={!!errors.otaReference} />}</Field>
              ) : (
                <Field label="Booking status">{(id) => (
                  <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                    <option value="confirmed">Confirmed</option>
                    {!(mode === 'edit' && initial?.status === 'confirmed') && <option value="tentative">Tentative (not yet confirmed by guest)</option>}
                  </Select>
                )}</Field>
              )}
            </div>
          </Card>

          {/* ---------- Rooms ---------- */}
          <Card>
            <CardHeader title="Rooms" description={lines.length > 1 ? 'Group booking — all rooms share one master bill.' : undefined}
              action={<Button variant="outline" size="sm" disabled={!roomTypes.data?.length} onClick={() => setLines((ls) => [...ls, newLine(ls[ls.length - 1]?.roomTypeId)])}><Plus className="h-4 w-4" />Add room</Button>} />
            <div className="flex flex-col gap-4 p-5">
              {lines.length > 1 && (
                <Field label="Group name" required error={errors.groupName}>{(id) => <Input id={id} placeholder="e.g. Sharma Wedding" value={groupName} onChange={(e) => setGroupName(e.target.value)} />}</Field>
              )}
              {errors.rooms && <p role="alert" className="text-sm text-danger">{errors.rooms}</p>}
              <AnimatePresence initial={false}>
                {lines.map((line, i) => {
                  const avail = availability.data;
                  const requested = lines.length;
                  const currentRoom = mode === 'edit' ? initial?.rooms.find((r) => r.id === line.reservationRoomId && r.roomId) : undefined;
                  return (
                    <motion.div key={line.key} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.2, ease: EASE_OUT }}>
                      <RoomLineEditor
                        index={i} line={line} canRemove={lines.length > 1} roomTypes={roomTypes.data ?? []}
                        priceError={errors[`rooms.${i}.nightlyRate`]}
                        gstError={errors[`rooms.${i}.gstRate`]} extrasError={errors[`rooms.${i}.extraPersonRate`]}
                        availability={avail} short={!!avail && requested > avail.available}
                        currentRoom={currentRoom ? { id: currentRoom.roomId!, number: currentRoom.roomNumber! } : undefined}
                        takenRoomIds={lines.filter((l) => l.key !== line.key).map((l) => l.roomId).filter(Boolean)}
                        datesValid={datesValid} estimate={estimate.data?.rooms[i]} estimateError={estimate.isError ? (estimate.error as Error).message : null}
                        onChange={(p) => updateLine(line.key, p)} onRemove={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                      />
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              <Field label="Purpose of visit" hint="Used for the guest register and for reports">{(id) => (
                <Select id={id} value={purpose} onChange={(e) => setPurpose(e.target.value as VisitPurpose | '')}>
                  <option value="">Not recorded</option>
                  {VISIT_PURPOSES.map((v) => <option key={v} value={v}>{VISIT_PURPOSE_LABELS[v]}</option>)}
                </Select>
              )}</Field>
              <Field label="Special requests">{(id) => <Textarea id={id} placeholder="Early check-in, extra pillow, anniversary cake…" value={specialRequests} onChange={(e) => setSpecialRequests(e.target.value)} />}</Field>
            </div>
          </Card>
        </div>

        {/* ---------- Summary ---------- */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardHeader title="Summary" />
            <div className="flex flex-col gap-3 p-5 text-sm">
              <Row label="Guest" value={guest?.fullName ?? ([newGuest.firstName, newGuest.lastName].filter(Boolean).join(' ') || '—')} />
              <Row label="Dates" value={datesValid ? `${formatDate(arrival, { year: false })} → ${formatDate(departure, { year: false })}` : '—'} />
              <Row label="Nights" value={datesValid ? String(nights) : '—'} />
              <div className="my-1 border-t border-border" />
              {!pricingReady
                ? <p className="text-text-2">Enter valid room prices, GST and extra-guest charges to calculate the total.</p>
                : estimate.isError ? <ErrorBanner message={(estimate.error as Error).message} />
                  : <EstimateBreakdown estimate={estimate.data} loading={estimate.isFetching} />}
              {mode !== 'edit' && <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
                <p className="font-medium">{status === 'confirmed' ? 'Confirmation sends automatically' : 'Confirmation sends when the booking is confirmed'}</p>
                <p className="mt-1 text-text-2">Email goes to the guest’s email address. {whatsappOptedIn ? 'WhatsApp goes to their mobile number.' : 'WhatsApp is off for this guest.'}</p>
                {whatsappOptedIn && <p className="mt-2 text-text-2">By saving, you confirm the guest agreed to receive booking, stay and payment messages from this hotel on WhatsApp.</p>}
                <details className="mt-2">
                  <summary className="cursor-pointer text-brand">Change WhatsApp preference</summary>
                  <div className="mt-2"><Field label="WhatsApp messages">{(id) => (
                    <Select id={id} value={whatsappOptedIn ? 'agreed' : 'declined'} onChange={e => setWhatsappOverride(e.target.value === 'agreed')}>
                      <option value="agreed">Guest agreed — send automatically</option>
                      <option value="declined">Guest declined — email only</option>
                    </Select>
                  )}</Field></div>
                </details>
              </div>}
              <Button size="lg" className="mt-2 w-full" loading={save.isPending} onClick={() => submit()}>
                <Check className="h-4 w-4" />{mode === 'edit' ? 'Save changes' : mode === 'rebook' ? 'Create new booking' : 'Save booking'}
              </Button>
              {mode !== 'create' && <Button variant="ghost" onClick={() => router.push(`/reservations/${initial!.id}`)}>Cancel</Button>}
            </div>
          </Card>
        </div>
      </div>

      {approval.dialog}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><span className="text-text-2">{label}</span><span className="truncate text-right font-medium num">{value}</span></div>;
}

/** Room / extra guests / meals, then GST and an estimated total — always labelled as an estimate. */
export function EstimateBreakdown({ estimate, loading }: { estimate?: { tax: BookingEstimate['tax'] }; loading?: boolean }) {
  if (loading || !estimate) return <Skeleton className="h-28" />;
  const t = estimate.tax;
  return (
    <div className="flex flex-col gap-2">
      <Row label="Room charges" value={formatINR(t.roomTotal)} />
      {money(t.extrasTotal).gt(0) && <Row label="Extra guests" value={formatINR(t.extrasTotal)} />}
      {money(t.mealTotal).gt(0) && <Row label="Meals in plan" value={formatINR(t.mealTotal)} />}
      <div className="flex justify-between gap-3 border-t border-border pt-2"><span className="text-text-2">Before GST</span><span className="font-medium num">{formatINR(t.taxableTotal)}</span></div>
      {t.available ? (
        <>
          <Row label="GST (estimated)" value={formatINR(t.taxTotal!)} />
          {money(t.roundOff!).abs().gt(0) && <Row label="Round off" value={formatINR(t.roundOff!, { paise: true })} />}
          <div className="mt-1 flex items-baseline justify-between border-t border-border pt-3">
            <span className="font-medium">Estimated total incl. GST</span>
            <span className="text-xl font-semibold num">{formatINR(t.grandTotal!)}</span>
          </div>
        </>
      ) : <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">{t.message}</p>}
      <p className="text-xs text-text-2">Estimate only. The final GST is calculated on the invoice at checkout.{t.usesPlaceholderRates ? ' GST rates are awaiting confirmation by the accountant.' : ''}</p>
    </div>
  );
}

function RoomLineEditor({ index, line, canRemove, roomTypes, availability, short, currentRoom, takenRoomIds, datesValid, estimate, estimateError, priceError, gstError, extrasError, onChange, onRemove }: {
  index: number; line: RoomLine; canRemove: boolean; roomTypes: RoomType[]; availability?: Availability; short: boolean;
  currentRoom?: { id: string; number: string }; takenRoomIds: string[]; datesValid: boolean;
  estimate?: BookingEstimate['rooms'][number]; estimateError: string | null; priceError?: string; gstError?: string; extrasError?: string; onChange: (patch: Partial<RoomLine>) => void; onRemove: () => void;
}) {
  const type = roomTypes.find((t) => t.id === line.roomTypeId);
  const guests = line.adults + line.childAges.length;
  const maxOccupancy = line.roomId ? type?.maxOccupancy : Math.max(1, ...roomTypes.map((t) => t.maxOccupancy));
  const [childAge, setChildAge] = useState('');
  const free = (availability?.rooms ?? []).filter((r) => !takenRoomIds.includes(r.id)).sort((a,b) => a.number.localeCompare(b.number,undefined,{numeric:true}));

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-semibold"><BedDouble className="h-4 w-4 text-text-3" />Room {index + 1}</p>
        {canRemove && <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove room ${index + 1}`}><Trash2 className="h-4 w-4" />Remove</Button>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Room number" className="sm:col-span-2" hint={availability ? `${free.length} ready rooms free for all nights · assign now or later` : datesValid ? 'Checking…' : undefined}
          error={short ? `Only ${availability!.available} rooms free for these dates` : undefined}>{(id, d) => (
          <Select id={id} aria-describedby={d} value={line.roomId} onChange={(e) => {
            const chosen = free.find((r) => r.id === e.target.value);
            onChange({ roomId: e.target.value, ...(chosen ? { roomTypeId: chosen.roomTypeId } : {}) });
          }}>
            <option value="">Assign later</option>
            {currentRoom && !free.some((r) => r.id === currentRoom.id) && <option value={currentRoom.id} disabled>{currentRoom.number} · not ready or no longer free</option>}
            {free.map((r) => <option key={r.id} value={r.id}>{r.number}{r.view ? ` · ${r.view} view` : ''}</option>)}
          </Select>
        )}</Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-2">Adults</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => onChange({ adults: Math.max(1, line.adults - 1) })} aria-label="Fewer adults"><Minus className="h-4 w-4" /></Button>
            <span className="w-10 text-center text-lg font-semibold num" aria-live="polite">{line.adults}</span>
            <Button variant="outline" size="icon" disabled={!!maxOccupancy && guests >= maxOccupancy} onClick={() => onChange({ adults: line.adults + 1 })} aria-label="More adults"><Plus className="h-4 w-4" /></Button>
          </div>
          {type && <span className="text-xs text-text-2">Max {maxOccupancy} guests{!line.useCustomPrice && ` · standard tariff includes ${type.baseOccupancy}`}</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-2">Children (ages)</span>
          <div className="flex flex-wrap items-center gap-2">
            {line.childAges.map((age, i) => (
              <span key={i} className="inline-flex h-9 items-center gap-1 rounded-full bg-surface-2 pl-3 pr-1 text-sm num">
                {age} yr
                <button onClick={() => onChange({ childAges: line.childAges.filter((_, j) => j !== i) })} className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-surface-3" aria-label={`Remove child aged ${age}`}><X className="h-3.5 w-3.5" /></button>
              </span>
            ))}
            {(!maxOccupancy || guests < maxOccupancy) && (
              <form onSubmit={(e) => { e.preventDefault(); const a = Number(childAge); if (childAge !== '' && a >= 0 && a <= 17) { onChange({ childAges: [...line.childAges, a] }); setChildAge(''); } }} className="flex items-center gap-1">
                <Input value={childAge} onChange={(e) => setChildAge(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" placeholder="Age" className="h-9 w-16" aria-label="Child age" />
                <Button type="submit" variant="secondary" size="sm" disabled={childAge === ''}>Add</Button>
              </form>
            )}
          </div>
        </div>
        <Field label="Meal plan">{(id) => (
          <Select id={id} value={line.mealPlan} onChange={(e) => onChange({ mealPlan: e.target.value as MealPlanCode })}>
            {MEAL_PLAN_CODES.map((p) => <option key={p} value={p}>{MEAL_LABEL[p]}</option>)}
          </Select>
        )}</Field>
        <Field label="Room pricing">{(id) => (
          <Select id={id} value={line.useCustomPrice ? 'custom' : 'configured'} onChange={(e) => onChange({ useCustomPrice: e.target.value === 'custom' })}>
            <option value="custom">Enter custom price</option>
            <option value="configured" disabled={!line.reservationRoomId && !line.roomId}>{line.reservationRoomId ? 'Keep agreed price' : 'Use this room’s standard price'}</option>
          </Select>
        )}</Field>
        <div className="grid grid-cols-[2fr_1fr] gap-3 sm:col-span-2">
        {line.useCustomPrice ? <Field label="Room price per night" required error={priceError} hint="Includes the chosen meal plan. GST and extra guests are added separately.">{(id, d) => (
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-2">₹</span>
            <Input id={id} aria-describedby={d} invalid={!!priceError} inputMode="decimal" className="pl-7 num" placeholder="Enter agreed amount" value={line.manualRate}
              onChange={(e) => onChange({ manualRate: e.target.value.replace(/[^\d.]/g, '') })} />
          </div>
        )}</Field> : <p className="self-center text-sm text-text-2">{line.reservationRoomId ? 'Unchanged rooms keep the agreed price.' : 'Using the hotel’s standard tariff.'}</p>}
        <Field label="GST %" error={gstError} hint="Blank = hotel setting">{(id, d) => (
          <Input id={id} aria-describedby={d} invalid={!!gstError} inputMode="decimal" value={line.gstRate} placeholder="Hotel setting" onChange={(e) => onChange({ gstRate: e.target.value.replace(/[^\d.]/g, '') })} />
        )}</Field>
        </div>
        {hasExtraGuests(line, roomTypes) && <Field label="Extra guest price per night" error={extrasError} hint="Total for all extra adults / children. Blank = standard charges; enter 0 to include them at no extra cost.">{(id, d) => (
          <Input id={id} aria-describedby={d} invalid={!!extrasError} inputMode="decimal" value={line.manualExtras}
            onChange={(e) => onChange({ manualExtras: e.target.value.replace(/[^\d.]/g, '') })} placeholder="Use configured prices" />
        )}</Field>}
      </div>
      {line.useCustomPrice && validRate(line.manualRate) === undefined ? <p className="mt-3 text-sm text-text-2">Enter a room price to see the booking total.</p> : datesValid && line.roomTypeId && (
        estimateError ? <p className="mt-3 text-sm text-danger">{estimateError}</p>
          : !estimate ? <Skeleton className="mt-3 h-10" />
            : (
              <div className="mt-4 flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-text-2 num">
                    Room {formatINR(estimate.roomTotal)}{money(estimate.extrasTotal).gt(0) && ` + extra guests ${formatINR(estimate.extrasTotal)}`}{money(estimate.mealTotal).gt(0) && ` + meals ${formatINR(estimate.mealTotal)}`}
                    {estimate.keptAgreedRates && <span className="ml-2 rounded-full bg-info-soft px-2 py-0.5 text-xs text-info">Agreed rates kept</span>}
                    {estimate.labels.length > 0 && <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-xs text-brand">{estimate.labels.join(', ')} rates</span>}
                  </span>
                  <span className="font-semibold num">{formatINR(estimate.total)}</span>
                </div>
                {estimate.belowFloor && <p className="flex items-center gap-1.5 text-warning"><AlertTriangle className="h-4 w-4" />Below the minimum rate of {formatINR(estimate.minRate)} — needs owner authorisation.</p>}
                {estimate.minStayViolated && <p className="flex items-center gap-1.5 text-warning"><AlertTriangle className="h-4 w-4" />Minimum stay for these dates is {estimate.minStay} nights.</p>}
              </div>
            )
      )}
    </div>
  );
}

