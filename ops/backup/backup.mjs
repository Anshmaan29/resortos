#!/usr/bin/env node
/**
 * Layer 3 backup (spec §53.3): a nightly logical dump, encrypted to a key this machine cannot read
 * back, written to a **different provider's** object storage under Object Lock.
 *
 * Run after night audit:
 *   node ops/backup/backup.mjs
 *
 * Environment:
 *   BACKUP_DATABASE_URL      the database to dump (read-only credentials are enough)
 *   BACKUP_PUBLIC_KEY        RSA public key, PEM. The private half never exists on this machine.
 *   BACKUP_S3_ENDPOINT       the off-site provider (Backblaze B2, Cloudflare R2, …)
 *   BACKUP_S3_BUCKET         created with Object Lock enabled — it cannot be added later
 *   BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY   write-only credentials (§53.3)
 *   BACKUP_RETENTION_DAYS    default 60 (§53.4 daily backups)
 *   BACKUP_S3_REGION         default 'auto'
 *
 * What makes this a backup rather than a file: the object is written with a retention date, so the
 * credentials that wrote it cannot delete or overwrite it. Ransomware with the server's keys can
 * encrypt the live database; it cannot touch last night's copy.
 */
import { createHash } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { seal } from './envelope.mjs';
import { runPgTool } from './pg-tools.mjs';

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See ops/runbooks/restore.md.`);
  return v;
};

/** `YYYY/MM/resortos-YYYY-MM-DDTHH-MM-SSZ.dump.enc` — sorts by date in any object browser. */
export function backupKey(at = new Date()) {
  const iso = at.toISOString().replace(/\.\d+Z$/, 'Z');
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/resortos-${iso.replace(/[:]/g, '-')}.dump.enc`;
}

export async function takeBackup({
  databaseUrl = need('BACKUP_DATABASE_URL'),
  publicKey = need('BACKUP_PUBLIC_KEY'),
  bucket = need('BACKUP_S3_BUCKET'),
  endpoint = need('BACKUP_S3_ENDPOINT'),
  region = process.env.BACKUP_S3_REGION ?? 'auto',
  credentials = {
    accessKeyId: need('BACKUP_S3_ACCESS_KEY_ID'),
    secretAccessKey: need('BACKUP_S3_SECRET_ACCESS_KEY'),
  },
  retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 60),
  forcePathStyle = process.env.BACKUP_S3_FORCE_PATH_STYLE !== 'false',
  now = new Date(),
  log = console.log,
} = {}) {
  // Custom format: compressed, and pg_restore can rebuild selectively from it.
  const dump = await runPgTool('pg_dump', ['-Fc', '--no-owner', '--no-privileges', '-d', '@url'], { url: databaseUrl });
  if (dump.code !== 0) {
    const stderr = dump.stderr.trim();
    if (/server version|aborting because of server version mismatch/i.test(stderr)) {
      throw new Error(
        `pg_dump is the wrong version for this server: ${stderr}\n` +
        'Install the client matching the server major version (postgresql-client-16), or set ' +
        'RESORTOS_PG_TOOLS=compose to use the tools inside the database container.',
      );
    }
    throw new Error(`pg_dump failed: ${stderr}`);
  }
  if (dump.stdout.length === 0) throw new Error('pg_dump produced an empty file');

  const sha256 = createHash('sha256').update(dump.stdout).digest('hex');
  const sealed = seal(dump.stdout, publicKey, {
    takenAt: now.toISOString(),
    plainBytes: dump.stdout.length,
    // The hash of the *plaintext*, checked after decryption. It is what proves the restore got back
    // exactly what was dumped, rather than something that merely decrypted without error.
    sha256,
    format: 'pg_dump-custom',
  });

  const key = backupKey(now);
  const retainUntil = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  const s3 = new S3Client({ endpoint, region, credentials, forcePathStyle });
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: sealed,
    ContentType: 'application/octet-stream',
    // COMPLIANCE, not GOVERNANCE: nobody can shorten it, including whoever holds the root account.
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: retainUntil,
    Metadata: { sha256, 'plain-bytes': String(dump.stdout.length) },
  }));
  s3.destroy();

  const result = { key, bucket, sha256, plainBytes: dump.stdout.length, sealedBytes: sealed.length, retainUntil };
  log(`✓ ${key} — ${(sealed.length / 1024 / 1024).toFixed(1)} MB encrypted, locked until ${retainUntil.toISOString().slice(0, 10)}`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  takeBackup().catch((error) => {
    console.error(`✗ Backup failed: ${error.message}`);
    process.exit(1);
  });
}
