'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Printer, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatDateTime } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { Card, CardHeader, EmptyState } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, newIdempotencyKey } from '@/lib/api';
import type { GrcList, GrcVersion, StayDetail } from '@/lib/types';

const METHOD_LABEL: Record<GrcVersion['signatureMethod'], string> = {
  not_collected: 'Signature not collected',
  touchscreen: 'Signed on the reception touchscreen',
  phone: 'Signed on a phone',
  paper_scan: 'Signed on paper, scanned back in',
};

/**
 * Guest registration card (spec §20). Printing the first time generates and stores the card;
 * printing again opens the stored file, so a reprint never creates a new version. A regeneration
 * is a deliberate, reasoned action and is kept alongside the card it replaces.
 */
export function RegistrationCard({ stay }: { stay: StayDetail }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [regenerateOpen, setRegenerateOpen] = useState(false);

  const list = useQuery({ queryKey: ['grc', stay.id], queryFn: () => api<GrcList>(`/stays/${stay.id}/grc`) });
  const current = list.data?.current ?? null;

  const openCard = useMutation({
    mutationFn: async (grcId: string) => api<{ url: string }>(`/grc-documents/${grcId}/view-url`),
    // Opened in a new tab: the browser's own PDF viewer is the print dialog staff already know.
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
    onError: (e) => toast('error', (e as Error).message),
  });

  const printKey = useRef(newIdempotencyKey());
  const generate = useMutation({
    mutationFn: () => api<{ grc: GrcVersion; created: boolean }>(`/stays/${stay.id}/grc`, { method: 'POST', body: {}, idempotencyKey: printKey.current }),
    onSuccess: async ({ grc, created }) => {
      printKey.current = newIdempotencyKey();
      await qc.invalidateQueries({ queryKey: ['grc', stay.id] });
      if (created) toast('success', `Registration card ${grc.number} created`);
      openCard.mutate(grc.id);
    },
    onError: (e) => toast('error', (e as Error).message),
  });

  return (
    <Card>
      <CardHeader
        title="Registration card"
        description={current ? `${current.number} · version ${current.version}` : 'Not created yet'}
        action={current && (
          <Button variant="ghost" size="sm" onClick={() => setRegenerateOpen(true)}><RefreshCw className="h-4 w-4" />New version</Button>
        )}
      />
      {list.isLoading ? (
        <div className="px-5 py-4 text-sm text-text-3">Loading…</div>
      ) : !current ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title="No registration card yet"
          description="The card includes a signature if one was collected. You can also print it without a signature."
          action={<Button loading={generate.isPending} onClick={() => generate.mutate()}><Printer className="h-4 w-4" />Create and print</Button>}
        />
      ) : (
        <div className="flex flex-col gap-4 p-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Button loading={generate.isPending || openCard.isPending} onClick={() => openCard.mutate(current.id)}>
              <Printer className="h-4 w-4" />Print
            </Button>
            <Pill tone="neutral">{METHOD_LABEL[current.signatureMethod]}</Pill>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <div><dt className="text-text-3">Signed</dt><dd className="mt-0.5 num">{current.signedAt ? formatDateTime(current.signedAt) : 'Not collected'}</dd></div>
            <div><dt className="text-text-3">Created</dt><dd className="mt-0.5 num">{formatDateTime(current.generatedAt)}</dd></div>
          </dl>
          <div>
            <p className="text-text-3">Checksum (SHA-256)</p>
            {/* The stored hash is shown in full: it is what proves the archived file has not changed. */}
            <p className="mt-0.5 break-all font-mono text-xs text-text-2">{current.sha256}</p>
          </div>
          {list.data && list.data.versions.length > 1 && (
            <div className="border-t border-border pt-3">
              <p className="font-medium">Earlier versions</p>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {list.data.versions.filter((v) => v.id !== current.id).map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2 text-text-2">
                    <span className="num">Version {v.version}</span>
                    <span className="text-text-3">{formatDateTime(v.generatedAt)}</span>
                    {v.reason && <span className="text-text-3">· {v.reason}</span>}
                    <button className="ml-auto font-medium text-brand hover:underline" onClick={() => openCard.mutate(v.id)}>Open</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <RegenerateDialog stay={stay} open={regenerateOpen} onClose={() => setRegenerateOpen(false)} />
    </Card>
  );
}

function RegenerateDialog({ stay, open, onClose }: { stay: StayDetail; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const key = useRef(newIdempotencyKey());
  const regenerate = useMutation({
    mutationFn: () => api<{ grc: GrcVersion }>(`/stays/${stay.id}/grc/regenerate`, { method: 'POST', body: { reason }, idempotencyKey: key.current }),
    onSuccess: async ({ grc }) => {
      key.current = newIdempotencyKey();
      setReason('');
      await qc.invalidateQueries({ queryKey: ['grc', stay.id] });
      onClose();
      toast('success', `Version ${grc.version} created`);
    },
    onError: (e) => toast('error', (e as Error).message),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a new version of the card"
      description="The current card and its file are kept. The new version carries the same card number and records why it was needed."
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={reason.trim().length < 3} loading={regenerate.isPending} onClick={() => regenerate.mutate()}>Create version</Button>
      </>}
    >
      <Field label="Why is a new card needed?" required hint="For example: an occupant was added after arrival">
        {(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
      </Field>
    </Dialog>
  );
}
