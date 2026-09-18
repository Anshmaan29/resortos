import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OUTBOX_HANDLERS, backoffSeconds, MAX_ATTEMPTS, type OutboxEvent, type OutboxHandler } from '../src/jobs/outbox-handlers';
import { OutboxDispatcher } from '../src/jobs/outbox.dispatcher';
import { bootApp, login, sql, type Agent } from './helpers';

/** The outbox worker (spec §8.2, §13): after-commit work that can fail without losing anything. */
let app: INestApplication;
let dispatcher: OutboxDispatcher;
let handlers: OutboxHandler[];
let owner: Agent;
let desk: Agent;
let propertyId: string;

beforeAll(async () => {
  app = await bootApp();
  dispatcher = app.get(OutboxDispatcher);
  // The module registers an empty array; tests push handlers into that same instance.
  handlers = app.get<OutboxHandler[]>(OUTBOX_HANDLERS);
  owner = await login(app, 'owner');
  desk = await login(app, 'receptionist');
  const [p] = await sql<{ id: string }>(`SELECT id FROM properties LIMIT 1`);
  propertyId = p!.id;
});
afterAll(async () => { await app.close(); });

beforeEach(async () => {
  handlers.length = 0;
  // Start from a clean slate: earlier suites leave real events behind.
  await sql(`UPDATE outbox_events SET dispatched_at = now() WHERE dispatched_at IS NULL AND failed_at IS NULL`);
});

async function emit(topic: string, payload: Record<string, unknown> = {}): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO outbox_events (property_id, topic, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, 'test', $3, $4) RETURNING id`,
    [propertyId, topic, randomUUID(), JSON.stringify(payload)],
  );
  return row!.id;
}

const eventRow = (id: string) => sql<{
  attempts: number; dispatched_at: Date | null; failed_at: Date | null; last_error: string | null; available_at: Date; payload: any;
}>(`SELECT attempts, dispatched_at, failed_at, last_error, available_at, payload FROM outbox_events WHERE id = $1`, [id]).then((r) => r[0]!);

/** Makes every pending event due now, standing in for the passage of time. */
const makeDue = () => sql(`UPDATE outbox_events SET available_at = now() WHERE dispatched_at IS NULL AND failed_at IS NULL`);

describe('retry schedule', () => {
  it('backs off, keeps jitter inside the step, and caps at 30 minutes', () => {
    for (const attempt of [1, 2, 3, 4, 8, 20]) {
      const base = Math.min(1800, 15 * 2 ** (attempt - 1));
      const seconds = backoffSeconds(attempt);
      expect(seconds).toBeGreaterThanOrEqual(Math.floor(base / 2));
      expect(seconds).toBeLessThanOrEqual(base);
    }
    expect(backoffSeconds(99)).toBeLessThanOrEqual(1800);
  });
});

describe('dispatching', () => {
  it('runs the handler that asked for the topic, and only that one', async () => {
    const seen: string[] = [];
    handlers.push(
      { name: 'welcome', topics: ['stay.checked_in'], handle: async (e) => { seen.push(`welcome:${e.payload.room}`); } },
      { name: 'sheets', topics: '*', handle: async (e) => { seen.push(`sheets:${e.topic}`); } },
      { name: 'invoices', topics: ['invoice.finalized'], handle: async () => { seen.push('invoices'); } },
    );
    const id = await emit('stay.checked_in', { room: '204' });

    const result = await dispatcher.drainOnce();
    expect(result.dispatched).toBe(1);
    expect(seen).toEqual(['welcome:204', 'sheets:stay.checked_in']);

    const row = await eventRow(id);
    expect(row.dispatched_at).not.toBeNull();
    expect(row.failed_at).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('carries the payload written inside the business transaction', async () => {
    let received: OutboxEvent | null = null;
    handlers.push({ name: 'capture', topics: '*', handle: async (e) => { received = e; } });
    await emit('grc.generated', { version: 2, number: 'GRC-000007' });
    await dispatcher.drainOnce();
    expect(received!.payload).toEqual({ version: 2, number: 'GRC-000007' });
    expect(received!.propertyId).toBe(propertyId);
  });

  it('an event nothing handles is not a failure and does not pile up', async () => {
    const id = await emit('housekeeping.task_needed');
    const result = await dispatcher.drainOnce();
    expect(result.dispatched).toBe(1);
    expect((await eventRow(id)).dispatched_at).not.toBeNull();
  });
});

describe('a failing handler retries and never loses the event', () => {
  it('fails twice, then succeeds, and the event is delivered exactly once in the end', async () => {
    let calls = 0;
    handlers.push({
      name: 'flaky-whatsapp',
      topics: ['stay.checked_out'],
      handle: async () => {
        calls += 1;
        if (calls <= 2) throw new Error(`WhatsApp provider returned 503 (call ${calls})`);
      },
    });
    const id = await emit('stay.checked_out', { room: '204' });

    const first = await dispatcher.drainOnce();
    expect(first.retrying).toBe(1);
    expect(first.dispatched).toBe(0);
    let row = await eventRow(id);
    expect(row.attempts).toBe(1);
    expect(row.dispatched_at).toBeNull();
    expect(row.failed_at).toBeNull();
    expect(row.last_error).toMatch(/503 \(call 1\)/);

    // It is deferred, so a tight loop does not hammer a service that is already unwell.
    expect(await dispatcher.drainOnce()).toMatchObject({ claimed: 0 });

    await makeDue();
    expect(await dispatcher.drainOnce()).toMatchObject({ retrying: 1 });
    await makeDue();
    const third = await dispatcher.drainOnce();

    expect(third.dispatched).toBe(1);
    expect(calls).toBe(3);
    row = await eventRow(id);
    expect(row.attempts).toBe(3);
    expect(row.dispatched_at).not.toBeNull();
    expect(row.last_error).toBeNull();

    // Delivered once: a dispatched event is never claimed again.
    await makeDue();
    expect(await dispatcher.drainOnce()).toMatchObject({ claimed: 0 });
    expect(calls).toBe(3);
  });

  it('gives up after the maximum attempts, keeps the event, and never retries it again', async () => {
    handlers.push({ name: 'always-broken', topics: ['email.send'], handle: async () => { throw new Error('mailbox does not exist'); } });
    const id = await emit('email.send');

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await makeDue();
      await dispatcher.drainOnce();
    }
    const row = await eventRow(id);
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.failed_at).not.toBeNull();
    expect(row.dispatched_at).toBeNull();
    expect(row.last_error).toBe('mailbox does not exist');

    // Dead-lettered: still there, still readable, no longer retried.
    await makeDue();
    expect(await dispatcher.drainOnce()).toMatchObject({ claimed: 0 });
    expect((await eventRow(id)).attempts).toBe(MAX_ATTEMPTS);
  });

  it('a handler that dies mid-flight leaves the event to be retried, not lost', async () => {
    let attempts = 0;
    handlers.push({
      name: 'crashes',
      topics: ['stay.room_shifted'],
      // Stands in for the process being killed: the outcome is never recorded.
      handle: async () => { attempts += 1; if (attempts === 1) throw new Error('process died'); },
    });
    const id = await emit('stay.room_shifted');
    await dispatcher.drainOnce();
    expect((await eventRow(id)).dispatched_at).toBeNull();

    await makeDue();
    await dispatcher.drainOnce();
    expect((await eventRow(id)).dispatched_at).not.toBeNull();
  });

  it('two workers draining at once never run the same event twice', async () => {
    const seen: string[] = [];
    handlers.push({ name: 'counter', topics: ['concurrent.test'], handle: async (e) => { seen.push(e.id); } });
    const ids = await Promise.all(Array.from({ length: 12 }, () => emit('concurrent.test')));

    const [a, b, c] = await Promise.all([dispatcher.drainOnce(), dispatcher.drainOnce(), dispatcher.drainOnce()]);
    expect(a.dispatched + b.dispatched + c.dispatched).toBe(12);
    expect(new Set(seen).size).toBe(12);

    const rows = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM outbox_events WHERE id = ANY($1::uuid[]) AND dispatched_at IS NOT NULL AND attempts = 1`, [ids],
    );
    expect(Number(rows[0]!.n)).toBe(12);
  });
});

describe('the database refuses to lose an event', () => {
  it('the API role cannot delete one', async () => {
    const id = await emit('never.deleted');
    const appDb = await sql<{ can: boolean }>(`SELECT has_table_privilege('resortos_app', 'outbox_events', 'DELETE') AS can`);
    expect(appDb[0]!.can).toBe(false);
    expect((await eventRow(id)).payload).toEqual({});
  });

  it('cannot be both dispatched and dead-lettered', async () => {
    const id = await emit('one.outcome');
    await expect(sql(`UPDATE outbox_events SET dispatched_at = now(), failed_at = now() WHERE id = $1`, [id]))
      .rejects.toThrow(/outbox_events_one_outcome/);
  });
});

describe('job status', () => {
  it('reports what is waiting, what is stuck, and which topics nothing handles yet', async () => {
    handlers.push({ name: 'always-broken', topics: ['dead.topic'], handle: async () => { throw new Error('nope'); } });
    const dead = await emit('dead.topic');
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) { await makeDue(); await dispatcher.drainOnce(); }
    await emit('waiting.topic');

    const res = await owner.get('/api/v1/health/jobs').expect(200);
    expect(res.body.status).toBe('attention');
    expect(res.body.deadLettered).toBeGreaterThanOrEqual(1);
    expect(res.body.pending).toBeGreaterThanOrEqual(1);
    expect(res.body.oldestPendingSeconds).toBeGreaterThanOrEqual(0);
    expect(res.body.handlers.map((h: { name: string }) => h.name)).toContain('always-broken');
    expect(res.body.topicsWithoutHandler).toContain('waiting.topic');
    expect((await eventRow(dead)).failed_at).not.toBeNull();
  });

  it('is owner-only: queue depth is not a public liveness probe', async () => {
    await desk.get('/api/v1/health/jobs').expect(403);
    const { default: request } = await import('supertest');
    await request(app.getHttpServer()).get('/api/v1/health/jobs').expect(401);
  });
});
