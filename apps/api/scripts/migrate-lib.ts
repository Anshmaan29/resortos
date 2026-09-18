import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { PgBoss } from 'pg-boss';

/** The job queue lives in its own schema, owned by the migration role (spec §7). */
export const JOB_SCHEMA = 'pgboss';

/**
 * Creates or upgrades the job queue schema, as the migration role.
 *
 * pg-boss knows how to install its own schema and how to migrate an older one; letting it do that
 * is far safer than copying its DDL into a checksummed migration, which would pin one pg-boss
 * version forever and leave upgrades to be hand-written. It is started with its background work
 * switched off, because the only job here is the schema.
 */
async function installJobQueue(connectionString: string): Promise<void> {
  const boss = new PgBoss({
    connectionString,
    schema: JOB_SCHEMA,
    migrate: true,
    supervise: false,
    schedule: false,
    application_name: 'resortos-migrate',
  });
  try {
    await boss.start();
  } finally {
    await boss.stop({ graceful: false, close: true }).catch(() => undefined);
  }
}

const ROOT = join(__dirname, '..', '..', '..', 'db');

/**
 * Applies SQL migrations in order, each in its own transaction, then installs the job queue
 * schema and re-applies grants.
 * - A changed checksum on an applied migration aborts: history is never rewritten.
 * - An advisory lock prevents two deploys migrating at once.
 *
 * pg-boss owns its own schema and knows how to create and upgrade it. Its plans are idempotent
 * and take their own advisory lock, so they are run here on every migration — like `grants.sql`
 * — rather than frozen into a checksummed file that would pin one pg-boss version forever.
 * Running them here also means the API, which connects as the least-privileged `resortos_app`
 * and cannot create anything, never needs DDL rights: it starts pg-boss with `migrate: false`.
 */
export async function migrate(connectionString: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = new Client({ connectionString, application_name: 'resortos-migrate' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(727274)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(`SELECT version, checksum FROM schema_migrations`);
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    const files = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = readFileSync(join(ROOT, 'migrations', file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const version = file.replace(/\.sql$/, '');
      const existing = done.get(version);
      if (existing) {
        if (existing !== checksum) throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
        continue;
      }
      log(`→ applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`, [version, checksum]);
        await client.query('COMMIT');
        applied.push(version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await installJobQueue(connectionString);
    // Grants run last so they cover the queue schema too.
    await client.query(readFileSync(join(ROOT, 'grants.sql'), 'utf8'));
    log(applied.length ? `✓ ${applied.length} migration(s) applied` : '✓ database is up to date');
    return applied;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(727274)`).catch(() => undefined);
    await client.end();
  }
}
