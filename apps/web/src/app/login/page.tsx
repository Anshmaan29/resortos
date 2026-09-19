'use client';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Eye, EyeOff, Palmtree } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useState, type FormEvent } from 'react';
import { loginSchema } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { api, ApiError } from '@/lib/api';
import { dialogIn } from '@/lib/motion';
import type { Me } from '@/lib/types';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desk = useQuery({ queryKey: ['desk'], queryFn: () => api<{ trusted: boolean; people?: unknown[] }>('/desk'), retry: false });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = loginSchema.safeParse({ login, password });
    if (!parsed.success) { setError(parsed.error.issues[0]!.message); return; }
    setBusy(true);
    setError(null);
    try {
      const { user } = await api<{ user: Me }>('/auth/login', { method: 'POST', body: parsed.data });
      qc.setQueryData(['me'], user);
      const next = params.get('next');
      router.replace(user.mustChangePassword ? '/change-password' : next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log in. Please try again.');
      setBusy(false);
    }
  }

  return (
    <motion.form {...dialogIn} onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 shadow-md" noValidate>
      <div className="mb-7 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand text-brand-contrast"><Palmtree className="h-6 w-6" /></div>
        <div>
          <p className="text-lg font-semibold leading-tight">ResortOS</p>
          <p className="text-sm text-text-3">Log in to continue</p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <Field label="Username or phone number">
          {(id) => <Input id={id} autoComplete="username" autoCapitalize="none" inputMode="text" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus />}
        </Field>
        <Field label="Password">
          {(id) => (
            <div className="relative">
              <Input id={id} type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="pr-11" />
              <button type="button" onClick={() => setShow((s) => !s)} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-text-3 hover:text-text" aria-label={show ? 'Hide password' : 'Show password'}>
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          )}
        </Field>
        {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <Button type="submit" size="lg" loading={busy} className="mt-1 w-full">Log in</Button>
        {desk.data?.trusted && Boolean(desk.data.people?.length) && (
          <Link href="/desk" className="text-center text-sm font-medium text-brand underline-offset-2 hover:underline">Switch in with your PIN</Link>
        )}
        <p className="text-center text-xs text-text-3">Forgot your password? Ask the owner to reset it.</p>
      </div>
    </motion.form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[radial-gradient(ellipse_at_top,var(--brand-soft),transparent_60%)] px-4">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
