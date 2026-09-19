import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/jobs/jobs.service';
import { OUTBOX_HANDLERS, type OutboxHandler } from '../src/jobs/outbox-handlers';
import { APP_URL, sql } from './helpers';

/**
 * The job runtime itself (spec §7), started the way production starts it: as `resortos_app`, the
 * least-privileged role, with `migrate: false`. The schema is installed by `pnpm db:migrate` as the
 * migration role — if that split were wrong, pg-boss would fail here and nowhere else.
 */
let app: INestApplication;
let handlers: OutboxHandler[];

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: APP_URL,
    JOBS_ENABLED: 'true',
    SESSION_COOKIE_SECURE: 'false',
    WEB_ORIGIN: 'http://localhost:3000',
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
    S3_BUCKET: 'resortos-documents-test',
    S3_ACCESS_KEY_ID: 'resortos',
    S3_SECRET_ACCESS_KEY: 'resortos-dev-minio-secret',
    S3_FORCE_PATH_STYLE: 'true',
  });
  const { createApp } = await import('../src/bootstrap');
  app = await createApp();
  await app.init();
  handlers = app.get<OutboxHandler[]>(OUTBOX_HANDLERS);
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.JOBS_ENABLED;
});

describe('pg-boss runs as the least-privileged API role', () => {
  it('starts against the schema the migration role installed, and drains a real event', async () => {
    const seen: string[] = [];
    handlers.push({ name: 'runtime-probe', topics: ['runtime.probe'], handle: async (e) => { seen.push(e.id); } });

    const [property] = await sql<{ id: string }>(`SELECT id FROM properties LIMIT 1`);
    const [event] = await sql<{ id: string }>(
      `INSERT INTO outbox_events (property_id, topic, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'runtime.probe', 'test', $2, '{}'::jsonb) RETURNING id`,
      [property!.id, randomUUID()],
    );

    // Ask for a drain now rather than waiting for the minute heartbeat.
    await app.get(JobsService).nudge();

    const deadline = Date.now() + 20_000;
    let dispatched = false;
    while (Date.now() < deadline && !dispatched) {
      await new Promise((r) => setTimeout(r, 250));
      const [row] = await sql<{ dispatched_at: Date | null }>(`SELECT dispatched_at FROM outbox_events WHERE id = $1`, [event!.id]);
      dispatched = row!.dispatched_at !== null;
    }

    expect(dispatched).toBe(true);
    expect(seen).toContain(event!.id);
    handlers.length = 0;
  }, 40_000);

  it('the queue schema belongs to the migration role, and the API never got DDL rights', async () => {
    const [schema] = await sql<{ owner: string }>(
      `SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'pgboss'`,
    );
    expect(schema!.owner).toBe('resortos_migrator');
    const [rights] = await sql<{ can_create: boolean }>(
      `SELECT has_schema_privilege('resortos_app', 'public', 'CREATE') AS can_create`,
    );
    expect(rights!.can_create).toBe(false);
  });
});
