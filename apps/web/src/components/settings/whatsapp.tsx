'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { whatsappSettingsSchema } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { api, newIdempotencyKey } from '@/lib/api';
import { Section, Toggle } from './common';

interface Template {
  key: 'booking_confirmation' | 'check_in_welcome' | 'checkout_reminder' | 'invoice' | 'receipt';
  language: 'en' | 'hi'; name: string; languageCode: string; active: boolean;
  label: string; body: string; variables: string[]; documentHeader: boolean;
  approval?: string; matching?: boolean; ready?: boolean;
}
interface Setup {
  enabled: boolean; templates: Template[]; checkedAt?: string; propertyId: string; version: number;
  configured: boolean; webhookConfigured: boolean; jobsEnabled: boolean;
}

export function WhatsAppSettings() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['whatsapp-settings'], queryFn: () => api<Setup>('/whatsapp-settings') });
  const [form, setForm] = useState<Setup | null>(null);
  const [selected, setSelected] = useState(0);
  const saveKey = useRef(newIdempotencyKey());
  useEffect(() => { if (data.data) setForm(data.data); }, [data.data]);
  const save = useMutation({
    mutationFn: () => api('/whatsapp-settings', { method: 'POST', idempotencyKey: saveKey.current, body: whatsappSettingsSchema.parse(form) }),
    onSuccess: async () => { saveKey.current = newIdempotencyKey(); await qc.invalidateQueries({ queryKey: ['whatsapp-settings'] }); await qc.invalidateQueries({ queryKey: ['whatsapp-availability'] }); },
  });
  const check = useMutation({
    mutationFn: () => api<Setup>('/whatsapp-settings/check-templates', { method: 'POST', body: {} }),
    onSuccess: value => { qc.setQueryData(['whatsapp-settings'], value); },
  });
  if (data.error) return <ErrorBanner message={(data.error as Error).message} />;
  if (!form) return <Skeleton className="h-64" />;
  const current = form.templates[selected];
  const edit = (patch: Partial<Template>) => setForm({ ...form, templates: form.templates.map((t, i) => i === selected ? { ...t, ...patch } : t) });
  return (
    <Section title="WhatsApp" description="Hotel messages through your registered Meta number. Email continues through Resend."
      action={<Button loading={save.isPending} onClick={() => save.mutate()}>Save WhatsApp settings</Button>}>
      <div className="flex flex-col gap-4 p-4">
        {!form.configured && <p className="text-sm text-text-2">Server setup is pending. Your operator needs this property ID: <code className="break-all">{form.propertyId}</code>. Access tokens and app secrets belong in Railway.</p>}
        {!form.jobsEnabled && <p className="text-sm text-text-2">The background message sender is off on this server.</p>}
        <Toggle label="Send WhatsApp messages to guests who have agreed" checked={form.enabled} onChange={v => setForm({ ...form, enabled: v })} />
        <p className="text-sm text-text-2">Reception records the guest’s WhatsApp agreement in the booking’s Messages panel. Having a phone number alone does not enable sending.</p>
        {current && <>
          <Field label="Message">{id => <Select id={id} value={selected} onChange={e => setSelected(Number(e.target.value))}>
            {form.templates.map((t, i) => <option key={t.key + t.language} value={i}>{t.label} · {t.language === 'hi' ? 'Hindi' : 'English'}</option>)}
          </Select>}</Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Meta template name">{id => <Input id={id} value={current.name} onChange={e => edit({ name: e.target.value, ready: false })} />}</Field>
            <Field label="Meta language code">{id => <Input id={id} value={current.languageCode} onChange={e => edit({ languageCode: e.target.value, ready: false })} />}</Field>
          </div>
          <Toggle label="Use this message" checked={current.active} onChange={v => edit({ active: v })} />
          <p className="text-sm text-text-2">Create a Utility template in WhatsApp Manager using this exact body. {current.documentHeader ? 'Choose a Document header and provide a sample PDF.' : 'Choose no header.'} Leave footer and buttons empty.</p>
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-4 text-sm">{current.body}</pre>
          <p className="text-xs text-text-3">{current.variables.map((v, i) => '{{' + (i + 1) + '}} = ' + v.replaceAll('_', ' ')).join(' · ')}</p>
          <p role="status" className="text-sm text-text-2">{current.approval ?? 'NOT_CHECKED'}{current.approval === 'APPROVED' && !current.matching ? ' — wording or header needs correction' : current.ready ? ' — ready' : ''}</p>
        </>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" disabled={!form.configured} loading={check.isPending} onClick={() => check.mutate()}>Check Meta template approval</Button>
          {form.checkedAt && <span className="text-xs text-text-3">Checked {new Date(form.checkedAt).toLocaleString('en-IN')}</span>}
        </div>
        {save.isSuccess && <p role="status" className="text-sm text-text-2">WhatsApp settings saved.</p>}
        {(save.error || check.error) && <ErrorBanner message={((save.error || check.error) as Error).message} />}
        <p className="text-xs text-text-3">Save template names before checking approval. “Sent” means Meta accepted it; “Delivered” confirms delivery. Incoming chat replies are not displayed in ResortOS.</p>
      </div>
    </Section>
  );
}
