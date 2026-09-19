#!/usr/bin/env node
/**
 * Restore test (spec §53.5) — the only thing that turns a backup into a backup.
 *
 *   take the latest off-site object
 *     ↓ decrypt with the offline private key
 *     ↓ check the plaintext hashes to what was recorded when it was written
 *     ↓ restore into a throwaway database
 *     ↓ run the integrity checks (ops/backup/integrity.sql)
 *     ↓ compare row counts and totals with the live database
 *     ↓ record PASS / FAIL with timings
 *     ↓ drop the throwaway database
 *
 * Run it:
 *   node ops/backup/restore-test.mjs
 *
 * Needs BACKUP_PRIVATE_KEY, which lives **outside the primary cloud** — so this is deliberately not
 * something the backup server itself can do. Run it from an operator's machine, or from a separate
 * environment that holds the key. Procedure: ops/runbooks/restore.md.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { open } from './envelope.mjs';
import { runPgTool } from './pg-tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See ops/runbooks/restore.md.`);
  return v;
};
const seconds = (from) => Math.round((Date.now() - from) / 100) / 10;

/** Newest object in the backup bucket — what a real recovery would reach for. */
export async function latestBackup(s3, bucket, prefix = '') {
  let newest = null;
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const obj of page.Contents ?? []) {
      if (!obj.Key?.endsWith('.dump.enc')) continue;
      if (!newest || obj.LastModified > newest.LastModified) newest = obj;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  if (!newest) throw new Error(`No backup found in ${bucket}${prefix ? `/${prefix}` : ''}`);
  return newest;
}

const asBuffer = async (body) => {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
};

export async function runRestoreTest({
  privateKey = need('BACKUP_PRIVATE_KEY'),
  passphrase = process.env.BACKUP_PRIVATE_KEY_PASSPHRASE,
  bucket = need('BACKUP_S3_BUCKET'),
  endpoint = need('BACKUP_S3_ENDPOINT'),
  region = process.env.BACKUP_S3_REGION ?? 'auto',
  credentials = {
    accessKeyId: need('BACKUP_S3_ACCESS_KEY_ID'),
    secretAccessKey: need('BACKUP_S3_SECRET_ACCESS_KEY'),
  },
  forcePathStyle = process.env.BACKUP_S3_FORCE_PATH_STYLE !== 'false',
  /** A live database to compare against. Optional: a restore still proves it restores without one. */
  compareWith = process.env.BACKUP_COMPARE_DATABASE_URL,
  /** Where the throwaway database is created. Must be an admin URL: it creates and drops a database. */
  adminUrl = need('BACKUP_RESTORE_ADMIN_URL'),
  prefix = process.env.BACKUP_S3_PREFIX ?? '',
  log = console.log,
} = {}) {
  const startedAt = new Date();
  const t0 = Date.now();
  const s3 = new S3Client({ endpoint, region, credentials, forcePathStyle });
  const steps = [];
  const findings = [];
  const scratch = `resortos_restore_${startedAt.toISOString().replace(/\D/g, '').slice(0, 14)}`;
  if (!/^resortos_restore_\d{14}$/.test(scratch)) throw new Error('Refusing to use an unexpected database name');

  try {
    const newest = await latestBackup(s3, bucket, prefix);
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: newest.Key }));
    const sealed = await asBuffer(object.Body);
    steps.push({ step: 'download', key: newest.Key, bytes: sealed.length, seconds: seconds(t0) });

    const tDecrypt = Date.now();
    const { plaintext, header } = open(sealed, privateKey, passphrase);
    const actual = createHash('sha256').update(plaintext).digest('hex');
    if (header.sha256 && actual !== header.sha256) {
      throw new Error(`The backup decrypted but its contents changed: expected ${header.sha256}, got ${actual}`);
    }
    steps.push({ step: 'decrypt', takenAt: header.takenAt, sha256: actual, verified: Boolean(header.sha256), seconds: seconds(tDecrypt) });

    const tRestore = Date.now();
    const admin = (db) => adminUrl.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
    await runPgTool('psql', ['-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`, '-d', '@url'], { url: admin('postgres') });
    await runPgTool('psql', ['-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${scratch}`, '-d', '@url'], { url: admin('postgres') });
    const restored = await runPgTool('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '-d', '@url'], {
      url: admin(scratch), stdin: plaintext,
    });
    if (restored.code !== 0) throw new Error(`pg_restore failed: ${restored.stderr.trim().split('\n').slice(-5).join(' ')}`);
    steps.push({ step: 'restore', database: scratch, seconds: seconds(tRestore) });

    const tChecks = Date.now();
    // The SQL goes in on stdin rather than with `psql -f`: the file lives here, but psql may be
    // running inside the database container, where this path does not exist.
    const integritySql = readFileSync(join(HERE, 'integrity.sql'), 'utf8');
    const checked = await runPgTool('psql', ['-t', '-A', '-v', 'ON_ERROR_STOP=1', '-d', '@url'], { url: admin(scratch), stdin: integritySql });
    if (checked.code !== 0) throw new Error(`Integrity checks could not run: ${checked.stderr.trim()}`);
    for (const line of checked.stdout.toString().split('\n').map((l) => l.trim()).filter(Boolean)) findings.push(line);
    steps.push({ step: 'integrity', findings: findings.length, seconds: seconds(tChecks) });

    const countsSql = readFileSync(join(HERE, 'counts.sql'), 'utf8');
    const restoredCounts = JSON.parse((await runPgTool('psql', ['-t', '-A', '-d', '@url'], { url: admin(scratch), stdin: countsSql })).stdout.toString().trim());
    let comparison = null;
    if (compareWith) {
      const liveCounts = JSON.parse((await runPgTool('psql', ['-t', '-A', '-d', '@url'], { url: compareWith, stdin: countsSql })).stdout.toString().trim());
      const differences = Object.keys(liveCounts)
        .filter((k) => String(liveCounts[k]) !== String(restoredCounts[k]))
        .map((k) => ({ key: k, live: liveCounts[k], restored: restoredCounts[k] }));
      comparison = { differences, live: liveCounts };
      // A restore is a point in time: the live database has moved on, so differences are expected
      // and reported rather than failed on. A restore with *fewer* rows than the backup claimed is
      // what would be alarming, and the SHA-256 check above already rules that out.
    }
    steps.push({ step: 'counts', restored: restoredCounts });

    const result = {
      result: findings.length === 0 ? 'PASS' : 'FAIL',
      startedAt: startedAt.toISOString(),
      totalSeconds: seconds(t0),
      backup: { bucket, key: newest.Key, takenAt: header.takenAt, bytes: sealed.length },
      steps,
      findings,
      comparison,
    };
    log(`${result.result} — restored ${newest.Key} in ${result.totalSeconds}s, ${findings.length} finding(s)`);
    for (const f of findings) log(`  • ${f}`);
    return result;
  } finally {
    const admin = (db) => adminUrl.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
    await runPgTool('psql', ['-c', `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`, '-d', '@url'], { url: admin('postgres') }).catch(() => undefined);
    s3.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRestoreTest()
    .then((r) => process.exit(r.result === 'PASS' ? 0 : 1))
    .catch((error) => {
      console.error(`✗ Restore test could not complete: ${error.message}`);
      process.exit(2);
    });
}
