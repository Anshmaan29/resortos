import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { todayIn, addDays } from '@resortos/shared';
import request from 'supertest';
import { bootAppOnOwnDatabase, login, type Agent, booking } from './helpers';
import { DbService } from '../src/db/db.service';
import { OutboxDispatcher } from '../src/jobs/outbox.dispatcher';
import { MessagingService } from '../src/messaging/messaging.service';
import { MESSAGE_PROVIDERS, type MessageProvider } from '../src/messaging/providers';
import { ensureVillaRooms } from '../scripts/ensure-villa-rooms-lib';
import { addVilla } from '../scripts/add-villa-lib';
let app: INestApplication,
  sql: <T = any>(s: string, v?: unknown[]) => Promise<T[]>,
  owner: Agent,
  villaDesk: Agent,
  desk: Agent,
  villaId: string,
  hotelId: string,
  ownerId: string;
let hotelSnapshot: string;
async function sourceSnapshot() {
  const [r] = await sql<{ hash: string }>(
    `SELECT md5(jsonb_build_object(
  'rooms',(SELECT jsonb_agg(t ORDER BY t.id) FROM rooms t WHERE property_id=$1),
  'rates',(SELECT jsonb_agg(t ORDER BY t.id) FROM room_types t WHERE property_id=$1),
  'bookings',(SELECT jsonb_agg(t ORDER BY t.id) FROM reservations t WHERE property_id=$1),
  'guests',(SELECT jsonb_agg(t ORDER BY t.id) FROM guests t WHERE property_id=$1),
  'docs',(SELECT jsonb_agg(t ORDER BY t.id) FROM guest_documents t WHERE property_id=$1),
  'stays',(SELECT jsonb_agg(t ORDER BY t.id) FROM stays t WHERE property_id=$1),
  'payments',(SELECT jsonb_agg(t ORDER BY t.id) FROM payments t WHERE property_id=$1),
  'invoices',(SELECT jsonb_agg(t ORDER BY t.id) FROM invoices t WHERE property_id=$1),
  'shifts',(SELECT jsonb_agg(t ORDER BY t.id) FROM cashier_shifts t WHERE property_id=$1)
 )::text) AS hash`,
    [hotelId],
  );
  return r!.hash;
}
const vpost = (path: string, body: object, key = randomUUID()) =>
  owner
    .post('/api/v1' + path)
    .set('x-resortos', '1')
    .set('x-resortos-property', villaId)
    .set('idempotency-key', key)
    .send(body);
const today = todayIn('Asia/Kolkata');
let seq = 0;
const slot = (date = addDays(today, 2), kind = 'pool', start = '10:00', end = '12:00') => ({
  useKind: kind,
  startsAt: `${date}T${start}:00+05:30`,
  endsAt: `${date}T${end}:00+05:30`,
  guestCount: 8,
  price: '1250.00',
  gstPercent: '18.00',
  guest: {
    firstName: 'Villa Test',
    mobile: `+919800${String(++seq).padStart(6, '0')}`,
    email: 'villa-test@example.com',
  },
});
const create = (body: object, key = randomUUID()) =>
  owner
    .post('/api/v1/villa/bookings')
    .set('x-resortos', '1')
    .set('x-resortos-property', villaId)
    .set('idempotency-key', key)
    .send(body);
const action = (id: string, op: string, version: number) =>
  owner
    .post(`/api/v1/villa/bookings/${id}/${op}`)
    .set('x-resortos', '1')
    .set('x-resortos-property', villaId)
    .set('idempotency-key', randomUUID())
    .send({ version });
const get = (path: string) => owner.get('/api/v1' + path).set('x-resortos-property', villaId);
beforeAll(async () => {
  ({ app, sql } = await bootAppOnOwnDatabase('villa_private', today));
  owner = await login(app, 'owner');
  desk = await login(app, 'receptionist');
  const rows = await sql<{ id: string; property_id: string }>(
    `SELECT id,property_id FROM users WHERE role='owner'`,
  );
  ownerId = rows[0]!.id;
  hotelId = rows[0]!.property_id;
  hotelSnapshot = await sourceSnapshot();
  villaId = (
    await app.get(DbService).tx({ userId: ownerId }, (q) => addVilla(q, hotelId, ownerId, '324001'))
  ).propertyId;
});
afterAll(async () => {
  await app.close();
});
describe('property boundaries', () => {
  it('owner can select two properties; receptionist remains restricted to one', async () => {
    const a = await owner.get('/api/v1/auth/properties').expect(200);
    expect(a.body).toHaveLength(2);
    expect((await desk.get('/api/v1/auth/properties').expect(200)).body).toHaveLength(1);
    await desk.get('/api/v1/property').set('x-resortos-property', villaId).expect(403);
    await desk.get('/api/v1/property?propertyContext=' + villaId).expect(403);
    expect((await get('/property').expect(200)).body).toMatchObject({
      id: villaId,
      name: 'Villa Sol by Voitto',
      pinCode: '324001',
    });
    expect((await owner.get('/api/v1/property').expect(200)).body.id).toBe(hotelId);
  });
  it('setup is repeatable and never copies hotel guest or financial records', async () => {
    expect(
      await app
        .get(DbService)
        .tx({ userId: ownerId }, (q) => addVilla(q, hotelId, ownerId, '324001')),
    ).toEqual({ propertyId: villaId, created: false });
    expect(await sql(`SELECT id FROM guests WHERE property_id=$1`, [villaId])).toHaveLength(0);
    expect(await sql(`SELECT id FROM cashier_shifts WHERE property_id=$1`, [villaId])).toHaveLength(
      0,
    );
    const rooms = await sql(`SELECT number FROM rooms WHERE property_id=$1`, [villaId]);
    expect(rooms.map((r) => r.number).sort()).toEqual(['1', '2']);
  });
  it('cannot deactivate or put the secondary bedroom out of order while both rooms are reserved', async () => {
    const b=await create({...slot(addDays(today,40),'both_bedrooms'),guestCount:1,endsAt:`${addDays(today,41)}T11:00:00+05:30`}).expect(201);
    const room=(await get('/rooms/setup').expect(200)).body.find((r:any)=>r.number==='2');
    const update=await owner.patch(`/api/v1/rooms/${room.id}`).set('x-resortos','1').set('x-resortos-property',villaId)
      .send({number:room.number,roomTypeId:room.roomTypeId,unitType:'room',isActive:false,version:room.version});
    await sql(`UPDATE rooms SET is_active=true WHERE id=$1`,[room.id]);
    expect(update.status).toBe(409);
    await vpost(`/rooms/${room.id}/out-of-order`,{startDate:addDays(today,40),endDate:addDays(today,41),reason:'Scheduled work'}).expect(409);
    await action(b.body.id,'cancel',b.body.version).expect(200);
  });
  it('rejects conflicting property headers and download query context', async () => {
    await get('/property?propertyContext=' + hotelId).expect(403);
  });
  it('creates separate Villa staff in Settings with access only to Villa and the granted owner PIN', async () => {
    await vpost('/users', {
      fullName: 'Villa QA Desk',
      username: 'villa_qa_desk',
      role: 'receptionist',
      temporaryPassword: 'Temporary#Pass1',
    }).expect(201);
    villaDesk = request.agent(app.getHttpServer());
    await villaDesk
      .post('/api/v1/auth/login')
      .set('x-resortos', '1')
      .send({ login: 'villa_qa_desk', password: 'Temporary#Pass1' })
      .expect(200);
    await villaDesk
      .post('/api/v1/auth/password/change')
      .set('x-resortos', '1')
      .send({ currentPassword: 'Temporary#Pass1', newPassword: 'Villa-Desk#2026' })
      .expect(200);
    expect((await villaDesk.get('/api/v1/property').expect(200)).body.id).toBe(villaId);
    expect((await villaDesk.get('/api/v1/auth/properties').expect(200)).body).toHaveLength(1);
    await villaDesk.get('/api/v1/property').set('x-resortos-property', hotelId).expect(403);
    await villaDesk.get('/api/v1/property?propertyContext=' + hotelId).expect(403);
    expect((await villaDesk.get('/api/v1/auth/owners').expect(200)).body).toContainEqual(
      expect.objectContaining({ id: ownerId }),
    );
  });
});
describe('whole-property exclusivity', () => {
  it('books a pool time slot and blocks garden and overnight overlap', async () => {
    const input = slot();
    const a = await create(input).expect(201);
    expect(a.body).toMatchObject({
      dayUse: true,
      guestCount: 8,
      estimatedTotal: '1475.00',
      useKind: 'pool',
    });
    await create({ ...slot(), useKind: 'garden' }).expect(409);
    await create({
      ...slot(),
      useKind: 'whole_villa',
      startsAt: input.startsAt,
      endsAt: `${addDays(today, 3)}T11:00:00+05:30`,
    }).expect(409);
    const avail = await get('/villa/availability')
      .query({ startsAt: input.startsAt, endsAt: input.endsAt })
      .expect(200);
    expect(avail.body.available).toBe(false);
    await owner.get('/api/v1/villa/bookings/' + a.body.id).expect(403);
    await owner.get('/api/v1/reservations/' + a.body.id).expect(404);
  });
  it('permits touching slots, and simultaneous competing saves yield one winner', async () => {
    await create(slot(addDays(today, 2), 'garden', '12:00', '13:00')).expect(201);
    const input = slot(addDays(today, 4));
    const responses = await Promise.all([
      create(input),
      create({ ...slot(addDays(today, 4)), useKind: 'garden' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  it('replays a save in its own resort and rejects cross-property idempotency replay', async () => {
    const key = randomUUID(),
      input = slot(addDays(today, 5));
    const a = await create(input, key).expect(201);
    const b = await create(input, key).expect(201);
    expect(b.body.id).toBe(a.body.id);
    await owner
      .post('/api/v1/villa/bookings')
      .set('x-resortos', '1')
      .set('idempotency-key', key)
      .send(input)
      .expect(422);
  });
  it('creates a both-bedroom stay without fake room numbers', async () => {
    const input = {
      ...slot(addDays(today, 6), 'both_bedrooms'),
      endsAt: `${addDays(today, 7)}T11:00:00+05:30`,
      price: '4500.00',
      gstPercent: '5.00',
    };
    const res = await create(input).expect(201);
    expect(res.body).toMatchObject({
      dayUse: false,
      subtotal: '4500.00',
      estimatedTotal: '4725.00',
    });
    const rows = await sql(
      `SELECT adults,nightly_rate,gst_rate_override FROM reservation_rooms WHERE reservation_id=$1`,
      [res.body.id],
    );
    expect(rows[0]).toMatchObject({
      adults: 8,
      nightly_rate: '4500.00',
      gst_rate_override: '5.00',
    });
  });
  it('cancels an unpaid slot and frees it without deleting history', async () => {
    const input = slot(addDays(today, 8));
    const a = await create(input).expect(201);
    await action(a.body.id, 'cancel', a.body.version).expect(200);
    await create({ ...input, guest: slot().guest }).expect(201);
    expect((await get('/villa/bookings/' + a.body.id).expect(200)).body.status).toBe('cancelled');
  });
  it('prevents a legacy endpoint from bypassing private-villa allocations', async () => {
    const type = (await sql(`SELECT id FROM room_types WHERE property_id=$1`, [villaId]))[0].id;
    await owner
      .post('/api/v1/reservations')
      .set('x-resortos', '1')
      .set('x-resortos-property', villaId)
      .set('idempotency-key', randomUUID())
      .send(
        booking({ roomTypeId: type, arrival: addDays(today, 9), departure: addDays(today, 10) }),
      )
      .expect(400);
  });
});
describe('pool arrival, money, invoice and email', () => {
  it('arrives without a check-in draft or ID, bills once, settles and checks out', async () => {
    const input = {
      ...slot(today),
      startsAt: new Date(Date.now() - 120000).toISOString(),
      endsAt: new Date(Date.now() + 1800000).toISOString(),
    };
    const a = await create(input).expect(201);
    const arrived = await action(a.body.id, 'arrive', a.body.version).expect(200);
    expect(arrived.body.status).toBe('checked_in');
    expect(arrived.body.bill.total).toBe('1475.00');
    expect((await get('/folios/' + a.body.folioId).expect(200)).body.total).toBe('1475.00');
    await owner.get('/api/v1/folios/' + a.body.folioId).expect(404);
    expect(
      await sql(`SELECT id FROM check_in_drafts WHERE reservation_id=$1`, [a.body.id]),
    ).toHaveLength(0);
    expect(
      await sql(`SELECT id FROM reservation_rooms WHERE reservation_id=$1`, [a.body.id]),
    ).toHaveLength(0);
    await action(a.body.id, 'depart', arrived.body.version).expect(409);
    const [account] = await sql(
      `INSERT INTO payment_accounts(property_id,name,kind,created_by) VALUES($1,'Test bank','bank',$2) RETURNING id`,
      [villaId, ownerId],
    );
    await owner
      .post(`/api/v1/folios/${a.body.folioId}/payments`)
      .set('x-resortos', '1')
      .set('x-resortos-property', villaId)
      .set('idempotency-key', randomUUID())
      .send({
        entryType: 'payment',
        method: 'bank_transfer',
        paymentAccountId: account.id,
        amount: '1475.00',
        reference: 'VILLA-QA-ONLY',
      })
      .expect(200);
    const completed = await action(a.body.id, 'depart', arrived.body.version).expect(200);
    expect(completed.body.status).toBe('checked_out');
    expect(completed.body.bill.documents[0].grandTotal).toBe('1475.00');
    const invoiceId = completed.body.bill.documents[0].id;
    await get('/invoices/' + invoiceId + '/pdf')
      .expect(200)
      .expect('Content-Type', /pdf/);
    await owner.get('/api/v1/invoices/' + invoiceId + '/pdf').expect(404);
    expect(completed.body.bill.documents[0].number).toMatch(/^VSI\//);
    const invoice = await sql(`SELECT seller_address,seller_legal_name FROM invoices WHERE id=$1`, [
      invoiceId,
    ]);
    expect(invoice[0].seller_address).toContain('Kaithun');
    expect(
      (await sql(`SELECT housekeeping_status FROM rooms WHERE property_id=$1`, [villaId]))[0]
        .housekeeping_status,
    ).toBe('dirty');
  });
});

describe('advance handling', () => {
  it('credits a pool advance to its own bill and records its refund before cancellation', async () => {
    const b = await create(slot(addDays(today, 20))).expect(201);
    const [account] = await sql(
      `SELECT id FROM payment_accounts WHERE property_id=$1 AND kind='bank'`,
      [villaId],
    );
    await vpost(`/reservations/${b.body.id}/advance`, {
      method: 'bank_transfer',
      paymentAccountId: account.id,
      amount: '500.00',
      reference: 'VILLA-ADVANCE-QA',
    }).expect(200);
    const after = (await get('/villa/bookings/' + b.body.id).expect(200)).body;
    expect(after.paid).toBe('500.00');
    expect(after.bill.paid).toBe('500.00');
    await action(b.body.id, 'cancel', after.version).expect(409);
    await vpost(`/villa/bookings/${b.body.id}/refund`, {
      entryType: 'refund',
      method: 'bank_transfer',
      paymentAccountId: account.id,
      amount: '600.00',
      reference: 'TOO-MUCH',
    }).expect(400);
    const refundBody = {
      entryType: 'refund',
      method: 'bank_transfer',
      paymentAccountId: account.id,
      amount: '500.00',
      reference: 'RETURNED-QA',
    };
    const refundRequest = (body: object) =>
      villaDesk
        .post(`/api/v1/villa/bookings/${b.body.id}/refund`)
        .set('x-resortos', '1')
        .set('idempotency-key', randomUUID())
        .send(body);
    const required = await refundRequest(refundBody).expect(403);
    expect(required.body.code).toBe('OWNER_PIN_REQUIRED');
    const authorisationId = required.body.details.authorisationId;
    await villaDesk
      .post(`/api/v1/owner-authorisations/${authorisationId}/approve`)
      .set('x-resortos', '1')
      .send({ ownerUserId: ownerId, pin: '482916' })
      .expect(200);
    await refundRequest({ ...refundBody, ownerAuthorisationId: authorisationId }).expect(200);
    const refunded = (await get('/villa/bookings/' + b.body.id).expect(200)).body;
    expect(refunded.paid).toBe('0.00');
    expect(refunded.bill.paid).toBe('0.00');
    await action(b.body.id, 'cancel', refunded.version).expect(200);
  });
});

describe('editing, overnight documents, communications and preservation', () => {
  it('edits dates/prices atomically and refuses conflicting edits', async () => {
    const body = slot(addDays(today, 12));
    const a = await create(body).expect(201);
    const next = {
      ...body,
      version: a.body.version,
      startsAt: `${addDays(today, 13)}T10:00:00+05:30`,
      endsAt: `${addDays(today, 13)}T13:00:00+05:30`,
      price: '2100.00',
      gstPercent: '5.00',
    };
    const changed = await owner
      .patch('/api/v1/villa/bookings/' + a.body.id)
      .set('x-resortos', '1')
      .set('x-resortos-property', villaId)
      .set('idempotency-key', randomUUID())
      .send(next)
      .expect(200);
    expect(changed.body.price).toBe('2100.00');
    await owner
      .patch('/api/v1/villa/bookings/' + a.body.id)
      .set('x-resortos', '1')
      .set('x-resortos-property', villaId)
      .set('idempotency-key', randomUUID())
      .send({ ...next, version: changed.body.version, ...slot(addDays(today, 2)) })
      .expect(409);
    expect((await get('/villa/bookings/' + a.body.id).expect(200)).body.price).toBe('2100.00');
  });
  it('uses verified overnight documents and the existing checkout/invoice pipeline', async () => {
    await sql(`UPDATE rooms SET housekeeping_status='clean' WHERE property_id=$1`, [villaId]);
    const body = {
      ...slot(today, 'whole_villa'),
      guestCount: 1,
      startsAt: new Date(Date.now() - 120000).toISOString(),
      endsAt: `${addDays(today, 1)}T11:00:00+05:30`,
      price: '4000.00',
      gstPercent: '5.00',
    };
    const b = await create(body).expect(201);
    const d = await vpost('/check-in-drafts', { reservationId: b.body.id }).expect(200);
    await vpost(`/check-in-drafts/${d.body.id}/confirm`, {}).expect(400);
    const data = structuredClone(d.body.data);
    const [room] = await sql<{ id: string }>(`SELECT id FROM rooms WHERE property_id=$1`, [
      villaId,
    ]);
    data.rooms[0].roomId = room!.id;
    data.rooms[0].occupants[0].idType = 'passport';
    data.rooms[0].occupants[0].idLast4 = '4321';
    data.consents = { stayAndCompliance: true, marketing: false };
    await owner
      .patch('/api/v1/check-in-drafts/' + d.body.id)
      .set('x-resortos', '1')
      .set('x-resortos-property', villaId)
      .send({ version: d.body.version, step: 5, data })
      .expect(200);
    for (const type of ['id_front', 'guest_photo']) {
      const bytes = Buffer.concat([Buffer.from([255, 216, 255, 224]), randomBytes(2048)]);
      const doc = await vpost(`/check-in-drafts/${d.body.id}/documents`, {
        source: 'desk_camera',
        docType: type,
        contentType: 'image/jpeg',
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        occupantKey: 'r0a0',
        ...(type === 'id_front' ? { idType: 'passport' } : {}),
      }).expect(201);
      const uploaded = await fetch(doc.body.upload.url, {
        method: 'PUT',
        headers: doc.body.upload.headers,
        body: bytes,
      });
      expect(uploaded.status).toBe(200);
      await vpost(
        `/check-in-drafts/${d.body.id}/documents/${doc.body.documentId}/confirm`,
        {},
      ).expect(200);
      await owner.get(`/api/v1/documents/${doc.body.documentId}/view-url`).expect(404);
    }
    const checked = await vpost(`/check-in-drafts/${d.body.id}/confirm`, {}).expect(200);
    const stayId = checked.body.stays[0].id;
    expect(
      (await sql(`SELECT allocation_status FROM villa_bookings WHERE id=$1`, [b.body.id]))[0]
        .allocation_status,
    ).toBe('occupied');
    await vpost(`/stays/${stayId}/extend`, {
      newDeparture: addDays(today, 2),
      reason: 'Conflict with pool booking',
    }).expect(409);
    expect((await get('/villa/bookings/' + b.body.id).expect(200)).body.endsAt).toBe(
      new Date(body.endsAt).toISOString(),
    );
    await get(`/stays/${stayId}/checkout-preview`).expect(200);
    const bill = (await get(`/stays/${stayId}/bill`).expect(200)).body;
    expect(bill.total).toBe('4200.00');
    const [account] = await sql(
      `SELECT id FROM payment_accounts WHERE property_id=$1 AND kind='bank'`,
      [villaId],
    );
    await vpost(`/folios/${bill.id}/payments`, {
      entryType: 'payment',
      method: 'bank_transfer',
      paymentAccountId: account.id,
      amount: bill.balance,
      reference: 'VILLA-OVERNIGHT-QA',
    }).expect(200);
    await vpost(`/stays/${stayId}/checkout`, {}).expect(200);
    expect((await get('/villa/bookings/' + b.body.id).expect(200)).body.status).toBe('checked_out');
  });
  it('queues automatic villa email with the right brand, contact, use and time', async () => {
    expect(app.get<MessageProvider[]>(MESSAGE_PROVIDERS)[0]!.name).toBe('dev');
    const outbox = app.get(OutboxDispatcher);
    for (let i = 0; i < 8; i++) if ((await outbox.drainOnce(100)).claimed === 0) break;
    const msgs = await sql(
      `SELECT body,recipient,template_key FROM messages WHERE property_id=$1 AND channel='email' AND template_key='booking_confirmation' ORDER BY queued_at`,
      [villaId],
    );
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].body).toContain('Villa Sol by Voitto');
    expect(msgs[0].body).toContain('9352204825');
    expect(msgs.some((m) => m.body.includes('Swimming pool'))).toBe(true);
    expect(msgs[0].body).toContain('From:');
    expect(msgs[0].body).not.toMatch(/Laxmi|Airtel/);
    await app.get(MessagingService).sendDue(100);
  });
  it('offers two physical rooms, allows different guests, and blocks shared facilities', async () => {
    await sql(`UPDATE rooms SET housekeeping_status='clean' WHERE property_id=$1`, [villaId]);
    const rooms = (await get('/rooms').expect(200)).body;
    expect(rooms.map((r: any) => r.number)).toEqual(['1', '2']);
    const input = {
      ...slot(addDays(today, 20), 'one_bedroom'),
      roomId: rooms[0].id,
      guestCount: 1,
      endsAt: `${addDays(today, 21)}T11:00:00+05:30`,
    };
    const a = await create(input).expect(201);
    const [line] = await sql(`SELECT id FROM reservation_rooms WHERE reservation_id=$1`, [
      a.body.id,
    ]);
    await vpost(`/reservation-rooms/${line.id}/assign`, { roomId: rooms[1].id }).expect(400);
    const b = await create({ ...input, roomId: rooms[1].id, guest: slot().guest }).expect(201);
    expect(a.body.useLabel).toBe('Room 1');
    expect(b.body.useLabel).toBe('Room 2');
    await create({ ...input, guest: slot().guest }).expect(409);
    await create({ ...input, useKind: 'both_bedrooms', guest: slot().guest }).expect(409);
    await create({ ...input, useKind: 'pool', guest: slot().guest }).expect(409);
    await create({ ...input, useKind: 'garden', guest: slot().guest }).expect(409);
    const opts = await get('/villa/availability')
      .query({
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        excludeId: a.body.id,
        useKind: 'one_bedroom',
        roomId: rooms[0].id,
      })
      .expect(200);
    expect(opts.body.available).toBe(true);
    expect(opts.body.rooms.map((r: any) => r.available)).toEqual([true, false]);
    const picker = await get('/availability')
      .query({
        arrival: addDays(today, 20),
        departure: addDays(today, 21),
        reservationId: a.body.id,
      })
      .expect(200);
    expect(picker.body.rooms.map((r: any) => r.id)).toEqual([rooms[0].id]);
    const rr = (
      await sql(`SELECT id FROM reservation_rooms WHERE reservation_id=$1`, [a.body.id])
    )[0];
    await vpost(`/reservation-rooms/${rr.id}/assign`, { roomId: rooms[1].id }).expect(409);
    await action(a.body.id, 'cancel', a.body.version).expect(200);
    await create({ ...input, guest: slot().guest }).expect(201);
  });
  it('serializes competing room saves and permits the other bedroom', async () => {
    await sql(`UPDATE rooms SET housekeeping_status='clean' WHERE property_id=$1`, [villaId]);
    const rooms = (await get('/rooms').expect(200)).body;
    const input = {
      ...slot(addDays(today, 22), 'one_bedroom'),
      roomId: rooms[0].id,
      guestCount: 1,
      endsAt: `${addDays(today, 23)}T11:00:00+05:30`,
    };
    const r = await Promise.all([create(input), create({ ...input, guest: slot().guest })]);
    expect(r.map((x) => x.status).sort()).toEqual([201, 409]);
    await create({ ...input, roomId: rooms[1].id, guest: slot().guest }).expect(201);
  });
  it('serializes a Villa booking against maintenance on its secondary bedroom', async()=>{
    const room=(await get('/rooms').expect(200)).body.find((r:any)=>r.number==='2');
    const results=await Promise.all([
      create(slot(addDays(today,42))),
      vpost(`/rooms/${room.id}/out-of-order`,{startDate:addDays(today,42),endDate:addDays(today,43),reason:'Scheduled work'}),
    ]);
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  });
  it('edits a room choice atomically and releases the previous room', async () => {
    const rooms = (await get('/rooms').expect(200)).body;
    const input = {
      ...slot(addDays(today, 26), 'one_bedroom'),
      roomId: rooms[0].id,
      guestCount: 1,
      endsAt: `${addDays(today, 27)}T11:00:00+05:30`,
    };
    const a = await create(input).expect(201);
    const changed = await owner
      .patch(`/api/v1/villa/bookings/${a.body.id}`)
      .set('x-resortos', '1')
      .set('x-resortos-property', villaId)
      .set('idempotency-key', randomUUID())
      .send({ ...input, version: a.body.version, roomId: rooms[1].id })
      .expect(200);
    expect(changed.body.useLabel).toBe('Room 2');
    await create({ ...input, guest: slot().guest }).expect(201);
  });
  it('adds room setup idempotently without rewriting existing bookings', async () => {
    const before = await sql(
      `SELECT to_jsonb(v) AS data FROM villa_bookings v WHERE property_id=$1 ORDER BY id`,
      [villaId],
    );
    expect(
      await app
        .get(DbService)
        .tx({ userId: ownerId }, (q) => ensureVillaRooms(q, villaId, ownerId)),
    ).toEqual({ created: [] });
    expect(
      await sql(
        `SELECT to_jsonb(v) AS data FROM villa_bookings v WHERE property_id=$1 ORDER BY id`,
        [villaId],
      ),
    ).toEqual(before);
  });
  it('records villa cash advances and expenses without shifts, while hotel cash still requires a shift', async () => {
    const b = await create(slot(addDays(today, 24))).expect(201);
    const [cash] = await sql(
      `SELECT id FROM payment_accounts WHERE property_id=$1 AND kind='cash'`,
      [villaId],
    );
    const paid = await vpost(`/reservations/${b.body.id}/advance`, {
      entryType: 'advance',
      method: 'cash',
      paymentAccountId: cash.id,
      amount: '100',
    }).expect(200);
    expect(paid.body).toBeTruthy();
    expect(
      (await sql(`SELECT cashier_shift_id FROM payments WHERE reservation_id=$1`, [b.body.id]))[0]
        .cashier_shift_id,
    ).toBeNull();
    const category = await vpost('/expense-categories', { name: 'Villa cleaning' }).expect(201);
    await vpost('/expenses', {
      categoryId: category.body.id,
      expenseDate: today,
      method: 'cash',
      paymentAccountId: cash.id,
      amount: '25',
      paidTo: 'Test cleaner',
    }).expect(201);
    expect(await sql(`SELECT id FROM cashier_shifts WHERE property_id=$1`, [villaId])).toHaveLength(
      0,
    );
    await vpost('/shifts/open', { openingCash: '0' }).expect(409);
    const preview = (await get('/night-audit').expect(200)).body;
    expect(preview.steps.map((s: any) => s.name)).not.toContain('open_shifts');
    await expect(
      sql(
        `INSERT INTO payments(property_id,reservation_id,entry_type,method,amount,business_date,received_by)
      VALUES($1,$4,'advance','cash',1,$3,$2)`,
        [hotelId, ownerId, today, randomUUID()],
      ),
    ).rejects.toThrow(/shift/);
  });
  it('checks in separate room guests independently and bills two rooms once', async () => {
    async function checkIn(id: string) {
      const d = await vpost('/check-in-drafts', { reservationId: id }).expect(200);
      const data = structuredClone(d.body.data);
      data.rooms[0].occupants[0].idType = 'passport';
      data.rooms[0].occupants[0].idLast4 = '4321';
      data.consents = { stayAndCompliance: true, marketing: false };
      await owner
        .patch('/api/v1/check-in-drafts/' + d.body.id)
        .set('x-resortos', '1')
        .set('x-resortos-property', villaId)
        .send({ version: d.body.version, step: 5, data })
        .expect(200);
      for (const type of ['id_front', 'guest_photo']) {
        const bytes = Buffer.concat([Buffer.from([255, 216, 255, 224]), randomBytes(2048)]);
        const doc = await vpost(`/check-in-drafts/${d.body.id}/documents`, {
          source: 'desk_camera',
          docType: type,
          contentType: 'image/jpeg',
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          occupantKey: 'r0a0',
          ...(type === 'id_front' ? { idType: 'passport' } : {}),
        }).expect(201);
        expect(
          (
            await fetch(doc.body.upload.url, {
              method: 'PUT',
              headers: doc.body.upload.headers,
              body: bytes,
            })
          ).status,
        ).toBe(200);
        await vpost(
          `/check-in-drafts/${d.body.id}/documents/${doc.body.documentId}/confirm`,
          {},
        ).expect(200);
      }
      return (await vpost(`/check-in-drafts/${d.body.id}/confirm`, {}).expect(200)).body.stays[0]
        .id;
    }
    async function settle(stayId: string) {
      await get(`/stays/${stayId}/checkout-preview`).expect(200);
      const bill = (await get(`/stays/${stayId}/bill`).expect(200)).body;
      const [cash] = await sql(
        `SELECT id FROM payment_accounts WHERE property_id=$1 AND kind='cash'`,
        [villaId],
      );
      await vpost(`/folios/${bill.id}/payments`, {
        entryType: 'payment',
        method: 'cash',
        paymentAccountId: cash.id,
        amount: bill.balance,
      }).expect(200);
      await vpost(`/stays/${stayId}/checkout`, {}).expect(200);
      return bill;
    }
    await sql(`UPDATE rooms SET housekeeping_status='clean' WHERE property_id=$1`, [villaId]);
    const body = {
      ...slot(today, 'both_bedrooms'),
      guestCount: 1,
      startsAt: new Date(Date.now() - 120000).toISOString(),
      endsAt: `${addDays(today, 1)}T09:00:00+05:30`,
      price: '700',
      gstPercent: '0',
    };
    const both = await create(body).expect(201);
    const bothStay = await checkIn(both.body.id);
    await vpost(`/stays/${bothStay}/grc`, {}).expect(200);
    const [secondary] = await sql(`SELECT id FROM rooms WHERE property_id=$1 AND number='2'`, [villaId]);
    await vpost(`/rooms/${secondary.id}/status`, { service: 'maintenance', housekeeping: 'dirty', reason: 'QA readiness check' }).expect(201);
    const mismatches = (await get('/night-audit').expect(200)).body.summary;
    await vpost(`/rooms/${secondary.id}/status`, { service: 'in_service', housekeeping: 'clean', reason: 'QA check complete' }).expect(201);
    expect(mismatches).toMatchObject({ roomsOccupiedOutOfService: 1, vacantRoomsStillDirty: 0 });
    expect(
      (await get('/rooms').expect(200)).body.map((r: any) => r.currentReservation?.id),
    ).toEqual([both.body.id, both.body.id]);
    expect(
      (await get('/housekeeping/board').expect(200)).body.rooms.map((r: any) => r.occupied),
    ).toEqual([true, true]);
    expect((await get('/night-audit').expect(200)).body.summary).toMatchObject({
      roomsActive: 2,
      roomsOccupied: 2,
    });
    const combinedBill = await settle(bothStay);
    expect(combinedBill.total).toBe('700.00');
    const [combinedLine] = await sql(`SELECT name FROM folio_lines WHERE folio_id=$1 AND line_type='room_night'`, [combinedBill.id]);
    const [combinedInvoice] = await sql(`SELECT room_numbers FROM invoices WHERE folio_id=$1 AND series IN ('INV','BOS')`, [combinedBill.id]);
    expect(combinedLine.name).toBe('Room 1 + 2');
    expect(combinedInvoice.room_numbers).toBe('1 + 2');
    expect((await get('/rooms').expect(200)).body.map((r: any) => r.housekeeping)).toEqual([
      'dirty',
      'dirty',
    ]);
    await sql(`UPDATE rooms SET housekeeping_status='clean' WHERE property_id=$1`, [villaId]);
    const rooms = (await get('/rooms').expect(200)).body;
    const a = await create({
      ...body,
      useKind: 'one_bedroom',
      roomId: rooms[0].id,
      guest: slot().guest,
    }).expect(201);
    const b = await create({
      ...body,
      useKind: 'one_bedroom',
      roomId: rooms[1].id,
      guest: slot().guest,
    }).expect(201);
    const stayA = await checkIn(a.body.id),
      stayB = await checkIn(b.body.id);
    const board = (await get('/rooms').expect(200)).body;
    expect(board.map((r: any) => r.currentReservation.id)).toEqual([a.body.id, b.body.id]);
    await settle(stayA);
    const after = (await get('/rooms').expect(200)).body;
    expect(after[0].housekeeping).toBe('dirty');
    expect(after[1].currentReservation.id).toBe(b.body.id);
    expect(after[1].housekeeping).toBe('clean');
    await sql(`UPDATE rooms SET housekeeping_status='clean' WHERE id=$1`,[rooms[0].id]);
    await vpost(`/stays/${stayB}/shift-room`,{toRoomId:rooms[0].id,rateDecision:'keep_rate',reason:'Guest requested another room'}).expect(200);
    expect((await get('/rooms').expect(200)).body[0].currentReservation.id).toBe(b.body.id);
    await settle(stayB);
  });
  it('keeps a room unavailable on later days while its booked arrival is still pending', async () => {
    await sql(`UPDATE rooms SET housekeeping_status='clean' WHERE property_id=$1`,[villaId]);
    const rooms=(await get('/rooms').expect(200)).body;
    const a=await create({...slot(addDays(today,30),'one_bedroom'),roomId:rooms[0].id,guestCount:1,endsAt:`${addDays(today,32)}T11:00:00+05:30`}).expect(201);
    const board=(await get('/rooms').query({date:addDays(today,31)}).expect(200)).body;
    expect(board[0].currentReservation.id).toBe(a.body.id);
    expect(board[0].displayState).toBe('arriving');
    expect(board[0].sellable).toBe(false);
  });
  it('restore integrity accepts independent room bookings while still checking shared resources', async () => {
    const findings=await sql<{check_name:string}>(readFileSync(resolve(process.cwd(),'../../ops/backup/integrity.sql'),'utf8'));
    expect(findings.filter(f=>f.check_name==='overlapping_private_villa')).toEqual([]);
  });
  it('refuses availability and arrival when a required physical bedroom is inactive', async()=>{
    await sql(`UPDATE rooms SET housekeeping_status='clean' WHERE property_id=$1`,[villaId]);
    const input={...slot(today),startsAt:new Date(Date.now()-120000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()};
    const b=await create(input).expect(201);
    let availability:any,arrival:any;
    try {
      await sql(`UPDATE rooms SET is_active=false WHERE property_id=$1 AND number='2'`,[villaId]);
      availability=await get('/villa/availability').query({startsAt:`${addDays(today,50)}T10:00:00+05:30`,endsAt:`${addDays(today,50)}T11:00:00+05:30`});
      arrival=await action(b.body.id,'arrive',b.body.version);
    } finally {await sql(`UPDATE rooms SET is_active=true WHERE property_id=$1 AND number='2'`,[villaId]);}
    expect(availability.body.available).toBe(false);
    expect(arrival.status).toBe(409);
    await action(b.body.id,'cancel',b.body.version).expect(200);
  });
  it('blocks cross-property guest, booking, stay, bill, payment, invoice and document access', async () => {
    const cases: [string,string[]][] = [
      ['reservations',['/reservations/{id}','/reservations/{id}/ota']],
      ['guests',['/guests/{id}']],
      ['stays',['/stays/{id}','/stays/{id}/bill','/stays/{id}/checkout-preview','/stays/{id}/grc']],
      ['check_in_drafts',['/check-in-drafts/{id}']],
      ['folios',['/folios/{id}','/folios/{id}/invoices']],
      ['payments',['/payments/{id}/receipt.pdf']],
      ['invoices',['/invoices/{id}','/invoices/{id}/pdf']],
      ['guest_documents',['/documents/{id}/view-url','/documents/{id}/download']],
    ];
    for(const [table,paths] of cases) {
      // Table names are a fixed allowlist above; values remain parameterised.
      const [row]=await sql<{id:string}>(`SELECT id FROM ${table} WHERE property_id=$1 LIMIT 1`,[villaId]);
      expect(row,table).toBeTruthy();
      for(const path of paths) {
        const response=await owner.get('/api/v1'+path.replace('{id}',row!.id));
        if(path.endsWith('/ota')) {
          expect(response.status).toBe(200);
          expect(['','null']).toContain(response.text);
        } else if(path.endsWith('/grc')) {
          expect(response.status).toBe(200);
          expect(response.body).toEqual({stayId:row!.id,current:null,versions:[]});
        } else if(path.endsWith('/invoices')) {
          expect(response.status).toBe(200);
          expect(response.body).toEqual([]);
        } else expect([403,404],path).toContain(response.status);
      }
    }
  });
  it.each(['/rooms','/guests','/reservations','/stays','/housekeeping/board','/maintenance/tickets',
    '/night-audit','/payment-accounts','/expenses','/messages','/invoices','/owner-review','/users',
    '/exports/all.xlsx','/email-settings','/whatsapp-settings','/villa/bookings'])
    ('rejects a hotel receptionist changing resort context for %s', async(path)=>{
      await desk.get('/api/v1'+path).set('x-resortos-property',villaId).expect(403);
      await desk.get('/api/v1'+path+'?propertyContext='+villaId).expect(403);
    });
  it('leaves every existing hotel room, price, booking, guest, document and money row unchanged', async () => {
    expect(await sourceSnapshot()).toBe(hotelSnapshot);
  });
});
