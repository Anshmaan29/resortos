'use client';
import { Eraser, PenLine } from 'lucide-react';
import SignaturePad from 'signature_pad';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/** Signature on the desk touchscreen or with a mouse (spec §20). Produces a PNG. */
export function SignatureField({ disabled, onSigned }: { disabled?: boolean; onSigned: (png: Blob) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pad = useRef<SignaturePad | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const el = canvas.current!;
    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const data = pad.current?.toData();
      el.width = el.offsetWidth * ratio;
      el.height = el.offsetHeight * ratio;
      el.getContext('2d')!.scale(ratio, ratio);
      pad.current?.clear();
      if (data) pad.current?.fromData(data);
    };
    pad.current = new SignaturePad(el, { penColor: '#1d1b16', backgroundColor: 'rgb(255,255,255)', minWidth: 0.8, maxWidth: 2.6 });
    pad.current.addEventListener('endStroke', () => setEmpty(pad.current!.isEmpty()));
    resize();
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); pad.current?.off(); };
  }, []);

  function save() {
    canvas.current!.toBlob((b) => b && onSigned(b), 'image/png');
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative rounded-lg border-2 border-dashed border-border-strong bg-white">
        <canvas ref={canvas} className="h-48 w-full touch-none rounded-lg" aria-label="Signature area — sign with finger, stylus or mouse" data-testid="signature-canvas" />
        {empty && <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-[#625e55]"><PenLine className="h-4 w-4" />Guest signs here</span>}
        <span className="pointer-events-none absolute bottom-8 left-6 right-6 border-b border-[#cfc9bc]" aria-hidden />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => { pad.current?.clear(); setEmpty(true); }}><Eraser className="h-4 w-4" />Clear</Button>
        <Button className="flex-1" disabled={empty || disabled} onClick={save}>Save signature</Button>
      </div>
    </div>
  );
}
