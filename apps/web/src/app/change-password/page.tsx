'use client';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { changePasswordSchema } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';

export default function ChangePasswordPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setErrors({ confirm: 'Passwords do not match' }); return; }
    const parsed = changePasswordSchema.safeParse({ currentPassword: current, newPassword: next });
    if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))); return; }
    setBusy(true); setErrors({});
    try {
      await api('/auth/password/change', { method: 'POST', body: parsed.data });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast('success', 'Password changed');
      router.replace('/');
    } catch (err) {
      const apiErr = err as ApiError;
      setErrors(Object.keys(apiErr.fields ?? {}).length ? apiErr.fields : { form: apiErr.message });
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 shadow-md" noValidate>
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-soft text-brand"><KeyRound className="h-5 w-5" /></div>
          <div><p className="text-lg font-semibold">Set a new password</p><p className="text-sm text-text-3">Use at least 10 characters.</p></div>
        </div>
        <div className="flex flex-col gap-4">
          <Field label="Current password" error={errors.currentPassword}>{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
          <Field label="New password" error={errors.newPassword}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
          <Field label="Type it again" error={errors.confirm}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
          {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{errors.form}</p>}
          <Button type="submit" size="lg" loading={busy}>Save password</Button>
        </div>
      </form>
    </main>
  );
}
