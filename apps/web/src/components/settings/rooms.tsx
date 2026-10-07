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
  const [editType, setEditType] = useState<RoomType | 'new' | null>(null);
  const [editRoom, setEditRoom] = useState<SetupRoom | 'new' | null>(null);
  if (!types.data || !rooms.data) return <Skeleton className="h-96" />;
  const typeName = (id: string) => types.data!.find((t) => t.id === id)?.name ?? '—';
  return (
    <div className="flex flex-col gap-5">
      <Section title="Room types" description="Selling below the minimum rate needs the owner’s PIN."
        action={<Button size="sm" onClick={() => setEditType('new')}><Plus className="h-4 w-4" aria-hidden />Add room type</Button>}>
        {types.data.map((t) => (
          <Row key={t.id} muted={!t.isActive}>
            <span><span className="font-medium">{t.name}</span> <span className="text-text-3">{t.code} · {t.baseOccupancy}–{t.maxOccupancy} guests</span>{!t.isActive && <span className="ml-2"><Pill>Off</Pill></span>}</span>
            <span className="flex items-center gap-4">
              <span className="tabular-nums">{formatINR(t.baseRate)} <span className="text-xs text-text-3">min {formatINR(t.minRate)}</span></span>
              <Button size="sm" variant="ghost" onClick={() => setEditType(t)}>Edit</Button>
            </span>
          </Row>
        ))}
      </Section>
      <Section title="Rooms" description="A room with bookings is switched off, never deleted."
        action={<Button size="sm" onClick={() => setEditRoom('new')} disabled={!types.data.length}><Plus className="h-4 w-4" aria-hidden />Add room</Button>}>
        {rooms.data.map((r) => (
          <Row key={r.id} muted={!r.isActive}>
            <span><span className="font-medium">Room {r.number}</span> <span className="text-text-3">{typeName(r.roomTypeId)} · {r.unitType}{r.view ? ` · ${r.view} view` : ''}{r.building ? ` · ${r.building}` : ''}</span>{!r.isActive && <span className="ml-2"><Pill>Off</Pill></span>}</span>
            <Button size="sm" variant="ghost" onClick={() => setEditRoom(r)}>Edit</Button>
          </Row>
        ))}
      </Section>
      {editType && <RoomTypeDialog type={editType === 'new' ? null : editType} onClose={() => setEditType(null)} />}
      {editRoom && <RoomDialog room={editRoom === 'new' ? null : editRoom} types={types.data.filter((t) => t.isActive)} onClose={() => setEditRoom(null)} />}
    </div>
  );
}

function RoomTypeDialog({ type, onClose }: { type: RoomType | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: type?.name ?? '', code: type?.code ?? '', baseOccupancy: String(type?.baseOccupancy ?? 2), maxOccupancy: String(type?.maxOccupancy ?? 3),
    baseRate: type?.baseRate ?? '', minRate: type?.minRate ?? '', extraAdultRate: type?.extraAdultRate ?? '0', extraChildRate: type?.extraChildRate ?? '0',
    isActive: type?.isActive ?? true,
  });
  const body = { ...f, baseOccupancy: Number(f.baseOccupancy), maxOccupancy: Number(f.maxOccupancy) };
  const save = useSave(() => (type
    ? api(`/room-types/${type.id}`, { method: 'PATCH', body: { ...body, version: type.version } })
    : api('/room-types', { method: 'POST', body })), { invalidate: [['room-types']], success: 'Room type saved', onDone: onClose });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const belowMin = f.baseRate && f.minRate && money(f.baseRate).lt(f.minRate);
  return (
    <Dialog open onClose={onClose} size="lg" title={type ? `Edit ${type.name}` : 'Add room type'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={Boolean(belowMin)} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {save.error && <div className="sm:col-span-2"><ErrorBanner message={(save.error as Error).message} /></div>}
        <Field label="Name" required error={save.fields.name}>{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
        <Field label="Short code" required hint="2–8 letters or digits, e.g. DLX" error={save.fields.code}>{(id) => <Input id={id} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={8} />}</Field>
        <Field label="Guests included in the rate" required>{(id) => <Input id={id} inputMode="numeric" value={f.baseOccupancy} onChange={set('baseOccupancy')} />}</Field>
        <Field label="Most guests" required error={save.fields.maxOccupancy}>{(id) => <Input id={id} inputMode="numeric" value={f.maxOccupancy} onChange={set('maxOccupancy')} />}</Field>
        <Field label="Room rate per night" required error={save.fields.baseRate}>{(id) => <Input id={id} inputMode="decimal" value={f.baseRate} onChange={set('baseRate')} />}</Field>
        <Field label="Minimum rate" required hint="Below this needs Owner PIN. Set 0 to allow any manually entered price." error={belowMin ? 'The room rate cannot be below the minimum' : save.fields.minRate}>{(id) => <Input id={id} inputMode="decimal" value={f.minRate} onChange={set('minRate')} />}</Field>
        <Field label="Extra adult per night">{(id) => <Input id={id} inputMode="decimal" value={f.extraAdultRate} onChange={set('extraAdultRate')} />}</Field>
        <Field label="Extra child per night">{(id) => <Input id={id} inputMode="decimal" value={f.extraChildRate} onChange={set('extraChildRate')} />}</Field>
        {type && <Toggle label="In use" hint="Switched-off room types cannot be booked" checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />}
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
        <Field label="Room type" required>{(id) => <Select id={id} value={f.roomTypeId} onChange={set('roomTypeId')}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
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
