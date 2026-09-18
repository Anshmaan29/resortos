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
  create(item: QueueItem): Promise<{ documentId: string; upload: UploadGrant }>;
  refresh(documentId: string): Promise<{ documentId: string; upload: UploadGrant }>;
  confirm(documentId: string): Promise<{ status: 'pending' | 'verified' | 'failed' | 'orphaned'; failureReason?: string | null }>;
}

export type QueueStatus = 'queued' | 'uploading' | 'verifying' | 'waiting_network' | 'done' | 'failed';

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

function backoff(attempts: number) {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
  return base / 2 + Math.random() * (base / 2);
}

/** PUT with progress; resolves with the storage status code (0 when the network failed). */
function putWithProgress(grant: UploadGrant, blob: Blob, onProgress: (fraction: number) => void): Promise<{ status: number; code?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', grant.url);
    for (const [k, v] of Object.entries(grant.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => resolve({ status: xhr.status, code: /<Code>(\w+)<\/Code>/.exec(xhr.responseText ?? '')?.[1] });
    xhr.onerror = () => resolve({ status: 0 });
    xhr.ontimeout = () => resolve({ status: 0 });
    xhr.timeout = 120_000;
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
  private persistenceBroken = false;

  /** True when this device refused to store the queue; the UI warns that a refresh would lose it. */
  get isMemoryOnly() {
    return this.persistenceBroken;
  }

  private async persist(item: QueueItem): Promise<void> {
    try {
      await (await db()).put('uploads', item);
    } catch (err) {
      // Keep going: the photo is in memory and the upload is what matters.
      this.persistenceBroken = true;
      console.warn('ResortOS: this device cannot store the upload queue; uploading from memory only', err);
    }
  }

  constructor(private readonly scope: string, private readonly transport: UploadTransport) {}

  start() {
    const kick = () => void this.process();
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', kick);
    this.timer = setInterval(kick, 2000);
    void this.purgeOld().then(kick);
    return () => {
      window.removeEventListener('online', kick);
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

  async add(input: Omit<QueueItem, 'id' | 'scope' | 'status' | 'attempts' | 'nextAttemptAt' | 'createdAt' | 'updatedAt' | 'size' | 'bytes' | 'blob'> & { blob: Blob }) {
    const now = Date.now();
    const { blob, ...rest } = input;
    const item: QueueItem = {
      ...rest, bytes: await blob.arrayBuffer(), id: crypto.randomUUID(), scope: this.scope, size: blob.size,
      status: 'queued', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    };
    // Persistence is best effort. If this device cannot write to IndexedDB at all (private
    // browsing, storage full, an old WebKit bug), the upload still runs from memory for this
    // session rather than the capture failing in the guest's face.
    this.memory.set(item.id, item);
    await this.persist(item);
    await this.emit();
    void this.process();
    return item;
  }

  /** Discards a failed item so the slot can be captured again. */
  async remove(id: string) {
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
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  private async save(item: QueueItem, patch: Partial<QueueItem>) {
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
        if (item.status === 'done' && Date.now() - item.updatedAt > DONE_RETENTION_MS) await database.delete('uploads', item.id);
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
        if (item.status === 'done' || item.status === 'failed' || item.nextAttemptAt > Date.now()) continue;
        if (!navigator.onLine) {
          if (item.status !== 'waiting_network') await this.save(item, { status: 'waiting_network' });
          continue;
        }
        await this.step(item);
      }
    } finally {
      this.running = false;
    }
  }

  private async retryLater(item: QueueItem, message: string, status: QueueStatus = navigator.onLine ? 'queued' : 'waiting_network') {
    await this.save(item, { status, attempts: item.attempts + 1, nextAttemptAt: Date.now() + backoff(item.attempts + 1), error: message });
  }

  private async fail(item: QueueItem, message: string) {
    await this.save(item, { status: 'failed', error: message });
  }

  private async step(item: QueueItem) {
    try {
      // 1. Get a pre-signed URL (new document, or a fresh URL for the same pending document).
      if (!item.documentId || !item.grant || new Date(item.grant.expiresAt).getTime() < Date.now() + 30_000) {
        // create() sends item.id as the client upload id, so a retry after a lost reply returns the same document.
        const res = item.documentId ? await this.transport.refresh(item.documentId) : await this.transport.create(item);
        await this.save(item, { documentId: res.documentId, grant: res.upload });
      }

      // 2. Upload straight to storage.
      if (item.status !== 'verifying') {
        const body = item.bytes ? new Blob([item.bytes], { type: item.contentType }) : item.blob ?? null;
        if (!body) return this.fail(item, 'The photo is no longer on this device. Capture it again.');
        await this.save(item, { status: 'uploading', error: undefined });
        const put = await putWithProgress(item.grant!, body, (f) => { this.progress.set(item.id, f); void this.emit(); });
        this.progress.delete(item.id);
        if (put.status === 0) return this.retryLater(item, 'Network lost — will resume automatically', 'waiting_network');
        if (put.status === 403) { await this.save(item, { grant: undefined }); return this.retryLater(item, 'Upload link expired — renewing'); }
        if (put.status === 400 && put.code === 'XAmzContentChecksumMismatch') return this.fail(item, 'The photo was damaged in transfer. Capture it again.');
        if (put.status !== 200 && put.status !== 412) return this.retryLater(item, `Storage returned ${put.status}`);
        await this.save(item, { status: 'verifying' });
      }

      // 3. The server re-hashes the stored object; only then is it received.
      const result = await this.transport.confirm(item.documentId!);
      if (result.status === 'verified') return this.save(item, { status: 'done', bytes: null, blob: null, error: undefined });
      if (result.status === 'failed' || result.status === 'orphaned') return this.fail(item, 'The server could not verify this photo. Capture it again.');
      return this.retryLater(item, 'Waiting for the server to receive the photo');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.details?.scannerClosed) return this.fail(item, err.message);
        if (err.code === 'CONFLICT' && err.details?.retryable) { await this.save(item, { status: 'queued' }); return this.retryLater(item, 'Upload did not arrive — sending again'); }
        if (err.code === 'INVALID_TRANSITION' && err.details?.status === 'verified') return this.save(item, { status: 'done', bytes: null, blob: null, documentId: err.details.documentId ?? item.documentId });
        if (err.status >= 400 && err.status < 500 && err.code !== 'RATE_LIMITED' && err.code !== 'SERVICE_BUSY') return this.fail(item, err.message);
        return this.retryLater(item, err.message);
      }
      return this.retryLater(item, 'Network lost — will resume automatically', navigator.onLine ? 'queued' : 'waiting_network');
    }
  }
}
