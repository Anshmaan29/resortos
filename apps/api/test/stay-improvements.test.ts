import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootAppOnOwnDatabase, booking, fixtures, key, login, post, type Agent } from './helpers';

let app: INestApplication;
let owner: Agent;
let desk: Agent;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let f: Awaited<ReturnType<typeof fixtures>>;
let guestId: string;
let firstDocumentId: string;
let firstStayId: string;
let returningDraftId: string;
let returningStayId: string;
let reservationId: string;
const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500, 1)]);
const checksum = createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  ({ app, sql } = await bootAppOnOwnDatabase('stay_improvements', '2026-09-16'));
  owner = await login(app, 'owner'); desk = await login(app, 'receptionist'); f = await fixtures(sql);
});
afterAll(async () => { await app.close(); });

async function upload(draftId: string) {
  const grant = await post(desk, `/check-in-drafts/${draftId}/documents`, {
    source: 'file_upload', docType: 'id_front', idType: 'passport', occupantKey: 'r0a0',
    contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: checksum,
  }, null).expect(201);
  expect((await fetch(grant.body.upload.url, { method: 'PUT', headers: grant.body.upload.headers, body: bytes })).status).toBe(200);
  await post(desk, `/check-in-drafts/${draftId}/documents/${grant.body.documentId}/confirm`, {}, null).expect(200);
  return grant.body.documentId as string;
}

describe('optional photo and returning guest registration', () => {
  it('checks in with an ID only, without a photograph or signature', async () => {
    const b = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('DLX'), roomId: f.room('205'), adults: 1, arrival: '2026-09-16', departure: '2026-09-17' }),
      guest: { firstName: 'Returning', lastName: 'Visitor', mobile: '9829066611', city: 'Kota', email: 'guest@example.test' },
    }).expect(201);
    guestId = b.body.guest.id;
    const d = (await post(desk, '/check-in-drafts', { reservationId: b.body.id }, null).expect(200)).body;
    expect(d.policy.requireGuestPhoto).toBe(false);
    const data = structuredClone(d.data);
    Object.assign(data.rooms[0].occupants[0], { idType: 'passport', idLast4: 'AB12' });
    data.consents.stayAndCompliance = true;
    await desk.patch(`/api/v1/check-in-drafts/${d.id}`).set('x-resortos', '1').send({ version: d.version, step: 5, data }).expect(200);
    firstDocumentId = await upload(d.id);
    const ready = (await desk.get(`/api/v1/check-in-drafts/${d.id}`).expect(200)).body;
    expect(ready.problems).toEqual([]);
    const confirmed = await post(desk, `/check-in-drafts/${d.id}/confirm`, {}).expect(200);
    firstStayId = confirmed.body.stays[0].id;
    await post(owner, `/stays/${firstStayId}/checkout`, { steps: { settlement: { pendingBalance: true } } }).expect(200);
    await desk.get(`/api/v1/documents/${firstDocumentId}/view-url`).expect(403);
  });

  it('prefills identity and privately reuses the ID, without altering old stay documents or copying consent', async () => {
    const b = await post(owner, '/reservations', {
      guestId, source: 'walk_in', arrival: '2026-09-16', departure: '2026-09-17',
      rooms: [{ roomTypeId: f.type('DLX'), roomId: f.room('203'), adults: 1, mealPlan: 'MAP', nightlyRate: '2500', includesMealPlan: true, gstRate: '0' }],
    }).expect(201);
    reservationId = b.body.id;
    const d = (await post(desk, '/check-in-drafts', { reservationId }, null).expect(200)).body;
    returningDraftId = d.id;
    expect(d.data.rooms[0].occupants[0]).toMatchObject({ fullName: 'Returning Visitor', idType: 'passport', idLast4: 'AB12' });
    expect(d.data.consents.stayAndCompliance).toBe(false);
    expect(d.documents).toHaveLength(1);
    expect(d.documents[0]).toMatchObject({ source: 'saved_guest_id', status: 'verified', docType: 'id_front' });
    expect(d.documents[0].id).not.toBe(firstDocumentId);
    const [original] = await sql('SELECT * FROM guest_documents WHERE id=$1', [firstDocumentId]);
    const [copied] = await sql('SELECT * FROM guest_documents WHERE id=$1', [d.documents[0].id]);
    expect(original.stay_id).toBe(firstStayId);
    expect(copied.storage_key).not.toBe(original.storage_key);
    expect(copied.reused_from_document_id).toBe(firstDocumentId);
    expect(copied.sha256.equals(original.sha256)).toBe(true);
    await desk.get(`/api/v1/documents/${d.documents[0].id}/view-url`).expect(200);
    await desk.get(`/api/v1/documents/${firstDocumentId}/view-url`).expect(403);
    const again = (await post(desk, '/check-in-drafts', { reservationId }, null).expect(200)).body;
    expect(again.documents.map((doc: any) => doc.id)).toEqual(d.documents.map((doc: any) => doc.id));
  });

  it('requires a new ID if the saved identity is edited to another person', async () => {
    const d = (await desk.get(`/api/v1/check-in-drafts/${returningDraftId}`).expect(200)).body;
    d.data.rooms[0].occupants[0].fullName = 'Someone Else';
    const changed = (await desk.patch(`/api/v1/check-in-drafts/${d.id}`).set('x-resortos', '1').send({ version: d.version, step: 5, data: d.data }).expect(200)).body;
    expect(changed.problems.some((p: any) => p.path.endsWith('.id_front'))).toBe(true);
    changed.data.rooms[0].occupants[0].fullName = 'Returning Visitor';
    changed.data.consents.stayAndCompliance = true;
    await desk.patch(`/api/v1/check-in-drafts/${d.id}`).set('x-resortos', '1').send({ version: changed.version, step: 5, data: changed.data }).expect(200);
    returningStayId = (await post(desk, `/check-in-drafts/${d.id}/confirm`, {}).expect(200)).body.stays[0].id;
  });

  it('does not reuse another guest’s ID just because the phone/name is the same', async () => {
    const b = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('DLX'), adults: 1, arrival: '2026-09-16', departure: '2026-09-17' }),
      guest: { firstName: 'Returning', lastName: 'Visitor', mobile: '9829066611' },
    }).expect(201);
    expect(b.body.guest.id).not.toBe(guestId);
    const d = (await post(desk, '/check-in-drafts', { reservationId: b.body.id }, null).expect(200)).body;
    expect(d.documents).toHaveLength(0);
    expect(d.data.rooms[0].occupants[0].idType).toBe('none');
  });
});

describe('agreed extension totals and payment safety', () => {
  it('stores an exact combined total across extra nights, preserves old prices and records payment once', async () => {
    const before = await sql('SELECT n.* FROM reservation_room_nights n JOIN stays s ON s.reservation_room_id=n.reservation_room_id WHERE s.id=$1 ORDER BY n.night_date', [returningStayId]);
    const [account] = await sql("SELECT id FROM payment_accounts WHERE property_id=(SELECT property_id FROM users WHERE id=$1) AND kind='bank' AND is_active LIMIT 1", [f.ownerId]);
    const payload = { newDeparture: '2026-09-20', expectedDeparture: '2026-09-17', totalRoomAmount: '10000.00',
      payment: { method: 'bank_transfer', amount: '10000', paymentAccountId: account.id, reference: 'EXTEND-QA' } };
    const idempotency = key();
    const extended = await post(desk, `/stays/${returningStayId}/extend`, payload, idempotency).expect(200);
    expect(extended.body.expectedDeparture).toBe('2026-09-20');
    await post(desk, `/stays/${returningStayId}/extend`, payload, idempotency).expect(200);
    const nights = await sql('SELECT n.* FROM reservation_room_nights n JOIN stays s ON s.reservation_room_id=n.reservation_room_id WHERE s.id=$1 ORDER BY n.night_date', [returningStayId]);
    expect(nights[0]).toMatchObject({ room_rate: before[0].room_rate, extra_person_amount: before[0].extra_person_amount, meal_amount: before[0].meal_amount });
    expect(nights.slice(1).map(n => n.room_rate)).toEqual(['3333.34','3333.33','3333.33']);
    expect(nights.slice(1).every(n => n.extra_person_amount === '0.00' && n.meal_amount === '0.00')).toBe(true);
    const payments = await sql("SELECT amount FROM payments WHERE reservation_id=$1 AND reference='EXTEND-QA'", [reservationId]);
    expect(payments).toEqual([{ amount: '10000.00' }]);
    const r = (await desk.get(`/api/v1/reservations/${reservationId}`).expect(200)).body;
    expect(r.departure).toBe('2026-09-20');
    expect(r.estimate.grandTotal).toBe('12500.00');
  });

  it('rolls back the extension if recording the payment fails', async () => {
    const before = await sql('SELECT count(*)::int AS n FROM reservation_room_nights WHERE reservation_room_id=(SELECT reservation_room_id FROM stays WHERE id=$1)', [returningStayId]);
    const failed = await post(desk, `/stays/${returningStayId}/extend`, {
      newDeparture: '2026-09-21', totalRoomAmount: '3000',
      payment: { method: 'bank_transfer', amount: '3000', paymentAccountId: randomUUID(), reference: 'INVALID-ACCOUNT' },
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect((await desk.get(`/api/v1/stays/${returningStayId}`).expect(200)).body.expectedDeparture).toBe('2026-09-20');
    const after = await sql('SELECT count(*)::int AS n FROM reservation_room_nights WHERE reservation_room_id=(SELECT reservation_room_id FROM stays WHERE id=$1)', [returningStayId]);
    expect(after).toEqual(before);
  });

  it('does not extend into scheduled maintenance on the occupied room', async () => {
    const [block] = await sql(`INSERT INTO room_out_of_order(property_id,room_id,start_date,end_date,reason,created_by)
      SELECT property_id,room_id,'2026-09-20','2026-09-22','Scheduled repair',$2 FROM stays WHERE id=$1 RETURNING id`, [returningStayId, f.ownerId]);
    const refused = await post(desk, `/stays/${returningStayId}/extend`, { newDeparture: '2026-09-21', totalRoomAmount: '3000' }).expect(409);
    expect(refused.body.message).toMatch(/maintenance/);
    expect((await desk.get(`/api/v1/stays/${returningStayId}`).expect(200)).body.expectedDeparture).toBe('2026-09-20');
    await sql("UPDATE room_out_of_order SET status='released',released_at=now(),released_by=$2 WHERE id=$1", [block.id, f.ownerId]);
  });

  it('refuses stale dates and a conflicting next booking without changing the current stay', async () => {
    await post(desk, `/stays/${returningStayId}/extend`, { newDeparture: '2026-09-21', expectedDeparture: '2026-09-17', totalRoomAmount: '3000' }).expect(409);
    await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('DLX'), roomId: f.room('203'), adults: 1, arrival: '2026-09-20', departure: '2026-09-22' }),
      guest: { firstName: 'Next', mobile: '9829066622' },
    }).expect(201);
    await post(desk, `/stays/${returningStayId}/extend`, { newDeparture: '2026-09-21', totalRoomAmount: '3000' }).expect(409);
    expect((await desk.get(`/api/v1/stays/${returningStayId}`).expect(200)).body.expectedDeparture).toBe('2026-09-20');
  });
});
