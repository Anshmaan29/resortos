'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Loader2, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/surface';
import { api } from '@/lib/api';
import type { DraftDocument } from './types';

const ID_NAMES: Record<string, string> = { aadhaar: 'Aadhaar', passport: 'Passport', driving_licence: 'Driving licence', voter_id: 'Voter ID', pan: 'PAN card', other: 'Other ID' };

interface Session { sessionId: string; token: string; captureUrl: string; expiresAt: string }
interface SessionStatus { claimed: boolean; open: boolean; expiresAt: string; closedReason: string | null; filesReceived: number; documents: DraftDocument[] }

/** QR for phone-as-scanner (spec §19.2). Documents appear here as each one is verified. */
export function PhoneScannerPanel({ draftId, onDocumentsChanged }: { draftId: string; onDocumentsChanged: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const create = useMutation({
    mutationFn: () => api<Session>(`/check-in-drafts/${draftId}/capture-sessions`, { method: 'POST', body: {} }),
    onSuccess: async (s) => { setSession(s); setQr(await QRCode.toDataURL(s.captureUrl, { margin: 1, width: 260, errorCorrectionLevel: 'M' })); },
  });
  const close = useMutation({
    mutationFn: () => api(`/capture-sessions/${session!.sessionId}/close`, { method: 'POST', body: {} }),
    onSuccess: () => { setSession(null); setQr(null); onDocumentsChanged(); },
  });

  // Live updates over SSE (spec §19.2); polling is the fallback, and stays the only path when the
  // browser has no EventSource or the stream drops. `live` wins while the stream is healthy.
  const [live, setLive] = useState<SessionStatus | null>(null);
  const [streaming, setStreaming] = useState(true);

  useEffect(() => {
    setLive(null);
    if (!session) return;
    if (typeof EventSource === 'undefined') { setStreaming(false); return; }
    setStreaming(true);
    const source = new EventSource(`/api/v1/capture-sessions/${session.sessionId}/events`);
    let closed = false;
    source.onmessage = (event) => setLive(JSON.parse(event.data) as SessionStatus);
    source.onerror = () => {
      // The server ends the stream when the session closes; that is not a failure.
      source.close();
      if (!closed) setStreaming(false);
    };
    return () => { closed = true; source.close(); };
  }, [session]);

  const query = useQuery({
    queryKey: ['capture-session', session?.sessionId],
    enabled: !!session,
    refetchInterval: streaming ? false : 1500,
    queryFn: () => api<SessionStatus>(`/capture-sessions/${session!.sessionId}`),
  });
  const status = { data: live ?? query.data };

  const verifiedCount = status.data?.documents.filter((d) => d.status === 'verified').length ?? 0;
  useEffect(() => { if (session) onDocumentsChanged(); }, [verifiedCount, session, onDocumentsChanged]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const secondsLeft = session ? Math.max(0, Math.round((new Date(session.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = !!session && (secondsLeft === 0 || status.data?.open === false);
  // Latest document per slot: a retaken photo replaces the earlier entry.
  const fromPhone = [...new Map((status.data?.documents ?? []).filter((d) => d.source === 'phone_scanner').map((d) => [`${d.occupantKey}:${d.docType}`, d])).values()];

  return (
    <Card>
      <CardHeader title="Scan with phone" description="Recommended: any phone camera opens the scanner. No login needed." />
      <div className="flex flex-col items-center gap-4 p-5">
        {!session && (
          <Button size="lg" className="w-full" loading={create.isPending} onClick={() => create.mutate()}><QrCode className="h-5 w-5" />Show QR code</Button>
        )}
        {create.isError && <p role="alert" className="text-sm text-danger">{(create.error as Error).message}</p>}
        {session && qr && (
          <>
            <div className={`rounded-lg border border-border bg-white p-2 ${expired ? 'opacity-30' : ''}`}>
              <img src={qr} alt="QR code for the phone scanner" width={220} height={220} />
            </div>
            {expired ? (
              <Button variant="outline" onClick={() => create.mutate()} loading={create.isPending}><RefreshCw className="h-4 w-4" />Show a new code</Button>
            ) : (
              <p className="text-sm text-text-2 num" aria-live="polite">
                {status.data?.claimed ? <span className="flex items-center gap-1.5 text-success"><Smartphone className="h-4 w-4" />Phone connected</span> : 'Waiting for a phone to scan…'}
                {' '}· expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
              </p>
            )}
            <ul className="flex w-full flex-col gap-2" aria-live="polite" aria-label="Documents received from the phone">
              <AnimatePresence initial={false}>
                {fromPhone.map((d) => (
                  <motion.li key={d.id} layout initial={{ opacity: 0, scale: 0.9, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.2 }}
                    className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-2 text-sm">
                    <span>{d.label}{d.idType ? ` · ${ID_NAMES[d.idType]}` : ''}</span>
                    {d.status === 'verified'
                      ? <motion.span initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 22 }} className="flex items-center gap-1 font-medium text-success"><CheckCircle2 className="h-4 w-4" />Received</motion.span>
                      : d.status === 'failed' ? <span className="text-danger">Failed</span>
                        : <span className="flex items-center gap-1 text-info"><Loader2 className="h-4 w-4 animate-spin" />Arriving</span>}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
            <Button variant="outline" className="w-full" loading={close.isPending} onClick={() => close.mutate()}>Done with phone</Button>
          </>
        )}
      </div>
    </Card>
  );
}
