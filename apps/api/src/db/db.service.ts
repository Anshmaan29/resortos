import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config';

// Keep money and dates exact: NUMERIC and DATE come back as strings, never JS numbers/Date objects.
types.setTypeParser(1700, (v) => v); // numeric
types.setTypeParser(1082, (v) => v); // date
types.setTypeParser(20, (v) => v); // int8 (bigint)

/**
 * Every query must declare its row type: the default is `never`, so reading an untyped
 * result is a compile error. Values are always passed as parameters ($1, $2 …) — a test
 * scans the source to make sure no SQL string is built by interpolation.
 */
export interface Queryable {
  query<R extends QueryResultRow = never>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  /**
   * True only for the pool, where each query takes its own connection. A pooled client — what `tx`
   * hands to its callback — speaks one connection and runs one query at a time, silently queueing
   * the rest: `Promise.all` over it is not parallel at all, and pg 9 removes that queue and makes
   * it an error. Read it through `gather()` rather than branching on it by hand.
   */
  readonly parallelSafe?: boolean;
}

/**
 * Runs read queries together when `q` can actually do them together, and one after another when it
 * cannot. Same result either way, so a function like `detail()` can be called both from a
 * controller (on the pool) and from inside a transaction without knowing which it got.
 */
export function gather<T extends readonly (() => Promise<unknown>)[]>(
  q: Queryable,
  tasks: [...T],
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  type Results = { [K in keyof T]: Awaited<ReturnType<T[K]>> };
  if (q.parallelSafe) return Promise.all(tasks.map((task) => task())) as Promise<Results>;
  return (async () => {
    const results: unknown[] = [];
    for (const task of tasks) results.push(await task());
    return results as Results;
  })();
}

export interface TxContext {
  userId?: string;
  reason?: string;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly pool: Pool;
  /** Every query here takes its own connection from the pool, so fanning out is real parallelism. */
  readonly parallelSafe = true;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      // Waiting for a free connection during a burst; beyond this the request fails as SERVICE_BUSY (503).
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      application_name: 'resortos-api',
    });
    this.pool.on('error', (err) => this.logger.error(`Idle client error: ${err.message}`));
  }

  query<R extends QueryResultRow = never>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }> {
    return this.pool.query<R>(text, values);
  }

  /**
   * Runs `fn` in one transaction (spec §8.2). Business change + audit + outbox
   * commit together or not at all. The acting user is exposed to DB triggers.
   */
  async tx<T>(ctx: TxContext, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('resortos.user_id', $1, true), set_config('resortos.reason', $2, true)`,
        [ctx.userId ?? '', ctx.reason ?? ''],
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
