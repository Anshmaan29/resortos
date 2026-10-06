import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootAppOnOwnDatabase, login, post, type Agent } from './helpers';

/**
 * Form C (spec §58.1) and the police register (§58.2).
 *
 * The record is opened by the database the moment a foreign national is checked in, so the tests
 * check in guests the way every path must: a stay row and its occupants. Everything after that —
 * the countdown, the details, the portal reference, the departure — goes through the API a desk
 * would use.
 */
const TEST_BUSINESS_DATE = '2026-09-16';

let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let f: { type: (code: string) => string; room: (number: string) => string; ownerId: string };

let mobile = 982_100_0000;

/** A checked-in stay with the given occupants, written the way the confirm path writes them. */
async function stayWithOccupants(room: string, type: string, occupants: { fullName: string; nationality?: string; isChild?: boolean; age?: number | null; idType?: string }[]) {
  mobile += 1;
  const created = await post(desk, '/reservations', {
    guest: { firstName: 'Stay', lastName: `Guest${mobile % 10000}`, mobile: String(mobile) },
    source: 'walk_in', arrival: TEST_BUSINESS_DATE, departure: '2026-09-18',
    rooms: [{ roomTypeId: f.type(type), roomId: f.room(room), adults: occupants.filter((o) => !o.isChild).length || 1, mealPlan: 'EP' }],
  }).expect(201);
  const [rr] = await sql<{ id: string; property_id: string }>(
    `SELECT id, property_id FROM reservation_rooms WHERE reservation_id = $1`, [created.body.id],
  );
  const [draft] = await sql<{ id: string }>(
    `INSERT INTO check_in_drafts (property_id, reservation_id, reservation_room_ids, status, confirmed_at, created_by)
     SELECT property_id, reservation_id, array_agg(id), 'confirmed', now(), created_by
       FROM reservation_rooms WHERE reservation_id = $1 GROUP BY property_id, reservation_id, created_by RETURNING id`,
    [created.body.id],
  );
  await sql(
    `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id,
                        business_date_in, expected_departure, checked_in_by)
     SELECT property_id, reservation_id, id, room_id,
            (SELECT primary_guest_id FROM reservations WHERE id = reservation_id), $2, arrival, departure, created_by
       FROM reservation_rooms WHERE id = $1`,
    [rr!.id, draft!.id],
  );
  const [stay] = await sql<{ id: string; property_id: string }>(`SELECT id, property_id FROM stays WHERE reservation_room_id = $1`, [rr!.id]);
  for (const [i, o] of occupants.entries()) {
    await sql(
      `INSERT INTO stay_occupants (property_id, stay_id, occupant_key, full_name, is_primary, is_child, age, nationality, id_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [stay!.property_id, stay!.id, `r0a${i}`, o.fullName, i === 0, o.isChild ?? false, o.isChild ? (o.age ?? 8) : null,
       o.nationality ?? 'IN', o.idType ?? (o.nationality === 'GB' ? 'passport' : 'aadhaar'), f.ownerId],
    );
  }
  await sql(`UPDATE reservations SET status = 'checked_in' WHERE id = $1`, [created.body.id]);
  await sql(`UPDATE reservation_rooms SET status = 'checked_in' WHERE id = $1`, [rr!.id]);
  await sql(`UPDATE room_allocations SET status = 'checked_in' WHERE reservation_room_id = $1`, [rr!.id]);
  return stay!.id;
}

const pendingRecords = () => sql<{ id: string; status: string; occupant_id: string }>(
  `SELECT id, status, occupant_id FROM form_c_records WHERE status = 'pending' ORDER BY arrived_at`,
);

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('compliance', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  const fixtures = await sql<{ id: string; code: string }>(`SELECT id, code FROM room_types`);
  const rooms = await sql<{ id: string; number: string }>(`SELECT id, number FROM rooms`);
  const owners = await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`);
  f = {
    type: (code) => fixtures.find((t) => t.code === code)!.id,
    room: (number) => rooms.find((r) => r.number === number)!.id,
    ownerId: owners[0]!.id,
  };
}, 120_000);
afterAll(async () => { await app.close(); });

describe('Form C (spec §58.1)', () => {
  it('opens a pending record the moment a foreign national is checked in, with the 24-hour countdown', async () => {
    await stayWithOccupants('103', 'DLX', [
      { fullName: 'Oliver Wright', nationality: 'GB' },
      { fullName: 'Meera Wright', nationality: 'IN' },
    ]);
    const list = (await desk.get('/api/v1/form-c').expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'pending', guestName: 'Oliver Wright', nationality: 'GB', roomNumber: '103' });
    expect(list[0].hoursLeft).toBeGreaterThan(0);
    expect(list[0].hoursLeft).toBeLessThanOrEqual(24);
    expect(list[0].missing).toEqual(expect.arrayContaining(['passportNumber', 'visaNumber', 'nextDestination']));

    const summary = (await desk.get('/api/v1/form-c/pending-summary').expect(200)).body;
    expect(summary).toMatchObject({ pending: 1 });
    expect(summary.hoursLeft).toBeGreaterThan(0);
  });

  it('opens one record per foreign occupant, never for the Indian ones', async () => {
    await stayWithOccupants('202', 'DLX', [
      { fullName: 'Emma Brown', nationality: 'GB' },
      { fullName: 'Liam Smith', nationality: 'FR', isChild: true, age: 9 },
    ]);
    const list = (await desk.get('/api/v1/form-c?status=pending').expect(200)).body;
    expect(list.map((r: any) => r.guestName).sort()).toEqual(['Emma Brown', 'Liam Smith', 'Oliver Wright']);
  });

  it('saves the details with a version, and the audit records which fields were filled — never their values', async () => {
    const [record] = await pendingRecords();
    const details = {
      passportNumber: 'P1234567', passportPlaceOfIssue: 'London', passportIssueDate: '2019-05-01', passportExpiryDate: '2029-04-30',
      visaNumber: 'V-998877', visaType: 'e-Tourist', visaPlaceOfIssue: 'Online', visaIssueDate: '2026-08-01', visaExpiryDate: '2026-11-01',
      arrivalInIndiaDate: '2026-09-10', arrivalPort: 'Delhi', nextDestination: 'Jaipur', addressInIndia: 'Hotel Road, Jaipur',
      homeAddress: '12 Baker Street, London',
    };
    const saved = await desk.put(`/api/v1/form-c/${record!.id}`).set('x-resortos', '1').send({ ...details, ...(await currentVersion(record!.id)) }).expect(200);
    expect(saved.body.missing).toEqual([]);
    expect(saved.body.details).toMatchObject({ passportNumber: 'P1234567', visaNumber: 'V-998877' });

    const [audit] = await sql<{ after_values: any }>(`SELECT after_values FROM audit_logs WHERE action = 'form_c.details_saved' ORDER BY seq DESC LIMIT 1`);
    expect(audit!.after_values.filled).toEqual(expect.arrayContaining(['passportNumber', 'visaNumber', 'homeAddress']));
    expect(JSON.stringify(audit)).not.toContain('P1234567');
    expect(JSON.stringify(audit)).not.toContain('V-998877');
  });

  it('refuses to submit while anything the official form asks for is missing — API and database alike', async () => {
    await stayWithOccupants('205', 'DLX', [{ fullName: 'Noah Dubois', nationality: 'FR' }]);
    const [record] = await pendingRecords();
    // Find the record for Noah (the one still pending with no details saved).
    const list = (await desk.get('/api/v1/form-c?status=pending').expect(200)).body;
    const noah = list.find((r: any) => r.guestName === 'Noah Dubois');

    const refused = await post(desk, `/form-c/${noah.id}/submit`, { reference: 'UKFR012345', version: noah.version }).expect(400);
    expect(refused.body.message).toMatch(/before marking it submitted/);
    expect(refused.body.details.missing).toContain('passportNumber');

    await expect(sql(`UPDATE form_c_records SET status = 'submitted', submitted_reference = 'REF-1', submitted_at = now(), submitted_by = $2 WHERE id = $1`, [noah.id, f.ownerId]))
      .rejects.toThrow(/form_c_submitted_complete/);
  });

  it('marks it submitted with the portal reference, exactly once, at the saved version', async () => {
    const list = (await desk.get('/api/v1/form-c?status=pending').expect(200)).body;
    const oliver = list.find((r: any) => r.guestName === 'Oliver Wright');
    const stale = await post(desk, `/form-c/${oliver.id}/submit`, { reference: 'UKFR012345', version: oliver.version + 5 });
    expect(stale.body.code).toBe('STALE_VERSION');

    const done = (await post(desk, `/form-c/${oliver.id}/submit`, { reference: 'UKFR012345', version: oliver.version }).expect(200)).body;
    expect(done.status).toBe('submitted');
    expect(done.submittedReference).toBe('UKFR012345');

    const again = await post(desk, `/form-c/${oliver.id}/submit`, { reference: 'UKFR012345', version: done.version });
    expect(again.body.code).toBe('INVALID_TRANSITION');

    const [audit] = await sql<{ after_values: any }>(`SELECT after_values FROM audit_logs WHERE action = 'form_c.submitted' ORDER BY seq DESC LIMIT 1`);
    expect(audit!.after_values).toMatchObject({ reference: 'UKFR012345' });
  });

  it('records the departure update only after the guest has checked out', async () => {
    const list = (await desk.get('/api/v1/form-c?status=submitted').expect(200)).body;
    const oliver = list[0];
    const early = await post(desk, `/form-c/${oliver.id}/departure-updated`, { version: oliver.version }).expect(409);
    expect(early.body.code).toBe('INVALID_TRANSITION');
    expect(early.body.message).toMatch(/not checked out yet/);

    // The owner records an authorised pending balance; departure reporting is tested independently of payment.
    const out = await post(owner, `/stays/${oliver.stayId}/checkout`, { steps: { settlement: { pendingBalance: true } } });
    expect(out.status).toBe(200);

    const done = (await post(desk, `/form-c/${oliver.id}/departure-updated`, { version: oliver.version }).expect(200)).body;
    expect(done.status).toBe('departure_updated');
  });

  it('lays the details out for the official portal, field by field', async () => {
    // Oliver's record left 'submitted' in the test above; the summary is the same text either way.
    const list = (await desk.get('/api/v1/form-c?status=departure_updated').expect(200)).body;
    const summary = (await desk.get(`/api/v1/form-c/${list[0].id}/portal-summary`).expect(200)).body;
    expect(summary.text).toContain('Passport number: P1234567');
    expect(summary.text).toContain('Next destination: Jaipur');
    expect(summary.missing).toEqual([]);
  });
});

describe('police register (spec §58.2)', () => {
  it('is one row per occupant for the date range, in the columns the station asked for', async () => {
    const body = (await owner.get('/api/v1/police-register').query({ from: TEST_BUSINESS_DATE, to: TEST_BUSINESS_DATE }).expect(200)).body;
    expect(body.columns.map((c: any) => c.key)).toContain('name');
    const rows = body.rows as string[][];
    // Three stays checked in on the 16th (Noah's from the submit test above), five occupants between
    // them; the demo seed's stays arrived on earlier dates, so the register is exactly these.
    expect(rows).toHaveLength(5);
    const names = rows.map((r) => r[body.columns.findIndex((c: any) => c.key === 'name')]);
    expect(names).toEqual(expect.arrayContaining(['Oliver Wright', 'Meera Wright', 'Emma Brown', 'Liam Smith', 'Noah Dubois']));
    const byName = (name: string) => rows.find((r) => r[body.columns.findIndex((c: any) => c.key === 'name')] === name)!;
    // The primary guest carries the address and the party size; the others do not.
    expect(byName('Emma Brown')[body.columns.findIndex((c: any) => c.key === 'persons')]).toBe('2');
    expect(byName('Liam Smith')[body.columns.findIndex((c: any) => c.key === 'address')]).toBe('');
    // Serial numbers run 1..n in arrival order.
    expect(rows.map((r) => r[body.columns.findIndex((c: any) => c.key === 'serial')])).toEqual(['1', '2', '3', '4', '5']);
  });

  it('follows the property column setting', async () => {
    await sql(`UPDATE properties SET police_register_columns = ARRAY['serial', 'name', 'nationality', 'room']`);
    const body = (await owner.get('/api/v1/police-register').query({ from: TEST_BUSINESS_DATE, to: TEST_BUSINESS_DATE }).expect(200)).body;
    expect(body.columns.map((c: any) => c.key)).toEqual(['serial', 'name', 'nationality', 'room']);
    expect(body.rows[0]).toHaveLength(4);
    await sql(`UPDATE properties SET police_register_columns = DEFAULT`);
  });

  it('is the owner’s screen', async () => {
    await desk.get('/api/v1/police-register').expect(403);
  });
});

async function currentVersion(id: string): Promise<{ version: number }> {
  const [row] = await sql<{ version: number }>(`SELECT version FROM form_c_records WHERE id = $1`, [id]);
  return { version: row!.version };
}
