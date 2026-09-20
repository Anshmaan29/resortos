import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootAppOnOwnDatabase, booking, createStaff, fixtures, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/**
 * Housekeeping (spec §37) and cleaner mode (§4.3).
 *
 * What these tests are really checking is the invariant the database maintains: the room's
 * housekeeping status and its open task always agree, whichever screen moved them.
 */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let cleaner: Agent;
let cleanerId: string;
let f: Awaited<ReturnType<typeof fixtures>>;
/** Rooms nobody is booked into in the seed, handed out one at a time so suites never collide. */
let spare: { number: string; code: string }[] = [];
const take = () => spare.shift() ?? (() => { throw new Error('No free room left in the fixture'); })();

const board = async (agent: Agent = desk) => (await agent.get('/api/v1/housekeeping/board').expect(200)).body;
const roomOnBoard = async (number: string, agent: Agent = desk) => (await board(agent)).rooms.find((r: any) => r.number === number);
const roomStatus = async (number: string) =>
  (await sql<{ housekeeping_status: string }>(`SELECT housekeeping_status FROM rooms WHERE number = $1`, [number]))[0]!.housekeeping_status;

async function checkInBySql(room: string, type: string, name: string, mobile: string, departure = '2026-09-19'): Promise<string> {
  const created = await post(owner, '/reservations', {
    ...booking({ roomTypeId: f.type(type), roomId: f.room(room), arrival: '2026-09-16', departure }),
    guest: { firstName: name, lastName: 'Guest', mobile },
  }).expect(201);
  const [draft] = await sql<{ id: string }>(
    `INSERT INTO check_in_drafts (property_id, reservation_id, reservation_room_ids, status, confirmed_at, created_by)
     SELECT r.property_id, r.id, array_agg(rr.id), 'confirmed', now(), r.created_by
       FROM reservations r JOIN reservation_rooms rr ON rr.reservation_id = r.id
      WHERE r.id = $1 GROUP BY r.property_id, r.id, r.created_by RETURNING id`, [created.body.id],
  );
  await sql(
    `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id,
                        business_date_in, expected_departure, checked_in_by)
     SELECT rr.property_id, rr.reservation_id, rr.id, rr.room_id, r.primary_guest_id, $2, rr.arrival, rr.departure, r.created_by
       FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id WHERE rr.reservation_id = $1`,
    [created.body.id, draft!.id],
  );
  await sql(`UPDATE reservation_rooms SET status = 'checked_in' WHERE reservation_id = $1`, [created.body.id]);
  await sql(`UPDATE room_allocations SET status = 'checked_in' WHERE reservation_room_id IN (SELECT id FROM reservation_rooms WHERE reservation_id = $1)`, [created.body.id]);
  await sql(`UPDATE reservations SET status = 'checked_in' WHERE id = $1`, [created.body.id]);
  const [stay] = await sql<{ id: string }>(`SELECT s.id FROM stays s JOIN reservation_rooms rr ON rr.id = s.reservation_room_id WHERE rr.reservation_id = $1`, [created.body.id]);
  return stay!.id;
}

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('housekeeping', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  f = await fixtures(sql);
  cleaner = await createStaff(app, owner, 'cleaner.test', 'cleaner');
  cleanerId = (await sql<{ id: string }>(`SELECT id FROM users WHERE username = 'cleaner.test'`))[0]!.id;
  spare = await sql<{ number: string; code: string }>(
    `SELECT r.number, rt.code FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.is_active AND r.service_status = 'in_service'
        AND NOT EXISTS (SELECT 1 FROM room_allocations a WHERE a.room_id = r.id AND a.status IN ('reserved', 'checked_in'))
      ORDER BY r.sort_order, r.number`,
  );
}, 120_000);
afterAll(async () => { await app.close(); });

describe('a room that needs cleaning', () => {
  it('gets a task at checkout, which a cleaner starts and finishes', async () => {
    const room = take();
    const stayId = await checkInBySql(room.number, room.code, 'Clean', '9820077001');
    await post(desk, `/stays/${stayId}/checkout`, { steps: { settlement: { pendingBalance: true } } }).expect(200);

    const dirty = await roomOnBoard(room.number);
    expect(dirty).toMatchObject({ housekeeping: 'dirty', occupied: false });
    expect(dirty.task).toMatchObject({ kind: 'checkout', status: 'open', assignedTo: null });

    // Unassigned work is not a cleaner's to take.
    await post(cleaner, `/housekeeping/tasks/${dirty.task.id}/start`, {}).expect(403);
    expect((await cleaner.get('/api/v1/housekeeping/my-tasks').expect(200)).body).toEqual([]);

    await desk.patch(`/api/v1/housekeeping/tasks/${dirty.task.id}`).set('x-resortos', '1')
      .send({ assignedTo: cleanerId, priority: 'high', note: 'Guest spilled tea', version: dirty.task.version }).expect(200);

    const mine = (await cleaner.get('/api/v1/housekeeping/my-tasks').expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ roomNumber: room.number, priority: 'high', note: 'Guest spilled tea', status: 'open' });
    // A cleaner sees the room and the job, never who is staying or what they owe (§4.3).
    expect(JSON.stringify(mine[0])).not.toMatch(/Clean Guest|9820077001|amount|balance/i);

    await post(cleaner, `/housekeeping/tasks/${mine[0].id}/start`, {}).expect(200);
    expect(await roomStatus(room.number)).toBe('cleaning');
    expect((await roomOnBoard(room.number)).task).toMatchObject({ status: 'in_progress' });

    await post(cleaner, `/housekeeping/tasks/${mine[0].id}/complete`, {}).expect(200);
    expect(await roomStatus(room.number)).toBe('clean');
    expect((await roomOnBoard(room.number)).task).toBeNull();
    const [done] = await sql<{ status: string; completed_by: string; started_by: string }>(
      `SELECT status, completed_by, started_by FROM housekeeping_tasks WHERE id = $1`, [mine[0].id],
    );
    expect(done).toMatchObject({ status: 'done', completed_by: cleanerId, started_by: cleanerId });
    expect((await cleaner.get('/api/v1/housekeeping/my-tasks').expect(200)).body).toEqual([]);
  });

  it('closes the same task when the desk marks the room clean from the room board', async () => {
    const room = take();
    const stayId = await checkInBySql(room.number, room.code, 'Board', '9820077002');
    await post(desk, `/stays/${stayId}/checkout`, { steps: { settlement: { pendingBalance: true } } }).expect(200);
    const task = (await roomOnBoard(room.number)).task;
    expect(task.status).toBe('open');

    await post(desk, `/rooms/${f.room(room.number)}/status`, { housekeeping: 'inspected', reason: 'Checked myself' }, null).expect(201);
    const [after] = await sql<{ status: string }>(`SELECT status FROM housekeeping_tasks WHERE id = $1`, [task.id]);
    expect(after!.status).toBe('done');
    expect((await roomOnBoard(room.number)).task).toBeNull();
  });

  it('reopens the task when a cleaner stops half way, and keeps a finished task as it was', async () => {
    const room = take();
    await post(desk, `/rooms/${f.room(room.number)}/status`, { housekeeping: 'dirty', reason: 'Spring clean' }, null).expect(201);
    const task = (await roomOnBoard(room.number)).task;
    expect(task.kind).toBe('manual');

    await post(desk, `/housekeeping/tasks/${task.id}/start`, {}).expect(200);
    await post(desk, `/housekeeping/tasks/${task.id}/stop`, {}).expect(200);
    expect(await roomStatus(room.number)).toBe('dirty');
    const [reopened] = await sql<{ status: string; started_at: string | null }>(`SELECT status, started_at FROM housekeeping_tasks WHERE id = $1`, [task.id]);
    expect(reopened).toMatchObject({ status: 'open', started_at: null });

    await post(desk, `/housekeeping/tasks/${task.id}/complete`, {}).expect(200);
    await expect(sql(`UPDATE housekeeping_tasks SET status = 'open' WHERE id = $1`, [task.id]))
      .rejects.toThrow(/finished housekeeping task is kept/);
  });

  it('never has two open tasks for one room', async () => {
    const room = take();
    await post(desk, `/rooms/${f.room(room.number)}/status`, { housekeeping: 'dirty', reason: 'One' }, null).expect(201);
    await post(desk, `/rooms/${f.room(room.number)}/status`, { housekeeping: 'cleaning', reason: 'Started' }, null).expect(201);
    await post(desk, `/rooms/${f.room(room.number)}/status`, { housekeeping: 'dirty', reason: 'Two' }, null).expect(201);
    const open = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM housekeeping_tasks WHERE room_id = $1 AND status IN ('open', 'in_progress')`, [f.room(room.number)],
    );
    expect(Number(open[0]!.n)).toBe(1);
  });
});

describe('the daily clean of occupied rooms', () => {
  it('is created by night audit for stays that continue, once, however often the audit is replayed', async () => {
    // One stay continues past tomorrow; the other leaves tomorrow, so it gets a checkout clean instead.
    const staying = take();
    const leaving = take();
    await checkInBySql(staying.number, staying.code, 'Stayover', '9820077003', '2026-09-20');
    await checkInBySql(leaving.number, leaving.code, 'Leaving', '9820077004', '2026-09-17');
    for (const r of [staying, leaving]) {
      await post(desk, `/rooms/${f.room(r.number)}/status`, { housekeeping: 'clean', reason: 'Ready' }, null).expect(201);
    }

    const { body: audit } = await owner.get('/api/v1/night-audit').expect(200);
    const step = audit.steps.find((s: any) => s.name === 'stayover_cleaning');
    expect(step.willDo).toContain(staying.number);
    expect(step.willDo).not.toContain(leaving.number);

    // Clear whatever the audit is waiting on, then close the date.
    for (;;) {
      const { body } = await owner.get('/api/v1/night-audit').expect(200);
      const blocking = body.steps.filter((st: any) => st.blocking && st.items.length > 0);
      if (!blocking.length) {
        await post(owner, '/night-audit/complete', { businessDate: body.businessDate }).expect(200);
        break;
      }
      for (const item of blocking.flatMap((st: any) => st.items)) {
        if (item.actions.includes('close_shift')) {
          const shift = await owner.get(`/api/v1/shifts/${item.id}`).expect(200);
          await post(owner, `/shifts/${item.id}/close`, { countedCash: shift.body.expectedCash, version: shift.body.version }).expect(200);
        } else if (item.actions.includes('no_show')) await post(owner, `/reservations/${item.id}/no-show`, {}).expect(200);
        else if (item.actions.includes('cancel')) await post(owner, `/reservations/${item.id}/cancel`, { reason: 'change_of_plans' }).expect(200);
        else await post(owner, `/stays/${item.id}/checkout`, { steps: { settlement: { pendingBalance: true } } }).expect(200);
      }
    }

    const tasks = await sql<{ id: string; business_date: string; status: string }>(
      `SELECT id, business_date, status FROM housekeeping_tasks WHERE room_id = $1 AND kind = 'stayover'`, [f.room(staying.number)],
    );
    expect(tasks).toHaveLength(1);
    expect(await roomStatus(staying.number)).toBe('dirty');

    // Replaying the closed date posts nothing twice (the rule every night audit step follows).
    const replayed = await sql<{ replay: string }>(
      `INSERT INTO housekeeping_tasks (property_id, room_id, kind, business_date)
       SELECT property_id, id, 'stayover', $2::date FROM rooms WHERE id = $1
       ON CONFLICT DO NOTHING RETURNING id AS replay`, [f.room(staying.number), tasks[0]!.business_date],
    );
    expect(replayed).toEqual([]);

    // A daily clean can be skipped with a reason; a checkout clean cannot.
    const stayover = (await roomOnBoard(staying.number)).task;
    await post(desk, `/housekeeping/tasks/${stayover.id}/skip`, { reason: 'Guest asked for no service' }).expect(200);
    expect(await roomStatus(staying.number)).toBe('clean');
    const [skipped] = await sql<{ status: string; cancelled_reason: string }>(`SELECT status, cancelled_reason FROM housekeeping_tasks WHERE id = $1`, [stayover.id]);
    expect(skipped).toMatchObject({ status: 'cancelled', cancelled_reason: 'Guest asked for no service' });

    const other = take();
    await post(desk, `/rooms/${f.room(other.number)}/status`, { housekeeping: 'dirty', reason: 'Checkout clean' }, null).expect(201);
    const manual = (await roomOnBoard(other.number)).task;
    await post(desk, `/housekeeping/tasks/${manual.id}/skip`, { reason: 'Not needed' }).expect(409);
  });
});
