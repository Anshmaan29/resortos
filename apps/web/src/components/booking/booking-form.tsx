'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, BedDouble, Check, Crown, Minus, Plus, Search, Trash2, UserRound, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  addDays, BOOKING_SOURCE_LABELS, BOOKING_SOURCES, createReservationSchema, formatDate, formatINR, formatMobile, guestSchema,
  money, nightsBetween, OTA_SOURCES, updateReservationSchema, VISIT_PURPOSE_LABELS, VISIT_PURPOSES,
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
  manualExtras: string;
}

type GuestChoice = Pick<Guest, 'id' | 'fullName' | 'mobile' | 'city' | 'isVip'> & { stays?: number };

const newLine = (roomTypeId = ''): RoomLine => ({ key: crypto.randomUUID(), roomTypeId, roomId: '', adults: 2, childAges: [], mealPlan: 'EP', manualRate: '', manualExtras: '' });
const validRate = (v: string) => (/^\d+(\.\d{1,2})?$/.test(v) ? v : undefined);

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
        roomId: mode === 'edit' ? r.roomId ?? '' : '', adults: r.adults, childAges: r.childAges, mealPlan: mode === 'edit' ? r.mealPlan : 'EP', manualRate: '', manualExtras: '',
      }))
    : [newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<ApiError | null>(null);

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
    queryKey: ['availability', arrival, departure], enabled: datesValid,
    queryFn: () => api<Availability>('/availability', { query: { arrival, departure } }),
  });
  const debouncedSearch = useDebounced(search, 250);
  const guestResults = useQuery({
    queryKey: ['guest-search', debouncedSearch], enabled: !guest && debouncedSearch.trim().length >= 3,
    queryFn: () => api<Guest[]>('/guests', { query: { q: debouncedSearch } }),
  });

  // Debounce the serialised input: a new object every render would never settle.
  const estimateJson = useDebounced(JSON.stringify({
    reservationId: mode === 'edit' ? initial?.id : undefined, arrival, departure,
    rooms: lines.map((l) => ({ reservationRoomId: l.reservationRoomId, roomTypeId: l.roomTypeId, adults: l.adults, childAges: l.childAges, mealPlan: l.mealPlan, nightlyRate: validRate(l.manualRate), extraPersonRate: validRate(l.manualExtras) })),
  }));
  const estimateInput = JSON.parse(estimateJson) as { reservationId?: string; arrival: string; departure: string; rooms: { roomTypeId: string }[] };
  const estimate = useQuery({
    queryKey: ['booking-estimate', estimateJson],
    enabled: nightsBetween(estimateInput.arrival || '2000-01-01', estimateInput.departure || '2000-01-01') >= 1 && estimateInput.rooms.every((r) => r.roomTypeId),
    placeholderData: (prev) => prev,
    queryFn: () => api<BookingEstimate>('/reservations/estimate', { method: 'POST', body: estimateInput }),
    retry: false,
  });

  useEffect(() => {
    if (roomTypes.data?.[0] && lines.length === 1 && !lines[0]!.roomTypeId) setLines([{ ...lines[0]!, roomTypeId: roomTypes.data[0].id }]);
  }, [roomTypes.data, lines]);

  const startNewGuest = () => {
    const digits = search.replace(/\D/g, '');
    setNewGuest((g) => digits.length >= 10 ? { ...g, mobile: search.trim() } : { ...g, firstName: search.trim().split(' ')[0] ?? '', lastName: search.trim().split(' ').slice(1).join(' ') });
    setSearch('');
  };

  const availabilityFor = (roomTypeId: string) => availability.data?.roomTypes.find((t) => t.roomTypeId === roomTypeId);
  /** Rooms this booking already holds of a type on overlapping dates — not a shortage when editing. */
  const ownOfType = (roomTypeId: string) => (mode === 'edit' && initial && arrival < initial.departure && departure > initial.arrival
    ? initial.rooms.filter((r) => r.status === 'reserved' && r.roomTypeId === roomTypeId).length : 0);
  const updateLine = (key: string, patch: Partial<RoomLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

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
      childAges: l.childAges, mealPlan: l.mealPlan, nightlyRate: validRate(l.manualRate), extraPersonRate: validRate(l.manualExtras),
    })),
    ownerAuthorisationId,
    ...(mode === 'edit' ? { version: initial!.version } : {}),
    ...(mode === 'rebook' ? { rebookedFromId: initial!.id } : {}),
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
      await Promise.all(['front-desk', 'reservations', 'reservation', 'rooms', 'availability', 'calendar'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
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
      if (line.manualRate && validRate(line.manualRate) === undefined) clientErrors[`rooms.${i}.nightlyRate`] = 'Enter a valid price with up to two decimals';
      if (line.manualExtras && validRate(line.manualExtras) === undefined) clientErrors[`rooms.${i}.extraPersonRate`] = 'Enter a valid price with up to two decimals';
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
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setGuest(null)}><X className="h-4 w-4" />Change</Button>
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
                                <button onClick={() => { setGuest(g); setSearch(''); }} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2">
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
              action={<Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, newLine(ls[ls.length - 1]?.roomTypeId)])}><Plus className="h-4 w-4" />Add room</Button>} />
            <div className="flex flex-col gap-4 p-5">
              {lines.length > 1 && (
                <Field label="Group name" required error={errors.groupName}>{(id) => <Input id={id} placeholder="e.g. Sharma Wedding" value={groupName} onChange={(e) => setGroupName(e.target.value)} />}</Field>
              )}
              {errors.rooms && <p role="alert" className="text-sm text-danger">{errors.rooms}</p>}
              <AnimatePresence initial={false}>
                {lines.map((line, i) => {
                  const avail = availabilityFor(line.roomTypeId);
                  const requested = lines.filter((l) => l.roomTypeId === line.roomTypeId).length - ownOfType(line.roomTypeId);
                  const currentRoom = mode === 'edit' ? initial?.rooms.find((r) => r.id === line.reservationRoomId && r.roomTypeId === line.roomTypeId && r.roomId) : undefined;
                  return (
                    <motion.div key={line.key} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.2, ease: EASE_OUT }}>
                      <RoomLineEditor
                        index={i} line={line} canRemove={lines.length > 1} roomTypes={roomTypes.data ?? []}
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
              <EstimateBreakdown estimate={estimate.data} loading={estimate.isFetching && !estimate.data} />
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

function RoomLineEditor({ index, line, canRemove, roomTypes, availability, short, currentRoom, takenRoomIds, datesValid, estimate, estimateError, onChange, onRemove }: {
  index: number; line: RoomLine; canRemove: boolean; roomTypes: RoomType[]; availability?: Availability['roomTypes'][number]; short: boolean;
  currentRoom?: { id: string; number: string }; takenRoomIds: string[]; datesValid: boolean;
  estimate?: BookingEstimate['rooms'][number]; estimateError: string | null; onChange: (patch: Partial<RoomLine>) => void; onRemove: () => void;
}) {
  const type = roomTypes.find((t) => t.id === line.roomTypeId);
  const guests = line.adults + line.childAges.length;
  const [childAge, setChildAge] = useState('');
  const free = (availability?.freeRooms ?? []).filter((r) => !takenRoomIds.includes(r.id));

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-semibold"><BedDouble className="h-4 w-4 text-text-3" />Room {index + 1}</p>
        {canRemove && <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove room ${index + 1}`}><Trash2 className="h-4 w-4" />Remove</Button>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Room type">{(id) => (
          <Select id={id} value={line.roomTypeId} onChange={(e) => onChange({ roomTypeId: e.target.value, roomId: '' })}>
            {roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name} · from {formatINR(t.baseRate)}</option>)}
          </Select>
        )}</Field>
        <Field label="Room number" hint={availability ? `${availability.available} ${type?.name ?? ''} free for all nights` : datesValid ? 'Checking…' : undefined}
          error={short ? `Only ${availability!.available} free for these dates` : undefined}>{(id, d) => (
          <Select id={id} aria-describedby={d} value={line.roomId} onChange={(e) => onChange({ roomId: e.target.value })}>
            <option value="">Assign later</option>
            {currentRoom && !free.some((r) => r.id === currentRoom.id) && <option value={currentRoom.id}>{currentRoom.number} · current room</option>}
            {free.map((r) => <option key={r.id} value={r.id}>{r.number}{r.view ? ` · ${r.view} view` : ''}{r.housekeeping === 'dirty' ? ' · needs cleaning' : ''}</option>)}
          </Select>
        )}</Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-2">Adults</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => onChange({ adults: Math.max(1, line.adults - 1) })} aria-label="Fewer adults"><Minus className="h-4 w-4" /></Button>
            <span className="w-10 text-center text-lg font-semibold num" aria-live="polite">{line.adults}</span>
            <Button variant="outline" size="icon" disabled={!!type && guests >= type.maxOccupancy} onClick={() => onChange({ adults: line.adults + 1 })} aria-label="More adults"><Plus className="h-4 w-4" /></Button>
          </div>
          {type && <span className="text-xs text-text-2">Max {type.maxOccupancy} guests · {type.baseOccupancy} included in rate</span>}
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
            {(!type || guests < type.maxOccupancy) && (
              <form onSubmit={(e) => { e.preventDefault(); const a = Number(childAge); if (childAge !== '' && a >= 0 && a <= 17) { onChange({ childAges: [...line.childAges, a] }); setChildAge(''); } }} className="flex items-center gap-1">
                <Input value={childAge} onChange={(e) => setChildAge(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" placeholder="Age" className="h-9 w-16" aria-label="Child age" />
                <Button type="submit" variant="secondary" size="sm" disabled={childAge === ''}>Add</Button>
              </form>
            )}
          </div>
        </div>
        {line.mealPlan !== 'EP' && <p className="text-sm text-text-3">Existing booking includes {MEAL_LABEL[line.mealPlan]}. Its agreed meal charges are kept.</p>}
        <Field label="Base room price per night" hint={line.reservationRoomId ? 'Leave empty to keep the agreed room price. Extra guest charges are added below.' : 'Leave empty for the configured room price. Extra guest charges are added below.'}>{(id, d) => (
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-2">₹</span>
            <Input id={id} aria-describedby={d} inputMode="decimal" className="pl-7 num" placeholder={type ? money(type.baseRate).toFixed(0) : ''} value={line.manualRate}
              onChange={(e) => onChange({ manualRate: e.target.value.replace(/[^\d.]/g, '') })} />
          </div>
        )}</Field>
        <Field label="Extra adult / child charges per night" hint="Total for all extra guests. Leave empty for configured prices; enter 0 to waive. Add extra beds separately on the bill.">{(id, d) => (
          <Input id={id} aria-describedby={d} inputMode="decimal" value={line.manualExtras}
            onChange={(e) => onChange({ manualExtras: e.target.value.replace(/[^\d.]/g, '') })} placeholder="Use configured prices" />
        )}</Field>
      </div>
      {datesValid && line.roomTypeId && (
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

