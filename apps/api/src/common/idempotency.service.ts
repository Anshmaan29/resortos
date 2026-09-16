import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@resortos/shared';
import type { Queryable } from '../db/db.service';
import { canonicalJson, sha256 } from './canonical';
import { AppError } from './errors';
import type { Actor } from './request-context';

export interface IdempotentResult<T> {
  body: T;
  replayed: boolean;
}

/**
 * Idempotency inside the business transaction (spec §51).
 *
 * The key row is inserted first. A concurrent request with the same key blocks on the
 * primary key until the first transaction finishes:
 *  - first commits  → second sees the stored response and returns it (nothing new happens)
 *  - first rolls back → second proceeds normally
 */
@Injectable()
export class IdempotencyService {
  async run<T>(
    q: Queryable,
    actor: Actor,
    key: string | undefined,
    request: { method: string; path: string; body: unknown },
    fn: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    if (!key) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Missing Idempotency-Key header.');
    }
    if (!/^[A-Za-z0-9_\-:.]{8,128}$/.test(key)) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Invalid Idempotency-Key header.');
    }
    const hash = sha256(`${request.method} ${request.path}\n${canonicalJson(request.body)}`);

    const inserted = await q.query<{ key: string }>(
      `INSERT INTO idempotency_keys (user_id, key, property_id, method, path, request_hash)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
      [actor.user.id, key, actor.user.propertyId, request.method, request.path, hash],
    );

    if (inserted.rowCount === 0) {
      const { rows } = await q.query<{ request_hash: Buffer; response_body: T; completed_at: string | null }>(
        `SELECT request_hash, response_body, completed_at FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
        [actor.user.id, key],
      );
      const existing = rows[0];
      if (!existing || !existing.request_hash.equals(hash)) {
        throw new AppError(ERROR_CODES.IDEMPOTENCY_MISMATCH, 'This request key was already used for a different action.');
      }
      if (!existing.completed_at) {
        throw new AppError(ERROR_CODES.CONFLICT, 'This action is still being processed. Please wait a moment.');
      }
      return { body: existing.response_body, replayed: true };
    }

    const body = await fn();
    await q.query(
      `UPDATE idempotency_keys SET response_status = 200, response_body = $3, completed_at = now() WHERE user_id = $1 AND key = $2`,
      [actor.user.id, key, JSON.stringify(body)],
    );
    return { body, replayed: false };
  }
}
