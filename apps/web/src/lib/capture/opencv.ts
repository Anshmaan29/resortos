/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Lazy OpenCV.js loader (spec §19.4). ~10 MB, served from our own origin, downloaded only when a
 * capture screen opens. Capture never waits for it: manual corners work immediately, and
 * edge detection snaps in when (and if) OpenCV finishes loading.
 *
 * Important: the OpenCV module object is "thenable" and resolves to itself. Awaiting it, or resolving a
 * Promise with it, never settles. It is therefore always returned wrapped as `{ cv }`.
 */
export type CV = any;

let loading: Promise<{ cv: CV }> | null = null;

export function loadOpenCv(timeoutMs = 60_000): Promise<{ cv: CV }> {
  if (typeof window === 'undefined') return Promise.reject(new Error('OpenCV needs a browser'));
  if ((window as any).cv?.Mat) return Promise.resolve({ cv: (window as any).cv });
  loading ??= new Promise<{ cv: CV }>((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const cv = (window as any).cv;
      if (cv?.Mat) { resolve({ cv }); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('Edge detection took too long to load')); return; }
      setTimeout(poll, 100);
    };
    const script = document.createElement('script');
    script.src = '/vendor/opencv.js';
    script.async = true;
    script.onload = poll;
    script.onerror = () => reject(new Error('Edge detection could not be downloaded'));
    document.head.appendChild(script);
  }).catch((err) => {
    loading = null; // allow a retry later (e.g. after the network returns)
    throw err;
  });
  return loading;
}

/** Start downloading in the background as soon as a capture screen mounts. */
export function preloadOpenCv() {
  loadOpenCv().catch(() => undefined);
}
