import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { type CORSRule, GetBucketCorsCommand, PutBucketCorsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';

export interface UploadGrant {
  method: 'PUT';
  url: string;
  /** Must be sent exactly; they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface VerifyResult {
  ok: boolean;
  reason?: 'not_received' | 'size_mismatch' | 'checksum_mismatch';
}

const UPLOAD_SECONDS = 600;
const VIEW_SECONDS = 60;

/**
 * Object storage through the S3 API only (spec §7, §52) — MinIO in development and CI,
 * a private, versioned, replicated S3 bucket in production. One code path everywhere.
 *
 * Uploads: pre-signed PUT that binds content type, length and SHA-256 checksum, and refuses to
 * overwrite (If-None-Match: *). The storage service itself rejects bytes whose checksum differs.
 * Verification: before a document counts as received, this server downloads the stored object and
 * re-hashes it (spec §19.5) — it does not trust the client or a metadata field.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly internal: S3Client;
  private readonly presigner: S3Client;
  private readonly bucket: string;
  private readonly webOrigin: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.webOrigin = new URL(config.PUBLIC_WEB_URL ?? config.WEB_ORIGIN).origin;
    const base = {
      region: config.S3_REGION,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000, throwOnRequestTimeout: true },
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
        : undefined,
      // Checksums are declared explicitly per upload; do not add SDK-default CRC32 parameters to URLs.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.internal = new S3Client({ ...base, endpoint: config.S3_ENDPOINT });
    // Browsers and phones must reach the signed host directly (e.g. https://<lan-ip>:9000 in development).
    this.presigner = new S3Client({ ...base, endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT });
    this.bucket = config.S3_BUCKET;
  }

  newKey(propertyId: string): string {
    const now = new Date();
    return `${propertyId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
  }

  async uploadGrant(key: string, contentType: string, sizeBytes: number, sha256Hex: string): Promise<UploadGrant> {
    const checksum = Buffer.from(sha256Hex, 'hex').toString('base64');
    const command = new PutObjectCommand({
      Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes, ChecksumSHA256: checksum, IfNoneMatch: '*',
    });
    const url = await getSignedUrl(this.presigner, command, {
      expiresIn: UPLOAD_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256', 'if-none-match']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256', 'if-none-match']),
    });
    return {
      method: 'PUT',
      url,
      headers: { 'content-type': contentType, 'x-amz-checksum-sha256': checksum, 'if-none-match': '*' },
      expiresAt: new Date(Date.now() + UPLOAD_SECONDS * 1000),
    };
  }

  /**
   * Stores bytes this server produced (registration cards, later invoice PDFs). Same discipline as a
   * pre-signed upload: the checksum travels with the request so storage itself rejects altered bytes,
   * and `If-None-Match: *` makes an overwrite impossible — a new version always gets a new key.
   */
  async putObject(key: string, body: Buffer, contentType: string, sha256: Buffer): Promise<void> {
    await this.internal.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length,
      ChecksumSHA256: sha256.toString('base64'), IfNoneMatch: '*',
    }));
  }

  async getObject(key: string): Promise<Buffer> {
    const object = await this.internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
    const chunks: Buffer[] = [];
    for await (const chunk of object.Body as Readable) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async verify(key: string, sizeBytes: number, sha256: Buffer): Promise<VerifyResult> {
    try {
      const head = await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (head.ContentLength !== sizeBytes) return { ok: false, reason: 'size_mismatch' };
      const object = await this.internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
      const hash = createHash('sha256');
      for await (const chunk of object.Body as Readable) hash.update(chunk as Buffer);
      return hash.digest().equals(sha256) ? { ok: true } : { ok: false, reason: 'checksum_mismatch' };
    } catch (err) {
      if (err instanceof S3ServiceException && (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404)) {
        return { ok: false, reason: 'not_received' };
      }
      throw err;
    }
  }

  /** Short-lived signed view URL (spec §19.7). */
  async viewUrl(key: string, contentType: string, downloadName?: string): Promise<{ url: string; expiresAt: Date }> {
    const url = await getSignedUrl(this.presigner, new GetObjectCommand({
      Bucket: this.bucket, Key: key, ResponseContentType: contentType, ResponseCacheControl: 'private, no-store', ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName}"` : 'inline',
    }), { expiresIn: VIEW_SECONDS });
    return { url, expiresAt: new Date(Date.now() + VIEW_SECONDS * 1000) };
  }

  /** Explicit owner setup for direct browser uploads; it never makes the bucket public. */
  async configurePhoneAccess() {
    let rules: CORSRule[];
    try { rules = (await this.internal.send(new GetBucketCorsCommand({ Bucket: this.bucket }))).CORSRules ?? []; }
    catch (err) {
      if (!(err instanceof S3ServiceException) || err.$metadata.httpStatusCode !== 404) throw err;
      rules = [];
    }
    await this.internal.send(new PutBucketCorsCommand({ Bucket: this.bucket, CORSConfiguration: { CORSRules: [
      ...rules.filter((r) => r.ID !== 'ResortOSPhoneAccess'),
      { ID: 'ResortOSPhoneAccess', AllowedOrigins: [this.webOrigin], AllowedMethods: ['GET', 'HEAD', 'PUT'],
        AllowedHeaders: ['content-type', 'x-amz-checksum-sha256', 'if-none-match'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 600 },
    ] } }));
    return { origin: this.webOrigin };
  }

  /** Readiness check for /health/storage. */
  async ping(): Promise<void> {
    await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: '__health__' }), { abortSignal: AbortSignal.timeout(5_000) }).catch((err: unknown) => {
      if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return;
      throw err;
    });
  }

  onModuleDestroy() {
    this.internal.destroy();
    this.presigner.destroy();
  }
}
