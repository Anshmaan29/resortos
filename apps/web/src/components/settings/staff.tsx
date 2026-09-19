'use client';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import { Row, Section, Toggle, useSave } from './common';

interface StaffUser {
  id: string; fullName: string; username: string; mobile: string | null; role: 'owner' | 'receptionist' | 'cleaner'; isActive: boolean;
  mustChangePassword: boolean; discountLimitPercent: string; canRunNightAudit: boolean; hasOwnerPin: boolean; hasStaffPin: boolean;
}

/** Staff accounts and receptionist limits (spec §4). No manager role: the owner, the desk, and optional cleaners. */
export function StaffSettings() {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<StaffUser[]>('/users') });
  const [edit, setEdit] = useState<StaffUser | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<StaffUser | null>(null);
  const active = useSave(({ id, isActive }: { id: string; isActive: boolean }) => api(`/users/${id}/active`, { method: 'PATCH', body: { isActive } }), { invalidate: [['users']], success: 'Saved' });
  if (!users.data) return <Skeleton className="h-96" />;
  return (
    <Section title="Staff" description="Each person logs in as themselves. The discount limit is enforced by the server; beyond it the owner’s PIN is needed."
      action={<Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden />Add person</Button>}>
      {users.data.map((u) => (
        <Row key={u.id} muted={!u.isActive}>
          <span>
            <span className="font-medium">{u.fullName}</span> <span className="text-text-3">@{u.username} · {u.role}</span>
            {u.role === 'receptionist' && <span className="text-text-3"> · discounts up to {Number(u.discountLimitPercent)}%</span>}
            {u.mustChangePassword && <span className="ml-2"><Pill tone="warning">Must set a password</Pill></span>}
            {!u.hasStaffPin && u.isActive && <span className="ml-2"><Pill>No desk PIN</Pill></span>}
            {!u.isActive && <span className="ml-2"><Pill>Off</Pill></span>}
          </span>
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEdit(u)}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={() => setResetting(u)}>Reset password</Button>
            {u.role !== 'owner' && <Button size="sm" variant="ghost" onClick={() => active.mutate({ id: u.id, isActive: !u.isActive })}>{u.isActive ? 'Switch off' : 'Switch on'}</Button>}
          </span>
        </Row>
      ))}
      {edit && <EditUser user={edit} onClose={() => setEdit(null)} />}
      {adding && <AddUser onClose={() => setAdding(false)} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
    </Section>
  );
}

function EditUser({ user, onClose }: { user: StaffUser; onClose: () => void }) {
  const [f, setF] = useState({ fullName: user.fullName, mobile: user.mobile ?? '', discountLimitPercent: user.discountLimitPercent, canRunNightAudit: user.canRunNightAudit });
  const save = useSave(() => api(`/users/${user.id}`, { method: 'PATCH', body: f }), { invalidate: [['users']], success: 'Saved', onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={`Edit ${user.fullName}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        <Field label="Name" required error={save.fields.fullName}>{(id) => <Input id={id} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />}</Field>
        <Field label="Mobile" error={save.fields.mobile}>{(id) => <Input id={id} value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />}</Field>
        {user.role === 'receptionist' && <>
          <Field label="Discount limit (%)" hint="Above this, the owner authorises with their PIN" error={save.fields.discountLimitPercent}>{(id) => <Input id={id} inputMode="decimal" value={f.discountLimitPercent} onChange={(e) => setF({ ...f, discountLimitPercent: e.target.value })} />}</Field>
          <Toggle label="May run night audit" hint="Also needs the property-wide setting in Policies" checked={f.canRunNightAudit} onChange={(v) => setF({ ...f, canRunNightAudit: v })} />
        </>}
      </div>
    </Dialog>
  );
}

function AddUser({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ fullName: '', username: '', mobile: '', role: 'receptionist', temporaryPassword: '', discountLimitPercent: '10' });
  const save = useSave(() => api('/users', { method: 'POST', body: { ...f, mobile: f.mobile || undefined } }), { invalidate: [['users']], success: 'Account created — they set their own password on first login', onDone: onClose });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onClose={onClose} title="Add a person" description="They must choose their own password the first time they log in."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!f.fullName || !f.username || !f.temporaryPassword} onClick={() => save.mutate(undefined)}>Create account</Button></>}>
      <div className="flex flex-col gap-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        <Field label="Name" required error={save.fields.fullName}>{(id) => <Input id={id} value={f.fullName} onChange={set('fullName')} />}</Field>
        <Field label="Username" required hint="Lowercase letters, numbers, dot" error={save.fields.username}>{(id) => <Input id={id} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} />}</Field>
        <Field label="Mobile" error={save.fields.mobile}>{(id) => <Input id={id} value={f.mobile} onChange={set('mobile')} />}</Field>
        <Field label="Role">{(id) => <Select id={id} value={f.role} onChange={set('role')}><option value="receptionist">Receptionist</option><option value="cleaner">Cleaner (tasks only)</option><option value="owner">Owner</option></Select>}</Field>
        <Field label="Temporary password" required error={save.fields.temporaryPassword}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={f.temporaryPassword} onChange={set('temporaryPassword')} />}</Field>
        {f.role === 'receptionist' && <Field label="Discount limit (%)">{(id) => <Input id={id} inputMode="decimal" value={f.discountLimitPercent} onChange={set('discountLimitPercent')} />}</Field>}
      </div>
    </Dialog>
  );
}

function ResetPassword({ user, onClose }: { user: StaffUser; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const save = useSave(() => api(`/users/${user.id}/reset-password`, { method: 'POST', body: { temporaryPassword: pw } }), { invalidate: [['users']], success: 'Password reset — they choose a new one at next login', onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={`Reset ${user.fullName}’s password`} description="Their sessions end, and they must set a new password when they next log in."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!pw} onClick={() => save.mutate(undefined)}>Reset</Button></>}>
      <div className="flex flex-col gap-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        <Field label="Temporary password" required>{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}
