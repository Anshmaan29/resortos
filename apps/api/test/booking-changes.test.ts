import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve, booking, bootApp, fixtures, login, post, sql, type Agent } from './helpers';

/** Booking edit, rebook, estimate and detail (real PostgreSQL). */
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

/** Turns a booking detail back into an edit request body. */
function editBody(d: any, patch: Record<string, unknown> = {}, roomPatch: Record<string, unknown> = {}) {
  return {
    version: d.version, guestId: d.guest.id, source: d.source, otaReference: d.otaReference ?? undefined, arrival: d.arrival, departure: d.departure,
    status: d.status, groupName: d.groupName ?? undefined, specialRequests: d.specialRequests ?? undefined,
    rooms: d.rooms.map((r: any) => ({ reservationRoomId: r.id, roomTypeId: r.roomTypeId, roomId: r.roomId ?? undefined, adults: r.adults, childAges: r.childAges, mealPlan: r.mealPlan, ...roomPatch })),
    ...patch,
  };
}
const patch = (agent: Agent, id: string, body: unknown) => agent.patch(`/api/v1/reservations/${id}`).set('x-resortos', '1').set('idempotency-key', `edit-${Math.random().toString(36).slice(2)}-key`).send(body as object);

describe('estimate with GST', () => {
  it('breaks down room and meals and estimates GST from the dated tax rules', async () => {
    const res = await post(desk, '/reservations/estimate', {
      arrival: '2026-10-06', departure: '2026-10-07', rooms: [{ roomTypeId: f.type('DLX'), adults: 2, mealPlan: 'CP' }],
    }, null).expect(200);
    expect(res.body.rooms[0]).toMatchObject({ roomTotal: '4000.00', mealTotal: '800.00', total: '4800.00' });
    // Room ₹4,000 at 5% (≤ ₹7,500 slab) + breakfast ₹800 as food at 5%
    expect(res.body.tax).toMatchObject({ available: true, taxTotal: '240.00', grandTotal: '5040.00', usesPlaceholderRates: true });
  });
});

describe('edit booking (same validation, limits and audit as create)', () => {
  it('changing notes keeps the agreed rates even if the rate calendar changed', async () => {
    const created = await post(desk, '/reservations', booking({ roomTypeId: f.type('STD'), arrival: '2026-11-03', departure: '2026-11-05' })).expect(201);
    const total = created.body.estimate.taxableTotal;
    const [plan] = await sql(`SELECT id FROM rate_plans WHERE is_default`);
    await sql(`INSERT INTO rate_calendar (property_id, rate_plan_id, room_type_id, label, start_date, end_date, rate, priority)
               SELECT property_id, $1, $2, 'Test surge', '2026-11-01', '2026-11-10', 9999, 50 FROM room_types WHERE id = $2`, [plan.id, f.type('STD')]);
    try {
      const edited = await patch(desk, created.body.id, editBody(created.body, { specialRequests: 'Late arrival' })).expect(200);
      expect(edited.body.estimate.taxableTotal).toBe(total);
      expect(edited.body.specialRequests).toBe('Late arrival');
      expect(edited.body.version).toBeGreaterThan(created.body.version);

      const repriced = await patch(desk, created.body.id, editBody(edited.body, {}, { adults: 1 })).expect(200);
      expect(repriced.body.rooms[0].roomTotal).toBe('19998.00');
    } finally {
      await sql(`UPDATE rate_calendar SET is_active = false WHERE label = 'Test surge'`);
    }
  });

  it('rejects a stale version', async () => {
    const created = await post(desk, '/reservations', booking({ roomTypeId: f.type('STD'), arrival: '2026-11-12', departure: '2026-11-13' })).expect(201);
    await patch(desk, created.body.id, editBody(created.body, { specialRequests: 'first' })).expect(200);
    const stale = await patch(desk, created.body.id, editBody(created.body, { specialRequests: 'second' }));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
  });

  it('moving into a booked room fails and leaves the booking unchanged', async () => {
    await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), roomId: f.room('201'), arrival: '2026-11-20', departure: '2026-11-22' })).expect(201);
    const mine = await post(desk, '/reservations', booking({ roomTypeId: f.type('DLX'), roomId: f.room('202'), arrival: '2026-11-20', departure: '2026-11-22' })).expect(201);
    const res = await patch(desk, mine.body.id, editBody(mine.body, {}, { roomId: f.room('201') }));
    expect(res.status).toBe(409);
    const after = await desk.get(`/api/v1/reservations/${mine.body.id}`).expect(200);
    expect(after.body.rooms[0].roomNumber).toBe('202');
    expect(after.body.version).toBe(mine.body.version);
  });

  it('does not count the booking against itself when the type is full', async () => {
    const a = await post(desk, '/reservations', booking({ roomTypeId: f.type('VILLA'), arrival: '2026-12-20', departure: '2026-12-22', adults: 4 })).expect(201);
    await post(desk, '/reservations', booking({ roomTypeId: f.type('VILLA'), arrival: '2026-12-20', departure: '2026-12-22', adults: 4 })).expect(201);
    await patch(desk, a.body.id, editBody(a.body, {}, { adults: 3 })).expect(200);
  });

  it('a new below-minimum rate needs owner approval again; an unchanged approved rate does not', async () => {
    const lowBody = { ...booking({ roomTypeId: f.type('STD'), arrival: '2026-11-25', departure: '2026-11-26', nightlyRate: '2000' }) };
    const pending = await post(desk, '/reservations', lowBody);
    await approve(desk, pending.body.details.authorisationId, f.ownerId).expect(200);
    const created = await post(desk, '/reservations', { ...lowBody, ownerAuthorisationId: pending.body.details.authorisationId }).expect(201);

    await patch(desk, created.body.id, editBody(created.body, { specialRequests: 'Needs cot' })).expect(200);
    const current = await desk.get(`/api/v1/reservations/${created.body.id}`).expect(200);
    const lower = await patch(desk, created.body.id, editBody(current.body, {}, { nightlyRate: '1800' }));
    expect(lower.body.code).toBe('OWNER_PIN_REQUIRED');
    expect(lower.body.details.description).toBe('Rate ₹1,800 is below the minimum ₹2,600');
  });

  it('writes before and after to the audit log and refuses cancelled bookings', async () => {
    const created = await post(desk, '/reservations', booking({ roomTypeId: f.type('STD'), arrival: '2026-11-15', departure: '2026-11-16' })).expect(201);
    await patch(desk, created.body.id, editBody(created.body, { departure: '2026-11-17' })).expect(200);
    const [entry] = await sql(`SELECT before_values, after_values FROM audit_logs WHERE entity_id = $1 AND action = 'reservation.updated'`, [created.body.id]);
    expect(entry.before_values.departure).toBe('2026-11-16');
    expect(entry.after_values.departure).toBe('2026-11-17');
    const [history] = await sql(`SELECT count(*)::int AS n FROM reservation_rooms WHERE reservation_id = $1 AND status = 'replaced'`, [created.body.id]);
    expect(history.n).toBe(1);

    const latest = await desk.get(`/api/v1/reservations/${created.body.id}`).expect(200);
    await post(desk, `/reservations/${created.body.id}/cancel`, { reason: 'guest_request' }).expect(200);
    const res = await patch(desk, created.body.id, editBody({ ...latest.body, version: latest.body.version + 1 }));
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });
});

describe('rebook (never un-cancel)', () => {
  it('creates a new linked booking and leaves the cancelled one cancelled', async () => {
    const original = await post(desk, '/reservations', booking({ roomTypeId: f.type('PCOT'), arrival: '2026-10-14', departure: '2026-10-16' })).expect(201);
    const notCancelled = await post(desk, '/reservations', { ...booking({ roomTypeId: f.type('PCOT'), arrival: '2026-10-20', departure: '2026-10-21' }), rebookedFromId: original.body.id });
    expect(notCancelled.body.code).toBe('INVALID_TRANSITION');

    await post(desk, `/reservations/${original.body.id}/cancel`, { reason: 'change_of_plans' }).expect(200);
    const rebooked = await post(desk, '/reservations', {
      guestId: original.body.guest.id, source: original.body.source, arrival: '2026-10-20', departure: '2026-10-22',
      rooms: [{ roomTypeId: f.type('PCOT'), adults: 2 }], rebookedFromId: original.body.id,
    }).expect(201);
    expect(rebooked.body.number).not.toBe(original.body.number);
    expect(rebooked.body.rebookedFrom).toEqual({ id: original.body.id, number: original.body.number });

    const old = await desk.get(`/api/v1/reservations/${original.body.id}`).expect(200);
    expect(old.body.status).toBe('cancelled');
    expect(old.body.canRebook).toBe(true);
    expect(old.body.rebookedAs[0].number).toBe(rebooked.body.number);
  });
});

describe('booking detail', () => {
  it('explains why check-in is not possible yet', async () => {
    const future = await post(desk, '/reservations', booking({ roomTypeId: f.type('STD'), arrival: '2026-10-28', departure: '2026-10-29' })).expect(201);
    expect(future.body.checkIn).toEqual({ ready: false, blockers: ['Check-in opens on the arrival day, 28 Oct 2026', 'Assign a room first'] });
    const today = await post(owner, '/reservations', booking({ roomTypeId: f.type('STD'), roomId: f.room('103'), arrival: '2026-09-16', departure: '2026-09-17' })).expect(201);
    expect(today.body.checkIn).toEqual({ ready: true, blockers: [] });
  });
});
