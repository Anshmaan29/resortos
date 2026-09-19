'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useProperty } from '@/lib/session';
import { Section, Toggle, useSave } from './common';

interface Template {
  key: string; label: string; language: 'en' | 'hi'; subject: string; body: string; isActive: boolean; isCustom: boolean;
  defaultSubject: string; defaultBody: string;
}

const render = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, n: string) => vars[n] ?? '');

/**
 * Guest message wording (spec §40), in English and Hindi. Only the listed variables can be used —
 * there is no variable for a guest's phone, address or ID, so none can ever reach a message.
 */
export function MessageSettings() {
  const property = useProperty();
  const data = useQuery({ queryKey: ['message-templates'], queryFn: () => api<{ variables: string[]; templates: Template[] }>('/message-templates') });
  const sample = useQuery({ queryKey: ['message-sample'], queryFn: () => api<Record<string, string>>('/message-templates/sample') });
  const [key, setKey] = useState('booking_confirmation');
  const [language, setLanguage] = useState<'en' | 'hi'>('en');
  const current = useMemo(() => data.data?.templates.find((t) => t.key === key && t.language === language), [data.data, key, language]);
  const [f, setF] = useState<{ subject: string; body: string; isActive: boolean } | null>(null);
  const [testTo, setTestTo] = useState('');
  useEffect(() => { if (current) setF({ subject: current.subject, body: current.body, isActive: current.isActive }); }, [current]);
  useEffect(() => { if (!testTo && property.data?.email) setTestTo(property.data.email); }, [property.data, testTo]);

  const save = useSave(() => api(`/message-templates/${key}/${language}`, { method: 'PUT', body: f }), { invalidate: [['message-templates']], success: 'Wording saved' });
  const test = useSave(() => api(`/message-templates/${key}/${language}/test`, { method: 'POST', body: { to: testTo } }), { invalidate: [], success: `Test sent to ${testTo}` });

  if (!data.data || !f || !current) return <Skeleton className="h-96" />;
  const keys = [...new Set(data.data.templates.map((t) => t.key))];
  const emailOn = property.data?.policies.emailEnabled;
  return (
    <div className="flex flex-col gap-5">
      {!emailOn && (
        <p className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-text-2">
          Guest email is switched off. Messages are still recorded as “skipped” on each stay, so you can see what would have gone. Switch it on in Policies once your sending domain is verified.
        </p>
      )}
      <Section title="Guest messages" description="Sent by email now; WhatsApp will use the same wording once Meta verification is done."
        action={<Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save wording</Button>}>
        <div className="grid gap-4 p-4 lg:grid-cols-[1fr_1fr]">
          <div className="flex flex-col gap-4">
            {save.error && <ErrorBanner message={(save.error as Error).message} />}
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field label="Message">{(id) => <Select id={id} value={key} onChange={(e) => setKey(e.target.value)}>{keys.map((k) => <option key={k} value={k}>{data.data!.templates.find((t) => t.key === k)!.label}</option>)}</Select>}</Field>
              <div className="flex items-end gap-1 rounded-lg" role="radiogroup" aria-label="Language">
                {(['en', 'hi'] as const).map((l) => (
                  <button key={l} type="button" role="radio" aria-checked={language === l} onClick={() => setLanguage(l)}
                    className={cn('h-11 rounded-md px-3 text-sm', language === l ? 'bg-brand-soft font-medium text-brand' : 'text-text-2 hover:bg-surface-2')}>{l === 'en' ? 'English' : 'हिन्दी'}</button>
                ))}
              </div>
            </div>
            <Field label="Subject" error={save.fields.subject}>{(id) => <Input id={id} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} maxLength={200} />}</Field>
            <Field label="Message" error={save.fields.body}>{(id) => <Textarea id={id} rows={12} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={4000} className="font-mono text-sm" />}</Field>
            <Toggle label="Send this message" checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
            <div className="flex flex-wrap items-center gap-2">
              {current.isCustom ? <Pill tone="brand">Your wording</Pill> : <Pill>Built-in wording</Pill>}
              <Button size="sm" variant="ghost" onClick={() => setF({ subject: current.defaultSubject, body: current.defaultBody, isActive: true })}>Use built-in wording</Button>
            </div>
            <div>
              <p className="mb-1.5 text-sm font-medium text-text-2">Variables</p>
              <div className="flex flex-wrap gap-1.5">{data.data.variables.map((v) => (
                <button key={v} type="button" onClick={() => setF({ ...f, body: `${f.body}{{${v}}}` })} className="rounded bg-surface-2 px-2 py-1 font-mono text-xs text-text-2 hover:bg-surface-3">{`{{${v}}}`}</button>
              ))}</div>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-text-2">Preview with sample details</p>
            <div className="rounded-xl border border-border bg-surface-2 p-4">
              <p className="text-sm font-semibold">{render(f.subject, sample.data ?? {})}</p>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{render(f.body, sample.data ?? {})}</p>
            </div>
            <div className="flex items-end gap-2">
              <Field label="Send a test to" className="flex-1">{(id) => <Input id={id} type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />}</Field>
              <Button variant="outline" loading={test.isPending} disabled={!testTo} onClick={() => test.mutate(undefined)}>Send test</Button>
            </div>
            {test.error && <ErrorBanner message={(test.error as Error).message} />}
            <p className="text-xs text-text-3">A test uses the saved wording, so save first. It goes through Resend exactly as a guest message would.</p>
          </div>
        </div>
      </Section>
    </div>
  );
}
