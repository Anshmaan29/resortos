'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, RotateCw, Send } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Card, CardHeader, ErrorBanner } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

interface Message {
  id: string; templateKey: string; templateLabel: string; recipient: string; subject: string | null; body: string; status: string;
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
  const key = ['messages', stayId ?? reservationId];
  const list = useQuery({ queryKey: key, queryFn: () => api<Message[]>('/messages', { query: { stayId, reservationId } }), refetchInterval: 15_000 });
  const resend = useMutation({
    mutationFn: (id: string) => api<Message>(`/messages/${id}/resend`, { method: 'POST', body: {} }),
    onSuccess: (m) => { void qc.invalidateQueries({ queryKey: key }); toast(m.status === 'skipped' ? 'error' : 'success', m.status === 'skipped' ? `Not sent: ${m.skipReason}` : 'Sending again'); },
  });
  const send = useMutation({
    mutationFn: (templateKey: string) => api<Message>('/messages/send', { method: 'POST', body: { templateKey, stayId, reservationId } }),
    onSuccess: (m) => { void qc.invalidateQueries({ queryKey: key }); toast(m.status === 'skipped' ? 'error' : 'success', m.status === 'skipped' ? `Not sent: ${m.skipReason}` : 'Message queued'); },
  });
  const messages = list.data ?? [];
  return (
    <Card>
      <CardHeader title="Messages" description="Email to the guest. A failed message never affects the booking or the bill."
        action={<Button size="sm" variant="outline" loading={send.isPending} onClick={() => send.mutate(stayId ? 'check_in_welcome' : 'booking_confirmation')}>
          <Send className="h-4 w-4" aria-hidden />{stayId ? 'Send welcome' : 'Send confirmation'}</Button>} />
      {list.isError && <div className="p-4"><ErrorBanner message={(list.error as Error).message} /></div>}
      {messages.length === 0 ? <p className="border-t border-border px-4 py-5 text-sm text-text-3">Nothing sent yet.</p> : (
        <ul className="border-t border-border">
          {messages.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm last:border-0">
              <button type="button" className="min-w-0 text-left" onClick={() => setOpen(m)}>
                <span className="flex flex-wrap items-center gap-2"><Mail className="h-4 w-4 text-text-3" aria-hidden /><span className="font-medium">{m.templateLabel}</span><Pill tone={STATUS[m.status]?.tone ?? 'neutral'}>{STATUS[m.status]?.label ?? m.status}</Pill></span>
                <span className="mt-0.5 block text-xs text-text-3">
                  {m.recipient || 'no email'} · {new Date(m.sentAt ?? m.queuedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                  {m.status === 'skipped' && m.skipReason ? ` · ${m.skipReason}` : ''}
                  {['failed', 'bounced', 'queued'].includes(m.status) && m.lastError ? ` · ${m.lastError}` : ''}
                  {m.status === 'queued' && new Date(m.sendAfter) > new Date() ? ` · after ${new Date(m.sendAfter).toLocaleTimeString('en-IN', { timeStyle: 'short' })}` : ''}
                </span>
              </button>
              {['failed', 'bounced', 'skipped', 'sent', 'delivered', 'opened'].includes(m.status) && m.trigger !== 'test' && (
                <Button size="sm" variant="ghost" loading={resend.isPending && resend.variables === m.id} onClick={() => resend.mutate(m.id)}><RotateCw className="h-4 w-4" aria-hidden />Resend</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <Dialog open onClose={() => setOpen(null)} title={open.subject ?? open.templateLabel} description={`To ${open.recipient || '—'}`}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{open.body}</p>
        </Dialog>
      )}
    </Card>
  );
}
