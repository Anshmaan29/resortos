import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DocumentType, IdType } from '@resortos/shared';
import { ApiError } from '@/lib/api';

/**
 * Durable upload queue (spec §19.5).
 *
 *   processed photo ─► SHA-256 on device ─► saved to IndexedDB ─► request pre-signed URL
 *     ─► PUT straight to storage ─► server re-hashes ─► VERIFIED ─► removed from the device
 *
 * Survives refresh, app switching and network loss. Retries with backoff and resumes as soon as the
 * browser reports it is online again. Never blocks the rest of the form.
 */

export interface UploadGrant { url: string; headers: Record<string, string>; expiresAt: string }

export interface UploadTransport {
  create(item: QueueItem, signal?: AbortSignal): Promise<{ documentId: string; upload: UploadGrant }>;
  refresh(documentId: string, signal?: AbortSignal): Promise<{ documentId: string; upload: UploadGrant }>;
  confirm(documentId: string, signal?: AbortSignal): Promise<{ status: 'pending' | 'verified' | 'failed' | 'orphaned'; failureReason?: string | null }>;
}

/** A request that never came back, as distinct from one that came back with bad news. */
export class UploadTimeoutError extends Error {
  constructor(what: string) { super(`The server did not answer the ${what} request in time`); }
}

export type QueueStatus = 'queued' | 'uploading' | 'verifying' | 'waiting_network' | 'done' | 'failed';

/** Shown when the photo cannot reach storage even though the phone believes it is online. */
export const BLOCKED_MESSAGE = 'Cannot reach the photo store from this phone — the desk can help';

/** True once an item has been trying and getting nowhere, so the screen can stop saying 0%. */
export const isBlocked = (item: { attempts: number; error?: string }): boolean =>
  item.error === BLOCKED_MESSAGE && item.attempts >= BLOCKED_AFTER_ATTEMPTS;

export interface QueueItem {
  id: string;
  scope: string; // capture token or check-in draft id
  slotKey: string; // e.g. "r0a0:id_front"
  docType: DocumentType;
  occupantKey?: string;
  idType?: Exclude<IdType, 'none'>;
  source: 'desk_camera' | 'file_upload' | 'signature_pad' | 'phone_scanner';
  /**
   * The photo itself, as bytes — never as a Blob or File.
   *
   * iOS Safari regularly refuses to store a Blob in IndexedDB with
   * "UnknownError: Error preparing Blob/File data to be stored in object store", which killed the
   * whole capture: the write threw, nothing was queued, and the photo never reached the desk.
   * ArrayBuffers go through plain structured cloning and store reliably everywhere.
   * Cleared once verified, to free space on the phone.
   */
  bytes: ArrayBuffer | null;
  /** Written by an earlier version that stored Blobs; still uploaded if one is found. */
  blob?: Blob | null;
  /**
   * A few-kilobyte preview, kept after `bytes` is cleared, so the screen can show what was sent.
   *
   * Deliberately local: the stored document is private, encrypted and behind a short-lived signed
   * URL whose every view is audit-logged (spec §19.4). Showing a thumbnail should not cost an
   * audit entry, and the desk should not have to trust a tick — it should see the photo.
   */
  thumbnail?: ArrayBuffer | null;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  size: number;
  sha256: string;
  status: QueueStatus;
  documentId?: string;
  grant?: UploadGrant;
  attempts: number;
  nextAttemptAt: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

interface CaptureDB extends DBSchema {
  uploads: { key: string; value: QueueItem; indexes: { scope: string } };
}

let dbPromise: Promise<IDBPDatabase<CaptureDB>> | null = null;
function db() {
  dbPromise ??= openDB<CaptureDB>('resortos-capture', 1, {
    upgrade(database) {
      const store = database.createObjectStore('uploads', { keyPath: 'id' });
      store.createIndex('scope', 'scope');
    },
  });
  return dbPromise;
}

const DONE_RETENTION_MS = 6 * 60 * 60 * 1000;
/** Flat wait after a request that never reached the server. See `deferForNetwork`. */
const NETWORK_RETRY_MS = 1500;
/**
 * Every call to our own API in this queue is given a deadline.
 *
 * The drain loop is single-threaded and guarded against re-entry, so one request that never returns
 * stops every other photo on the device — the same way a hung PUT did until it was given a timeout.
 * `fetch` has no timeout of its own, so without this a stalled confirm leaves an ID showing
 * "Checking…" for ever, and the guest's other documents never upload at all.
 */
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * How many times an upload may fail to leave the device, while the browser insists it is online,
 * before the screen stops saying "Uploading" and says what is actually happening.
 *
 * Found on a real phone: the page worked, documents were created, and every photo sat at
 * "Uploading 0%" for ever. Uploads go straight to object storage on a *different* origin, and that
 * origin was unreachable from the phone — so not one byte ever left, and the queue, seeing what
 * looks exactly like a flaky network, retried silently until somebody thought to read the database.
 * Whatever the cause — an untrusted certificate in testing, a proxy or firewall in a real resort —
 * a photo that cannot be sent must say so rather than show a progress bar that never moves.
 */
const BLOCKED_AFTER_ATTEMPTS = 3;
const BLOCKED_RETRY_MS = 5_000;

function backoff(attempts: number) {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
  return base / 2 + Math.random() * (base / 2);
}

/**
 * PUT with progress; resolves with the storage status code (0 when the network failed).
 *
 * `onStart` hands the request back so the queue can abort it. Losing the network mid-upload does
 * not reliably fail the request — Chromium can leave it hanging — and the drain loop awaits this
 * promise, so one hanging request would stop every other photo on the device.
 */
function putWithProgress(
  grant: UploadGrant,
  blob: Blob,
  onProgress: (fraction: number) => void,
  onStart: (xhr: XMLHttpRequest) => void,
): Promise<{ status: number; code?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', grant.url);
    for (const [k, v] of Object.entries(grant.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => resolve({ status: xhr.status, code: /<Code>(\w+)<\/Code>/.exec(xhr.responseText ?? '')?.[1] });
    xhr.onerror = () => resolve({ status: 0 });
    xhr.ontimeout = () => resolve({ status: 0 });
    xhr.onabort = () => resolve({ status: 0 });
    xhr.timeout = 60_000;
    onStart(xhr);
    xhr.send(blob);
  });
}

export class UploadQueue {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(items: QueueItem[]) => void>();
  private progress = new Map<string, number>();
  /** Mirror of this session's items, so a device that cannot persist can still upload. */
  private memory = new Map<string, QueueItem>();
  /** The upload in flight, so losing the network can cut it short instead of leaving it hanging. */
  private active: XMLHttpRequest | null = null;
  private persistenceBroken = false;
  private removed = new Set<string>();
  private activeItemId: string | null = null;

  /** True when this device refused to store the queue; the UI warns that a refresh would lose it. */
  get isMemoryOnly() {
    return this.persistenceBroken;
  }

  private async persist(item: QueueItem): Promise<void> {
    try {
      const database = await db();
      if (this.removed.has(item.id)) return;
      await database.put('uploads', item);
      if (this.removed.has(item.id)) await database.delete('uploads', item.id);
    } catch (err) {
      // Keep going: the photo is in memory and the upload is what matters.
      this.persistenceBroken = true;
      console.warn('ResortOS: this device cannot store the upload queue; uploading from memory only', err);
    }
  }

  constructor(private readonly scope: string, private readonly transport: UploadTransport) {}

  start() {
    const kick = () => void this.process();
    const resume = async () => {
      // Anything parked for want of a network is due the instant it returns.
      for (const item of await this.items()) {
        if (item.status === 'waiting_network') await this.save(item, { status: 'queued', nextAttemptAt: Date.now() });
      }
      kick();
    };
    const onOnline = () => void resume();
    // Cut the upload in flight short: losing the network does not reliably fail the request, and a
    // hanging request blocks the drain loop for every other photo on the device.
    const onOffline = () => this.active?.abort();

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', kick);
    this.timer = setInterval(kick, 2000);
    void this.purgeOld().then(kick);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', kick);
      if (this.timer) clearInterval(this.timer);
    };
  }

  subscribe(listener: (items: QueueItem[]) => void) {
    this.listeners.add(listener);
    void this.emit();
    return () => this.listeners.delete(listener);
  }

  progressOf(id: string) {
    return this.progress.get(id) ?? 0;
  }

  async add(input: Omit<QueueItem, 'id' | 'scope' | 'status' | 'attempts' | 'nextAttemptAt' | 'createdAt' | 'updatedAt' | 'size' | 'bytes' | 'blob' | 'thumbnail'> & { blob: Blob; thumbnail?: Blob | null }) {
    const now = Date.now();
    const { blob, thumbnail, ...rest } = input;
    const item: QueueItem = {
      ...rest, bytes: await blob.arrayBuffer(), id: crypto.randomUUID(), scope: this.scope, size: blob.size,
      thumbnail: thumbnail ? await thumbnail.arrayBuffer() : null,
      status: 'queued', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    };
    // Persistence is best effort. If this device cannot write to IndexedDB at all (private
    // browsing, storage full, an old WebKit bug), the upload still runs from memory for this
    // session rather than the capture failing in the guest's face.
    for (const previous of await this.items()) {
      if (previous.slotKey === item.slotKey) await this.remove(previous.id);
    }
    this.memory.set(item.id, item);
    await this.persist(item);
    await this.emit();
    void this.process();
    return item;
  }

  /** Discards a failed item so the slot can be captured again. */
  async remove(id: string) {
    this.removed.add(id);
    if (this.activeItemId === id) this.active?.abort();
    this.progress.delete(id);
    this.memory.delete(id);
    try {
      await (await db()).delete('uploads', id);
    } catch { /* nothing stored to remove */ }
    await this.emit();
  }

  async items(): Promise<QueueItem[]> {
    const byId = new Map<string, QueueItem>();
    try {
      for (const item of await (await db()).getAllFromIndex('uploads', 'scope', this.scope)) byId.set(item.id, item);
    } catch (err) {
      this.persistenceBroken = true;
      console.warn('ResortOS: cannot read the stored upload queue', err);
    }
    // This session's copies win: they carry the live status even when the write failed.
    for (const item of this.memory.values()) if (item.scope === this.scope) byId.set(item.id, item);
    return [...byId.values()].filter((item) => !this.removed.has(item.id)).sort((a, b) => a.createdAt - b.createdAt);
  }

  private async save(item: QueueItem, patch: Partial<QueueItem>) {
    if (this.removed.has(item.id)) return;
    Object.assign(item, patch, { updatedAt: Date.now() });
    this.memory.set(item.id, item);
    await this.persist(item);
    await this.emit();
  }

  private async emit() {
    const items = await this.items();
    for (const l of this.listeners) l(items);
  }

  private async purgeOld() {
    try {
      const database = await db();
      for (const item of await database.getAll('uploads')) {
        if (this.removed.has(item.id) || item.status === 'done' && Date.now() - item.updatedAt > DONE_RETENTION_MS) await database.delete('uploads', item.id);
      }
    } catch (err) {
      this.persistenceBroken = true;
      console.warn('ResortOS: cannot tidy the stored upload queue', err);
    }
  }

  async process() {
    if (this.running) return;
    this.running = true;
    try {
      for (const item of await this.items()) {
        if (this.removed.has(item.id) || item.status === 'done' || item.status === 'failed' || item.nextAttemptAt > Date.now()) continue;
        if (!navigator.onLine) {
          if (item.status !== 'waiting_network') await this.save(item, { status: 'waiting_network' });
          continue;
        }
        this.activeItemId = item.id;
        try { await this.step(item); } finally { this.activeItemId = null; }
      }
    } finally {
      this.running = false;
    }
  }

  private async retryLater(item: QueueItem, message: string, status: QueueStatus = navigator.onLine ? 'queued' : 'waiting_network') {
    await this.save(item, { status, attempts: item.attempts + 1, nextAttemptAt: Date.now() + backoff(item.attempts + 1), error: message });
  }

  /**
   * The request never reached the server, so there is nothing to back off from.
   *
   * Exponential backoff exists to stop hammering a service that is struggling. A missing network is
   * not that: the moment it returns, the right thing is to send immediately. Backing off here is
   * actively wrong — after a handful of drop-outs the delay reaches its 30-second ceiling and the
   * guest's ID sits at "Saved — waiting for network" long after the wifi is back.
   *
   * Attempts still climb, so the count in job status stays honest, but the delay stays flat.
   */
  private async deferForNetwork(item: QueueItem, message: string) {
    if (!navigator.onLine) {
      await this.save(item, {
        status: 'waiting_network',
        attempts: item.attempts + 1,
        nextAttemptAt: Date.now() + NETWORK_RETRY_MS,
        error: message,
      });
      return;
    }
    // The browser says we are online and the request still could not leave. That is not a network
    // drop-out, and pretending it is hides a problem nobody can see from the screen.
    const attempts = item.attempts + 1;
    const blocked = attempts >= BLOCKED_AFTER_ATTEMPTS;
    await this.save(item, {
      status: 'queued',
      attempts,
      nextAttemptAt: Date.now() + (blocked ? BLOCKED_RETRY_MS : NETWORK_RETRY_MS),
      error: blocked ? BLOCKED_MESSAGE : message,
    });
  }

  private async fail(item: QueueItem, message: string) {
    await this.save(item, { status: 'failed', error: message });
  }

  /** Runs a transport call under a deadline, cancelling the request rather than waiting for ever. */
  private async call<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) throw new UploadTimeoutError(what);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async step(item: QueueItem) {
    if (this.removed.has(item.id)) return;
    try {
      // 1. Get a pre-signed URL (new document, or a fresh URL for the same pending document).
      if (!item.documentId || !item.grant || new Date(item.grant.expiresAt).getTime() < Date.now() + 30_000) {
        // create() sends item.id as the client upload id, so a retry after a lost reply returns the same document.
        const res = item.documentId
          ? await this.call('upload link', (signal) => this.transport.refresh(item.documentId!, signal))
          : await this.call('upload link', (signal) => this.transport.create(item, signal));
        if (this.removed.has(item.id)) return;
        await this.save(item, { documentId: res.documentId, grant: res.upload });
      }

      // 2. Upload straight to storage.
      if (item.status !== 'verifying') {
        const body = item.bytes ? new Blob([item.bytes], { type: item.contentType }) : item.blob ?? null;
        if (!body) return this.fail(item, 'The photo is no longer on this device. Capture it again.');
        await this.save(item, { status: 'uploading', error: undefined });
        if (this.removed.has(item.id)) return;
        const put = await putWithProgress(
          item.grant!, body,
          (f) => { this.progress.set(item.id, f); void this.emit(); },
          (xhr) => { this.active = xhr; },
        ).finally(() => { this.active = null; });
        this.progress.delete(item.id);
        if (this.removed.has(item.id)) return;
        if (put.status === 0) return this.deferForNetwork(item, 'Network lost — will resume automatically');
        if (put.status === 403) { await this.save(item, { grant: undefined }); return this.retryLater(item, 'Upload link expired — renewing'); }
        if (put.status === 400 && put.code === 'XAmzContentChecksumMismatch') return this.fail(item, 'The photo was damaged in transfer. Capture it again.');
        if (put.status !== 200 && put.status !== 412) return this.retryLater(item, `Storage returned ${put.status}`);
        await this.save(item, { status: 'verifying' });
      }

      // 3. The server re-hashes the stored object; only then is it received.
      if (this.removed.has(item.id)) return;
      const result = await this.call('confirmation', (signal) => this.transport.confirm(item.documentId!, signal));
      // bytes go, the thumbnail stays: the desk keeps seeing what it sent.
      if (result.status === 'verified') return this.save(item, { status: 'done', bytes: null, blob: null, error: undefined });
      if (result.status === 'failed' || result.status === 'orphaned') return this.fail(item, 'The server could not verify this photo. Capture it again.');
      return this.retryLater(item, 'Waiting for the server to receive the photo');
    } catch (err) {
      if (this.removed.has(item.id)) return;
      // The request was cancelled for taking too long. Nothing is known about whether the server
      // acted on it, which is exactly what idempotency keys are for: sending it again is safe.
      if (err instanceof UploadTimeoutError) return this.retryLater(item, 'The server is taking a long time — trying again');
      if (err instanceof ApiError) {
        if (err.details?.scannerClosed) return this.fail(item, err.message);
        if (err.code === 'CONFLICT' && err.details?.retryable) { await this.save(item, { status: 'queued' }); return this.retryLater(item, 'Upload did not arrive — sending again'); }
        if (err.code === 'INVALID_TRANSITION' && err.details?.status === 'verified') return this.save(item, { status: 'done', bytes: null, blob: null, documentId: err.details.documentId ?? item.documentId });
        if (err.status >= 400 && err.status < 500 && err.code !== 'RATE_LIMITED' && err.code !== 'SERVICE_BUSY') return this.fail(item, err.message);
        return this.retryLater(item, err.message);
      }
      return this.deferForNetwork(item, 'Network lost — will resume automatically');
    }
  }
}
