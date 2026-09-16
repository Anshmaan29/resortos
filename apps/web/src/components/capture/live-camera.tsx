'use client';
import { Camera, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

function permissionHelp(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'On iPhone: open Settings → Safari → Camera → Allow, then reload this page.';
  if (/Android/.test(ua)) return 'On Android: tap the lock icon next to the address → Permissions → Camera → Allow, then reload.';
  if (/Edg\//.test(ua)) return 'In Edge: click the lock icon next to the address → Camera → Allow, then reload.';
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) return 'In Safari: Safari menu → Settings for This Website → Camera → Allow, then reload.';
  return 'In Chrome: click the camera icon in the address bar → Always allow → Done, then reload.';
}

/** Live preview (desk webcam or phone). Secondary to the native camera input, which is more reliable on phones. */
export function LiveCamera({ facing = 'environment', onCapture, onClose }: { facing?: 'environment' | 'user'; onCapture: (blob: Blob) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceIndex, setDeviceIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      setReady(false);
      if (!navigator.mediaDevices?.getUserMedia) { setError('This browser cannot open the camera here. Use "Take photo" instead (it must be HTTPS).'); return; }
      try {
        stream.current?.getTracks().forEach((t) => t.stop());
        const chosen = devices[deviceIndex];
        const media = await navigator.mediaDevices.getUserMedia({
          video: chosen ? { deviceId: { exact: chosen.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { media.getTracks().forEach((t) => t.stop()); return; }
        stream.current = media;
        if (video.current) { video.current.srcObject = media; await video.current.play().catch(() => undefined); }
        if (devices.length === 0) {
          const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
          if (!cancelled) setDevices(all);
        }
        setReady(true);
        setError(null);
      } catch (err) {
        const name = (err as DOMException).name;
        setError(name === 'NotAllowedError' || name === 'SecurityError' ? `Camera permission was denied. ${permissionHelp()}`
          : name === 'NotFoundError' ? 'No camera was found on this device.' : 'The camera could not be started. Close other apps using it and try again.');
      }
    }
    void start();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceIndex, facing]);

  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    canvas.toBlob((b) => b && onCapture(b), 'image/jpeg', 0.95);
    stream.current?.getTracks().forEach((t) => t.stop());
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <p role="alert" className="rounded-md bg-danger-soft px-3 py-3 text-sm text-danger">{error}</p> : (
        <div className="relative overflow-hidden rounded-lg bg-black">
          <video ref={video} playsInline muted className="max-h-[60vh] w-full object-contain" aria-label="Camera preview" />
          {!ready && <p className="absolute inset-0 flex items-center justify-center text-sm text-white">Starting camera…</p>}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onClose}><X className="h-4 w-4" />Close</Button>
        {devices.length > 1 && <Button variant="outline" onClick={() => setDeviceIndex((i) => (i + 1) % devices.length)} aria-label="Switch camera"><RefreshCw className="h-4 w-4" />Switch</Button>}
        <Button className="flex-1" disabled={!ready} onClick={capture}><Camera className="h-4 w-4" />Capture</Button>
      </div>
    </div>
  );
}
