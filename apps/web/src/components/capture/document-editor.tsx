'use client';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Check, Loader2, Plus, RotateCcw, ScanLine, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { DocumentType, IdType } from '@resortos/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  applyMasks, decodeImage, defaultCorners, detectDocument, encodeJpeg, measureQuality, scaleToFit, straighten,
  type Corners, type MaskRect, type Point, type Quality,
} from '@/lib/capture/image';
import { loadOpenCv, type CV } from '@/lib/capture/opencv';

export interface EditorResult { blob: Blob; maskedOnDevice: boolean }

type Stage = 'loading' | 'corners' | 'mask' | 'review' | 'encoding';

/** Default box over where the 12-digit number sits on an Aadhaar card. Staff move it to fit. */
const AADHAAR_DEFAULT_MASK: MaskRect = { x: 0.24, y: 0.7, w: 0.4, h: 0.12 };

export function DocumentEditor({ source, docType, idType, onDone, onRetake }: {
  source: Blob;
  docType: DocumentType;
  idType?: Exclude<IdType, 'none'> | null;
  onDone: (result: EditorResult) => void;
  onRetake: () => void;
}) {
  const needsCorners = docType === 'id_front' || docType === 'id_back' || docType === 'id_extra';
  const needsMask = needsCorners && idType === 'aadhaar';

  const [stage, setStage] = useState<Stage>('loading');
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState<HTMLCanvasElement | null>(null);
  const [corners, setCorners] = useState<Corners | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [edgesFound, setEdgesFound] = useState<boolean | null>(null);
  const [flat, setFlat] = useState<HTMLCanvasElement | null>(null);
  const [masks, setMasks] = useState<MaskRect[]>([AADHAAR_DEFAULT_MASK]);
  const [maskConfirmed, setMaskConfirmed] = useState(false);
  const [quality, setQuality] = useState<Quality | null>(null);
  const cvRef = useRef<CV | null>(null);
  const cornersTouched = useRef(false);

  useEffect(() => {
    let cancelled = false;
    decodeImage(source).then((canvas) => {
      if (cancelled) return;
      setOriginal(canvas);
      if (!needsCorners) {
        const scaled = scaleToFit(canvas, 2000);
        setFlat(scaled);
        setQuality(measureQuality(scaled));
        setStage('review');
        return;
      }
      setCorners(defaultCorners(canvas.width, canvas.height));
      setStage('corners');
      setDetecting(true);
      loadOpenCv()
        .then(({ cv }) => {
          if (cancelled) return;
          cvRef.current = cv;
          const found = detectDocument(cv, canvas);
          setEdgesFound(!!found);
          // Never overwrite corners the user already moved.
          if (found && !cornersTouched.current) setCorners(found);
        })
        .catch(() => setEdgesFound(false))
        .finally(() => !cancelled && setDetecting(false));
    }).catch((err: Error) => setError(err.message));
    return () => { cancelled = true; };
  }, [source, needsCorners]);

  function acceptCorners() {
    if (!original || !corners) return;
    const out = straighten(cvRef.current, original, corners);
    setFlat(out);
    setQuality(measureQuality(out));
    setStage(needsMask ? 'mask' : 'review');
  }

  async function finish() {
    if (!flat) return;
    setStage('encoding');
    try {
      const output = needsMask ? applyMasks(flat, masks) : flat;
      onDone({ blob: await encodeJpeg(output), maskedOnDevice: needsMask });
    } catch (err) {
      setError((err as Error).message);
      setStage('review');
    }
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 p-6 text-center">
        <AlertTriangle className="h-8 w-8 text-danger" />
        <p className="text-sm text-danger">{error}</p>
        <Button onClick={onRetake}><RotateCcw className="h-4 w-4" />Take again</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <AnimatePresence mode="wait">
        {stage === 'loading' && (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex h-64 items-center justify-center text-text-2">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />Preparing photo…
          </motion.div>
        )}

        {stage === 'corners' && original && corners && (
          <motion.div key="corners" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm text-text-2" role="status">
              <ScanLine className="h-4 w-4" />
              {detecting ? 'Finding the document edges… you can drag the corners now.'
                : edgesFound ? 'Edges found. Drag a corner if it is not exactly on the card.' : 'Drag the four corners onto the edges of the document.'}
            </p>
            <CornerEditor image={original} corners={corners} onChange={(c) => { cornersTouched.current = true; setCorners(c); }} />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={onRetake}><RotateCcw className="h-4 w-4" />Retake</Button>
              <Button onClick={acceptCorners}><Check className="h-4 w-4" />Crop</Button>
            </div>
          </motion.div>
        )}

        {stage === 'mask' && flat && (
          <motion.div key="mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-3">
            <div className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
              Aadhaar: cover the <strong>first 8 digits</strong> of the number (and the QR code on the back). Only the masked image is uploaded — the original never leaves this device.
            </div>
            <MaskEditor image={flat} masks={masks} onChange={(m) => { setMasks(m); setMaskConfirmed(false); }} />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setMasks((m) => [...m, { x: 0.35, y: 0.4, w: 0.3, h: 0.12 }])}><Plus className="h-4 w-4" />Add box</Button>
              {masks.length > 1 && <Button variant="ghost" size="sm" onClick={() => setMasks((m) => m.slice(0, -1))}><Trash2 className="h-4 w-4" />Remove last box</Button>}
            </div>
            <label className="flex min-h-11 items-start gap-3 rounded-md border border-border p-3 text-sm">
              <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[var(--brand)]" checked={maskConfirmed} onChange={(e) => setMaskConfirmed(e.target.checked)} />
              I have checked the preview: the first 8 digits are fully covered.
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setStage('corners')}>Back</Button>
              <Button disabled={!maskConfirmed} onClick={() => setStage('review')}><Check className="h-4 w-4" />Continue</Button>
            </div>
          </motion.div>
        )}

        {(stage === 'review' || stage === 'encoding') && flat && (
          <motion.div key="review" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-3">
            <PreviewCanvas canvas={needsMask ? applyMasks(flat, masks) : flat} />
            {quality && (quality.blurry || quality.tooDark || quality.tooBright) && (
              <div role="alert" className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{quality.blurry ? 'Photo looks blurry — retake?' : quality.tooDark ? 'Photo looks too dark — move to better light and retake?' : 'Photo looks too bright — avoid glare and retake?'} Check that all text is readable.</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={onRetake} disabled={stage === 'encoding'}><RotateCcw className="h-4 w-4" />Retake</Button>
              <Button onClick={finish} loading={stage === 'encoding'}><Check className="h-4 w-4" />Use photo</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PreviewCanvas({ canvas }: { canvas: HTMLCanvasElement }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const small = scaleToFit(canvas, 1200);
    el.width = small.width;
    el.height = small.height;
    el.getContext('2d')!.drawImage(small, 0, 0);
  }, [canvas]);
  return <canvas ref={ref} className="max-h-[55vh] w-full rounded-md bg-black object-contain" aria-label="Photo preview" />;
}

/** Drawn image with four large draggable corner handles (touch, mouse, keyboard arrows). */
function CornerEditor({ image, corners, onChange }: { image: HTMLCanvasElement; corners: Corners; onChange: (c: Corners) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const dragging = useRef<number | null>(null);
  const preview = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = preview.current;
    if (!el) return;
    const small = scaleToFit(image, 1200);
    el.width = small.width;
    el.height = small.height;
    el.getContext('2d')!.drawImage(small, 0, 0);
  }, [image]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sx = size.w / image.width;
  const sy = size.h / image.height;

  const move = useCallback((index: number, clientX: number, clientY: number) => {
    const rect = container.current!.getBoundingClientRect();
    const p: Point = {
      x: Math.min(image.width, Math.max(0, (clientX - rect.left) / sx)),
      y: Math.min(image.height, Math.max(0, (clientY - rect.top) / sy)),
    };
    const next = [...corners] as Corners;
    next[index] = p;
    onChange(next);
  }, [corners, image, onChange, sx, sy]);

  const names = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
  return (
    <div ref={container} className="relative w-full touch-none select-none" style={{ aspectRatio: `${image.width} / ${image.height}`, maxHeight: '60vh' }}
      onPointerMove={(e) => dragging.current !== null && move(dragging.current, e.clientX, e.clientY)}
      onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }}>
      <canvas ref={preview} className="absolute inset-0 h-full w-full rounded-md" aria-hidden />
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <polygon points={corners.map((c) => `${c.x * sx},${c.y * sy}`).join(' ')} fill="rgba(79,191,159,0.18)" stroke="#4fbf9f" strokeWidth={2} />
      </svg>
      {corners.map((c, i) => (
        <button key={i} type="button" aria-label={`Move ${names[i]} corner`}
          className="absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
          style={{ left: c.x * sx, top: c.y * sy }}
          onPointerDown={(e: ReactPointerEvent) => { dragging.current = i; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }}
          onPointerMove={(e) => dragging.current === i && move(i, e.clientX, e.clientY)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 20 : 4;
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
            if (!d) return;
            e.preventDefault();
            const rect = container.current!.getBoundingClientRect();
            move(i, rect.left + c.x * sx + d[0]!, rect.top + c.y * sy + d[1]!);
          }}>
          <span className="h-6 w-6 rounded-full border-[3px] border-white bg-[#0f5c4d] shadow-md" />
        </button>
      ))}
    </div>
  );
}

/** Black boxes the user drags and resizes over the Aadhaar number. What you see is exactly what is uploaded. */
function MaskEditor({ image, masks, onChange }: { image: HTMLCanvasElement; masks: MaskRect[]; onChange: (m: MaskRect[]) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ index: number; mode: 'move' | 'resize'; startX: number; startY: number; start: MaskRect } | null>(null);

  useEffect(() => {
    const el = preview.current;
    if (!el) return;
    const small = scaleToFit(image, 1200);
    el.width = small.width;
    el.height = small.height;
    el.getContext('2d')!.drawImage(small, 0, 0);
  }, [image]);

  function onMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const rect = container.current!.getBoundingClientRect();
    const dx = (e.clientX - d.startX) / rect.width;
    const dy = (e.clientY - d.startY) / rect.height;
    const next = [...masks];
    const r = d.start;
    next[d.index] = d.mode === 'move'
      ? { ...r, x: Math.min(1 - r.w, Math.max(0, r.x + dx)), y: Math.min(1 - r.h, Math.max(0, r.y + dy)) }
      : { ...r, w: Math.min(1 - r.x, Math.max(0.05, r.w + dx)), h: Math.min(1 - r.y, Math.max(0.04, r.h + dy)) };
    onChange(next);
  }

  return (
    <div ref={container} className="relative w-full touch-none select-none" style={{ aspectRatio: `${image.width} / ${image.height}` }}
      onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <canvas ref={preview} className="absolute inset-0 h-full w-full rounded-md" aria-label="Document with masking boxes" />
      {masks.map((m, i) => (
        <div key={i} className={cn('absolute cursor-move bg-black ring-2 ring-warning')}
          style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }}
          onPointerDown={(e) => { drag.current = { index: i, mode: 'move', startX: e.clientX, startY: e.clientY, start: m }; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }}
          role="img" aria-label={`Masking box ${i + 1}`}>
          <span className="absolute -bottom-3 -right-3 flex h-8 w-8 cursor-nwse-resize items-center justify-center"
            onPointerDown={(e) => { e.stopPropagation(); drag.current = { index: i, mode: 'resize', startX: e.clientX, startY: e.clientY, start: m }; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }}
            aria-label={`Resize masking box ${i + 1}`}>
            <span className="h-4 w-4 rounded-sm border-2 border-white bg-warning" />
          </span>
        </div>
      ))}
    </div>
  );
}
