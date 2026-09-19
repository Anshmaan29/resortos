'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ID_TYPES_WITH_BACK, type DocumentType, type IdType } from '@resortos/shared';
import { CaptureSlot, slotState } from '@/components/capture/capture-slot';
import { Field, Input, Select } from '@/components/ui/field';
import { Card, CardHeader } from '@/components/ui/surface';
import { api } from '@/lib/api';
import { preloadOpenCv } from '@/lib/capture/opencv';
import { sha256Hex } from '@/lib/capture/image';
import { UploadQueue, type QueueItem } from '@/lib/capture/upload-queue';
import { PhoneScannerPanel } from './phone-scanner-panel';
import type { CheckInDraft, Occupant } from './types';

const ID_LABELS: Record<Exclude<IdType, 'none'>, string> = {
  aadhaar: 'Aadhaar', passport: 'Passport', driving_licence: 'Driving licence', voter_id: 'Voter ID', pan: 'PAN card', other: 'Other ID',
};

/** Desk-side capture queue shared by the documents and signature steps. */
export function useDeskQueue(draftId: string) {
  const queue = useRef<UploadQueue | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  useEffect(() => {
    const q = new UploadQueue(draftId, {
      create: (item, signal) => api(`/check-in-drafts/${draftId}/documents`, {
        method: 'POST', signal,
        body: { clientUploadId: item.id, source: item.source === 'phone_scanner' ? 'desk_camera' : item.source, docType: item.docType, idType: item.idType, occupantKey: item.occupantKey, contentType: item.contentType, sizeBytes: item.size, sha256: item.sha256 },
      }),
      refresh: (documentId, signal) => api(`/check-in-drafts/${draftId}/documents/${documentId}/grant`, { method: 'POST', body: {}, signal }),
      confirm: (documentId, signal) => api(`/check-in-drafts/${draftId}/documents/${documentId}/confirm`, { method: 'POST', body: {}, signal }),
    });
    queue.current = q;
    const stop = q.start();
    const unsub = q.subscribe(setItems);
    return () => { stop(); unsub(); };
  }, [draftId]);

  const add = useCallback(async (input: { slotKey: string; docType: DocumentType; occupantKey?: string; idType?: Exclude<IdType, 'none'>; source: QueueItem['source']; blob: Blob; contentType: QueueItem['contentType'] }) => {
    await queue.current?.add({ ...input, sha256: await sha256Hex(input.blob) });
  }, []);
  const latest = (slotKey: string) => [...items].reverse().find((i) => i.slotKey === slotKey);
  return { items, add, latest, progressOf: (id: string) => queue.current?.progressOf(id) ?? 0, remove: (id: string) => queue.current?.remove(id) };
}

export function DocumentsStep({ draft, data, onChange, onRefresh, queue }: {
  draft: CheckInDraft; data: CheckInDraft['data']; onChange: (d: CheckInDraft['data']) => void; onRefresh: () => void; queue: ReturnType<typeof useDeskQueue>;
}) {
  useEffect(() => preloadOpenCv(), []);

  // An ID type chosen on the phone fills in the guest's ID type here if the desk has not set one.
  useEffect(() => {
    let changed = false;
    const rooms = data.rooms.map((r) => ({
      ...r,
      occupants: r.occupants.map((o) => {
        if (o.idType !== 'none') return o;
        const doc = draft.documents.find((d) => d.occupantKey === o.key && d.idType && d.status === 'verified');
        if (!doc?.idType) return o;
        changed = true;
        return { ...o, idType: doc.idType };
      }),
    }));
    if (changed) onChange({ ...data, rooms });
  }, [draft.documents, data, onChange]);

  const setOccupant = (roomIndex: number, key: string, patch: Partial<Occupant>) =>
    onChange({ ...data, rooms: data.rooms.map((r, i) => (i === roomIndex ? { ...r, occupants: r.occupants.map((o) => (o.key === key ? { ...o, ...patch } : o)) } : r)) });

  const serverStatus = (occupantKey: string, docType: DocumentType) =>
    [...draft.documents].reverse().find((d) => d.occupantKey === occupantKey && d.docType === docType)?.status;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-6">
        {data.rooms.map((room, i) => (
          room.occupants.filter((o) => !o.isChild && (draft.policy.idRequiredFor === 'all_adults' || o.isPrimary)).map((o) => {
            const idType = o.idType === 'none' ? null : o.idType;
            const slots: { docType: DocumentType; label: string; show: boolean; required: boolean }[] = [
              { docType: 'guest_photo', label: 'Guest photo', show: o.isPrimary && draft.policy.requireGuestPhoto, required: true },
              { docType: 'id_front', label: 'ID — front', show: !!idType, required: true },
              { docType: 'id_back', label: 'ID — back', show: !!idType && ID_TYPES_WITH_BACK.includes(idType), required: true },
              { docType: 'id_extra', label: 'Extra page', show: !!idType, required: false },
            ];
            return (
              <Card key={o.key}>
                <CardHeader title={o.fullName || 'Guest'} description={o.isPrimary ? 'Primary guest' : 'Adult guest'} />
                <div className="flex flex-col gap-4 p-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="ID type" required>{(id) => (
                      <Select id={id} value={o.idType} onChange={(e) => setOccupant(i, o.key, { idType: e.target.value as IdType })}>
                        <option value="none">Choose ID type</option>
                        {Object.entries(ID_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </Select>
                    )}</Field>
                    <Field label="Last 4 characters of the ID" required hint="Never type the full number">{(id, d) => (
                      <Input id={id} aria-describedby={d} maxLength={4} className="uppercase num tracking-widest" value={o.idLast4 ?? ''}
                        onChange={(e) => setOccupant(i, o.key, { idLast4: e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase() })} />
                    )}</Field>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {slots.filter((s) => s.show).map((s) => {
                      const slotKey = `${o.key}:${s.docType}`;
                      const item = queue.latest(slotKey);
                      return (
                        <CaptureSlot key={slotKey} compact label={s.label + (s.required ? '' : ' (optional)')} docType={s.docType} idType={s.docType === 'guest_photo' ? null : idType}
                          state={slotState(serverStatus(o.key, s.docType), item, item ? queue.progressOf(item.id) : 0)}
                          onDiscardFailed={() => { if (item?.status === 'failed') void queue.remove(item.id); }}
                          onCaptured={(r, via) => void queue.add({
                            slotKey, docType: s.docType, occupantKey: o.key, idType: s.docType === 'guest_photo' ? undefined : idType ?? undefined,
                            source: via === 'file' ? 'file_upload' : 'desk_camera', blob: r.blob, contentType: 'image/jpeg',
                          }).then(onRefresh)} />
                      );
                    })}
                  </div>
                </div>
              </Card>
            );
          })
        ))}
      </div>
      <div className="xl:sticky xl:top-24 xl:self-start">
        <PhoneScannerPanel draftId={draft.id} onDocumentsChanged={onRefresh} />
      </div>
    </div>
  );
}
