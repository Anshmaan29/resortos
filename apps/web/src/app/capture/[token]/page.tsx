'use client';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, CloudOff, Palmtree, ScanLine, ShieldCheck, TimerOff } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ID_TYPES_WITH_BACK, type DocumentType, type IdType } from '@resortos/shared';
import { CaptureSlot } from '@/components/capture/capture-slot';
import { slotState } from '@/lib/capture/slot-state';
import { Select } from '@/components/ui/field';
import { api, ApiError } from '@/lib/api';
import { preloadOpenCv } from '@/lib/capture/opencv';
import { sha256Hex } from '@/lib/capture/image';
import { UploadQueue, type QueueItem, type UploadTransport } from '@/lib/capture/upload-queue';

interface Occupant { key: string; label: string; isChild: boolean; isPrimary: boolean; idType: Exclude<IdType, 'none'> | null }
interface ServerDoc { id: string; docType: DocumentType; idType: Exclude<IdType, 'none'> | null; occupantKey: string | null; status: 'pending' | 'verified' | 'failed' | 'orphaned'; failureReason: string | null }

const ID_LABELS: Record<Exclude<IdType, 'none'>, string> = {
  aadhaar: 'Aadhaar', passport: 'Passport', driving_licence: 'Driving licence', voter_id: 'Voter ID', pan: 'PAN card', other: 'Other ID',
};

type Phase = { kind: 'connecting' } | { kind: 'ready' } | { kind: 'closed'; message: string };

export default function PhoneCapturePage() {
  const { token } = useParams<{ token: string }>();
  const storageKey = `rsos-capture:${token}`;
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [secret, setSecret] = useState<string | null>(null);
  const [occupants, setOccupants] = useState<Occupant[]>([]);
  const [docs, setDocs] = useState<ServerDoc[]>([]);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [online, setOnline] = useState(true);
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [items, setItems] = useState<QueueItem[]>([]);
  // Remembered on the phone so a refresh never hides the ID slots.
  const [idChoice, setIdChoice] = useState<Record<string, Exclude<IdType, 'none'>>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem(`rsos-capture-ids:${token}`) ?? '{}'); } catch { return {}; }
  });
  useEffect(() => { localStorage.setItem(`rsos-capture-ids:${token}`, JSON.stringify(idChoice)); }, [idChoice, token]);
  const queueRef = useRef<UploadQueue | null>(null);

  const headers = useMemo(() => (secret ? { 'x-capture-device': secret } : undefined), [secret]);

  const closed = useCallback((err: unknown) => {
    if (err instanceof ApiError && (err.details?.scannerClosed || err.status === 403 || err.status === 409)) {
      setPhase({ kind: 'closed', message: err.message });
      return true;
    }
    return false;
  }, []);

  // Claim once; after a refresh, reuse the stored device secret.
  useEffect(() => {
    preloadOpenCv();
    const stored = localStorage.getItem(storageKey);
    if (stored) { setSecret(stored); return; }
    api<{ deviceSecret: string; expiresAt: string; occupants: Occupant[] }>(`/capture/${token}/claim`, { method: 'POST', body: {} })
      .then((res) => { localStorage.setItem(storageKey, res.deviceSecret); setSecret(res.deviceSecret); setOccupants(res.occupants); setExpiresAt(new Date(res.expiresAt).getTime()); })
      .catch((err) => { if (!closed(err)) setPhase({ kind: 'closed', message: 'Could not connect. Check the network and scan the QR code again.' }); });
  }, [token, storageKey, closed]);

  const refreshStatus = useCallback(async () => {
    if (!headers) return;
    try {
      const s = await api<{ expiresAt: string; occupants: Occupant[]; documents: ServerDoc[] }>(`/capture/${token}/status`, { method: 'POST', body: {}, headers });
      setOccupants(s.occupants);
      setDocs(s.documents);
      setExpiresAt(new Date(s.expiresAt).getTime());
      setPhase((p) => (p.kind === 'connecting' ? { kind: 'ready' } : p));
    } catch (err) {
      if (!closed(err) && phase.kind === 'connecting' && !navigator.onLine) setPhase({ kind: 'ready' }); // offline after refresh: queue still works
    }
  }, [headers, token, closed, phase.kind]);

  useEffect(() => {
    if (!headers) return;
    void refreshStatus();
    const t = setInterval(refreshStatus, 4000);
    return () => clearInterval(t);
  }, [headers, refreshStatus]);

  // Durable upload queue for this scanner session.
  useEffect(() => {
    if (!headers) return;
    const transport: UploadTransport = {
      create: (item, signal) => api(`/capture/${token}/uploads`, {
        method: 'POST', headers, signal,
        body: { clientUploadId: item.id, docType: item.docType, idType: item.idType, occupantKey: item.occupantKey, contentType: item.contentType, sizeBytes: item.size, sha256: item.sha256 },
      }),
      refresh: (documentId, signal) => api(`/capture/${token}/uploads/${documentId}/grant`, { method: 'POST', body: {}, headers, signal }),
      confirm: (documentId, signal) => api(`/capture/${token}/uploads/${documentId}/confirm`, { method: 'POST', body: {}, headers, signal }),
    };
    const queue = new UploadQueue(token, transport);
    queueRef.current = queue;
    const stop = queue.start();
    const unsubscribe = queue.subscribe((list) => { setItems(list); setMemoryOnly(queue.isMemoryOnly); void refreshStatus(); });
    return () => { stop(); unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headers, token]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); clearInterval(tick); };
  }, []);

  const secondsLeft = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;
  useEffect(() => {
    if (secondsLeft === 0 && phase.kind === 'ready') setPhase({ kind: 'closed', message: 'This QR code has expired (codes last 10 minutes). Ask the desk to show a new one.' });
  }, [secondsLeft, phase.kind]);

  async function captured(occupant: Occupant, docType: DocumentType, idType: Exclude<IdType, 'none'> | null, blob: Blob) {
    await queueRef.current?.add({
      slotKey: `${occupant.key}:${docType}`, docType, occupantKey: occupant.key, idType: idType ?? undefined, source: 'phone_scanner',
      blob, contentType: 'image/jpeg', sha256: await sha256Hex(blob),
    });
  }

  const latestItem = (slotKey: string) => [...items].reverse().find((i) => i.slotKey === slotKey);
  const serverStatus = (occupantKey: string, docType: DocumentType) =>
    [...docs].reverse().find((d) => d.occupantKey === occupantKey && d.docType === docType)?.status;
  const pendingOnDevice = items.filter((i) => i.status !== 'done' && i.status !== 'failed').length;
  const adults = occupants.filter((o) => !o.isChild);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-4 px-4 pb-10 pt-4">
      <header className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-brand-contrast"><Palmtree className="h-5 w-5" /></span>
        <div className="flex-1">
          <p className="font-semibold leading-tight">Document scanner</p>
          <p className="text-xs text-text-2">Photos go straight to the front desk</p>
        </div>
        {phase.kind === 'ready' && secondsLeft !== null && (
          <span className="rounded-full bg-surface-2 px-3 py-1 text-xs font-medium num text-text-2" aria-live="off">{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</span>
        )}
      </header>

      <AnimatePresence>
        {!online && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="status"
            className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-3 text-sm text-warning">
            <CloudOff className="mt-0.5 h-4 w-4 shrink-0" />
            {memoryOnly
              ? 'No network. Keep this page open — this phone cannot save photos, so they would be lost if you close it.'
              : 'No network. Photos are saved on this phone and will upload automatically when the network is back.'}
          </motion.div>
        )}
        {online && memoryOnly && pendingOnDevice > 0 && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="status"
            className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-3 text-sm text-warning">
            <CloudOff className="mt-0.5 h-4 w-4 shrink-0" />Keep this page open until the photos reach the desk — this phone will not remember them.
          </motion.div>
        )}
      </AnimatePresence>

      {phase.kind === 'connecting' && <p className="flex items-center gap-2 py-10 text-text-2"><ScanLine className="h-5 w-5 animate-pulse" />Connecting to the desk…</p>}

      {phase.kind === 'closed' && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface px-4 py-8 text-center">
          {pendingOnDevice === 0 ? <CheckCircle2 className="h-10 w-10 text-success" /> : <TimerOff className="h-10 w-10 text-warning" />}
          <p className="font-medium">{phase.message}</p>
          {pendingOnDevice > 0 && <p className="text-sm text-warning">{pendingOnDevice} photo(s) did not finish uploading. Capture them again with a new QR code.</p>}
        </div>
      )}

      {phase.kind === 'ready' && (
        <>
          <p className="flex items-start gap-2 rounded-lg bg-brand-soft px-3 py-2 text-sm text-brand">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />This page can only send photos to the desk. It cannot show guest details.
          </p>
          {adults.map((o) => {
            const idType = idChoice[o.key] ?? o.idType
              ?? [...docs].reverse().find((d) => d.occupantKey === o.key && d.idType)?.idType
              ?? [...items].reverse().find((i) => i.occupantKey === o.key && i.idType)?.idType ?? null;
            const slots: { docType: DocumentType; label: string; hint?: string; show: boolean }[] = [
              { docType: 'guest_photo', label: 'Guest photo', hint: 'Face clearly visible, no hat or sunglasses', show: o.isPrimary },
              { docType: 'id_front', label: 'ID — front', hint: 'Fill the frame with the card', show: !!idType },
              { docType: 'id_back', label: 'ID — back', show: !!idType && ID_TYPES_WITH_BACK.includes(idType) },
              { docType: 'id_extra', label: 'Extra page (optional)', hint: 'e.g. passport visa page', show: !!idType },
            ];
            return (
              <section key={o.key} className="flex flex-col gap-3">
                <h2 className="pt-2 text-lg font-semibold">{o.label}{o.isPrimary ? ' · primary guest' : ''}</h2>
                <label className="flex flex-col gap-1.5 text-sm font-medium text-text-2">
                  ID type
                  <Select value={idType ?? ''} onChange={(e) => setIdChoice((c) => ({ ...c, [o.key]: e.target.value as Exclude<IdType, 'none'> }))}>
                    <option value="" disabled>Choose the ID the guest gave</option>
                    {Object.entries(ID_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                </label>
                {slots.filter((s) => s.show).map((s) => {
                  const slotKey = `${o.key}:${s.docType}`;
                  const item = latestItem(slotKey);
                  const state = slotState(serverStatus(o.key, s.docType), item, item ? queueRef.current?.progressOf(item.id) ?? 0 : 0);
                  return (
                    <CaptureSlot key={slotKey} label={s.label} hint={s.hint} docType={s.docType} idType={s.docType === 'guest_photo' ? null : idType} state={state}
                      allowFiles={s.docType !== 'guest_photo'}
                      onDiscardFailed={() => { if (item?.status === 'failed') void queueRef.current?.remove(item.id); }}
                      onCaptured={(r) => void captured(o, s.docType, s.docType === 'guest_photo' ? null : idType, r.blob)} />
                  );
                })}
              </section>
            );
          })}
          {adults.length === 0 && <p className="text-sm text-text-2">The desk has not added guests yet. This page updates automatically.</p>}
        </>
      )}
    </main>
  );
}
