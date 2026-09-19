import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve, bootAppOnOwnDatabase, booking, fixtures, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/**
 * Milestone 2.2 — the bill (spec §23, §24).
 *
 * Runs on its own database, like the night audit suite, because the interesting behaviour here is
 * what happens *across* a night audit: room nights posting once, and a closed day refusing charges.
 */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let f: Awaited<ReturnType<typeof fixtures>>;
let stayId: string;

const bill = (agent: Agent, id = stayId) => agent.get(`/api/v1/stays/${id}/bill`).expect(200);
const businessDate = async () => (await sql<{ d: string }>(`SELECT current_business_date AS d FROM properties`))[0]!.d;

/** A guest in a room, in house — the same fixture shortcut the night audit suite uses. */
async function checkInBySql(room: string, type: string, arrival: string, departure: string, name: string, mobile: string): Promise<string> {
  const created = await post(owner, '/reservations', {
    ...booking({ roomTypeId: f.type(type), roomId: f.room(room), arrival, departure }),
    guest: { firstName: name, lastName: 'Guest', mobile },
  }).expect(201);
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
  await sql(`UPDATE room_allocations SET status = 'checked_in' WHERE reservation_room_id IN (SELECT id FROM reservation_rooms WHERE reservation_id = $1)`, [created.body.id]);
  await sql(`UPDATE reservations SET status = 'checked_in' WHERE id = $1`, [created.body.id]);
  const [stay] = await sql<{ id: string }>(`SELECT s.id FROM stays s JOIN reservation_rooms rr ON rr.id = s.reservation_room_id WHERE rr.reservation_id = $1`, [created.body.id]);
  return stay!.id;
}

/** Clears whatever blocks the audit, then closes the day. */
async function runNightAudit(agent: Agent) {
  for (;;) {
    const { body } = await agent.get('/api/v1/night-audit').expect(200);
    const blocking = body.steps.filter((s: any) => s.blocking && s.items.length > 0);
    if (!blocking.length) return post(agent, '/night-audit/complete', { businessDate: body.businessDate }).expect(200);
    for (const step of blocking) {
      for (const item of step.items) {
        if (item.actions.includes('no_show')) await post(agent, `/reservations/${item.id}/no-show`, {}).expect(200);
        else if (item.actions.includes('cancel')) await post(agent, `/reservations/${item.id}/cancel`, { reason: 'change_of_plans' }).expect(200);
        else await post(agent, `/stays/${item.id}/checkout`, { steps: { settlement: { pendingBalance: true } } }).expect(200);
      }
    }
  }
}

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('folio', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  f = await fixtures(sql);
  stayId = await checkInBySql('202', 'DLX', '2026-09-16', '2026-09-19', 'Bill', '9820033001');
}, 120_000);
afterAll(async () => { await app.close(); });

describe('opening a bill', () => {
  it('opens on first look, with a number, and nothing on it yet', async () => {
    const { body } = await bill(desk);
    expect(body.number).toMatch(/^F-\d{6}$/);
    expect(body.lines).toEqual([]);
    expect(body.charges).toBe('0.00');
    expect(body.roomNumber).toBe('202');
    expect(body.guestName).toMatch(/Bill Guest/);
    // Payments arrive in 2.3; the row exists so the desk can see where the number will be.
    expect(body.paid).toBe('0.00');
  });

  it('is the same bill next time, not a second one', async () => {
    const first = await bill(desk);
    const second = await bill(owner);
    expect(second.body.id).toBe(first.body.id);
    const [only] = await sql<{ n: string }>(`SELECT count(*) AS n FROM folios WHERE stay_id = $1`, [stayId]);
    expect(only!.n).toBe('1');
  });

  it('two requests racing to open the same bill still make one', async () => {
    const other = await checkInBySql('203', 'DLX', '2026-09-16', '2026-09-17', 'Race', '9820033002');
    const results = await Promise.all([bill(desk, other), bill(owner, other), bill(desk, other)]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const [race] = await sql<{ n: string }>(`SELECT count(*) AS n FROM folios WHERE stay_id = $1`, [other]);
    expect(race!.n).toBe('1');
  });
});

describe('adding charges', () => {
  it('stores the name exactly as typed, because that is what the invoice shows', async () => {
    const { body: b } = await bill(desk);
    const after = await post(desk, `/folios/${b.id}/charges`, {
      lineType: 'food', name: 'Paneer Tikka', quantity: 2, unitRate: '280.00',
    }).expect(200);

    const line = after.body.lines.at(-1);
    expect(line.name).toBe('Paneer Tikka');
    expect(line.quantity).toBe(2);
    expect(line.amount).toBe('560.00');
    expect(line.taxCategory).toBe('food');
    expect(line.source).toBe('manual');
    expect(line.businessDate).toBe('2026-09-16');
    expect(after.body.charges).toBe('560.00');
  });

  it('works out GST from the line, and never asks the receptionist for a rate', async () => {
    const { body } = await bill(desk);
    expect(body.tax.available).toBe(true);
    expect(Number(body.tax.taxTotal)).toBeGreaterThan(0);
    expect(body.tax.groups.length).toBeGreaterThan(0);
    // The balance is derived, not stored: nothing in the schema holds it.
    const columns = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'folios'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('balance');
    expect(columns.map((c) => c.column_name)).not.toContain('total');
  });

  it('refuses a charge dated in the future', async () => {
    const { body: b } = await bill(desk);
    const refused = await post(desk, `/folios/${b.id}/charges`, {
      lineType: 'laundry', name: 'Laundry', unitRate: '300.00', businessDate: '2026-09-20',
    }).expect(400);
    expect(refused.body.message).toMatch(/has not happened yet/);
  });

  it('fills the tax category from a saved item rather than from the type', async () => {
    const item = await post(owner, '/charge-items', {
      name: 'Jeep Safari', lineType: 'activity', defaultRate: '1500.00',
    }).expect(201);
    expect(item.body.taxCategory).toBe('activity');

    const { body: b } = await bill(desk);
    const after = await post(desk, `/folios/${b.id}/charges`, {
      lineType: 'activity', name: 'Jeep Safari × 2', quantity: 2, unitRate: '1500.00', chargeItemId: item.body.id,
    }).expect(200);
    const line = after.body.lines.at(-1);
    expect(line.name).toBe('Jeep Safari × 2');
    expect(line.amount).toBe('3000.00');
    expect(line.taxCategory).toBe('activity');
  });
});

describe('a line is never edited', () => {
  it('is voided with a reason, stays visible, and stops counting', async () => {
    const { body: before } = await bill(desk);
    const target = before.lines.find((l: any) => l.name === 'Paneer Tikka');
    const chargesBefore = Number(before.charges);

    const after = await post(desk, `/folio-lines/${target.id}/void`, { reason: 'Added to the wrong room' }).expect(200);
    const voided = after.body.lines.find((l: any) => l.id === target.id);
    expect(voided.voided).toBe(true);
    expect(voided.voidReason).toBe('Added to the wrong room');
    expect(voided.voidedBy).toBe('Priya Sharma');
    // Still on the bill — history, not deletion.
    expect(after.body.lines.map((l: any) => l.id)).toContain(target.id);
    expect(Number(after.body.charges)).toBe(chargesBefore - 560);
  });

  it('cannot be voided twice', async () => {
    const { body } = await bill(desk);
    const voided = body.lines.find((l: any) => l.voided);
    await post(desk, `/folio-lines/${voided.id}/void`, { reason: 'Again' }).expect(409);
  });

  it('cannot be edited in the database at all, by anyone', async () => {
    const [line] = await sql<{ id: string }>(`SELECT id FROM folio_lines WHERE voided_at IS NULL LIMIT 1`);
    await expect(sql(`UPDATE folio_lines SET amount = 1 WHERE id = $1`, [line!.id])).rejects.toThrow(/never edited/);
    await expect(sql(`UPDATE folio_lines SET name = 'Something else' WHERE id = $1`, [line!.id])).rejects.toThrow(/never edited/);
    await expect(sql(`DELETE FROM folio_lines WHERE id = $1`, [line!.id])).rejects.toThrow(/voided, never deleted/);
    // And a voided line is finished: it cannot be voided again or un-voided.
    const [gone] = await sql<{ id: string }>(`SELECT id FROM folio_lines WHERE voided_at IS NOT NULL LIMIT 1`);
    await expect(sql(`UPDATE folio_lines SET voided_at = NULL WHERE id = $1`, [gone!.id])).rejects.toThrow(/cannot change again/);
  });

  it('always needs a reason — there is no silent removal', async () => {
    const { body } = await bill(desk);
    const live = body.lines.find((l: any) => !l.voided);
    await post(desk, `/folio-lines/${live.id}/void`, { reason: 'x' }).expect(400);
  });
});

describe('night audit posts the room charges', () => {
  it('posts room, meal and extra-person parts separately, because GST differs', async () => {
    const preview = await desk.get('/api/v1/night-audit').expect(200);
    const step = preview.body.steps.find((s: any) => s.name === 'room_charges');
    expect(step).toBeTruthy();
    expect(step.blocking).toBe(false);
    expect(step.willDo).toMatch(/Post ₹.* of room charges to \d+ bill/);
    expect(preview.body.summary.roomsToCharge).toBeGreaterThan(0);

    await runNightAudit(owner);

    const { body } = await bill(desk);
    const posted = body.lines.filter((l: any) => l.source === 'night_audit' && l.businessDate === '2026-09-16');
    expect(posted.length).toBeGreaterThan(0);
    const room = posted.find((l: any) => l.lineType === 'room_night');
    expect(room.name).toMatch(/^Room — /);
    expect(room.taxCategory).toBe('accommodation');
    expect(Number(room.amount)).toBeGreaterThan(0);

    const meal = posted.find((l: any) => l.lineType === 'meal');
    if (meal) {
      // The reason they are separate lines: accommodation is slab-rated, food is not.
      expect(meal.taxCategory).toBe('food');
    }
  });

  it('charges the rate agreed on the booking, not today\'s rate calendar', async () => {
    const { body } = await bill(desk);
    const room = body.lines.find((l: any) => l.lineType === 'room_night' && l.businessDate === '2026-09-16');
    const [night] = await sql<{ room_rate: string }>(
      `SELECT n.room_rate FROM reservation_room_nights n
         JOIN stays s ON s.reservation_room_id = n.reservation_room_id
        WHERE s.id = $1 AND n.night_date = '2026-09-16'`,
      [stayId],
    );
    expect(room.amount).toBe(night!.room_rate);
  });

  it('posts once per room per business date, however many times it runs', async () => {
    const { body: before } = await bill(desk);
    const postedBefore = before.lines.filter((l: any) => l.source === 'night_audit').length;

    // Replay the step directly against the date that was just closed — what a retry, a crash
    // halfway, or two audits racing would do.
    const { NIGHT_AUDIT_STEPS } = await import('../src/night-audit/night-audit-pipeline');
    const { DbService } = await import('../src/db/db.service');
    const steps = app.get<any[]>(NIGHT_AUDIT_STEPS);
    const step = steps.find((s) => s.name === 'room_charges');
    const db = app.get(DbService);
    const [property] = await sql<{ id: string }>(`SELECT id FROM properties`);
    const [ownerUser] = await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`);
    const actor = { user: { id: ownerUser!.id, propertyId: property!.id, role: 'owner', fullName: 'Vikram Rathore' } } as any;

    const result = await db.tx<{ posted: number; skipped: number }>({ userId: actor.user.id }, (q) =>
      step.run({ q, actor, propertyId: property!.id, businessDate: '2026-09-16' }));
    expect(result.posted).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);

    const { body: after } = await bill(desk);
    expect(after.lines).toHaveLength(before.lines.length);
    expect(after.lines.filter((l: any) => l.source === 'night_audit').length).toBe(postedBefore);
  });

  it('posts the next day too, so a stay accrues a night at a time', async () => {
    expect(await businessDate()).toBe('2026-09-17');
    await runNightAudit(owner);
    const { body } = await bill(desk);
    const dates = new Set(body.lines.filter((l: any) => l.source === 'night_audit').map((l: any) => l.businessDate));
    expect([...dates].sort()).toEqual(['2026-09-16', '2026-09-17']);
  });
});

describe('a day night audit has closed', () => {
  it('refuses a new charge on it, and says where to put it instead', async () => {
    const { body: b } = await bill(desk);
    const refused = await post(desk, `/folios/${b.id}/charges`, {
      lineType: 'laundry', name: 'Laundry', unitRate: '300.00', businessDate: '2026-09-16',
    }).expect(409);
    expect(refused.body.message).toMatch(/Night audit has closed 16 Sep 2026\. Add this charge on 18 Sep 2026 instead\./);
  });

  it('needs Owner PIN to void a line on it — a receptionist alone cannot', async () => {
    const { body } = await bill(desk);
    const closedLine = body.lines.find((l: any) => l.businessDate === '2026-09-16' && !l.voided);
    const refused = await post(desk, `/folio-lines/${closedLine.id}/void`, { reason: 'Charged in error' }).expect(403);
    expect(refused.body.code).toBe('OWNER_PIN_REQUIRED');
    expect(refused.body.details.reasons[0].description).toMatch(/night audit has closed/);

    // With the owner's approval it goes through, and the authorisation is recorded on the bill.
    const [ownerUser] = await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`);
    const approved = await approve(desk, refused.body.details.authorisationId, ownerUser!.id).expect(200);
    const done = await post(desk, `/folio-lines/${closedLine.id}/void`,
      { reason: 'Charged in error', ownerAuthorisationId: approved.body.authorisationId }).expect(200);
    expect(done.body.lines.find((l: any) => l.id === closedLine.id).voided).toBe(true);

    const [override] = await sql<{ action: string }>(
      `SELECT action FROM owner_overrides WHERE entity_type = 'folio' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(override).toBeTruthy();
  });

  it('lets a charge be added on the open date without any fuss', async () => {
    const { body: b } = await bill(desk);
    const after = await post(desk, `/folios/${b.id}/charges`, {
      lineType: 'laundry', name: 'Laundry', unitRate: '300.00',
    }).expect(200);
    expect(after.body.lines.at(-1).businessDate).toBe('2026-09-18');
  });
});

describe('saved charge items', () => {
  it('are a list, not a menu system, and are deactivated rather than deleted', async () => {
    await post(desk, '/charge-items', { name: 'Nope', lineType: 'food', defaultRate: '10.00' }).expect(403);
    const created = await post(owner, '/charge-items', {
      name: 'Butter Chicken', lineType: 'food', defaultRate: '420.00',
    }).expect(201);
    expect(created.body.taxCategory).toBe('food');

    const listed = await desk.get('/api/v1/charge-items').expect(200);
    expect(listed.body.map((i: any) => i.name)).toContain('Butter Chicken');

    // Saved items are owner settings (§24.2): the desk uses them, the owner maintains them.
    await desk.patch(`/api/v1/charge-items/${created.body.id}`).set('x-resortos', '1')
      .send({ name: 'Butter Chicken', lineType: 'food', defaultRate: '450.00', isActive: false, version: created.body.version })
      .expect(403);
    await owner.patch(`/api/v1/charge-items/${created.body.id}`).set('x-resortos', '1')
      .send({ name: 'Butter Chicken', lineType: 'food', defaultRate: '450.00', isActive: false, version: created.body.version })
      .expect(200);

    const active = await desk.get('/api/v1/charge-items').expect(200);
    expect(active.body.map((i: any) => i.name)).not.toContain('Butter Chicken');
    const all = await desk.get('/api/v1/charge-items').query({ includeInactive: 'true' }).expect(200);
    expect(all.body.map((i: any) => i.name)).toContain('Butter Chicken');

    await expect(sql(`DELETE FROM charge_items WHERE id = $1`, [created.body.id])).rejects.toThrow(/deactivated, not deleted/);
  });
});
