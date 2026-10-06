import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { StorageService } from './storage.service';

describe('storage liveness is bounded', () => {
  it('aborts a real bucket request which accepts a connection but never responds', async () => {
    const server = createServer(() => { /* deliberately stall */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/test',
      S3_BUCKET: 'documents', S3_REGION: 'auto', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test', S3_FORCE_PATH_STYLE: 'true',
      S3_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const storage = new StorageService(config);
    const started = Date.now();
    try { await expect(storage.ping()).rejects.toThrow(); expect(Date.now()-started).toBeLessThan(7_500); }
    finally { storage.onModuleDestroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 10_000);
});
