import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertProductionSafe, UnsafeProductionDataError } from '../src/safety/production-guard';
import type { Queryable } from '../src/db/db.service';
import { assertSeedAllowed } from '../scripts/seed-lib';
import { APP_URL, MIGRATOR_URL } from './helpers';
import { Pool } from 'pg';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('SQL safety', () => {
  it('no SQL text in the API is built by string interpolation — values are always $n parameters', () => {
    const offenders: string[] = [];
    for (const file of files(join(__dirname, '..', 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.query(?:<[^()]*?>)?\(\s*`([\s\S]*?)`/g)) {
        if (m[1]!.includes('${')) offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no read is fanned out over a Queryable with Promise.all — use gather()', () => {
    // A `Queryable` may be a single pooled client inside a transaction, which runs one query at a
    // time and quietly queues the rest. Promise.all over it is fake parallelism today and an error
    // in pg 9, so `gather()` decides based on what the caller actually handed us.
    /** The text between `Promise.all(` and its matching `)`, so a later statement is not blamed. */
    function argumentOf(src: string, openParen: number): string {
      let depth = 0;
      for (let i = openParen; i < src.length; i += 1) {
        const c = src[i];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') {
          depth -= 1;
          if (depth === 0) return src.slice(openParen + 1, i);
        }
      }
      return '';
    }

    const offenders: string[] = [];
    for (const file of files(join(__dirname, '..', 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/Promise\.all\(/g)) {
        const arg = argumentOf(src, m.index + 'Promise.all'.length);
        if (/\bq\.query\b/.test(arg)) offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('gather() adapts to what it was given', () => {
  it('runs together on the pool and one at a time on a transaction client', async () => {
    const { DbService, gather } = await import('../src/db/db.service');
    const db = new DbService({ DATABASE_URL: APP_URL } as never);
    try {
      // On the pool: three sleeps overlap, so the wall time is one sleep, not three.
      const started = Date.now();
      await gather(db, [
        () => db.query(`SELECT pg_sleep(0.3)`),
        () => db.query(`SELECT pg_sleep(0.3)`),
        () => db.query(`SELECT pg_sleep(0.3)`),
      ]);
      const parallel = Date.now() - started;

      // Inside a transaction there is one connection, so the same three sleeps queue up.
      const serial = await db.tx({}, async (q) => {
        const at = Date.now();
        await gather(q, [
          () => q.query(`SELECT pg_sleep(0.3)`),
          () => q.query(`SELECT pg_sleep(0.3)`),
          () => q.query(`SELECT pg_sleep(0.3)`),
        ]);
        return Date.now() - at;
      });

      expect(parallel).toBeLessThan(750);
      expect(serial).toBeGreaterThan(850);
      // The point of the helper: the caller gets the same shape either way.
      const rows = await db.tx({}, (q) => gather(q, [() => q.query<{ n: number }>(`SELECT 1::int AS n`), () => Promise.resolve('plain')]));
      expect(rows[0].rows[0]!.n).toBe(1);
      expect(rows[1]).toBe('plain');
    } finally {
      await db.onModuleDestroy();
    }
  });
});

describe('demo data can never reach production', () => {
  it('seed refuses production, missing RESORTOS_ENV and remote databases', () => {
    expect(() => assertSeedAllowed('postgres://u:p@localhost:5433/x', { NODE_ENV: 'production', RESORTOS_ENV: 'development' })).toThrow(/forbidden/);
    expect(() => assertSeedAllowed('postgres://u:p@localhost:5433/x', {})).toThrow(/RESORTOS_ENV/);
    expect(() => assertSeedAllowed('postgres://u:p@prod-db.ap-south-1.rds.amazonaws.com:5432/x', { RESORTOS_ENV: 'development' })).toThrow(/local database/);
    expect(() => assertSeedAllowed('postgres://u:p@localhost:5433/x', { RESORTOS_ENV: 'development' })).not.toThrow();
  });

  it('production boot refuses a database containing demo property, logins or placeholder GST rules', async () => {
    const pool = new Pool({ connectionString: APP_URL });
    try {
      const err = await assertProductionSafe(pool as unknown as Queryable).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsafeProductionDataError);
      expect((err as UnsafeProductionDataError).problems.join(' ')).toMatch(/demo property.*demo login.*placeholder GST/s);
    } finally {
      await pool.end();
    }
  });

  it('a clean database passes', async () => {
    const clean: Queryable = { query: (async () => ({ rows: [{ demo_properties: '0', demo_users: '0', placeholder_tax_rules: '0' }], rowCount: 1 })) as Queryable['query'] };
    await expect(assertProductionSafe(clean)).resolves.toBeUndefined();
    expect(MIGRATOR_URL).toContain('_test');
  });
});

describe('graceful failure under load', () => {
  it('pool exhaustion, statement timeouts, deadlocks and lock timeouts become SERVICE_BUSY, never internal errors', async () => {
    const { fromPgError } = await import('../src/common/errors');
    for (const err of [new Error('timeout exceeded when trying to connect'), { code: '57014' }, { code: '40P01' }, { code: '55P03' }]) {
      const mapped = fromPgError(err);
      expect(mapped?.code).toBe('SERVICE_BUSY');
      expect(mapped?.status).toBe(503);
    }
  });
});
