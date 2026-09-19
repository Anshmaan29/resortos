'use client';
import { motion } from 'motion/react';
import { AlertTriangle, Camera, CheckCircle2, CircleDashed, CloudOff, FileUp, Loader2, Maximize2, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DocumentType, IdType } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import type { QueueItem } from '@/lib/capture/upload-queue';
import { type SlotState } from '@/lib/capture/slot-state';
import { DocumentEditor, type EditorResult } from './document-editor';
import { LiveCamera } from './live-camera';

const ID_NAMES: Record<string, string> = { aadhaar: 'Aadhaar', passport: 'Passport', driving_licence: 'Driving licence', voter_id: 'Voter ID', pan: 'PAN card', other: 'Other ID' };

/**
 * Shows the photo that was captured, from the copy kept on this device.
 *
 * Not the stored document: that one is private, encrypted, behind a 60-second signed URL, and every
 * view of it is audit-logged (spec §19.4). Looking at what you just took should not cost an audit
 * entry, and the receptionist should not have to trust a tick — they should see the photo.
 */
function useThumbnail(bytes: ArrayBuffer | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) { setUrl(null); return; }
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes]);
  return url;
}

/** The mini viewer: a thumbnail in the slot, tapped to see it big enough to check. */
export function CapturePreview({ item, label }: { item: QueueItem | undefined; label: string }) {
  const url = useThumbnail(item?.thumbnail);
  const [open, setOpen] = useState(false);
  if (!url) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View the ${label.toLowerCase()} photo you captured`}
        className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <img src={url} alt="" className="h-full w-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center bg-ink/0 text-transparent transition group-hover:bg-black/40 group-hover:text-white">
          <Maximize2 className="h-4 w-4" aria-hidden />
        </span>
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title={label} description="The photo on this device. Capture it again if it is not clear.">
        <img src={url} alt={`${label} as captured`} className="mx-auto max-h-[60vh] w-auto rounded-md" />
      </Dialog>
    </>
  );
}

/**
 * The slot's live status. The new state replaces the old one at once and only animates in.
 *
 * This used to be an AnimatePresence in "wait" mode, which keeps the old label on screen until its
 * exit animation finishes. The status changes several times within a second (uploading → checking →
 * received), and when that exit stalled the old label stayed for good: the phone said "Checking…"
 * next to a photo the server had already verified. A status must never lag the state it reports.
 */
export function SlotStatus({ state }: { state: SlotState }) {
  return (
    <motion.span key={state.kind} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18 }}
      className={cn('inline-flex items-center gap-1.5 text-sm font-medium',
        state.kind === 'received' ? 'text-success'
          : state.kind === 'failed' ? 'text-danger'
          : state.kind === 'blocked' ? 'text-warning'
          : state.kind === 'empty' ? 'text-text-2' : 'text-info')}
      role="status">
      {state.kind === 'empty' && <><CircleDashed className="h-4 w-4" />Not captured</>}
      {state.kind === 'uploading' && <><Loader2 className="h-4 w-4 animate-spin" />Uploading {Math.round(state.progress * 100)}%</>}
      {state.kind === 'waiting_network' && <><CloudOff className="h-4 w-4" />Saved — waiting for network</>}
      {state.kind === 'blocked' && <><CloudOff className="h-4 w-4" />{state.message}</>}
      {state.kind === 'verifying' && <><Loader2 className="h-4 w-4 animate-spin" />Checking…</>}
      {state.kind === 'received' && <><CheckCircle2 className="h-4 w-4" />Received</>}
      {state.kind === 'failed' && <><AlertTriangle className="h-4 w-4" />{state.message}</>}
    </motion.span>
  );
}

/**
 * One document slot. Order of capture methods follows spec §19.3:
 * native camera input first (most reliable on phones), live preview second, file upload third.
 */
export function CaptureSlot({ label, hint, docType, idType, state, facing = 'environment', allowLive = true, allowFiles = true, compact, onCaptured, onDiscardFailed, item }: {
  label: string;
  hint?: string;
  docType: DocumentType;
  idType?: Exclude<IdType, 'none'> | null;
  state: SlotState;
  facing?: 'environment' | 'user';
  allowLive?: boolean;
  allowFiles?: boolean;
  compact?: boolean;
  onCaptured: (result: EditorResult, via: 'camera' | 'live' | 'file') => void;
  onDiscardFailed?: () => void;
  /** The queued item, if there is one — carries the local thumbnail for the mini viewer. */
  item?: QueueItem;
}) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<{ blob: Blob; via: 'camera' | 'live' | 'file' } | null>(null);
  const [live, setLive] = useState(false);
  const busy = state.kind === 'uploading' || state.kind === 'verifying' || state.kind === 'waiting_network';
  const done = state.kind === 'received';

  function picked(e: React.ChangeEvent<HTMLInputElement>, via: 'camera' | 'file') {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    onDiscardFailed?.();
    setSource({ blob: file, via });
  }

  const idLabel = idType ? ` · ${ID_NAMES[idType]}` : '';
  return (
    <div className={cn('flex flex-col gap-3 rounded-lg border p-4 transition-colors', done ? 'border-success/40 bg-success-soft/40' : state.kind === 'failed' ? 'border-danger/40' : 'border-border bg-surface')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          {/* The photo that was captured, so nobody has to take a tick on trust. */}
          <CapturePreview item={item} label={label + idLabel} />
          <div className="min-w-0">
            <p className="font-medium">{label}<span className="font-normal text-text-2">{idLabel}</span></p>
            {hint && <p className="text-xs text-text-2">{hint}</p>}
          </div>
        </div>
        <SlotStatus state={state} />
      </div>
      {!busy && (
        <div className={cn('grid gap-2', compact ? 'grid-cols-2' : 'grid-cols-1')}>
          <Button className={compact ? 'col-span-2' : undefined} variant={done ? 'outline' : 'primary'} size={compact ? 'md' : 'lg'} onClick={() => cameraInput.current?.click()}>
            <Camera className="h-5 w-5" />{done ? 'Retake' : 'Take photo'}
          </Button>
          {allowLive && <Button variant="outline" size={compact ? 'sm' : 'md'} onClick={() => setLive(true)}><Video className="h-4 w-4" />{compact ? 'Webcam' : 'Live camera'}</Button>}
          {allowFiles && <Button variant="outline" size={compact ? 'sm' : 'md'} onClick={() => fileInput.current?.click()}><FileUp className="h-4 w-4" />{compact ? 'File' : 'Choose file'}</Button>}
        </div>
      )}
      <input ref={cameraInput} type="file" accept="image/*" capture={facing} className="hidden" onChange={(e) => picked(e, 'camera')} data-testid={`camera-input-${docType}`} />
      <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => picked(e, 'file')} data-testid={`file-input-${docType}`} />

      <Dialog open={live} onClose={() => setLive(false)} title={label} size="lg">
        {live && <LiveCamera facing={facing} onClose={() => setLive(false)} onCapture={(blob) => { setLive(false); onDiscardFailed?.(); setSource({ blob, via: 'live' }); }} />}
      </Dialog>
      <Dialog open={!!source} onClose={() => setSource(null)} title={label} size="lg">
        {source && (
          <DocumentEditor source={source.blob} docType={docType}
            onRetake={() => { setSource(null); if (source.via === 'camera') cameraInput.current?.click(); else if (source.via === 'live') setLive(true); else fileInput.current?.click(); }}
            onDone={(result) => { const via = source.via; setSource(null); onCaptured(result, via); }} />
        )}
      </Dialog>
    </div>
  );
}
