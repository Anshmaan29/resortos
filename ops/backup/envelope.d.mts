/** Types for envelope.mjs. The scripts stay plain JavaScript so an ops box needs no build step. */
export declare const MAGIC: Buffer;

export interface SealedHeader {
  v: number;
  alg: string;
  wrap: string;
  iv: string;
  key: string;
  /** SHA-256 of the plaintext, recorded when the backup was written and checked after decryption. */
  sha256?: string;
  takenAt?: string;
  plainBytes?: number;
  format?: string;
}

export declare function seal(plaintext: Buffer, publicKeyPem: string, meta?: Record<string, unknown>): Buffer;
export declare function readHeader(sealed: Buffer): { header: SealedHeader; bodyStart: number };
export declare function open(sealed: Buffer, privateKeyPem: string, passphrase?: string): { plaintext: Buffer; header: SealedHeader };
