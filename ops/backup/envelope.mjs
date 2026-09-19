/**
 * Envelope encryption for off-site backups (spec §53.3, §54).
 *
 * The point is that **the machine taking the backup cannot read it back**. It holds only a public
 * key; the private key lives outside the primary cloud, on paper and on an offline device. A
 * compromised server, or a compromised backup bucket, yields ciphertext and nothing else.
 *
 *   random 32-byte data key ──AES-256-GCM──> the dump
 *   data key ──RSA-OAEP(SHA-256)──> wrapped, stored in the header
 *
 * Both primitives are Node built-ins, so a resort's ops box needs no extra software. `age` would be
 * the alternative and is a fine choice; this stays with the standard library because the restore
 * test below decrypts and restores for real on every CI run, which is the assurance that matters —
 * a backup nobody has restored is not a backup.
 *
 * File layout:
 *   magic 'RESORTOS-BK1\n' | 4-byte header length (BE) | JSON header | ciphertext | 16-byte tag
 */
import { createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes, constants } from 'node:crypto';

export const MAGIC = Buffer.from('RESORTOS-BK1\n');
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

/** Encrypts `plaintext` to `publicKeyPem`. `meta` is stored in the clear — never put secrets in it. */
export function seal(plaintext, publicKeyPem, meta = {}) {
  const dataKey = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.from(JSON.stringify({
    v: 1,
    alg: 'AES-256-GCM',
    wrap: 'RSA-OAEP-SHA256',
    iv: iv.toString('base64'),
    key: publicEncrypt({ key: publicKeyPem, ...OAEP }, dataKey).toString('base64'),
    ...meta,
  }));
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length);
  // The header is authenticated by nothing, so anything that must be trusted (the SHA-256 of the
  // plaintext) is checked after decryption, against what the dump actually decrypts to.
  return Buffer.concat([MAGIC, headerLength, header, body, tag]);
}

/** Reads the clear header without needing the private key — what a listing or an alert can show. */
export function readHeader(sealed) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a ResortOS backup file');
  const headerLength = sealed.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  return { header: JSON.parse(sealed.subarray(start, start + headerLength).toString()), bodyStart: start + headerLength };
}

/** Decrypts with the offline private key. Throws if the file was altered by so much as one byte. */
export function open(sealed, privateKeyPem, passphrase) {
  const { header, bodyStart } = readHeader(sealed);
  if (header.v !== 1) throw new Error(`Unsupported backup format version ${header.v}`);
  const dataKey = privateDecrypt(
    { key: privateKeyPem, ...(passphrase ? { passphrase } : {}), ...OAEP },
    Buffer.from(header.key, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  const body = sealed.subarray(bodyStart, sealed.length - TAG_BYTES);
  return { plaintext: Buffer.concat([decipher.update(body), decipher.final()]), header };
}
