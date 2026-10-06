import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { loadConfig } from '../config';
import { StorageService } from './storage.service';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/test', S3_BUCKET: 'resortos-documents-test', PUBLIC_WEB_URL: 'https://hotel.example/capture/test' });
afterEach(() => vi.restoreAllMocks());

describe('private phone upload CORS setup', () => {
  it('preserves other rules and replaces our rule with only the hotel origin and required headers', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({ CORSRules: [{ ID: 'Other', AllowedOrigins: ['https://other.example'] }, { ID: 'ResortOSPhoneAccess', AllowedOrigins: ['https://old.example'] }] } as never).mockResolvedValueOnce({} as never);
    const storage = new StorageService(config);
    try {
      await expect(storage.configurePhoneAccess()).resolves.toEqual({ origin: 'https://hotel.example' });
      expect(send.mock.calls[0]![0]).toBeInstanceOf(GetBucketCorsCommand);
      const command = send.mock.calls[1]![0] as PutBucketCorsCommand;
      expect(command.input.CORSConfiguration?.CORSRules).toEqual([
        { ID: 'Other', AllowedOrigins: ['https://other.example'] },
        { ID: 'ResortOSPhoneAccess', AllowedOrigins: ['https://hotel.example'], AllowedMethods: ['GET', 'HEAD', 'PUT'], AllowedHeaders: ['content-type', 'x-amz-checksum-sha256', 'if-none-match'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 600 },
      ]);
    } finally { storage.onModuleDestroy(); }
  });
  it('sets a first rule when CORS is absent, but never overwrites after a permission failure', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValueOnce(new S3ServiceException({ name: 'NoSuchCORSConfiguration', $fault: 'client', $metadata: { httpStatusCode: 404 } })).mockResolvedValueOnce({} as never);
    const storage = new StorageService(config);
    try {
      await storage.configurePhoneAccess();
      expect(send).toHaveBeenCalledTimes(2);
      send.mockReset().mockRejectedValueOnce(new S3ServiceException({ name: 'AccessDenied', $fault: 'client', $metadata: { httpStatusCode: 403 } }));
      await expect(storage.configurePhoneAccess()).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
    } finally { storage.onModuleDestroy(); }
  });
});
