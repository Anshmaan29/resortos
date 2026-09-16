import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'rsos_session';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
