'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, RotateCw, Send } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Card, CardHeader, ErrorBanner } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, newIdempotencyKey } from '@/lib/api';

interface Message {
  id: string; channel: 'email' | 'whatsapp'; templateKey: string; templateLabel: string; recipient: string; subject: string | null; body: string; status: string;
  skipReason: string | null; lastError: string | null; attempts: number; queuedAt: string; sentAt: string | null; deliveredAt: string | null;
  sendAfter: string; trigger: string; resendOf: string | null;
}

const STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'warning' | 'danger' | 'info' }> = {
  queued: { label: 'Waiting to send', tone: 'info' }, sending: { label: 'Sending', tone: 'info' }, sent: { label: 'Sent', tone: 'brand' },
  delivered: { label: 'Delivered', tone: 'brand' }, opened: { label: 'Opened', tone: 'brand' }, bounced: { label: 'Bounced', tone: 'danger' },
  complained: { label: 'Marked as spam', tone: 'danger' }, failed: { label: 'Failed', tone: 'danger' }, skipped: { label: 'Not sent', tone: 'neutral' },
};

/**
 * Every message for a stay or booking (spec §40): what went, what did not and why, with Resend. A
 * message that failed never touched the booking or the bill; this is where the desk sees it.
 */
export function MessagesPanel({ stayId, reservationId }: { stayId?: string; reservationId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<Message | null>(null);
  const [channel,setChannel] = useState<'email'|'whatsapp'>('email');
  const availability = useQuery({queryKey:['whatsapp-availability'],queryFn:()=>api<{enabled:boolean;configured:boolean}>('/whatsapp-availability')});
  const consent = useQuery({queryKey:['whatsapp-consent',stayId ?? reservationId],queryFn:()=>api<{optedIn:boolean;version:number}>('/whatsapp-consent',{query:{stayId,reservationId}}),enabled:Boolean(availability.data?.configured)});
  const consentKey = useRef(newIdempotencyKey());
  const saveConsent = useMutation({
    mutationFn:(optedIn:boolean)=>api('/whatsapp-consent',{method:'POST',idempotencyKey:consentKey.current,body:{stayId,reservationId,optedIn,version:consent.data?.version}}),
    onSuccess:()=>{consentKey.current=newIdempotencyKey();void qc.invalidateQueries({queryKey:['whatsapp-consent',stayId ?? reservationId]});},
  });
  const key = ['messages', stayId ?? reservationId];
  const list = useQuery({ queryKey: key, queryFn: () => api<Message[]>('/messages', { query: { stayId, reservationId } }), refetchInterval: 15_000 });
  const resendKey = useRef(newIdempotencyKey());
  const sendKey = useRef(newIdempotencyKey());
  const resend = useMutation({
    mutationFn: (id: string) => api<Message>(`/messages/${id}/resend`, { method: 'POST', idempotencyKey:resendKey.current, body: {} }),
    onSuccess: (m) => { resendKey.current=newIdempotencyKey(); void qc.invalidateQueries({ queryKey: key }); toast(m.status === 'skipped' ? 'error' : 'success', m.status === 'skipped' ? `Not sent: ${m.skipReason}` : 'Sending again'); },
  });
  const send = useMutation({
    mutationFn: (templateKey: string) => api<Message>('/messages/send', { method: 'POST', idempotencyKey:sendKey.current, body: { channel, templateKey, stayId, reservationId } }),
    onSuccess: (m) => { sendKey.current=newIdempotencyKey(); void qc.invalidateQueries({ queryKey: key }); toast(m.status === 'skipped' ? 'error' : 'success', m.status === 'skipped' ? `Not sent: ${m.skipReason}` : 'Message queued'); },
  });
  const messages = list.data ?? [];
  return (
    <Card>
      <CardHeader title="Messages" description="Email and WhatsApp to the guest. A failed message never affects the booking or the bill."
        action={<Button size="sm" variant="outline" loading={send.isPending} onClick={() => send.mutate(stayId ? 'check_in_welcome' : 'booking_confirmation')}>
          <Send className="h-4 w-4" aria-hidden />{stayId ? 'Send welcome' : 'Send confirmation'}</Button>} />
      {availability.data?.configured && <div className="flex flex-col gap-3 border-t border-border p-4 text-sm">
        <label className="flex items-center gap-2">Send using
          <select aria-label="Message channel" className="rounded border border-border bg-surface-2 p-2" value={channel} onChange={e=>{setChannel(e.target.value as 'email'|'whatsapp');sendKey.current=newIdempotencyKey();}}>
            <option value="email">Email</option><option value="whatsapp" disabled={!availability.data.enabled}>WhatsApp</option>
          </select>
        </label>
        {consent.data && <label className="flex items-start gap-2">
          <input type="checkbox" checked={consent.data.optedIn} disabled={saveConsent.isPending} onChange={e=>saveConsent.mutate(e.target.checked)} />
          The guest has agreed to receive booking, stay and payment messages from this hotel on WhatsApp.
        </label>}
        {saveConsent.error && <ErrorBanner message={(saveConsent.error as Error).message} />}
        {!availability.data.enabled && <p className="text-text-3">WhatsApp is switched off in Settings.</p>}
      </div>}
      {(send.error || resend.error) && <div className="p-4"><ErrorBanner message={((send.error || resend.error) as Error).message}/></div>}
      {list.isError && <div className="p-4"><ErrorBanner message={(list.error as Error).message} /></div>}
      {messages.length === 0 ? <p className="border-t border-border px-4 py-5 text-sm text-text-3">Nothing sent yet.</p> : (
        <ul className="border-t border-border">
          {messages.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm last:border-0">
              <button type="button" className="min-w-0 text-left" onClick={() => setOpen(m)}>
                <span className="flex flex-wrap items-center gap-2"><Mail className="h-4 w-4 text-text-3" aria-hidden /><span className="font-medium">{m.templateLabel}</span><span className="text-xs text-text-3">{m.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}</span><Pill tone={STATUS[m.status]?.tone ?? 'neutral'}>{m.channel === 'whatsapp' && m.status === 'opened' ? 'Read' : STATUS[m.status]?.label ?? m.status}</Pill></span>
                <span className="mt-0.5 block text-xs text-text-3">
                  {m.channel === 'whatsapp' ? (m.recipient ? '••••' + m.recipient.slice(-4) : 'no phone') : m.recipient || 'no email'} · {new Date(m.sentAt ?? m.queuedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                  {m.status === 'skipped' && m.skipReason ? ` · ${m.skipReason}` : ''}
                  {['failed', 'bounced', 'queued'].includes(m.status) && m.lastError ? ` · ${m.lastError}` : ''}
                  {m.status === 'queued' && new Date(m.sendAfter) > new Date() ? ` · after ${new Date(m.sendAfter).toLocaleTimeString('en-IN', { timeStyle: 'short' })}` : ''}
                </span>
              </button>
              {['failed', 'bounced', 'skipped', 'sent', 'delivered', 'opened'].includes(m.status) && m.trigger !== 'test' && (
                <Button size="sm" variant="ghost" loading={resend.isPending && resend.variables === m.id} onClick={() => { if (!m.lastError?.includes('uncertain') || window.confirm('Delivery is uncertain. Check Meta first. Sending again could duplicate this message. Continue?')) resend.mutate(m.id); }}><RotateCw className="h-4 w-4" aria-hidden />Resend</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <Dialog open onClose={() => setOpen(null)} title={open.subject ?? open.templateLabel} description={open.channel === 'whatsapp' ? 'WhatsApp · ••••' + open.recipient.slice(-4) : `To ${open.recipient || '—'}`}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{open.body}</p>
        </Dialog>
      )}
    </Card>
  );
}
