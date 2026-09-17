'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, CircleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatDate, formatINR, MEAL_PLAN_LABELS } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { useOwnerApproval } from '@/components/ui/owner-pin';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import type { Availability, Quote, StayDetail } from '@/lib/types';

const REASONS = [
  'Air conditioning not working',
  'Hot water not working',
  'Room too noisy',
  'Guest asked for a different view',
  'Guest asked for a higher floor',
  'Maintenance needed in this room',
  'Upgrade offered to the guest',
];

/**
 * Room shift (spec §21). The screen shows what is free and lets the receptionist choose what
 * happens to the rate; the server decides whether the room is really available (exclusion
 * constraint) and whether the new rate needs the Owner PIN.
 */
export function RoomShiftDialog({ stay, open, onClose, onDone }: {
  stay: StayDetail; open: boolean; onClose: () => void; onDone: (message: string) => void;
}) {
  const toast = useToast();
  const [toRoomId, setToRoomId] = useState('');
  const [reason, setReason] = useState(REASONS[0]!);
  const [note, setNote] = useState('');
  const [rateDecision, setRateDecision] = useState<'keep_rate' | 'new_room_type_rate'>('keep_rate');
  const [formError, setFormError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  // Free for the rest of the stay, from today onwards — the same window the server will check.
  const avail = useQuery({
    queryKey: ['availability', stay.businessDate, stay.expectedDeparture],
    enabled: open,
    queryFn: () => api<Availability>('/availability', { query: { arrival: stay.businessDate, departure: stay.expectedDeparture } }),
  });

  const rooms = (avail.data?.roomTypes ?? []).flatMap((t) =>
    t.freeRooms.filter((r) => r.id !== stay.roomId).map((r) => ({ ...r, roomTypeId: t.roomTypeId, roomTypeName: t.roomTypeName })));
  const chosen = rooms.find((r) => r.id === toRoomId);
  const typeChanges = !!chosen && chosen.roomTypeId !== stay.roomTypeId;

  // What the new room type would cost, so "new room type rate" is not a blind choice.
  const quote = useQuery({
    queryKey: ['rates/quote', chosen?.roomTypeId, stay.businessDate, stay.expectedDeparture, stay.adults, stay.mealPlan],
    enabled: open && typeChanges,
    queryFn: () => api<Quote>('/rates/quote', {
      query: {
        roomTypeId: chosen!.roomTypeId, arrival: stay.businessDate, departure: stay.expectedDeparture,
        adults: stay.adults, childAges: stay.childAges.join(',') || undefined, mealPlan: stay.mealPlan,
      },
    }),
  });

  const shift = useMutation({
    mutationFn: (ownerAuthorisationId?: string) => api<StayDetail>(`/stays/${stay.id}/shift-room`, {
      method: 'POST',
      idempotencyKey: key.current,
      body: { toRoomId, reason: note.trim() ? `${reason} — ${note.trim()}` : reason, rateDecision, ownerAuthorisationId },
    }),
    onSuccess: (updated) => {
      key.current = newIdempotencyKey();
      setFormError(null);
      onDone(`Guest moved to room ${updated.roomNumber}`);
    },
    onError: (err) => {
      if (approval.handleError(err)) return;
      setFormError((err as Error).message);
      // A refused room means someone else took it: show the message and refresh what is free.
      if (err instanceof ApiError && err.code === 'ROOM_UNAVAILABLE') { setToRoomId(''); void avail.refetch(); }
      toast('error', (err as Error).message);
    },
  });
  const approval = useOwnerApproval((authorisationId) => shift.mutate(authorisationId));

  const nights = Math.max(1, Math.round((Date.parse(stay.expectedDeparture) - Date.parse(stay.businessDate)) / 86_400_000));

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={`Move ${stay.guestName} out of room ${stay.roomNumber}`}
        size="lg"
        description={`The bill stays the same and both rooms are kept in the stay's history. Room ${stay.roomNumber} becomes dirty for housekeeping.`}
        footer={<>
          <Button variant="outline" onClick={onClose}>Keep room {stay.roomNumber}</Button>
          <Button disabled={!toRoomId} loading={shift.isPending} onClick={() => { setFormError(null); shift.mutate(undefined); }}>
            Move to room {chosen?.number ?? '…'}
          </Button>
        </>}
      >
        <div className="flex flex-col gap-4">
          <Field label="New room" required hint={avail.isLoading ? 'Checking what is free…' : `Free for all ${nights} remaining night${nights > 1 ? 's' : ''}`}>
            {(id) => (
              <Select id={id} value={toRoomId} onChange={(e) => setToRoomId(e.target.value)} disabled={avail.isLoading}>
                <option value="" disabled>{avail.isLoading ? 'Loading…' : rooms.length ? 'Choose a room' : 'No other room is free for these dates'}</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.number} · {r.roomTypeName}{r.view ? ` · ${r.view}` : ''}{r.housekeeping === 'dirty' || r.housekeeping === 'cleaning' ? ` · ${r.housekeeping}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {chosen && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm">
              <span className="num font-medium">{stay.roomNumber}</span>
              <span className="text-text-3">{stay.roomTypeName}</span>
              <ArrowRight className="h-4 w-4 text-text-3" aria-hidden />
              <span className="num font-medium">{chosen.number}</span>
              <span className="text-text-3">{chosen.roomTypeName}</span>
              <span className="ml-auto text-text-3">{formatDate(stay.businessDate, { year: false })} → {formatDate(stay.expectedDeparture, { year: false })}</span>
            </div>
          )}

          <Field label="Reason" required hint="Shown in the stay's history and the audit log">
            {(id) => (
              <Select id={id} value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Note">{(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional detail" />}</Field>

          {typeChanges && (
            <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium text-text-2">Room rate</legend>
              <p className="text-sm text-text-3">
                {chosen!.roomTypeName} is a different room type. Current rate {formatINR(stay.nightlyRate)} per night ({MEAL_PLAN_LABELS[stay.mealPlan]}).
              </p>
              {(['keep_rate', 'new_room_type_rate'] as const).map((value) => (
                <label key={value} className="flex items-start gap-2.5 text-sm">
                  <input type="radio" name="rateDecision" className="mt-1" checked={rateDecision === value} onChange={() => setRateDecision(value)} />
                  <span>
                    <span className="font-medium">{value === 'keep_rate' ? `Keep ${formatINR(stay.nightlyRate)} per night` : 'Use the new room type’s rate'}</span>
                    {value === 'new_room_type_rate' && (
                      <span className="block text-text-3">
                        {quote.isLoading ? 'Working out the rate…'
                          : quote.data ? `${formatINR(quote.data.averageRoomRate)} per night for the remaining nights${quote.data.belowFloor ? ' — below the minimum, so it needs the Owner PIN' : ''}`
                            : 'Rate will be worked out from the rate plan'}
                      </span>
                    )}
                  </span>
                </label>
              ))}
              {rateDecision === 'new_room_type_rate' && quote.data?.belowFloor && (
                <p className="flex items-start gap-2 text-sm text-warning">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  The owner will be asked for their PIN on this screen.
                </p>
              )}
            </fieldset>
          )}

          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
        </div>
      </Dialog>
      {approval.dialog}
    </>
  );
}
