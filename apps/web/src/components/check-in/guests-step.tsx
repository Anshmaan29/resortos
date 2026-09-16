'use client';
import { Car, Crown, Plus, Trash2, UserRound } from 'lucide-react';
import { normalizeVehicleNumber, isValidIndianVehicleNumber } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Card, CardHeader } from '@/components/ui/surface';
import type { CheckInDraft, Occupant, Vehicle } from './types';

const COUNTRIES: [string, string][] = [['IN', 'India'], ['US', 'United States'], ['GB', 'United Kingdom'], ['AE', 'United Arab Emirates'], ['DE', 'Germany'], ['FR', 'France'], ['AU', 'Australia'], ['CA', 'Canada'], ['NP', 'Nepal'], ['LK', 'Sri Lanka'], ['BD', 'Bangladesh'], ['SG', 'Singapore'], ['OTHER', 'Other…']];

export function GuestsStep({ draft, data, onChange }: { draft: CheckInDraft; data: CheckInDraft['data']; onChange: (d: CheckInDraft['data']) => void }) {
  const setRoom = (i: number, patch: Partial<CheckInDraft['data']['rooms'][number]>) =>
    onChange({ ...data, rooms: data.rooms.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  return (
    <div className="flex flex-col gap-6">
      {data.rooms.map((room, i) => {
        const info = draft.reservation.rooms.find((r) => r.reservationRoomId === room.reservationRoomId)!;
        const setOccupant = (k: number, patch: Partial<Occupant>) => {
          const occupants = room.occupants.map((o, j) => (j === k ? { ...o, ...patch } : patch.isPrimary ? { ...o, isPrimary: false } : o));
          setRoom(i, { occupants });
        };
        return (
          <Card key={room.reservationRoomId}>
            <CardHeader title={data.rooms.length > 1 ? `Room ${i + 1} · ${info.roomTypeName}` : 'Guests staying'}
              description={`${info.adults} adult${info.adults > 1 ? 's' : ''}${info.childAges.length ? ` and ${info.childAges.length} child${info.childAges.length > 1 ? 'ren' : ''}` : ''} on this booking. Names as on their ID.`} />
            <div className="flex flex-col gap-4 p-5">
              {room.occupants.map((o, k) => (
                <div key={o.key} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-[1fr_auto]">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={o.isChild ? `Child ${room.occupants.filter((x) => x.isChild).indexOf(o) + 1} name` : `Adult ${room.occupants.filter((x) => !x.isChild).indexOf(o) + 1} name`} required>
                      {(id) => <Input id={id} value={o.fullName} autoComplete="off" onChange={(e) => setOccupant(k, { fullName: e.target.value })} />}
                    </Field>
                    {o.isChild ? (
                      <Field label="Age" required>{(id) => <Input id={id} inputMode="numeric" value={o.age ?? ''} onChange={(e) => setOccupant(k, { age: e.target.value === '' ? undefined : Math.min(17, Number(e.target.value.replace(/\D/g, ''))) })} />}</Field>
                    ) : (
                      <Field label="Relation to primary guest">{(id) => <Input id={id} placeholder="e.g. Spouse, Friend" value={o.relation ?? ''} onChange={(e) => setOccupant(k, { relation: e.target.value })} />}</Field>
                    )}
                    <Field label="Nationality" hint={o.nationality !== 'IN' ? 'Foreign nationals need Form C within 24 hours' : undefined}>{(id, d) => (
                      <Select id={id} aria-describedby={d} value={COUNTRIES.some(([c]) => c === o.nationality) ? o.nationality : 'OTHER'}
                        onChange={(e) => e.target.value !== 'OTHER' && setOccupant(k, { nationality: e.target.value })}>
                        {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                      </Select>
                    )}</Field>
                    {!COUNTRIES.some(([c]) => c === o.nationality && c !== 'OTHER') && (
                      <Field label="Country code (2 letters)">{(id) => <Input id={id} maxLength={2} value={o.nationality === 'OTHER' ? '' : o.nationality} onChange={(e) => setOccupant(k, { nationality: e.target.value.toUpperCase() })} />}</Field>
                    )}
                  </div>
                  {!o.isChild && (
                    <label className="flex h-11 items-center gap-2 self-end rounded-md px-2 text-sm font-medium">
                      <input type="radio" name={`primary-${i}`} className="h-5 w-5 accent-[var(--brand)]" checked={o.isPrimary} onChange={() => setOccupant(k, { isPrimary: true })} />
                      {o.isPrimary ? <span className="flex items-center gap-1 text-brand"><Crown className="h-4 w-4" />Primary</span> : 'Primary'}
                    </label>
                  )}
                </div>
              ))}

              <div className="flex flex-col gap-3 border-t border-border pt-4">
                <p className="flex items-center gap-2 text-sm font-medium"><Car className="h-4 w-4 text-text-2" />Vehicles</p>
                {room.vehicles.map((v, k) => (
                  <VehicleRow key={k} vehicle={v}
                    onChange={(patch) => setRoom(i, { vehicles: room.vehicles.map((x, j) => (j === k ? { ...x, ...patch } : x)) })}
                    onRemove={() => setRoom(i, { vehicles: room.vehicles.filter((_, j) => j !== k) })} />
                ))}
                <div><Button variant="outline" size="sm" onClick={() => setRoom(i, { vehicles: [...room.vehicles, { registration: '', vehicleType: 'car', nonStandard: false }] })}><Plus className="h-4 w-4" />Add vehicle</Button></div>
              </div>
            </div>
          </Card>
        );
      })}
      <p className="flex items-center gap-2 text-sm text-text-2"><UserRound className="h-4 w-4" />To change the number of guests, edit the booking first.</p>
    </div>
  );
}

function VehicleRow({ vehicle, onChange, onRemove }: { vehicle: Vehicle; onChange: (p: Partial<Vehicle>) => void; onRemove: () => void }) {
  const invalid = vehicle.registration.length >= 4 && !vehicle.nonStandard && !isValidIndianVehicleNumber(vehicle.registration);
  return (
    <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_140px_120px_auto]">
      <Field label="Registration number" error={invalid ? 'Looks wrong (e.g. RJ14CX1234) — tick "Other format" if correct' : undefined}>
        {(id) => <Input id={id} className="uppercase num" value={vehicle.registration} onChange={(e) => onChange({ registration: normalizeVehicleNumber(e.target.value) })} invalid={invalid} />}
      </Field>
      <Field label="Type">{(id) => (
        <Select id={id} value={vehicle.vehicleType} onChange={(e) => onChange({ vehicleType: e.target.value as Vehicle['vehicleType'] })}>
          <option value="car">Car</option><option value="bike">Bike</option><option value="bus">Bus</option><option value="other">Other</option>
        </Select>
      )}</Field>
      <Field label="Parking slot">{(id) => <Input id={id} value={vehicle.parkingSlot ?? ''} onChange={(e) => onChange({ parkingSlot: e.target.value })} />}</Field>
      <div className="flex items-end gap-2">
        <label className="flex h-11 items-center gap-2 text-xs"><input type="checkbox" checked={vehicle.nonStandard} onChange={(e) => onChange({ nonStandard: e.target.checked })} />Other format</label>
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Remove vehicle"><Trash2 className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}
