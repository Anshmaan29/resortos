import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booking, bootApp, fixtures, login, post, sql, type Agent } from './helpers';

/** Milestone 1.9 — the screens the old software had: Customers, Check In List, Room Shift Log, Ctrl+K. */
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

describe('purpose of visit', () => {
  it('is recorded on the booking, not the guest, and comes back on the detail', async () => {
    const created = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('DLX'), arrival: '2026-11-02', departure: '2026-11-04' }),
      purpose: 'pilgrimage',
    }).expect(201);
    const detail = await owner.get(`/api/v1/reservations/${created.body.id}`).expect(200);
    expect(detail.body.purpose).toBe('pilgrimage');

    // Same guest, different visit, different purpose — which is why it is not a guest field.
    const second = await post(owner, '/reservations', {
      guestId: detail.body.guest.id, source: 'phone', arrival: '2026-11-20', departure: '2026-11-22',
      rooms: [{ roomTypeId: f.type('DLX'), adults: 2 }], purpose: 'business',
    }).expect(201);
    expect((await owner.get(`/api/v1/reservations/${second.body.id}`)).body.purpose).toBe('business');
    expect((await owner.get(`/api/v1/reservations/${created.body.id}`)).body.purpose).toBe('pilgrimage');
  });

  it('is optional, and the database refuses a purpose that is not on the list', async () => {
    const created = await post(owner, '/reservations', booking({ roomTypeId: f.type('DLX'), arrival: '2026-11-05', departure: '2026-11-06' })).expect(201);
    expect((await owner.get(`/api/v1/reservations/${created.body.id}`)).body.purpose).toBeNull();

    const bad = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('DLX'), arrival: '2026-11-07', departure: '2026-11-08' }), purpose: 'honeymoon',
    });
    expect(bad.status).toBe(400);
    await expect(sql(`UPDATE reservations SET purpose = 'honeymoon' WHERE id = $1`, [created.body.id]))
      .rejects.toThrow(/purpose/);
  });
});

describe('guest search (spec §16)', () => {
  it('finds a guest by the vehicle they arrived in', async () => {
    // The demo seed's in-house stay is the only one with a vehicle at this point.
    const [vehicle] = await sql<{ registration: string; guest: string }>(
      `SELECT v.registration, trim(g.first_name || ' ' || g.last_name) AS guest
         FROM stay_vehicles v JOIN stays s ON s.id = v.stay_id JOIN guests g ON g.id = s.primary_guest_id LIMIT 1`,
    );
    if (!vehicle) return; // no stay with a vehicle in this run

    const exact = await desk.get('/api/v1/guests').query({ q: vehicle.registration }).expect(200);
    expect(exact.body.map((g: { fullName: string }) => g.fullName)).toContain(vehicle.guest);

    // Typed the way a person writes it, with spaces.
    const spaced = vehicle.registration.replace(/^(..)(..)(..)/, '$1 $2 $3 ');
    const loose = await desk.get('/api/v1/guests').query({ q: spaced }).expect(200);
    expect(loose.body.map((g: { fullName: string }) => g.fullName)).toContain(vehicle.guest);
  });

  it('still finds by mobile, part of a name and booking number', async () => {
    const created = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('DLX'), arrival: '2026-12-01', departure: '2026-12-03' }),
      guest: { firstName: 'Lakshmi', lastName: 'Iyer', mobile: '9829099001' },
    }).expect(201);

    for (const term of ['9829099001', '99001', 'lakshmi', created.body.number]) {
      const res = await desk.get('/api/v1/guests').query({ q: term }).expect(200);
      expect(res.body.map((g: { fullName: string }) => g.fullName), `search for ${term}`).toContain('Lakshmi Iyer');
    }
  });
});

describe('guest profile', () => {
  it('shows stays, what is still to come, vehicles and documents', async () => {
    const [stay] = await sql<{ guest_id: string; room_number: string }>(
      `SELECT s.primary_guest_id AS guest_id, rm.number AS room_number
         FROM stays s JOIN rooms rm ON rm.id = s.room_id WHERE s.status = 'in_house' LIMIT 1`,
    );
    if (!stay) return;

    const profile = await owner.get(`/api/v1/guests/${stay.guest_id}`).expect(200);
    expect(profile.body.stays.map((s: { roomNumber: string }) => s.roomNumber)).toContain(stay.room_number);
    expect(Array.isArray(profile.body.upcoming)).toBe(true);
    expect(Array.isArray(profile.body.vehicles)).toBe(true);
    expect(Array.isArray(profile.body.documents)).toBe(true);
    // The list never carries the image itself — only a signed URL does, and that is logged.
    expect(JSON.stringify(profile.body.documents)).not.toMatch(/storage_key|http/);
  });

  it('a receptionist sees documents of a current stay; older ones are owner-only', async () => {
    const [past] = await sql<{ guest_id: string; document_id: string }>(
      `SELECT s.primary_guest_id AS guest_id, d.id AS document_id
         FROM guest_documents d JOIN stays s ON s.id = d.stay_id
        WHERE s.status = 'checked_out' AND d.status = 'verified' LIMIT 1`,
    );
    if (!past) return;

    const asOwner = await owner.get(`/api/v1/guests/${past.guest_id}`).expect(200);
    expect(asOwner.body.documentsRestricted).toBe(false);
    expect(asOwner.body.documents.map((d: { id: string }) => d.id)).toContain(past.document_id);

    const asDesk = await desk.get(`/api/v1/guests/${past.guest_id}`).expect(200);
    expect(asDesk.body.documentsRestricted).toBe(true);
    expect(asDesk.body.documents.map((d: { id: string }) => d.id)).not.toContain(past.document_id);
    // And the image itself stays shut, not merely hidden from the list.
    expect((await desk.get(`/api/v1/documents/${past.document_id}/view-url`)).status).toBe(403);
  });
});

describe('the in-house list ("Check In List")', () => {
  it('defaults to who is here now, and filters by status and date range', async () => {
    const now = await desk.get('/api/v1/stays').expect(200);
    expect(now.body.every((s: { status: string }) => s.status === 'in_house')).toBe(true);

    const all = await desk.get('/api/v1/stays').query({ status: 'all' }).expect(200);
    expect(all.body.length).toBeGreaterThanOrEqual(now.body.length);

    // A range that ends before anyone arrived returns nobody.
    const old = await desk.get('/api/v1/stays').query({ status: 'all', to: '2020-01-01' }).expect(200);
    expect(old.body).toEqual([]);

    // A stay that straddles the range still belongs to it: the range overlaps, it does not contain.
    if (now.body.length > 0) {
      const one = now.body[0];
      const straddle = await desk.get('/api/v1/stays').query({ status: 'all', from: one.dueOut, to: one.dueOut }).expect(200);
      expect(straddle.body.map((s: { id: string }) => s.id)).toContain(one.id);
    }
  });

  it('finds a stay by room number, guest name or booking number', async () => {
    const [any] = (await desk.get('/api/v1/stays').query({ status: 'all' }).expect(200)).body;
    if (!any) return;
    for (const term of [any.roomNumber, any.guestName.split(' ')[0], any.reservationNumber]) {
      const res = await desk.get('/api/v1/stays').query({ status: 'all', q: term }).expect(200);
      expect(res.body.map((s: { id: string }) => s.id), `find by ${term}`).toContain(any.id);
    }
  });
});

describe('the room-shift log', () => {
  it('lists every room change with its reason and who made it', async () => {
    const log = await desk.get('/api/v1/room-shifts').expect(200);
    expect(Array.isArray(log.body)).toBe(true);
    const [count] = await sql<{ n: string }>(`SELECT count(*) AS n FROM room_shifts`);
    expect(log.body.length).toBe(Number(count!.n));
    for (const row of log.body) {
      expect(row.reason.length).toBeGreaterThan(2);
      expect(row.by).toBeTruthy();
      expect(row.from).not.toBe(row.to);
    }
  });
});

describe('global search (Ctrl+K, spec §71)', () => {
  it('finds guests, bookings, rooms and vehicles from one box', async () => {
    const created = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('DLX'), arrival: '2026-12-10', departure: '2026-12-12' }),
      guest: { firstName: 'Search', lastName: 'Target', mobile: '9829099777' },
    }).expect(201);

    const byGuest = await desk.get('/api/v1/search').query({ q: 'Search Target' }).expect(200);
    expect(byGuest.body.some((h: { kind: string; title: string }) => h.kind === 'guest' && h.title.includes('Search Target'))).toBe(true);

    const byBooking = await desk.get('/api/v1/search').query({ q: created.body.number }).expect(200);
    const hit = byBooking.body.find((h: { kind: string }) => h.kind === 'booking');
    expect(hit.title).toBe(created.body.number);
    expect(hit.href).toBe(`/reservations/${created.body.id}`);

    const byRoom = await desk.get('/api/v1/search').query({ q: '204' }).expect(200);
    expect(byRoom.body.some((h: { kind: string; title: string }) => h.kind === 'room' && h.title === 'Room 204')).toBe(true);

    // Too short to be worth a query.
    expect((await desk.get('/api/v1/search').query({ q: 'a' }).expect(200)).body).toEqual([]);
  });

  it('never leaks another property, and needs a session', async () => {
    const { default: request } = await import('supertest');
    await request(app.getHttpServer()).get('/api/v1/search').query({ q: 'test' }).expect(401);
    const res = await desk.get('/api/v1/search').query({ q: 'Search Target' }).expect(200);
    const ids = res.body.map((h: { id: string }) => h.id);
    const [mine] = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM guests WHERE id = ANY($1::uuid[]) AND property_id <> (SELECT id FROM properties LIMIT 1)`, [ids],
    );
    expect(Number(mine!.n)).toBe(0);
  });
});
