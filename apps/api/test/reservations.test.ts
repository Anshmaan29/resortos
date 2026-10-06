import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booking, bootApp, fixtures, key, login, post, sql, type Agent } from './helpers';

let app: INestApplication;
let desk: Agent;
let owner: Agent;
let f: Awaited<ReturnType<typeof fixtures>>;

beforeAll(async () => {
  app = await bootApp();
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  f = await fixtures();
});
afterAll(async () => { await app.close(); });

describe('double-booking protection (spec §13)', () => {
  it('two concurrent bookings of the same room: exactly one succeeds', async () => {
    const body = () => booking({ roomTypeId: f.type('DLX'), roomId: f.room('203'), arrival: '2026-10-05', departure: '2026-10-08' });
    const results = await Promise.all([post(desk, '/reservations', body()), post(owner, '/reservations', body())]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('ROOM_UNAVAILABLE');
    const rows = await sql(`SELECT count(*)::int AS n FROM room_allocations WHERE room_id = $1 AND status = 'reserved' AND start_date = '2026-10-05'`, [f.room('203')]);
    expect(rows[0].n).toBe(1);
  });

  it('many concurrent unassigned bookings never exceed room-type capacity', async () => {
    // Executive has 2 rooms (101, 107).
    const attempts = Array.from({ length: 6 }, () =>
      post(desk, '/reservations', booking({ roomTypeId: f.type('EXE'), arrival: '2026-11-10', departure: '2026-11-12', adults: 2 })));
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('allows checkout and new arrival in the same room on the same day', async () => {
    await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), roomId: f.room('103'), arrival: '2026-10-20', departure: '2026-10-22' })).expect(201);
    await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), roomId: f.room('103'), arrival: '2026-10-22', departure: '2026-10-23' })).expect(201);
  });

  it('the database itself rejects overlapping allocations, even bypassing the API', async () => {
    const rr = await sql(`SELECT id FROM reservation_rooms WHERE room_id = $1 LIMIT 1`, [f.room('103')]);
    await expect(sql(
      `INSERT INTO room_allocations (property_id, reservation_room_id, room_id, start_date, end_date)
       SELECT property_id, $1, $2, '2026-10-21', '2026-10-24' FROM rooms WHERE id = $2`,
      [rr[0].id, f.room('103')],
    )).rejects.toThrow(/no_overlapping_room_allocations/);
  });
});

describe('idempotency (spec §51)', () => {
  it('double-click with the same key creates one booking', async () => {
    const k = key();
    const body = booking({ roomTypeId: f.type('PRE'), arrival: '2026-12-01', departure: '2026-12-03' });
    const [a, b] = await Promise.all([post(desk, '/reservations', body, k), post(desk, '/reservations', body, k)]);
    const ok = [a, b].filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const numbers = new Set(ok.map((r) => r.body.number));
    expect(numbers.size).toBe(1);
    const retry = await post(desk, '/reservations', body, k).expect(201);
    expect(retry.body.number).toBe([...numbers][0]);
    const rows = await sql(`SELECT count(*)::int AS n FROM reservations r JOIN guests g ON g.id = r.primary_guest_id WHERE g.last_name = $1`, [body.guest.lastName]);
    expect(rows[0].n).toBe(1);
  });

  it('rejects mutations without a key', async () => {
    const res = await post(desk, '/reservations', booking({ roomTypeId: f.type('PRE'), arrival: '2026-12-01', departure: '2026-12-02' }), null);
    expect(res.status).toBe(400);
  });
});

describe('cancellation (spec §15)', () => {
  it('cancelling frees the room and keeps the booking in history', async () => {
    const body = booking({ roomTypeId: f.type('DLX'), roomId: f.room('202'), arrival: '2026-10-01', departure: '2026-10-03' });
    const created = await post(desk, '/reservations', body).expect(201);
    const cancelled = await post(desk, `/reservations/${created.body.id}/cancel`, { reason: 'guest_request' }).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), roomId: f.room('202'), arrival: '2026-10-01', departure: '2026-10-03' })).expect(201);
    const still = await desk.get(`/api/v1/reservations/${created.body.id}`).expect(200);
    expect(still.body.status).toBe('cancelled');
  });

  it('refuses money options when nothing was paid', async () => {
    const created = await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), arrival: '2026-10-11', departure: '2026-10-12' })).expect(201);
    const res = await post(desk, `/reservations/${created.body.id}/cancel`, { reason: 'guest_request', moneyOption: 'refund' });
    expect(res.status).toBe(400);
  });

  it('database refuses to un-cancel or delete a booking', async () => {
    const [r] = await sql(`SELECT id FROM reservations WHERE status = 'cancelled' LIMIT 1`);
    await expect(sql(`UPDATE reservations SET status = 'confirmed' WHERE id = $1`, [r.id])).rejects.toThrow(/cannot move/);
    await expect(sql(`DELETE FROM reservations WHERE id = $1`, [r.id])).rejects.toThrow(/not allowed/);
  });
});

describe('validation', () => {
  it('rejects past arrival, over-occupancy and duplicate OTA references', async () => {
    const past = await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), arrival: '2026-09-10', departure: '2026-09-12' }));
    expect(past.status).toBe(400);
    const crowd = await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), arrival: '2026-10-01', departure: '2026-10-02', adults: 5 }));
    expect(crowd.status).toBe(400);
    const ota = { source: 'agoda', otaReference: 'AG-99887766' };
    await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), arrival: '2026-10-03', departure: '2026-10-04', extra: ota })).expect(201);
    const dup = await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), arrival: '2026-10-05', departure: '2026-10-06', extra: ota }));
    expect(dup.status).toBe(409);
  });
});

describe('audit log integrity (spec §50)', () => {
  it('hash chain is valid after concurrent activity', async () => {
    const [row] = await sql(`SELECT (verify_audit_chain(id)).* FROM properties LIMIT 1`);
    expect(row.ok).toBe(true);
    expect(Number(row.checked)).toBeGreaterThan(10);
  });

  it('application role cannot modify or delete audit entries', async () => {
    const { Client } = await import('pg');
    const c = new Client({ connectionString: 'postgres://resortos_app:app_dev_password@localhost:5433/resortos_test' });
    await c.connect();
    await expect(c.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(c.query(`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/);
    await expect(c.query(`TRUNCATE audit_logs`)).rejects.toThrow(/permission denied/);
    await expect(c.query(`DROP TABLE reservations`)).rejects.toThrow(/must be owner/);
    await c.end();
  });

  it('detects tampering even by a privileged database user', async () => {
    await sql(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable`);
    try {
      await sql(`UPDATE audit_logs SET reason = 'edited' WHERE chain_position = 2`);
      const [row] = await sql(`SELECT (verify_audit_chain(id)).* FROM properties LIMIT 1`);
      expect(row.ok).toBe(false);
      expect(Number(row.first_bad_position)).toBe(2);
    } finally {
      await sql(`UPDATE audit_logs SET reason = NULL WHERE chain_position = 2`);
      await sql(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable`);
    }
  });
});


describe('manual extra guest prices', () => {
  it('quotes and saves a manual total for adults and children, preserves it on unrelated edits, and can waive it', async () => {
    const body = booking({ roomTypeId: f.type('DLX'), arrival: '2035-04-01', departure: '2035-04-03', nightlyRate: '4500' });
    const room = { ...body.rooms[0]!, adults: 2, childAges: [8], extraPersonRate: '375.50' };
    const estimate = await post(desk, '/reservations/estimate', { arrival: body.arrival, departure: body.departure, rooms: [room] }, null).expect(200);
    expect(estimate.body.rooms[0].extrasTotal).toBe('751.00');
    const created = await post(desk, '/reservations', { ...body, rooms: [room] }).expect(201);
    expect(created.body.rooms[0].extrasTotal).toBe('751.00');
    const agreed = { ...room, reservationRoomId: created.body.rooms[0].id, nightlyRate: undefined, extraPersonRate: undefined };
    const updated = await desk.patch(`/api/v1/reservations/${created.body.id}`).set('x-resortos', '1').set('idempotency-key', key())
      .send({ ...body, rooms: [agreed], specialRequests: 'Extra pillows', version: created.body.version }).expect(200);
    expect(updated.body.rooms[0].extrasTotal).toBe('751.00');
    const waived = await desk.patch(`/api/v1/reservations/${created.body.id}`).set('x-resortos', '1').set('idempotency-key', key())
      .send({ ...body, rooms: [{ ...agreed, reservationRoomId: updated.body.rooms[0].id, extraPersonRate: '0' }], version: updated.body.version }).expect(200);
    expect(waived.body.rooms[0].extrasTotal).toBe('0.00');
    expect(waived.body.rooms[0].roomTotal).toBe('9000.00');
    await post(desk, '/reservations/estimate', { arrival: body.arrival, departure: body.departure, rooms: [{ ...room, extraPersonRate: '-1' }] }, null).expect(400);
  });
});


describe('calendar range', () => {
  it('honours an explicit exclusive end and refuses oversized or ambiguous ranges', async () => {
    const range = await desk.get('/api/v1/calendar?from=2026-11-01&to=2026-11-29').expect(200);
    expect(range.body.to).toBe('2026-11-29');
    await desk.get('/api/v1/calendar?from=2026-11-01&to=2027-11-01').expect(400);
    await desk.get('/api/v1/calendar?from=2026-11-01&to=2026-11-10&days=3').expect(400);
  });
});
