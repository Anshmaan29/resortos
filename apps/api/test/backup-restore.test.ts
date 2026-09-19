import { generateKeyPairSync } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATOR_URL } from './helpers';

/**
 * Milestone 2G — minimum viable Gate 0 (spec §53, §85).
 *
 * A backup nobody has restored is not a backup, so this is the restore test itself, run on every
 * commit: dump → encrypt → upload under Object Lock → download → decrypt → verify the plaintext
 * hash → restore into a throwaway database → run the integrity checks.
 *
 * MinIO stands in for the off-site provider. It speaks the same S3 API as Backblaze B2 and
 * Cloudflare R2, including Object Lock — which is why the "the bucket refuses to delete it" test
 * below is worth something rather than being a comment about what production will do.
 */
const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'auto',
  credentials: { accessKeyId: 'resortos', secretAccessKey: 'resortos-dev-minio-secret' },
  forcePathStyle: true,
};
const BUCKET = 'resortos-backups-test';

let publicKey: string;
let privateKey: string;
let s3: S3Client;
let taken: { key: string; sha256: string; plainBytes: number };

beforeAll(async () => {
  // The key pair a resort would generate once, on a machine that is not the server. Only the
  // public half is ever copied to the backup host.
  ({ publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }));
  s3 = new S3Client(S3);
}, 60_000);
afterAll(() => s3?.destroy());

describe('the nightly off-site backup', () => {
  it('dumps, encrypts and uploads with a retention date the writing credentials cannot shorten', async () => {
    const { takeBackup } = await import('../../../ops/backup/backup.mjs');
    taken = await takeBackup({
      databaseUrl: MIGRATOR_URL,
      publicKey,
      bucket: BUCKET,
      endpoint: S3.endpoint,
      region: S3.region,
      credentials: S3.credentials,
      retentionDays: 1,
      log: () => undefined,
    });

    expect(taken.key).toMatch(/^\d{4}\/\d{2}\/resortos-.*\.dump\.enc$/);
    expect(taken.plainBytes).toBeGreaterThan(50_000);

    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: taken.key }));
    expect(head.ObjectLockMode).toBe('COMPLIANCE');
    expect(head.ObjectLockRetainUntilDate!.getTime()).toBeGreaterThan(Date.now());
  }, 120_000);

  it('cannot be destroyed while the retention stands — the point of the whole layer', async () => {
    // Ransomware holding the server's keys can encrypt the live database. This is the copy it
    // cannot touch, and the guarantee comes from the storage provider, not from our code.
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: taken.key }));
    const versionId = head.VersionId!;
    expect(versionId).toBeTruthy();

    await expect(s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: taken.key, VersionId: versionId })))
      .rejects.toThrow(/WORM|retention|Access ?Denied|protected/i);
    await expect(s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: taken.key, VersionId: versionId }))).resolves.toBeTruthy();

    // Object Lock is only half of it, and the half it is not covers a real attack. A delete without
    // a version id is *accepted*: it writes a delete marker, which destroys nothing but hides the
    // backup from every listing — including the restore test's "find the newest backup". The other
    // half is the IAM policy on the write credentials, which must deny s3:DeleteObject outright
    // (spec §53.3, "write but not delete"). ops/runbooks/restore.md carries the policy.
    const marker = await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: taken.key }));
    expect(marker.DeleteMarker).toBe(true);
    await expect(s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: taken.key, VersionId: versionId }))).resolves.toBeTruthy();

    // Put the listing back, so the restore test below sees what a real one would.
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: taken.key, VersionId: marker.VersionId }));
    await expect(s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: taken.key }))).resolves.toBeTruthy();
  }, 30_000);

  it('is unreadable without the key, which does not live on the machine that wrote it', async () => {
    const { readHeader, open } = await import('../../../ops/backup/envelope.mjs');
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: taken.key }));
    const chunks: Buffer[] = [];
    for await (const chunk of object.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    const sealed = Buffer.concat(chunks);

    // The header is readable by anyone — that is deliberate, so an alert can say how old the
    // newest backup is without holding the key.
    const { header } = readHeader(sealed);
    expect(header.sha256).toBe(taken.sha256);
    expect(header.wrap).toBe('RSA-OAEP-SHA256');

    // The contents are not. A pg_dump custom-format file starts with the magic "PGDMP".
    expect(sealed.includes(Buffer.from('PGDMP'))).toBe(false);
    const wrongKey = generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    expect(() => open(sealed, wrongKey)).toThrow();

    // One flipped byte anywhere is caught, rather than restoring silently corrupted data.
    const tampered = Buffer.from(sealed);
    const at = Math.floor(tampered.length / 2);
    tampered.writeUInt8(tampered.readUInt8(at) ^ 0x01, at);
    expect(() => open(tampered, privateKey)).toThrow();
  }, 60_000);
});

describe('the restore test', () => {
  it('restores the newest backup into a throwaway database and finds nothing wrong', async () => {
    const { runRestoreTest } = await import('../../../ops/backup/restore-test.mjs');
    const report = await runRestoreTest({
      privateKey,
      bucket: BUCKET,
      endpoint: S3.endpoint,
      region: S3.region,
      credentials: S3.credentials,
      adminUrl: MIGRATOR_URL,
      compareWith: MIGRATOR_URL,
      log: () => undefined,
    });

    // Findings first: if this fails, the useful output is *what* was wrong in the restored copy,
    // not the word FAIL. These checks run over whatever state the other suites left behind, so a
    // failure here usually means a fixture built something the real code never could.
    expect(report.findings).toEqual([]);
    expect(report.result).toBe('PASS');
    expect(report.steps.map((step) => step.step)).toEqual(['download', 'decrypt', 'restore', 'integrity', 'counts']);

    // The plaintext hash was checked against what was recorded when the backup was written: the
    // restore got back exactly what was dumped, not merely something that decrypted cleanly.
    const decrypt = report.steps.find((step) => step.step === 'decrypt')!;
    expect(decrypt.verified).toBe(true);
    expect(decrypt.sha256).toBe(taken.sha256);

    // The data is really there — a restore that produced an empty schema would also "succeed".
    const counts = report.steps.find((step) => step.step === 'counts')!.restored as Record<string, string>;
    // Tables the seed always fills, so this holds whatever order the suites ran in. (audit_logs is
    // deliberately not here: a freshly seeded database has none, because the seed writes rows
    // directly rather than through the API.)
    expect(Number(counts.properties)).toBe(1);
    expect(Number(counts.users)).toBeGreaterThan(0);
    expect(Number(counts.guests)).toBeGreaterThan(0);
    expect(Number(counts.reservations)).toBeGreaterThan(0);
    expect(Number(counts.reservation_rooms)).toBeGreaterThan(0);

    // And it is recorded, because Gate 0 asks for evidence with a date and a duration.
    expect(report.startedAt).toBeTruthy();
    expect(report.totalSeconds).toBeGreaterThan(0);
  }, 180_000);

  it('leaves no throwaway database behind', async () => {
    const { runPgTool } = await import('../../../ops/backup/pg-tools.mjs');
    const left = await runPgTool('psql', ['-t', '-A', '-d', '@url'], {
      url: MIGRATOR_URL,
      stdin: `SELECT count(*) FROM pg_database WHERE datname LIKE 'resortos_restore_%'`,
    });
    expect(left.stdout.toString().trim()).toBe('0');
  }, 60_000);
});
