'use client';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Camera, CheckCircle2, CircleDashed, CloudOff, FileUp, Loader2, Video } from 'lucide-react';
import { useRef, useState } from 'react';
import type { DocumentType, IdType } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import type { QueueItem } from '@/lib/capture/upload-queue';
import { DocumentEditor, type EditorResult } from './document-editor';
import { LiveCamera } from './live-camera';

const ID_NAMES: Record<string, string> = { aadhaar: 'Aadhaar', passport: 'Passport', driving_licence: 'Driving licence', voter_id: 'Voter ID', pan: 'PAN card', other: 'Other ID' };

export type SlotState =
  | { kind: 'empty' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'waiting_network' }
  | { kind: 'verifying' }
  | { kind: 'received' }
  | { kind: 'failed'; message: string };

/** Local queue state wins while an upload is in flight; the server's verified status is final. */
export function slotState(serverStatus: 'pending' | 'verified' | 'failed' | 'orphaned' | undefined, item: QueueItem | undefined, progress: number): SlotState {
  if (serverStatus === 'verified' || item?.status === 'done') return { kind: 'received' };
  if (item?.status === 'failed') return { kind: 'failed', message: item.error ?? 'Upload failed' };
  if (item?.status === 'waiting_network') return { kind: 'waiting_network' };
  if (item?.status === 'verifying') return { kind: 'verifying' };
  if (item && (item.status === 'uploading' || item.status === 'queued')) return { kind: 'uploading', progress };
  if (serverStatus === 'pending') return { kind: 'verifying' };
  if (serverStatus === 'failed') return { kind: 'failed', message: 'Upload failed — capture it again' };
  return { kind: 'empty' };
}

export function SlotStatus({ state }: { state: SlotState }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span key={state.kind} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
        className={cn('inline-flex items-center gap-1.5 text-sm font-medium',
          state.kind === 'received' ? 'text-success' : state.kind === 'failed' ? 'text-danger' : state.kind === 'empty' ? 'text-text-2' : 'text-info')}
        role="status">
        {state.kind === 'empty' && <><CircleDashed className="h-4 w-4" />Not captured</>}
        {state.kind === 'uploading' && <><Loader2 className="h-4 w-4 animate-spin" />Uploading {Math.round(state.progress * 100)}%</>}
        {state.kind === 'waiting_network' && <><CloudOff className="h-4 w-4" />Saved — waiting for network</>}
        {state.kind === 'verifying' && <><Loader2 className="h-4 w-4 animate-spin" />Checking…</>}
        {state.kind === 'received' && <><CheckCircle2 className="h-4 w-4" />Received</>}
        {state.kind === 'failed' && <><AlertTriangle className="h-4 w-4" />{state.message}</>}
      </motion.span>
    </AnimatePresence>
  );
}

/**
 * One document slot. Order of capture methods follows spec §19.3:
 * native camera input first (most reliable on phones), live preview second, file upload third.
 */
export function CaptureSlot({ label, hint, docType, idType, state, facing = 'environment', allowLive = true, allowFiles = true, compact, onCaptured, onDiscardFailed }: {
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
        <div>
          <p className="font-medium">{label}<span className="font-normal text-text-2">{idLabel}</span></p>
          {hint && <p className="text-xs text-text-2">{hint}</p>}
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
          <DocumentEditor source={source.blob} docType={docType} idType={idType}
            onRetake={() => { setSource(null); if (source.via === 'camera') cameraInput.current?.click(); else if (source.via === 'live') setLive(true); else fileInput.current?.click(); }}
            onDone={(result) => { const via = source.via; setSource(null); onCaptured(result, via); }} />
        )}
      </Dialog>
    </div>
  );
}
