import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { addDays, todayIn } from '@resortos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { NIGHT_AUDIT_STEPS, type NightAuditContext, type NightAuditStep } from '../src/night-audit/night-audit-pipeline';
import { propertyToday } from '../src/property/property.service';
import { booking, bootAppOnOwnDatabase, login, post, type Agent } from './helpers';

it('uses the hotel timezone at midnight, independently of its unclosed accounting date', () => {
  const property = { data_origin: 'live' as const, timezone: 'Asia/Kolkata', current_business_date: '2026-10-06' };
  expect(propertyToday(property, new Date('2026-10-06T18:29:59Z'))).toBe('2026-10-06');
  expect(propertyToday(property, new Date('2026-10-06T18:30:00Z'))).toBe('2026-10-07');
  expect(propertyToday({ ...property, timezone: 'America/New_York' }, new Date('2026-10-06T18:30:00Z'))).toBe('2026-10-06');
  expect(propertyToday({ ...property, data_origin: 'demo' }, new Date('2026-10-06T18:30:00Z'))).toBe('2026-10-06');
});

let app: INestApplication;
let owner: Agent;
let sql: Awaited<ReturnType<typeof bootAppOnOwnDatabase>>['sql'];
let propertyId: string;
let roomTypeId: string;
let roomId: string;
let reservationId: string;
const today = todayIn();
beforeAll(async () => {
  ({ app, sql } = await bootAppOnOwnDatabase('calendar_date', '2026-09-16'));
  owner = await login(app, 'owner');
  const [property] = await sql(`SELECT id FROM properties LIMIT 1`);
  propertyId = property.id;
  await sql(`UPDATE properties SET data_origin = 'live' WHERE id = $1`, [propertyId]);
  const [room] = await sql(`SELECT id, room_type_id FROM rooms WHERE property_id = $1 AND number = '205'`, [propertyId]);
  roomId = room.id; roomTypeId = room.room_type_id;
});
afterAll(async () => { await app?.close(); });

describe('reception after midnight while night audit is still pending', () => {
  it('shows today, defaults reception to today and rejects a new arrival in the past', async () => {
    const property = await owner.get('/api/v1/property').expect(200);
    expect(property.body.today).toBe(today);
    expect(property.body.businessDate).toBe('2026-09-16');
    const desk = await owner.get('/api/v1/front-desk').expect(200);
    expect(desk.body.businessDate).toBe(today);
    await post(owner, '/reservations', booking({ roomTypeId, arrival: addDays(today, -1), departure: addDays(today, 1) })).expect(400);
  });

  it('allows today’s booking and check-in without closing or skipping the accounting day', async () => {
    const created = await post(owner, '/reservations', booking({ roomTypeId, roomId, adults: 1, arrival: today, departure: addDays(today, 2) })).expect(201);
    reservationId = created.body.id;
    expect(created.body.checkIn.ready).toBe(true);
    const started = await post(owner, '/check-in-drafts', { reservationId }, null).expect(200);
    const data = structuredClone(started.body.data);
    data.rooms[0].occupants[0].idType = 'passport';
    data.rooms[0].occupants[0].idLast4 = '1234';
    data.consents.stayAndCompliance = true;
    await owner.patch(`/api/v1/check-in-drafts/${started.body.id}`).set('x-resortos', '1').send({ version: started.body.version, step: 5, data }).expect(200);
    // Genuine private-storage upload/verification for each required capture.
    for (const docType of ['id_front', 'guest_photo']) {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1000)]);
      const grant = await post(owner, `/check-in-drafts/${started.body.id}/documents`, {
        source: 'file_upload', docType, occupantKey: 'r0a0', ...(docType === 'id_front' ? { idType: 'passport' } : {}),
        contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      }, null).expect(201);
      expect((await fetch(grant.body.upload.url, { method: 'PUT', headers: grant.body.upload.headers, body: bytes })).status).toBe(200);
      await post(owner, `/check-in-drafts/${started.body.id}/documents/${grant.body.documentId}/confirm`, {}, null).expect(200);
    }
    const confirmed = await post(owner, `/check-in-drafts/${started.body.id}/confirm`, {}).expect(200);
    const stayId = confirmed.body.stays[0].id;
    const [stay] = await sql(`SELECT business_date_in FROM stays WHERE id = $1`, [stayId]);
    expect(stay.business_date_in).toBe(today);
    const checkout = await owner.get(`/api/v1/stays/${stayId}/checkout-preview`).expect(200);
    expect(checkout.body.businessDate).toBe(today);
    const [property] = await sql(`SELECT current_business_date FROM properties WHERE id = $1`, [propertyId]);
    expect(property.current_business_date).toBe('2026-09-16');
    const [audits] = await sql(`SELECT count(*)::int AS count FROM night_audits WHERE property_id = $1`, [propertyId]);
    expect(audits.count).toBe(0);
  });

  it('does not post an earlier reserved night before the actual check-in date', async () => {
    // Historical late-arrival data may contain an agreed night before the guest actually arrived.
    await sql(`INSERT INTO reservation_room_nights
      (reservation_room_id, night_date, property_id, room_rate, extra_person_amount, meal_amount, rate_source)
      SELECT id, $2::date, property_id, nightly_rate, 0, 0, 'base' FROM reservation_rooms WHERE reservation_id = $1`,
      [reservationId, addDays(today, -1)]);
    const [user] = await sql(`SELECT id FROM users WHERE role = 'owner' LIMIT 1`);
    const step = app.get<NightAuditStep[]>(NIGHT_AUDIT_STEPS).find((s) => s.name === 'room_charges')!;
    const context = { q: app.get(DbService), propertyId, businessDate: addDays(today, -1),
      actor: { user: { id: user.id, propertyId, role: 'owner', fullName: 'Test owner' } } } as NightAuditContext;
    expect((await step.inspect(context)).facts.roomsToCharge).toBe(0);
    expect((await step.inspect({ ...context, businessDate: today })).facts.roomsToCharge).toBe(1);
  });

  it('still refuses check-in before the actual arrival day', async () => {
    const future = await post(owner, '/reservations', booking({ roomTypeId, arrival: addDays(today, 1), departure: addDays(today, 2) })).expect(201);
    expect(future.body.checkIn.ready).toBe(false);
    const response = await post(owner, '/check-in-drafts', { reservationId: future.body.id }, null).expect(409);
    expect(response.body.message).toMatch(/arrival day/);
  });
});
