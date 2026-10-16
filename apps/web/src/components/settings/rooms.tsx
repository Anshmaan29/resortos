'use client';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { formatINR, money, ROOM_VIEWS, UNIT_TYPES } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import type { RoomType } from '@/lib/types';
import { Row, Section, Toggle, useSave } from './common';

interface SetupRoom { id: string; number: string; roomTypeId: string; unitType: string; view: string | null; building: string | null; floor: string | null; notes: string | null; isActive: boolean; version: number }

/**
 * Room types (with the minimum rate a receptionist may sell at, spec §11.1) and rooms (§9). Neither is
 * ever deleted — a room with history is switched off.
 */
export function RoomsSettings() {
  const types = useQuery({ queryKey: ['room-types', 'all'], queryFn: () => api<RoomType[]>('/room-types', { query: { includeInactive: 'true' } }) });
  const rooms = useQuery({ queryKey: ['rooms-setup'], queryFn: () => api<SetupRoom[]>('/rooms/setup') });
  const [editType, setEditType] = useState<RoomType | null>(null);
  const [editRoom, setEditRoom] = useState<SetupRoom | 'new' | null>(null);
  if (!types.data || !rooms.data) return <Skeleton className="h-96" />;
  const labels = (id: string) => `Rooms ${rooms.data!.filter((r) => r.roomTypeId === id).map((r) => r.number).sort((a,b) => a.localeCompare(b,undefined,{numeric:true})).join(', ') || 'not assigned'}`;
  const prices = types.data.map((t) => ({ ...t, name: labels(t.id) }));
  return (
    <div className="flex flex-col gap-5">
      <Section title="Standard prices and occupancy" description="Existing defaults are kept for these room numbers. Reception can enter the agreed price on each booking. Editing a row changes defaults for all rooms listed in that row.">
        {prices.filter((t) => rooms.data.some((r) => r.roomTypeId === t.id)).map((t) => (
          <Row key={t.id} muted={!t.isActive}>
            <span><span className="font-medium">{t.name}</span> <span className="text-text-3">{t.baseOccupancy}–{t.maxOccupancy} guests</span>{!t.isActive && <span className="ml-2"><Pill>Off</Pill></span>}</span>
            <span className="flex items-center gap-4">
              <span className="tabular-nums">{formatINR(t.baseRate)} <span className="text-xs text-text-3">min {formatINR(t.minRate)}</span></span>
              <Button size="sm" variant="ghost" onClick={() => setEditType(types.data.find((x) => x.id === t.id)!)}>Edit</Button>
            </span>
          </Row>
        ))}
      </Section>
      <Section title="Rooms" description="A room with bookings is switched off, never deleted."
        action={<Button size="sm" onClick={() => setEditRoom('new')} disabled={!types.data.length}><Plus className="h-4 w-4" aria-hidden />Add room</Button>}>
        {rooms.data.map((r) => (
          <Row key={r.id} muted={!r.isActive}>
            <span><span className="font-medium">Room {r.number}</span> <span className="text-text-3">{r.unitType}{r.view ? ` · ${r.view} view` : ''}{r.building ? ` · ${r.building}` : ''}</span>{!r.isActive && <span className="ml-2"><Pill>Off</Pill></span>}</span>
            <Button size="sm" variant="ghost" onClick={() => setEditRoom(r)}>Edit</Button>
          </Row>
        ))}
      </Section>
      {editType && <RoomTypeDialog type={editType} label={labels(editType.id)} onClose={() => setEditType(null)} />}
      {editRoom && <RoomDialog room={editRoom === 'new' ? null : editRoom} types={prices.filter((t) => t.isActive)} onClose={() => setEditRoom(null)} />}
    </div>
  );
}

function RoomTypeDialog({ type, label, onClose }: { type: RoomType; label: string; onClose: () => void }) {
  const [f, setF] = useState({
    name: type?.name ?? 'Room', code: type?.code ?? '', baseOccupancy: String(type?.baseOccupancy ?? 2), maxOccupancy: String(type?.maxOccupancy ?? 3),
    baseRate: type?.baseRate ?? '', minRate: type?.minRate ?? '', extraAdultRate: type?.extraAdultRate ?? '0', extraChildRate: type?.extraChildRate ?? '0',
    isActive: type?.isActive ?? true,
  });
  const body = { ...f, description: type.description ?? undefined, baseOccupancy: Number(f.baseOccupancy), maxOccupancy: Number(f.maxOccupancy) };
  const save = useSave(() => api(`/room-types/${type.id}`, { method: 'PATCH', body: { ...body, version: type.version } }),
    { invalidate: [['room-types']], success: 'Standard prices saved', onDone: onClose });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const belowMin = f.baseRate && f.minRate && money(f.baseRate).lt(f.minRate);
  return (
    <Dialog open onClose={onClose} size="lg" title={`Standard prices · ${label}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={Boolean(belowMin)} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {save.error && <div className="sm:col-span-2"><ErrorBanner message={(save.error as Error).message} /></div>}
        <Field label="Guests included in the rate" required>{(id) => <Input id={id} inputMode="numeric" value={f.baseOccupancy} onChange={set('baseOccupancy')} />}</Field>
        <Field label="Most guests" required error={save.fields.maxOccupancy}>{(id) => <Input id={id} inputMode="numeric" value={f.maxOccupancy} onChange={set('maxOccupancy')} />}</Field>
        <Field label="Room rate per night" required error={save.fields.baseRate}>{(id) => <Input id={id} inputMode="decimal" value={f.baseRate} onChange={set('baseRate')} />}</Field>
        <Field label="Minimum rate" required hint="Below this needs Owner PIN. Set 0 to allow any manually entered price." error={belowMin ? 'The room rate cannot be below the minimum' : save.fields.minRate}>{(id) => <Input id={id} inputMode="decimal" value={f.minRate} onChange={set('minRate')} />}</Field>
        <Field label="Extra adult per night">{(id) => <Input id={id} inputMode="decimal" value={f.extraAdultRate} onChange={set('extraAdultRate')} />}</Field>
        <Field label="Extra child per night">{(id) => <Input id={id} inputMode="decimal" value={f.extraChildRate} onChange={set('extraChildRate')} />}</Field>
      </div>
    </Dialog>
  );
}

function RoomDialog({ room, types, onClose }: { room: SetupRoom | null; types: RoomType[]; onClose: () => void }) {
  const [f, setF] = useState({
    number: room?.number ?? '', roomTypeId: room?.roomTypeId ?? types[0]?.id ?? '', unitType: room?.unitType ?? 'room', view: room?.view ?? '',
    building: room?.building ?? '', floor: room?.floor ?? '', notes: room?.notes ?? '', isActive: room?.isActive ?? true,
  });
  const body = { ...f, view: f.view || undefined };
  const save = useSave(() => (room
    ? api(`/rooms/${room.id}`, { method: 'PATCH', body: { ...body, version: room.version } })
    : api('/rooms', { method: 'POST', body })), { invalidate: [['rooms-setup'], ['rooms']], success: 'Room saved', onDone: onClose });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onClose={onClose} size="lg" title={room ? `Edit room ${room.number}` : 'Add room'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!f.number.trim()} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {save.error && <div className="sm:col-span-2"><ErrorBanner message={(save.error as Error).message} /></div>}
        <Field label="Room number" required error={save.fields.number}>{(id) => <Input id={id} value={f.number} onChange={set('number')} maxLength={10} />}</Field>
        {!room && <Field label="Copy standard prices from" required>{(id) => <Select id={id} value={f.roomTypeId} onChange={set('roomTypeId')}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>}
        <Field label="Kind">{(id) => <Select id={id} value={f.unitType} onChange={set('unitType')}>{UNIT_TYPES.map((u) => <option key={u} value={u}>{u}</option>)}</Select>}</Field>
        <Field label="View">{(id) => <Select id={id} value={f.view} onChange={set('view')}><option value="">—</option>{ROOM_VIEWS.map((v) => <option key={v} value={v}>{v}</option>)}</Select>}</Field>
        <Field label="Building / block">{(id) => <Input id={id} value={f.building} onChange={set('building')} maxLength={40} />}</Field>
        <Field label="Floor">{(id) => <Input id={id} value={f.floor} onChange={set('floor')} maxLength={10} />}</Field>
        <Field label="Notes" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={f.notes} onChange={set('notes')} maxLength={500} />}</Field>
        {room && <Toggle label="In use" hint="A switched-off room cannot be booked; its history stays" checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />}
      </div>
    </Dialog>
  );
}
