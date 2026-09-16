import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booking, bootApp, fixtures, login, post, sql } from './helpers';

/** The audit hash chain must never fork, however many actions run at once (spec §50). */
let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });

describe('audit chain under concurrency', () => {
  it('stays a single valid chain after 60 parallel actions from several users', async () => {
    const desk = await login(app, 'receptionist');
    const owner = await login(app, 'owner');
    const f = await fixtures();
    const rooms = ['101', '102', '201', '202', '203', 'C2', 'C3'];
    const statuses = ['dirty', 'cleaning', 'clean', 'inspected'];
    const actions = Array.from({ length: 60 }, (_, i) => {
      const agent = i % 2 ? desk : owner;
      if (i % 3 === 0) {
        return post(agent, '/reservations', booking({ roomTypeId: f.type('STD'), arrival: '2027-05-01', departure: '2027-05-02' }));
      }
      return post(agent, `/rooms/${f.room(rooms[i % rooms.length]!)}/status`, { housekeeping: statuses[i % statuses.length] }, null);
    });
    const results = await Promise.all(actions);
    const serverErrors = results.filter((r) => r.status >= 500 && r.status !== 503).map((r) => ({ status: r.status, body: r.body }));
    expect(serverErrors).toEqual([]);
    // Business refusals (e.g. no room left) are fine; the chain must still be intact.
    // Under heavy machine load some requests may be refused as SERVICE_BUSY (503, nothing saved);
    // they must never surface as internal errors, and the chain must stay intact either way.
    expect(results.every((r) => [200, 201, 409, 503].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.status === 503).every((r) => r.body.code === 'SERVICE_BUSY' && r.body.details.retryable)).toBe(true);

    const [chain] = await sql(`SELECT (verify_audit_chain(id)).* FROM properties LIMIT 1`);
    expect(chain.ok).toBe(true);
    const [shape] = await sql(`SELECT count(*)::int AS n, max(chain_position)::int AS max, count(DISTINCT chain_position)::int AS distinct_positions,
                                      count(DISTINCT prev_hash)::int AS distinct_prev FROM audit_logs`);
    expect(shape.n).toBe(shape.max);
    expect(shape.distinct_positions).toBe(shape.n);
    expect(shape.distinct_prev).toBe(shape.n - 1); // every entry has a different parent: no forks
  });
});
