'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Delete, Lock, Palmtree } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/surface';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Me } from '@/lib/types';

interface DeskStatus { trusted: boolean; device?: { name: string }; property?: string; lockMinutes?: number; people?: { id: string; fullName: string; role: string }[] }

/**
 * The shared desk's lock screen (spec §5.3). Staff who logged in with their password earlier today
 * tap their name and enter their PIN. Everyone else logs in with their password.
 */
export default function DeskPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['desk'], queryFn: () => api<DeskStatus>('/desk'), refetchInterval: 30_000 });
  const [person, setPerson] = useState<{ id: string; fullName: string } | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async (value: string) => {
    if (!person || value.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api<{ user: Me }>('/desk/switch', { method: 'POST', body: { userId: person.id, pin: value } });
      qc.clear();
      qc.setQueryData(['me'], user);
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not switch. Try again.');
      setPin('');
      setBusy(false);
    }
  }, [person, busy, qc, router]);

  useEffect(() => {
    if (!person) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 6 ? p + e.key : p));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') void submit(pin);
      else if (e.key === 'Escape') { setPerson(null); setPin(''); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [person, pin, submit]);

  if (status.isLoading) return <main className="mx-auto max-w-md p-6"><Skeleton className="h-96" /></main>;
  const s = status.data;
  if (!s?.trusted) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-text-2">This computer is not a shared desk.</p>
        <Link href="/login" className="font-medium text-brand underline">Log in with your password</Link>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-brand-contrast"><Palmtree className="h-5 w-5" /></div>
        <div>
          <p className="font-semibold">{s.property}</p>
          <p className="flex items-center gap-1 text-xs text-text-3"><Lock className="h-3 w-3" />Shared desk · {s.device?.name}</p>
        </div>
      </div>

      {!person ? (
        <>
          <h1 className="text-xl font-semibold">Who is at the desk?</h1>
          {s.people?.length ? (
            <div className="grid grid-cols-2 gap-2">
              {s.people.map((p) => (
                <button key={p.id} type="button" onClick={() => { setPerson(p); setPin(''); setError(null); }}
                  className="rounded-xl border border-border bg-surface px-4 py-4 text-left transition-colors hover:border-brand">
                  <span className="block font-medium">{p.fullName}</span><span className="text-xs capitalize text-text-3">{p.role}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-2">Nobody can switch in by PIN yet. Log in with your password first today — and set a PIN in Settings if you have not.</p>
          )}
          <Link href="/login" className="text-center text-sm font-medium text-brand underline-offset-2 hover:underline">Log in with a password instead</Link>
        </>
      ) : (
        <>
          <div>
            <button type="button" className="text-sm text-text-2 hover:text-text" onClick={() => { setPerson(null); setPin(''); }}>← Someone else</button>
            <h1 className="mt-2 text-xl font-semibold">{person.fullName}</h1>
            <p className="text-sm text-text-3">Enter your PIN</p>
          </div>
          <div className="flex justify-center gap-2.5" role="status" aria-label={`${pin.length} digits entered`}>
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className={cn('h-3.5 w-3.5 rounded-full border-2 transition-colors', i < pin.length ? 'border-brand bg-brand' : 'border-border-strong', i >= 4 && pin.length <= i && 'opacity-40')} />
            ))}
          </div>
          {error && <p role="alert" className="text-center text-sm font-medium text-danger">{error}</p>}
          <div className="mx-auto grid w-full max-w-[280px] grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} type="button" tabIndex={-1} onClick={() => setPin((p) => (p.length < 6 ? p + d : p))} className="h-14 rounded-lg bg-surface-2 text-xl font-medium hover:bg-surface-3 active:scale-95">{d}</button>
            ))}
            <span />
            <button type="button" tabIndex={-1} onClick={() => setPin((p) => (p.length < 6 ? `${p}0` : p))} className="h-14 rounded-lg bg-surface-2 text-xl font-medium hover:bg-surface-3 active:scale-95">0</button>
            <button type="button" tabIndex={-1} onClick={() => setPin((p) => p.slice(0, -1))} className="flex h-14 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2" aria-label="Delete digit"><Delete className="h-5 w-5" /></button>
          </div>
          <Button size="lg" loading={busy} disabled={pin.length < 4} onClick={() => void submit(pin)}>Unlock</Button>
        </>
      )}
    </main>
  );
}
