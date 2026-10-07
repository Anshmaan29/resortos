'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { api, newIdempotencyKey } from '@/lib/api';
import { Section, Toggle, useSave } from './common';

export interface EmailSetup {
  enabled: boolean; fromName: string; fromAddress: string; replyTo: string;
  dailySummaryRecipients: string[]; version: number;
  provider: 'resend' | 'dev' | 'off'; jobsEnabled: boolean; webhookConfigured: boolean; readyToSend: boolean;
}

export function EmailSetupSettings() {
  const data = useQuery({ queryKey: ['email-settings'], queryFn: () => api<EmailSetup>('/email-settings') });
  const [form, setForm] = useState<EmailSetup | null>(null);
  const [recipients, setRecipients] = useState('');
  const key = useRef(newIdempotencyKey());
  useEffect(() => { if (data.data) { setForm(data.data); setRecipients(data.data.dailySummaryRecipients.join(', ')); } }, [data.data]);
  const save = useSave(() => api('/email-settings', {
    method: 'PUT', idempotencyKey: key.current,
    body: { ...form, dailySummaryRecipients: recipients.split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean) },
  }), { invalidate: [['email-settings'], ['property']], success: 'Email settings saved', onDone: () => { key.current = newIdempotencyKey(); } });
  if (data.error) return <ErrorBanner message={data.error.message} />;
  if (!form || !data.data) return <Skeleton className="h-52" />;
  const update = (field: 'fromName' | 'fromAddress' | 'replyTo', value: string) => setForm({ ...form, [field]: value });
  return <Section title="Email setup" description="Use a sender on the domain you verify in Resend."
    action={<Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save email settings</Button>}>
    <div className="flex flex-col gap-4 p-4">
      {save.error && <ErrorBanner message={save.error.message} />}
      <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-text-2">
        {data.data.provider === 'dev' ? 'Practice mode: emails are recorded locally. No email reaches a guest.'
          : data.data.provider === 'off' ? 'Resend is not connected. Your administrator needs to configure it on the server.'
          : !data.data.jobsEnabled ? 'Resend is configured, but automatic sending is stopped on the server.'
          : !data.data.fromAddress ? 'Add your sender address below to complete email setup.'
          : 'Resend is configured. Send a test below and confirm its delivery before enabling guest emails.'}
        {data.data.provider === 'resend' && !data.data.webhookConfigured && ' Delivery reports still need to be connected.'}
      </p>
      <Toggle label="Send guest emails" hint="Booking confirmation, welcome, reminders, invoices and receipts"
        checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sender name" error={save.fields.fromName}>{(id) => <Input id={id} value={form.fromName} maxLength={80} onChange={(e) => update('fromName', e.target.value)} />}</Field>
        <Field label="Sender email" hint="For example, reception@yourdomain.com" error={save.fields.fromAddress}>{(id) => <Input id={id} type="email" value={form.fromAddress} onChange={(e) => update('fromAddress', e.target.value)} />}</Field>
        <Field label="Reply to" hint="Where guest replies should arrive" error={save.fields.replyTo}>{(id) => <Input id={id} type="email" value={form.replyTo} onChange={(e) => update('replyTo', e.target.value)} />}</Field>
        <Field label="Daily summary recipients" hint="Separate addresses with commas. Leave blank to stop summaries." error={Object.entries(save.fields).find(([k]) => k.startsWith('dailySummaryRecipients'))?.[1]}>{(id) => <Input id={id} value={recipients} onChange={(e) => setRecipients(e.target.value)} />}</Field>
      </div>
    </div>
  </Section>;
}
