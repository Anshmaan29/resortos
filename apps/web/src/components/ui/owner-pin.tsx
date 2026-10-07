'use client';
import { useQuery } from '@tanstack/react-query';
import { Delete, ShieldCheck } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from './button';
import { Dialog } from './dialog';

/**
 * On-screen Owner PIN pad (spec §4.5). Works with touch, mouse, and the physical keyboard
 * (digits, Backspace, Enter, Escape). The PIN approves one server-side authorisation that is
 * bound to the exact request values; this component never decides whether a PIN is right.
 */
export function OwnerPinDialog({ open, reason, error, busy, onCancel, onSubmit }: {
  open: boolean; reason: string; error?: string | null; busy?: boolean; onCancel: () => void; onSubmit: (ownerUserId: string, pin: string) => void;
}) {
  const owners = useQuery({ queryKey: ['owners'], queryFn: () => api<{ id: string; fullName: string }[]>('/auth/owners'), enabled: open });
  const [selectedOwnerId, setOwnerId] = useState('');
  const ownerId = selectedOwnerId || owners.data?.[0]?.id || '';
  const [pin, setPin] = useState('');
  // Keyboard events can arrive before React commits the last digit. Keep the input
  // current synchronously so a fast Enter includes the last digit.
  const pinRef = useRef('');
  const state = useRef({ ownerId, busy, onSubmit });
  state.current = { ownerId, busy, onSubmit };
  const updatePin = useCallback((next: string) => { pinRef.current = next; setPin(next); }, []);

  useLayoutEffect(() => { if (open) updatePin(''); }, [open, error, updatePin]);

  const press = useCallback((d: string) => {
    if (pinRef.current.length < 6) updatePin(pinRef.current + d);
  }, [updatePin]);
  const removeDigit = useCallback(() => updatePin(pinRef.current.slice(0, -1)), [updatePin]);
  const submit = useCallback(() => {
    const s = state.current;
    if (pinRef.current.length >= 4 && pinRef.current.length <= 6 && s.ownerId && !s.busy) s.onSubmit(s.ownerId, pinRef.current);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); removeDigit(); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, press, removeDigit, submit]);

  return (
    <Dialog open={open} onClose={onCancel} title="Owner authorisation" size="sm" description={reason}>
      <div className="flex flex-col items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand"><ShieldCheck className="h-6 w-6" /></div>
        {owners.data && owners.data.length > 1 && (
          <div className="flex flex-wrap justify-center gap-2" role="radiogroup" aria-label="Authorising owner">
            {owners.data.map((o) => (
              <button key={o.id} type="button" role="radio" aria-checked={ownerId === o.id} onClick={() => setOwnerId(o.id)}
                className={cn('rounded-full border px-3 py-1.5 text-sm', ownerId === o.id ? 'border-brand bg-brand-soft text-brand' : 'border-border text-text-2')}>
                {o.fullName}
              </button>
            ))}
          </div>
        )}
        {owners.isPending && <p className="text-center text-sm text-text-3" role="status">Loading owners…</p>}
        {owners.isError && <p className="text-center text-sm text-danger" role="alert">Could not load owners. Close this dialog and try again.</p>}
        {owners.data?.length === 0 && <p className="text-center text-sm text-danger">No owner has set a PIN yet. The owner can do this action from their own login.</p>}
        <p className="text-sm text-text-2">Enter your 4–6 digit owner PIN.</p>
        <div className="flex gap-2.5" role="status" aria-label={`${pin.length} digits entered; owner PIN accepts 4 to 6 digits`}>
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className={cn('h-3.5 w-3.5 rounded-full border-2 transition-colors', i < pin.length ? 'border-brand bg-brand' : 'border-border-strong')} />
          ))}
        </div>
        {error && <p role="alert" className="text-center text-sm font-medium text-danger">{error}</p>}
        <div className="grid w-full max-w-[260px] grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} type="button" tabIndex={-1} onClick={() => press(d)} className="h-14 rounded-lg bg-surface-2 text-xl font-medium num hover:bg-surface-3 active:scale-95">{d}</button>
          ))}
          <span />
          <button type="button" tabIndex={-1} onClick={() => press('0')} className="h-14 rounded-lg bg-surface-2 text-xl font-medium num hover:bg-surface-3 active:scale-95">0</button>
          <button type="button" tabIndex={-1} onClick={removeDigit} className="flex h-14 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2" aria-label="Delete digit"><Delete className="h-5 w-5" /></button>
        </div>
        <p className="text-xs text-text-3">You can also type the PIN on the keyboard and press Enter.</p>
        <div className="flex w-full gap-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
          <Button className="flex-1" disabled={pin.length < 4 || pin.length > 6 || !ownerId} loading={busy} onClick={submit}>Authorise</Button>
        </div>
      </div>
    </Dialog>
  );
}

const APPROVAL_CODES = new Set(['OWNER_PIN_REQUIRED', 'OWNER_AUTHORISATION_INVALID']);

/**
 * Wires a mutation to the owner approval flow:
 *   request rejected (needs owner) → PIN pad → approve on server → retry(authorisationId)
 */
export function useOwnerApproval(retry: (authorisationId: string) => void): { handleError: (err: unknown) => boolean; dialog: ReactNode } {
  const [state, setState] = useState<{ authorisationId: string; reason: string; error: string | null; busy: boolean } | null>(null);

  const handleError = useCallback((err: unknown) => {
    if (!(err instanceof ApiError) || !APPROVAL_CODES.has(err.code) || !err.details?.authorisationId) return false;
    setState({
      authorisationId: err.details.authorisationId,
      reason: `Needed because: ${err.details.description}`,
      error: err.code === 'OWNER_AUTHORISATION_INVALID' ? err.details.problem ?? err.message : null,
      busy: false,
    });
    return true;
  }, []);

  async function approve(ownerUserId: string, pin: string) {
    if (!state) return;
    setState({ ...state, busy: true, error: null });
    try {
      await api(`/owner-authorisations/${state.authorisationId}/approve`, { method: 'POST', body: { ownerUserId, pin } });
      const id = state.authorisationId;
      setState(null);
      retry(id);
    } catch (err) {
      setState({ ...state, busy: false, error: err instanceof ApiError ? err.message : 'Could not verify the PIN. Try again.' });
    }
  }

  const dialog = (
    <OwnerPinDialog open={!!state} reason={state?.reason ?? ''} error={state?.error} busy={state?.busy}
      onCancel={() => setState(null)} onSubmit={approve} />
  );
  return { handleError, dialog };
}
