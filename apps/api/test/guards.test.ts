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
