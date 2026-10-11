'use client';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ErrorBanner } from '@/components/ui/surface';
import { api } from '@/lib/api';
import { Section } from './common';

/** Codes are shown once, kept out of the query cache and cleared on leaving this screen. */
export function OwnerSecuritySettings() {
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function generate(e: FormEvent) {
    e.preventDefault();
    if (!window.confirm('Generate new recovery codes? Any previous unused codes will stop working.')) return;
    setBusy(true); setError(null); setCodes([]);
    try {
      const result = await api<{ codes: string[] }>('/auth/recovery-codes', { method: 'POST', body: { password } });
      setCodes(result.codes);
    } catch (e) { setError((e as Error).message); }
    finally { setPassword(''); setBusy(false); }
  }
  function download() {
    const blob = new Blob(['ResortOS owner recovery codes\nKeep this file private and off the reception computer. Each code works once.\n\n' + codes.join('\n') + '\n\nUse the Owner account recovery link on the login screen.\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'resortos-owner-recovery-codes.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <Section title="Owner recovery codes" description="Keep a private copy away from the reception computer. A code resets your password and ends all existing sessions. Staff should ask the owner to reset their password.">
    <div className="flex flex-col gap-4 p-4">
      {error && <ErrorBanner message={error} />}
      {codes.length ? <>
        <p role="status" className="text-sm">These codes are shown once. Download them before leaving, then hide them.</p>
        <ul aria-label="Private owner recovery codes" className="grid max-w-sm grid-cols-2 gap-2 rounded-md bg-surface-2 p-4 font-mono text-sm">{codes.map(code => <li key={code}>{code}</li>)}</ul>
        <div className="flex flex-wrap gap-3"><Button onClick={download}>Download private codes</Button><Button variant="outline" onClick={() => setCodes([])}>Hide codes</Button></div>
      </> : <form onSubmit={generate} className="flex max-w-sm flex-col gap-4">
        <Field label="Your password" hint="Confirm the owner's password to create a new set">{id => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />}</Field>
        <Button type="submit" loading={busy} disabled={!password}>Generate recovery codes</Button>
      </form>}
    </div>
  </Section>;
}
