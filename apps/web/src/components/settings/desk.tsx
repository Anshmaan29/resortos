'use client';
import { useQuery } from '@tanstack/react-query';
import { Monitor } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import { Row, Section, useSave } from './common';

interface Device { id: string; name: string; createdAt: string; lastSeenAt: string | null; revokedAt: string | null; createdBy: string }

/**
 * Shared desk computers (spec §5.3). On one, staff who logged in with their password earlier that day
 * switch in with their PIN. The owner marks the computer they are sitting at.
 */
export function DeskSettings() {
  const devices = useQuery({ queryKey: ['desk-devices'], queryFn: () => api<Device[]>('/desk/devices') });
  const status = useQuery({ queryKey: ['desk'], queryFn: () => api<{ trusted: boolean; device?: { name: string } }>('/desk') });
  const [name, setName] = useState('Reception');
  const trust = useSave(() => api('/desk/trust', { method: 'POST', body: { name } }), { invalidate: [['desk-devices'], ['desk']], success: 'This computer is now a shared desk' });
  const revoke = useSave((id: string) => api(`/desk/devices/${id}/revoke`, { method: 'POST', body: {} }), { invalidate: [['desk-devices'], ['desk']], success: 'Desk removed — its PIN sessions have ended' });
  if (!devices.data || !status.data) return <Skeleton className="h-64" />;
  return (
    <div className="flex flex-col gap-5">
      <Section title="This computer" description="Only mark a computer that stays at the reception desk.">
        <div className="p-4">
          {status.data.trusted ? (
            <p className="flex items-center gap-2 text-sm"><Monitor className="h-4 w-4 text-brand" />This computer is the shared desk “{status.data.device?.name}”.</p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              {trust.error && <ErrorBanner message={(trust.error as Error).message} />}
              <Field label="Name this computer" className="w-64">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}</Field>
              <Button loading={trust.isPending} disabled={!name.trim()} onClick={() => trust.mutate(undefined)}>Make this a shared desk</Button>
            </div>
          )}
        </div>
      </Section>
      <Section title="Shared desks" description="Removing a desk ends every PIN session on it at once.">
        {devices.data.length === 0 && <p className="px-4 py-6 text-sm text-text-3">None yet.</p>}
        {devices.data.map((d) => (
          <Row key={d.id} muted={Boolean(d.revokedAt)}>
            <span><span className="font-medium">{d.name}</span> <span className="text-text-3">added by {d.createdBy}{d.lastSeenAt ? ` · last used ${new Date(d.lastSeenAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</span>{d.revokedAt && <span className="ml-2"><Pill>Removed</Pill></span>}</span>
            {!d.revokedAt && <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === d.id} onClick={() => revoke.mutate(d.id)}>Remove</Button>}
          </Row>
        ))}
      </Section>
    </div>
  );
}

/** Your own quick-switch PIN, for everyone. */
export function MyPinSettings() {
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const save = useSave(() => api('/auth/staff-pin', { method: 'POST', body: { password, pin } }), {
    invalidate: [['users']], success: 'PIN saved', onDone: () => { setPassword(''); setPin(''); },
  });
  return (
    <Section title="My desk PIN" description="On a shared desk, after your first password login of the day, you can switch in with this 4–6 digit PIN.">
      <div className="flex max-w-sm flex-col gap-4 p-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        <Field label="New PIN" hint="4 to 6 digits, not all the same, not a sequence" error={save.fields.pin}>{(id) => <Input id={id} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />}</Field>
        <Field label="Your password" hint="To prove it is you">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button loading={save.isPending} disabled={pin.length < 4 || !password} onClick={() => save.mutate(undefined)}>Save PIN</Button>
      </div>
    </Section>
  );
}
