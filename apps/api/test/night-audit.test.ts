import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootAppOnOwnDatabase, booking, fixtures, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/**
 * Milestone 2.1 — night audit and the business date (spec §35).
 *
 * This suite runs on a database of its own, because completing an audit moves the business date and
 * every other suite asserts the seeded one. See `bootAppOnOwnDatabase`.
 *
 * The seed gives us a realistic starting position on 2026-09-16: BK-000001 arrives today and nobody
 * has checked it in. The seed stops short of creating `stays` (check-in is a whole flow with
 * documents and a signature), so `checkInBySql` puts a guest in a room the way the seed would if it
 * went that far — a fixture shortcut, clearly marked, not a second check-in path.
 */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let f: Awaited<ReturnType<typeof fixtures>>;

const preview = (agent: Agent) => agent.get('/api/v1/night-audit').expect(200);
const complete = (agent: Agent, date: string) => post(agent, '/night-audit/complete', { businessDate: date });
const businessDate = async () => (await sql<{ d: string }>(`SELECT current_business_date AS d FROM properties`))[0]!.d;

/**
 * Puts a guest in a room, in house, arriving on the business date. A fixture shortcut: the real
 * check-in needs verified documents and a signature (milestone 1.8), which has its own suite, and
 * what this suite needs is simply somebody occupying a room.
 */
async function checkInBySql(input: { room: string; type: string; arrival: string; departure: string; name: string; mobile: string }): Promise<string> {
  // A booking cannot be created arriving before the business date, so an already-running stay is
  // created for today and then dated back — which is what a check-in yesterday would have left.
  const created = await post(owner, '/reservations', {
    ...booking({ roomTypeId: f.type(input.type), roomId: f.room(input.room), arrival: '2026-09-16', departure: '2026-09-17' }),
    guest: { firstName: input.name, lastName: 'Guest', mobile: input.mobile },
  }).expect(201);
  if (input.arrival !== '2026-09-16' || input.departure !== '2026-09-17') {
    await sql(`UPDATE reservation_rooms SET arrival = $2::date, departure = $3::date WHERE reservation_id = $1`,
      [created.body.id, input.arrival, input.departure]);
    await sql(`UPDATE reservations SET arrival = $2::date, departure = $3::date WHERE id = $1`,
      [created.body.id, input.arrival, input.departure]);
    await sql(`UPDATE reservation_room_nights SET night_date = $2::date
                WHERE reservation_room_id IN (SELECT id FROM reservation_rooms WHERE reservation_id = $1)`,
      [created.body.id, input.arrival]);
  }
  // The draft too is written directly: the real one refuses a booking that arrived before today,
  // which is exactly the situation being set up.
  const [draft] = await sql<{ id: string }>(
    `INSERT INTO check_in_drafts (property_id, reservation_id, reservation_room_ids, status, confirmed_at, created_by)
     SELECT r.property_id, r.id, array_agg(rr.id), 'confirmed', now(), r.created_by
       FROM reservations r JOIN reservation_rooms rr ON rr.reservation_id = r.id
      WHERE r.id = $1 GROUP BY r.property_id, r.id, r.created_by RETURNING id`,
    [created.body.id],
  );
  await sql(
    `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id,
                        business_date_in, expected_departure, checked_in_by)
     SELECT rr.property_id, rr.reservation_id, rr.id, rr.room_id, r.primary_guest_id, $2, rr.arrival, rr.departure, r.created_by
       FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id WHERE rr.reservation_id = $1`,
    [created.body.id, draft!.id],
  );
  await sql(`UPDATE reservation_rooms SET status = 'checked_in' WHERE reservation_id = $1`, [created.body.id]);
  // An allocation's room and start date are immutable by trigger, so re-dating means releasing the
  // one the booking created and holding the room again for the dates this fixture wants.
  await sql(`UPDATE room_allocations SET status = 'released', release_reason = 'test_fixture'
              WHERE reservation_room_id IN (SELECT id FROM reservation_rooms WHERE reservation_id = $1)`, [created.body.id]);
  await sql(
    `INSERT INTO room_allocations (property_id, reservation_room_id, room_id, start_date, end_date, status, created_by)
     SELECT rr.property_id, rr.id, rr.room_id, rr.arrival, rr.departure, 'checked_in', r.created_by
       FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id WHERE rr.reservation_id = $1`,
    [created.body.id],
  );
  await sql(`UPDATE reservations SET status = 'checked_in' WHERE id = $1`, [created.body.id]);
  const [stay] = await sql<{ id: string }>(`SELECT s.id FROM stays s JOIN reservation_rooms rr ON rr.id = s.reservation_room_id WHERE rr.reservation_id = $1`, [created.body.id]);
  return stay!.id;
}

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('nightaudit', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  f = await fixtures(sql);
  // A guest in room 102 whose departure date is the business date: the audit must not close a date
  // with somebody still in a room they were due to leave.
  // Arrived yesterday, due out today — a stay cannot both start and end on the same business date.
  await checkInBySql({ room: '103', type: 'STD', arrival: '2026-09-15', departure: '2026-09-16', name: 'Dueout', mobile: '9820022001' });
}, 120_000);
afterAll(async () => { await app.close(); });

/** Clears whatever is blocking the audit, the way the desk would from the screen. */
async function clearBlockers(agent: Agent) {
  for (;;) {
    const { body } = await preview(agent);
    const blocking = body.steps.filter((s: any) => s.blocking && s.items.length > 0);
    if (!blocking.length) return body;
    for (const step of blocking) {
      for (const item of step.items) {
        // Only ever take an action the step itself offered — the point of `actions` is that the
        // screen never presents something the backend will refuse.
        if (item.actions.includes('no_show')) await post(agent, `/reservations/${item.id}/no-show`, { note: 'Never arrived' }).expect(200);
        else if (item.actions.includes('cancel')) await post(agent, `/reservations/${item.id}/cancel`, { reason: 'change_of_plans' }).expect(200);
        else await post(agent, `/stays/${item.id}/checkout`, {}).expect(200);
      }
    }
  }
}

describe('the night audit screen', () => {
  it('reports the real blockers from the seeded day, and refuses to close while they stand', async () => {
    const { body } = await preview(desk);
    expect(body.businessDate).toBe('2026-09-16');
    expect(body.nextBusinessDate).toBe('2026-09-17');
    expect(body.alreadyCompleted).toBeNull();

    const arrivals = body.steps.find((s: any) => s.name === 'arrivals_not_checked_in');
    const departures = body.steps.find((s: any) => s.name === 'departures_not_checked_out');
    expect(arrivals.blocking).toBe(true);
    expect(arrivals.items.length).toBeGreaterThan(0);
    expect(arrivals.items[0].actions).toEqual(['no_show', 'extend_arrival', 'cancel']);
    expect(arrivals.items[0].label).toMatch(/BK-\d{6} · .+/);
    expect(departures.items.length).toBeGreaterThan(0);
    expect(departures.items[0].actions).toEqual(['check_out', 'extend_stay']);

    expect(body.blocked).toBe(true);
    expect(body.canComplete).toBe(false);

    // The steps are in spec order and every registered one is reported, blocking or not. This list
    // grows as milestones register steps — 2.2 added room_charges, 2.4 will add the shift check —
    // and it is asserted exactly so that a step appearing or vanishing is never silent.
    expect(body.steps.map((s: any) => s.name)).toEqual([
      'arrivals_not_checked_in', 'departures_not_checked_out', 'open_shifts', 'room_charges', 'room_status_check', 'integrity_check', 'summary',
    ]);

    const refused = await complete(desk, '2026-09-16').expect(400);
    expect(refused.body.message).toMatch(/still need attention before 16 Sep 2026/);
    expect(refused.body.details.blockers.map((b: any) => b.step)).toEqual(['arrivals_not_checked_in', 'departures_not_checked_out']);
    // Nothing moved.
    expect(await businessDate()).toBe('2026-09-16');
    expect(await sql(`SELECT id FROM night_audits`)).toHaveLength(0);
  });

  it('records the refusal, so the owner can see it was attempted and why', async () => {
    const rows = await sql<{ action: string; after_values: any }>(
      `SELECT action, after_values FROM audit_logs WHERE action = 'night_audit.refused' ORDER BY seq DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after_values.businessDate).toBe('2026-09-16');
    expect(rows[0]!.after_values.code).toBe('VALIDATION_FAILED');
    expect(rows[0]!.after_values.message).toMatch(/still need attention/);
    expect(rows[0]!.after_values.details.blockers.length).toBe(2);
  });

  it('is a read: polling it never writes anything', async () => {
    const [beforeRow] = await sql<{ n: string }>(`SELECT count(*) AS n FROM audit_logs`);
    await preview(desk);
    await preview(desk);
    const [afterRow] = await sql<{ n: string }>(`SELECT count(*) AS n FROM audit_logs`);
    expect(afterRow!.n).toBe(beforeRow!.n);
  });
});

describe('resolving the blockers', () => {
  it('marks an arrival that never came as a no-show, and frees the room', async () => {
    const { body } = await preview(desk);
    const item = body.steps.find((s: any) => s.name === 'arrivals_not_checked_in').items[0];
    const res = await post(desk, `/reservations/${item.id}/no-show`, { note: 'Called, phone off' }).expect(200);
    expect(res.body.status).toBe('no_show');

    const [row] = await sql<{ no_show_at: Date; no_show_note: string; no_show_money_option: string; cancelled_at: Date | null }>(
      `SELECT no_show_at, no_show_note, no_show_money_option, cancelled_at FROM reservations WHERE id = $1`, [item.id],
    );
    expect(row!.no_show_at).toBeTruthy();
    expect(row!.no_show_note).toBe('Called, phone off');
    expect(row!.no_show_money_option).toBe('none');
    // A no-show is not a cancellation: §15.3 counts them separately.
    expect(row!.cancelled_at).toBeNull();

    const alloc = await sql<{ status: string; release_reason: string }>(
      `SELECT a.status, a.release_reason FROM room_allocations a
         JOIN reservation_rooms rr ON rr.id = a.reservation_room_id WHERE rr.reservation_id = $1`, [item.id],
    );
    expect(alloc.every((a) => a.status === 'released' && a.release_reason === 'no_show')).toBe(true);

    // It is gone from the step, and cannot be marked twice.
    const after = await preview(desk);
    expect(after.body.steps.find((s: any) => s.name === 'arrivals_not_checked_in').items.map((i: any) => i.id)).not.toContain(item.id);
    await post(desk, `/reservations/${item.id}/no-show`, {}).expect(409);
  });

  it('refuses a no-show for a booking that has not arrived yet', async () => {
    const future = await post(owner, '/reservations', booking({ roomTypeId: f.type('DLX'), arrival: '2026-09-25', departure: '2026-09-26' })).expect(201);
    const refused = await post(owner, `/reservations/${future.body.id}/no-show`, {}).expect(409);
    expect(refused.body.message).toMatch(/arrives on 25 Sep 2026/);
  });

  it('extends a stay instead of checking it out, and prices the extra nights', async () => {
    const { body } = await preview(desk);
    const item = body.steps.find((s: any) => s.name === 'departures_not_checked_out').items[0];
    const before = await desk.get(`/api/v1/stays/${item.id}`).expect(200);

    const extended = await post(desk, `/stays/${item.id}/extend`, { newDeparture: '2026-09-18', reason: 'Guest staying two more nights' }).expect(200);
    expect(extended.body.expectedDeparture).toBe('2026-09-18');

    // The extra nights are priced and stored, and the nights already stayed are untouched.
    const nights = await sql<{ night_date: string; room_rate: string }>(
      `SELECT to_char(n.night_date, 'YYYY-MM-DD') AS night_date, n.room_rate
         FROM reservation_room_nights n JOIN stays s ON s.reservation_room_id = n.reservation_room_id
        WHERE s.id = $1 ORDER BY n.night_date`, [item.id],
    );
    expect(nights.map((n) => n.night_date)).toContain('2026-09-16');
    expect(nights.map((n) => n.night_date)).toContain('2026-09-17');
    expect(nights.every((n) => Number(n.room_rate) > 0)).toBe(true);

    // The room is held for the new nights too.
    const [alloc] = await sql<{ end_date: string }>(
      `SELECT to_char(a.end_date, 'YYYY-MM-DD') AS end_date FROM room_allocations a
         JOIN stays s ON s.reservation_room_id = a.reservation_room_id
        WHERE s.id = $1 AND a.status = 'checked_in'`, [item.id],
    );
    expect(alloc!.end_date).toBe('2026-09-18');
    expect(before.body.expectedDeparture).toBe('2026-09-16');

    // Gone from the blocking step, because the stay now runs past the business date.
    const after = await preview(desk);
    expect(after.body.steps.find((s: any) => s.name === 'departures_not_checked_out').items.map((i: any) => i.id)).not.toContain(item.id);
  });

  it('refuses an extension into a room somebody else has', async () => {
    // A guest in 103 until tomorrow, and 103 already sold to somebody else from tomorrow.
    const stayId = await checkInBySql({ room: '202', type: 'DLX', arrival: '2026-09-16', departure: '2026-09-17', name: 'Extend', mobile: '9820011001' });
    const next = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('DLX'), roomId: f.room('202'), arrival: '2026-09-17', departure: '2026-09-18' }),
      guest: { firstName: 'Next', lastName: 'Guest', mobile: '9820011002' },
    }).expect(201);

    const refused = await post(owner, `/stays/${stayId}/extend`, { newDeparture: '2026-09-18', reason: 'Wants one more night' }).expect(409);
    expect(refused.body.message).toMatch(/just booked by someone else/);

    // Nothing half-applied: the stay still ends when it did, and the other booking is untouched.
    expect((await owner.get(`/api/v1/stays/${stayId}`)).body.expectedDeparture).toBe('2026-09-17');
    const nights = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM reservation_room_nights n JOIN stays s ON s.reservation_room_id = n.reservation_room_id WHERE s.id = $1`, [stayId],
    );
    expect(nights[0]!.n).toBe('1');
    await post(owner, `/stays/${stayId}/checkout`, {}).expect(200);
    await post(owner, `/reservations/${next.body.id}/cancel`, { reason: 'guest_request' }).expect(200);
  });

  it('refuses an extension that is not an extension', async () => {
    const [stay] = await sql<{ id: string; expected_departure: string }>(
      `SELECT id, to_char(expected_departure, 'YYYY-MM-DD') AS expected_departure FROM stays WHERE status = 'in_house' ORDER BY expected_departure DESC LIMIT 1`,
    );
    const refused = await post(desk, `/stays/${stay!.id}/extend`, { newDeparture: stay!.expected_departure, reason: 'Typed the same date' }).expect(400);
    expect(refused.body.message).toMatch(/already booked until .*check them out instead/);
  });
});

describe('completing the audit', () => {
  it('closes the date, moves the business date, and records what it did', async () => {
    await clearBlockers(desk);
    const beforePreview = await preview(desk);
    expect(beforePreview.body.canComplete).toBe(true);
    expect(beforePreview.body.summary.roomsActive).toBeGreaterThan(0);

    const done = await complete(desk, '2026-09-16').expect(200);
    expect(done.body.alreadyCompleted).toBe(false);
    expect(done.body.run.businessDate).toBe('2026-09-16');
    expect(done.body.run.completedBy).toBe('Priya Sharma');
    expect(done.body.run.steps.map((s: any) => s.name)).toEqual([
      'arrivals_not_checked_in', 'departures_not_checked_out', 'open_shifts', 'room_charges', 'room_status_check', 'integrity_check', 'summary',
    ]);
    expect(done.body.run.summary).toMatchObject({
      roomsActive: expect.any(Number), roomsOccupied: expect.any(Number), occupancyPercent: expect.any(Number),
      arrivalsCheckedIn: expect.any(Number), departuresCompleted: expect.any(Number), noShows: expect.any(Number),
    });

    expect(await businessDate()).toBe('2026-09-17');
    const runs = await sql<{ business_date: string }>(`SELECT to_char(business_date, 'YYYY-MM-DD') AS business_date FROM night_audits`);
    expect(runs.map((r) => r.business_date)).toEqual(['2026-09-16']);

    // The screen now shows the closed date rather than a button that would fail.
    const after = await preview(desk);
    expect(after.body.businessDate).toBe('2026-09-17');
    expect(after.body.alreadyCompleted).toBeNull(); // a new, open date
  });

  it('emits exactly one completion event for the daily summary, Sheets mirror and metrics', async () => {
    const events = await sql<{ topic: string; payload: any }>(
      `SELECT topic, payload FROM outbox_events WHERE topic = 'night_audit.completed'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ businessDate: '2026-09-16', nextBusinessDate: '2026-09-17' });
  });

  it('appears in the day audit log with who ran it and what it posted', async () => {
    const log = await desk.get('/api/v1/night-audit/log').expect(200);
    expect(log.body).toHaveLength(1);
    expect(log.body[0]).toMatchObject({ businessDate: '2026-09-16', completedBy: 'Priya Sharma' });
    expect(log.body[0].steps.length).toBe(7);
    expect(log.body[0].startedAt).toBeTruthy();
  });

  it('is append-only: a completed run cannot be edited or deleted, even by the API role', async () => {
    await expect(sql(`UPDATE night_audits SET summary = '{}'::jsonb`)).rejects.toThrow(/never changed after it completes/);
    await expect(sql(`DELETE FROM night_audits`)).rejects.toThrow(/history is kept/);
  });

  it('marks the closed date closed, for the folio and payment rules that arrive in 2.2', async () => {
    const [closed] = await sql<{ yes: boolean; no: boolean }>(
      `SELECT is_business_date_closed(id, '2026-09-16') AS yes, is_business_date_closed(id, '2026-09-17') AS no FROM properties`,
    );
    expect(closed!.yes).toBe(true);
    expect(closed!.no).toBe(false);
  });
});

describe('running it twice', () => {
  it('a retried request returns the first run instead of closing a second date', async () => {
    await clearBlockers(desk);
    const date = await businessDate();
    const sameKey = `night-audit-retry-${date}`;

    const first = await post(desk, '/night-audit/complete', { businessDate: date }, sameKey).expect(200);
    expect(first.body.alreadyCompleted).toBe(false);
    const again = await post(desk, '/night-audit/complete', { businessDate: date }, sameKey).expect(200);
    expect(again.body.run.id).toBe(first.body.run.id);

    const runs = await sql<{ n: string }>(`SELECT count(*) AS n FROM night_audits WHERE business_date = $1::date`, [date]);
    expect(runs[0]!.n).toBe('1');
    const [daysRow] = await sql<{ days: number }>(`SELECT (current_business_date - $1::date)::int AS days FROM properties`, [date]);
    expect(daysRow!.days).toBe(1);
  });

  it('a fresh request for a date that has already been closed returns that run and changes nothing', async () => {
    const [closedRow] = await sql<{ d: string }>(`SELECT to_char(max(business_date), 'YYYY-MM-DD') AS d FROM night_audits`);
    const closed = closedRow!.d;
    const before = await businessDate();
    // No idempotency key: this is the real path, not a replay of a stored response.
    const again = await complete(desk, closed).expect(200);
    expect(again.body.alreadyCompleted).toBe(true);
    expect(again.body.run.businessDate).toBe(closed);
    expect(await businessDate()).toBe(before);
  });

  it('the database itself refuses a second run for the same date', async () => {
    // Guarantee 1 is a constraint, not application logic: even raw SQL cannot close a date twice.
    await expect(sql(
      `INSERT INTO night_audits (property_id, business_date, started_at, completed_at, completed_by, steps, summary)
       SELECT na.property_id, na.business_date, now(), now(), na.completed_by, '[]'::jsonb, '{}'::jsonb
         FROM night_audits na LIMIT 1`,
    )).rejects.toThrow(/night_audits_one_per_date/);
  });

  it('two people pressing Complete at the same moment close the date once, and the date moves once', async () => {
    await clearBlockers(owner);
    const before = await businessDate();

    // Six requests from two users, each naming the date the screen showed, none sharing an
    // idempotency key: nothing but the database serialises these.
    const results = await Promise.all([
      complete(desk, before), complete(owner, before), complete(desk, before),
      complete(owner, before), complete(desk, before), complete(owner, before),
    ]);
    // 200 for the one that closed it, 409 for the rest — and never a 503. A 503 here would mean
    // the audits deadlocked against each other, which they did while this held the property row
    // with FOR UPDATE: that blocks the KEY SHARE lock every foreign key to `properties` needs.
    // Never a 503: that would mean the audits deadlocked against each other, which they did while
    // this held the property row with FOR UPDATE — a lock strong enough to block the KEY SHARE that
    // every foreign key to `properties` needs.
    expect(results.map((r) => r.status).filter((sc) => sc !== 200 && sc !== 409)).toEqual([]);
    // Exactly one request did the work; the others found the date already closed and were handed
    // that same run, which is the answer they wanted anyway.
    expect(results.filter((r) => r.status === 200 && r.body.alreadyCompleted === false)).toHaveLength(1);

    const runs = await sql<{ n: string }>(`SELECT count(*) AS n FROM night_audits WHERE business_date = $1::date`, [before]);
    expect(runs[0]!.n).toBe('1');

    // The date advanced by exactly one day, however many requests raced. This is the assertion the
    // whole design exists for: two audits at once must not skip a day of trading.
    const [daysRow] = await sql<{ days: number }>(
      `SELECT (current_business_date - $1::date)::int AS days FROM properties`, [before],
    );
    expect(daysRow!.days).toBe(1);

    // Every successful response describes the same single run.
    const ids = new Set(results.filter((r) => r.status === 200).map((r) => r.body.run.id));
    expect(ids.size).toBe(1);
  });

  it('replaying every step against a closed date posts nothing twice', async () => {
    // The contract for anything registered in NIGHT_AUDIT_STEPS: run() is idempotent. 2.2 registers
    // room-night posting here, and this is the test that will catch it double-posting.
    const { NIGHT_AUDIT_STEPS } = await import('../src/night-audit/night-audit-pipeline');
    const steps = app.get<any[]>(NIGHT_AUDIT_STEPS);
    const { DbService } = await import('../src/db/db.service');
    const db = app.get(DbService);
    const [propertyRow] = await sql<{ id: string }>(`SELECT id FROM properties`);
    const propertyId = propertyRow!.id;
    const [closedRow] = await sql<{ d: string }>(
      `SELECT to_char(max(business_date), 'YYYY-MM-DD') AS d FROM night_audits`,
    );
    const closedDate = closedRow!.d;
    const [rowsBeforeRow] = await sql<{ n: string }>(
      `SELECT (SELECT count(*) FROM reservation_room_nights)::text AS n`,
    );

    const actor = { user: { id: (await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`))[0]!.id, propertyId, role: 'owner', fullName: 'Vikram Rathore' } } as any;
    await db.tx({ userId: actor.user.id }, async (q) => {
      for (const step of steps) {
        if (step.run) await step.run({ q, actor, propertyId, businessDate: closedDate });
      }
    });

    const [rowsAfterRow] = await sql<{ n: string }>(
      `SELECT (SELECT count(*) FROM reservation_room_nights)::text AS n`,
    );
    expect(rowsAfterRow!.n).toBe(rowsBeforeRow!.n);
    const [runsRow] = await sql<{ n: string }>(`SELECT count(*) AS n FROM night_audits WHERE business_date = $1::date`, [closedDate]);
    expect(runsRow!.n).toBe('1');
  });
});

describe('who may run it', () => {
  it('a receptionist is refused once the owner turns the setting off, and the owner still can', async () => {
    await sql(`UPDATE properties SET receptionist_can_run_night_audit = false`);
    await clearBlockers(owner);

    const date = await businessDate();
    const refused = await complete(desk, date).expect(403);
    expect(refused.body.message).toMatch(/Only the owner can run night audit/);
    expect((await preview(desk)).body.mayRun).toBe(false);
    expect((await preview(owner)).body.mayRun).toBe(true);

    const done = await complete(owner, date).expect(200);
    expect(done.body.run.completedBy).toBe('Vikram Rathore');
    await sql(`UPDATE properties SET receptionist_can_run_night_audit = true`);
  });
});

describe('the business date itself', () => {
  it('cannot be moved backwards, by anyone', async () => {
    await expect(sql(`UPDATE properties SET current_business_date = current_business_date - 1`))
      .rejects.toThrow(/cannot move backwards/);
  });
});
