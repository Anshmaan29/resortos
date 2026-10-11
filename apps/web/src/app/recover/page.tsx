'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { recoverAccountSchema } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { api } from '@/lib/api';

export default function RecoverPage() {
  const qc = useQueryClient();
  const [login, setLogin] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (password !== confirm) { setError('Passwords do not match'); return; }
    const parsed = recoverAccountSchema.safeParse({ login, recoveryCode: code, newPassword: password });
    if (!parsed.success) { setError(parsed.error.issues[0]!.message); return; }
    setBusy(true);
    try {
      await api('/auth/recover', { method: 'POST', body: parsed.data });
      qc.clear(); setCode(''); setPassword(''); setConfirm(''); setDone(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="flex min-h-dvh items-center justify-center px-4 py-8">
    <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 shadow-md">
      <h1 className="text-xl font-semibold">Owner account recovery</h1>
      {done ? <p role="status" className="my-4 text-sm">Password reset. All previous sessions have ended. Log in with your new password.</p> : <>
        <p className="my-4 text-sm text-text-3">Use one of your saved recovery codes. Each code works once. Staff should ask the owner to reset their password.</p>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Owner username or phone number">{id => <Input id={id} autoComplete="username" autoCapitalize="none" value={login} onChange={e => setLogin(e.target.value)} />}</Field>
          <Field label="Recovery code">{id => <Input id={id} autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={e => setCode(e.target.value.toUpperCase())} />}</Field>
          <Field label="New password" hint="At least 10 characters">{id => <Input id={id} type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />}</Field>
          <Field label="Type it again">{id => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />}</Field>
          {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" loading={busy}>Reset owner password</Button>
        </form>
      </>}
      <Link href="/login" className="mt-4 flex min-h-11 items-center text-sm font-medium text-brand hover:underline">Back to login</Link>
    </div>
  </main>;
}
