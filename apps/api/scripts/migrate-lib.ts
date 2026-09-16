import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const ROOT = join(__dirname, '..', '..', '..', 'db');

/**
 * Applies SQL migrations in order, each in its own transaction, then re-applies grants.
 * - A changed checksum on an applied migration aborts: history is never rewritten.
 * - An advisory lock prevents two deploys migrating at once.
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
    await client.query(readFileSync(join(ROOT, 'grants.sql'), 'utf8'));
    log(applied.length ? `✓ ${applied.length} migration(s) applied` : '✓ database is up to date');
    return applied;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(727274)`).catch(() => undefined);
    await client.end();
  }
}
