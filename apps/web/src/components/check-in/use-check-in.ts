'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import type { ReservationDetail } from '@/lib/types';
import { useDeskQueue } from './documents-step';
import type { CheckInDraft } from './types';

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';

/**
 * Everything a check-in screen needs from its server-side draft (spec §18): load, debounced autosave
 * with version conflicts handled, live document status, and confirm with an idempotency key. The
 * step-by-step wizard and the one-screen express check-in both use this, so they are the same
 * check-in — same validation, limits, audit and idempotency — laid out differently.
 */
export function useCheckIn(draftId: string, options: { pollDocuments: boolean; initialStep?: (serverStep: number) => number; afterConfirm?: 'reservation' | 'stay' }) {
  // Read through a ref: callers pass a fresh object each render, which must not re-run the effects.
  const optsRef = useRef(options);
  optsRef.current = options;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();

  const draft = useQuery({ queryKey: ['check-in', draftId], queryFn: () => api<CheckInDraft>(`/check-in-drafts/${draftId}`), refetchOnWindowFocus: false });
  const reservation = useQuery({
    queryKey: ['reservation', draft.data?.reservationId], enabled: !!draft.data,
    queryFn: () => api<ReservationDetail>(`/reservations/${draft.data!.reservationId}`),
  });
  const queue = useDeskQueue(draftId);

  const [data, setData] = useState<CheckInDraft['data'] | null>(null);
  const [step, setStep] = useState(1);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const version = useRef(0);
  const dirty = useRef(false);
  const [confirmed, setConfirmed] = useState(false);

  // Adopt server state on first load, and whenever it moved on and we have nothing unsaved.
  useEffect(() => {
    if (!draft.data || draft.data.status !== 'active') return;
    if (data === null || (!dirty.current && draft.data.version > version.current)) {
      setData(draft.data.data);
      version.current = draft.data.version;
      const initial = optsRef.current.initialStep;
      if (data === null) setStep(initial ? initial(draft.data.step) : Math.min(Math.max(draft.data.step, 1), 5));
    }
  }, [draft.data, data]);

  const save = useCallback(async (next: CheckInDraft['data'], nextStep: number) => {
    setSaveState('saving');
    try {
      const saved = await api<CheckInDraft>(`/check-in-drafts/${draftId}`, { method: 'PATCH', body: { version: version.current, step: nextStep, data: next } });
      version.current = saved.version;
      dirty.current = false;
      qc.setQueryData(['check-in', draftId], saved);
      setSaveState('saved');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') {
        dirty.current = false;
        setData(null);
        await draft.refetch();
        toast('error', 'This check-in was changed on another screen. Showing the latest version.');
      } else {
        setSaveState('error');
      }
    }
  }, [draftId, qc, draft, toast]);

  // Debounced autosave while typing.
  useEffect(() => {
    if (!data || !dirty.current) return;
    setSaveState('unsaved');
    const t = setTimeout(() => void save(data, step), 700);
    return () => clearTimeout(t);
  }, [data, step, save]);

  const change = useCallback((next: CheckInDraft['data']) => { dirty.current = true; setData(next); }, []);
  const refresh = useCallback(() => { void draft.refetch(); }, [draft]);

  // Keep document status live while documents and the signature are on screen.
  useEffect(() => {
    if (!optsRef.current.pollDocuments && step < 3) return;
    const t = setInterval(() => { if (!dirty.current) void draft.refetch(); }, 2000);
    return () => clearInterval(t);
  }, [step, draft]);

  const confirmKey = useRef(newIdempotencyKey());
  const confirm = useMutation({
    mutationFn: () => api<{ reservationId: string; stays: { id: string }[] }>(`/check-in-drafts/${draftId}/confirm`, { method: 'POST', body: {}, idempotencyKey: confirmKey.current }),
    onSuccess: async (res) => {
      setConfirmed(true);
      await Promise.all(['front-desk', 'rooms', 'reservations', 'reservation', 'calendar'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      const toStay = optsRef.current.afterConfirm === 'stay' && res.stays[0];
      setTimeout(() => router.push(toStay ? `/stays/${res.stays[0]!.id}` : `/reservations/${res.reservationId}`), 1100);
    },
    onError: () => { confirmKey.current = newIdempotencyKey(); void draft.refetch(); },
  });

  const uploading = queue.items.some((i) => ['queued', 'uploading', 'verifying', 'waiting_network'].includes(i.status));
  return { draft, reservation, queue, data, change, refresh, save, step, setStep, saveState, dirty, confirm, confirmed, uploading };
}
