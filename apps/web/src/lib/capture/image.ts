/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CV } from './opencv';

export interface Point { x: number; y: number }
/** Corners in source-image pixels, ordered top-left, top-right, bottom-right, bottom-left. */
export type Corners = [Point, Point, Point, Point];
/** Mask rectangles in 0..1 of the output image. */
export interface MaskRect { x: number; y: number; w: number; h: number }

export const MAX_SIDE = 2000;
export const TARGET_BYTES = 600_000;

/** Decodes a photo with its EXIF orientation applied (iPhone photos are often rotated). */
export async function decodeImage(blob: Blob): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise<HTMLImageElement>((ok, fail) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => fail(new Error('This file is not a photo this browser can open. Try taking the photo again.'));
      img.src = URL.createObjectURL(blob);
    });
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  if ('close' in bitmap) bitmap.close();
  return canvas;
}

export function scaleToFit(source: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  if (scale === 1) return source;
  const out = document.createElement('canvas');
  out.width = Math.round(source.width * scale);
  out.height = Math.round(source.height * scale);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

export interface Quality {
  /** Variance of the Laplacian on a 500 px grayscale copy; low means blurry. */
  sharpness: number;
  /** Mean luminance 0..255. */
  brightness: number;
  blurry: boolean;
  tooDark: boolean;
  tooBright: boolean;
}

/** Thresholds to calibrate during real-device testing (docs/phone-testing.md). */
export const QUALITY_LIMITS = { minSharpness: 35, minBrightness: 55, maxBrightness: 235 };

export function measureQuality(source: HTMLCanvasElement): Quality {
  const small = scaleToFit(source, 500);
  const { width: w, height: h } = small;
  const data = small.getContext('2d')!.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    const v = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
    gray[i] = v;
    sum += v;
  }
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = gray[i - w]! + gray[i + w]! + gray[i - 1]! + gray[i + 1]! - 4 * gray[i]!;
      lapSum += lap;
      lapSq += lap * lap;
      n++;
    }
  }
  const mean = lapSum / n;
  const sharpness = lapSq / n - mean * mean;
  const brightness = sum / (w * h);
  return {
    sharpness, brightness,
    blurry: sharpness < QUALITY_LIMITS.minSharpness,
    tooDark: brightness < QUALITY_LIMITS.minBrightness,
    tooBright: brightness > QUALITY_LIMITS.maxBrightness,
  };
}

export function defaultCorners(w: number, h: number, inset = 0.06): Corners {
  const dx = w * inset;
  const dy = h * inset;
  return [{ x: dx, y: dy }, { x: w - dx, y: dy }, { x: w - dx, y: h - dy }, { x: dx, y: h - dy }];
}

function order(points: Point[]): Corners {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0]!, byDiff[0]!, bySum[3]!, byDiff[3]!];
}

/** Classical edge detection (no AI): largest convex 4-sided contour covering ≥ 20 % of the frame. */
export function detectDocument(cv: CV, source: HTMLCanvasElement): Corners | null {
  const work = scaleToFit(source, 800);
  const scale = source.width / work.width;
  const mats: any[] = [];
  const track = <T>(m: T) => { mats.push(m); return m; };
  try {
    const src = track(cv.imread(work));
    const blurred = track(new cv.Mat());
    cv.GaussianBlur(src, blurred, new cv.Size(5, 5), 0);
    // Edges from each colour channel combined: a blue card header on a brown table has little
    // grayscale contrast but a strong blue-channel edge.
    const channels = track(new cv.MatVector());
    cv.split(blurred, channels);
    const edges = track(cv.Mat.zeros(work.height, work.width, cv.CV_8U));
    for (let ch = 0; ch < 3; ch++) {
      const channel = channels.get(ch);
      const e = new cv.Mat();
      cv.Canny(channel, e, 50, 150);
      cv.bitwise_or(edges, e, edges);
      e.delete();
      channel.delete();
    }
    const kernel = track(cv.Mat.ones(5, 5, cv.CV_8U));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const minArea = work.width * work.height * 0.2;
    let best: Point[] | null = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      const area = cv.contourArea(approx);
      if (approx.rows === 4 && area > minArea && area > bestArea && cv.isContourConvex(approx)) {
        bestArea = area;
        best = Array.from({ length: 4 }, (_, k) => ({ x: approx.data32S[k * 2] * scale, y: approx.data32S[k * 2 + 1] * scale }));
      }
      approx.delete();
      c.delete();
    }
    return best ? order(best) : null;
  } catch {
    return null;
  } finally {
    for (const m of mats) m.delete();
  }
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Perspective-corrects the document to a flat rectangle (longest side ≤ 2000 px). Falls back to a plain crop without OpenCV. */
export function straighten(cv: CV | null, source: HTMLCanvasElement, c: Corners): HTMLCanvasElement {
  const width = Math.max(dist(c[0], c[1]), dist(c[3], c[2]));
  const height = Math.max(dist(c[0], c[3]), dist(c[1], c[2]));
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;

  if (!cv) {
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    const x = Math.max(0, Math.min(...xs));
    const y = Math.max(0, Math.min(...ys));
    const w = Math.min(source.width, Math.max(...xs)) - x;
    const h = Math.min(source.height, Math.max(...ys)) - y;
    out.width = Math.round(w * Math.min(1, MAX_SIDE / Math.max(w, h)));
    out.height = Math.round(h * Math.min(1, MAX_SIDE / Math.max(w, h)));
    out.getContext('2d')!.drawImage(source, x, y, w, h, 0, 0, out.width, out.height);
    return out;
  }

  const src = cv.imread(source);
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, c.flatMap((p) => [p.x, p.y]));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const m = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(src, dst, m, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    cv.imshow(out, dst);
    return out;
  } finally {
    [src, dst, from, to, m].forEach((x) => x.delete());
  }
}

/** Paints solid black boxes into the pixels. The unmasked image never leaves the device (spec §19.4). */
export function applyMasks(source: HTMLCanvasElement, masks: MaskRect[]): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(source, 0, 0);
  ctx.fillStyle = '#000';
  for (const r of masks) ctx.fillRect(r.x * out.width, r.y * out.height, r.w * out.width, r.h * out.height);
  return out;
}

/**
 * Re-encodes to JPEG, longest side ≤ 2000 px, stepping quality/size down to stay under ~600 KB.
 * Drawing to a canvas and re-encoding drops all EXIF metadata, including GPS location.
 */
export async function encodeJpeg(source: HTMLCanvasElement, maxBytes = TARGET_BYTES): Promise<Blob> {
  let canvas = scaleToFit(source, MAX_SIDE);
  for (const quality of [0.82, 0.74, 0.66, 0.58]) {
    const blob = await toBlob(canvas, 'image/jpeg', quality);
    if (blob.size <= maxBytes) return blob;
  }
  for (let side = Math.max(canvas.width, canvas.height) * 0.8; side >= 800; side *= 0.8) {
    canvas = scaleToFit(source, side);
    const blob = await toBlob(canvas, 'image/jpeg', 0.66);
    if (blob.size <= maxBytes) return blob;
  }
  return toBlob(canvas, 'image/jpeg', 0.6);
}

export function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Could not prepare the photo'))), type, quality));
}

export async function sha256Hex(blob: Blob): Promise<string> {
  if (!crypto?.subtle) throw new Error('This page must be opened over HTTPS to capture documents.');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
