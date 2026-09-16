import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@resortos/shared';
import { APP_CONFIG, type AppConfig } from '../config';
import { AppError } from '../common/errors';

export interface UploadGrant {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface VerifyResult {
  ok: boolean;
  reason?: 'not_received' | 'size_mismatch' | 'checksum_mismatch';
}

/**
 * Object storage behind one interface (spec §7, §52). Development uses local disk with HMAC-signed,
 * short-lived URLs. Production uses a private, versioned, replicated S3 bucket (adapter pending).
 *
 * Nothing is trusted from the client: after upload the server re-reads the stored bytes and
 * checks size and SHA-256 before a document can count as received (spec §19.5).
 */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.root = isAbsolute(config.STORAGE_DIR) ? config.STORAGE_DIR : resolve(process.cwd(), config.STORAGE_DIR);
  }

  newKey(propertyId: string): string {
    const now = new Date();
    return `${propertyId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
  }

  private path(key: string): string {
    if (!/^[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/.test(key)) throw new AppError(ERROR_CODES.VALIDATION, 'Invalid storage key.');
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new AppError(ERROR_CODES.FORBIDDEN, 'Invalid storage key.');
    return full;
  }

  private sign(parts: (string | number)[]): string {
    return createHmac('sha256', this.config.STORAGE_SIGNING_SECRET).update(parts.join('|')).digest('base64url');
  }

  private checkSignature(expected: string, given: unknown) {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  uploadGrant(key: string, contentType: string, sizeBytes: number, expiresInSeconds = 600): UploadGrant {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = this.sign(['PUT', key, exp, sizeBytes, contentType]);
    const qs = new URLSearchParams({ key, exp: String(exp), size: String(sizeBytes), type: contentType, sig });
    return { method: 'PUT', url: `/api/v1/storage/upload?${qs}`, headers: { 'content-type': contentType }, expiresAt: new Date(exp * 1000) };
  }

  /** Streams an upload to disk. Write-once: an existing object is never overwritten. */
  async receiveUpload(query: Record<string, unknown>, contentType: string | undefined, body: Readable): Promise<{ sizeBytes: number }> {
    const key = String(query.key ?? '');
    const exp = Number(query.exp);
    const size = Number(query.size);
    const type = String(query.type ?? '');
    const forbidden = new AppError(ERROR_CODES.FORBIDDEN, 'This upload link is not valid. Please capture the document again.');
    if (!this.checkSignature(this.sign(['PUT', key, exp, size, type]), query.sig)) throw forbidden;
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) throw new AppError(ERROR_CODES.FORBIDDEN, 'This upload link has expired. Please try again.');
    if (contentType?.split(';')[0]?.trim() !== type) throw new AppError(ERROR_CODES.VALIDATION, 'The file type does not match the upload request.');

    const target = this.path(key);
    if (await stat(target).then(() => true, () => false)) throw new AppError(ERROR_CODES.CONFLICT, 'This document was already uploaded.');
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.part`;
    let received = 0;
    await new Promise<void>((ok, fail) => {
      const out = createWriteStream(temp, { flags: 'wx' });
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > size) {
          body.destroy();
          out.destroy();
          fail(new AppError(ERROR_CODES.VALIDATION, 'The file is larger than declared.'));
        }
      });
      body.on('error', fail);
      out.on('error', fail);
      out.on('finish', ok);
      body.pipe(out);
    }).catch(async (err) => {
      await rm(temp, { force: true });
      throw err;
    });
    await rename(temp, target);
    return { sizeBytes: received };
  }

  /** Server-side verification: re-hash what is actually stored. */
  async verify(key: string, sizeBytes: number, sha256: Buffer): Promise<VerifyResult> {
    const target = this.path(key);
    const info = await stat(target).catch(() => null);
    if (!info) return { ok: false, reason: 'not_received' };
    if (info.size !== sizeBytes) return { ok: false, reason: 'size_mismatch' };
    const digest = await new Promise<Buffer>((ok, fail) => {
      const hash = createHash('sha256');
      createReadStream(target).on('data', (c) => hash.update(c)).on('end', () => ok(hash.digest())).on('error', fail);
    });
    return digest.equals(sha256) ? { ok: true } : { ok: false, reason: 'checksum_mismatch' };
  }

  /** Short-lived signed view URL (spec §19.7: e.g. 60 seconds). */
  viewUrl(key: string, contentType: string, expiresInSeconds = 60): { url: string; expiresAt: Date } {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = this.sign(['GET', key, exp, contentType]);
    return { url: `/api/v1/storage/object?${new URLSearchParams({ key, exp: String(exp), type: contentType, sig })}`, expiresAt: new Date(exp * 1000) };
  }

  openForView(query: Record<string, unknown>): { stream: Readable; contentType: string } {
    const key = String(query.key ?? '');
    const exp = Number(query.exp);
    const type = String(query.type ?? '');
    if (!this.checkSignature(this.sign(['GET', key, exp, type]), query.sig) || !Number.isFinite(exp) || exp * 1000 < Date.now()) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'This link has expired.');
    }
    return { stream: createReadStream(this.path(key)), contentType: type };
  }

  get rootDir() {
    return this.root;
  }
}

