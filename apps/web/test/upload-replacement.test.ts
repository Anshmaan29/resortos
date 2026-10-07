import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadQueue, type QueueItem, type UploadTransport } from '../src/lib/capture/upload-queue';

const stored = vi.hoisted(() => new Map<string, QueueItem>());
vi.mock('idb', () => ({ openDB: async () => ({
  put: async (_: string, item: QueueItem) => { stored.set(item.id, structuredClone(item)); },
  delete: async (_: string, id: string) => { stored.delete(id); },
  getAllFromIndex: async (_: string, __: string, scope: string) => [...stored.values()].filter((item) => item.scope === scope),
}) }));
const photo = (slotKey = 'r0a0:id_back') => ({ slotKey, docType: 'id_back' as const, occupantKey: slotKey.split(':')[0],
  source: 'file_upload' as const, contentType: 'image/jpeg' as const, sha256: 'a'.repeat(64), blob: new Blob(['photo']) });
beforeEach(() => { stored.clear(); vi.stubGlobal('navigator', { onLine: false }); });
afterEach(() => vi.unstubAllGlobals());

describe('replacement upload queue', () => {
  it('discards an earlier retake but keeps another guest’s document', async () => {
    const queue = new UploadQueue('draft', {} as UploadTransport);
    const old = await queue.add(photo());
    const other = await queue.add(photo('r0a1:id_back'));
    const latest = await queue.add(photo());
    expect((await queue.items()).map((item) => item.id).sort()).toEqual([other.id, latest.id].sort());
    expect(stored.has(old.id)).toBe(false);
  });

  it('does not resurrect a removed upload when a delayed grant arrives', async () => {
    let release!: (value: Awaited<ReturnType<UploadTransport['create']>>) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const transport = { create: vi.fn(() => { started(); return new Promise((resolve) => { release = resolve; }); }),
      confirm: vi.fn(), refresh: vi.fn() } as unknown as UploadTransport;
    const queue = new UploadQueue('draft', transport);
    const item = await queue.add(photo());
    // The automatic offline drain completes before starting the controlled online request.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.stubGlobal('navigator', { onLine: true });
    const drain = queue.process();
    await entered;
    await queue.remove(item.id);
    release({ documentId: 'old', upload: { url: 'https://unused.invalid', headers: {}, expiresAt: new Date(Date.now() + 60000).toISOString() } });
    await drain;
    expect(await queue.items()).toEqual([]);
    expect(stored.has(item.id)).toBe(false);
    expect(transport.confirm).not.toHaveBeenCalled();
  });
});
