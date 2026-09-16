import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenHash } from '../src/auth/tokens';
import { applySteps, collectBlockers, type CheckoutStep } from '../src/stays/checkout-pipeline';
import { booking, bootApp, fixtures, key, login, post, sql, type Agent } from './helpers';

/** Milestone 1.8: check-in drafts, phone scanner, document verification, room shift, checkout. Real PostgreSQL + real storage. */
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

const jpeg = (n = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(n)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const phone = () => request(app.getHttpServer());

/** Uploads straight to S3 (MinIO) with the pre-signed URL, exactly as a browser or phone does. */
async function putFile(grant: { url: string; headers: Record<string, string> }, bytes: Buffer, headers: Record<string, string> = {}) {
  const res = await fetch(grant.url, { method: 'PUT', headers: { ...grant.headers, ...headers }, body: bytes });
  return { status: res.status, code: (await res.text()).match(/<Code>(\w+)<\/Code>/)?.[1] };
}

async function deskDocument(draftId: string, docType: string, extra: Record<string, unknown> = {}, bytes = jpeg()) {
  const res = await post(desk, `/check-in-drafts/${draftId}/documents`, {
    source: docType === 'signature' ? 'signature_pad' : 'desk_camera', docType, contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes), ...extra,
  }, null).expect(201);
  expect((await putFile(res.body.upload, bytes)).status).toBe(200);
  const confirmed = await post(desk, `/check-in-drafts/${draftId}/documents/${res.body.documentId}/confirm`, {}, null).expect(200);
  return confirmed.body;
}

let draft: any;
let token: string;
let deviceSecret: string;
let reservationId: string;

describe('check-in draft', () => {
  it('starts from a booking with occupants prefilled and survives a refresh', async () => {
    const created = await post(owner, '/reservations', { ...booking({ roomTypeId: f.type('DLX'), roomId: f.room('205'), arrival: '2026-09-16', departure: '2026-09-18' }), guest: { firstName: 'Meera', lastName: 'Joshi', mobile: '9829055555' } }).expect(201);
    reservationId = created.body.id;
    const started = await post(desk, '/check-in-drafts', { reservationId }, null).expect(200);
    expect(started.body.data.rooms[0].occupants.map((o: any) => [o.fullName, o.isPrimary])).toEqual([['Meera Joshi', true], ['', false]]);

    const again = await post(desk, '/check-in-drafts', { reservationId }, null).expect(200);
    expect(again.body.id).toBe(started.body.id); // resumes, never duplicates

    const data = structuredClone(started.body.data);
    data.rooms[0].occupants[0] = { ...data.rooms[0].occupants[0], idType: 'driving_licence', idLast4: '4321' };
    data.rooms[0].occupants[1] = { ...data.rooms[0].occupants[1], fullName: 'Arjun Joshi', idType: 'passport', idLast4: 'Z9K1' };
    data.rooms[0].vehicles = [{ registration: 'RJ 27 CB 1234', vehicleType: 'car' }];
    const saved = await desk.patch(`/api/v1/check-in-drafts/${started.body.id}`).set('x-resortos', '1').send({ version: started.body.version, step: 4, data }).expect(200);
    const stale = await desk.patch(`/api/v1/check-in-drafts/${started.body.id}`).set('x-resortos', '1').send({ version: started.body.version, step: 4, data });
    expect(stale.body.code).toBe('STALE_VERSION');

    const reloaded = await desk.get(`/api/v1/check-in-drafts/${started.body.id}`).expect(200);
    expect(reloaded.body.step).toBe(4);
    expect(reloaded.body.data.rooms[0].occupants[1].fullName).toBe('Arjun Joshi');
    draft = saved.body;
  });

  it('refuses full ID numbers', async () => {
    const data = structuredClone(draft.data);
    data.rooms[0].occupants[0].idLast4 = '123456789012';
    const res = await desk.patch(`/api/v1/check-in-drafts/${draft.id}`).set('x-resortos', '1').send({ version: draft.version, step: 4, data });
    expect(res.status).toBe(400);
  });
});

describe('phone as scanner (spec §19.2)', () => {
  it('QR token opens once, for one phone only, and reveals no guest details', async () => {
    const session = await post(desk, `/check-in-drafts/${draft.id}/capture-sessions`, {}, null).expect(201);
    token = session.body.token;
    expect(session.body.captureUrl).toMatch(new RegExp(`/capture/${token}$`));
    expect(new Date(session.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 1000);

    const claim = await phone().post(`/api/v1/capture/${token}/claim`).set('x-resortos', '1').expect(200);
    deviceSecret = claim.body.deviceSecret;
    const text = JSON.stringify(claim.body);
    for (const secret of ['Meera', 'Joshi', '9829055555', '205', 'BK-']) expect(text).not.toContain(secret);
    expect(claim.body.occupants.map((o: any) => o.label)).toEqual(['Guest 1', 'Guest 2']);

    const secondPhone = await phone().post(`/api/v1/capture/${token}/claim`).set('x-resortos', '1');
    expect(secondPhone.status).toBe(409);
  });

  it('the phone can only upload, and only with its device secret', async () => {
    const body = { docType: 'id_front', idType: 'driving_licence', occupantKey: 'r0a0', contentType: 'image/jpeg', sizeBytes: 100, sha256: 'a'.repeat(64) };
    expect((await phone().post(`/api/v1/capture/${token}/uploads`).set('x-resortos', '1').send(body)).status).toBe(403);
    expect((await phone().post(`/api/v1/capture/${token}/uploads`).set('x-resortos', '1').set('x-capture-device', 'x'.repeat(43)).send(body)).status).toBe(403);
    // No staff endpoint accepts the capture token or device secret
    expect((await phone().get(`/api/v1/check-in-drafts/${draft.id}`).set('x-capture-device', deviceSecret)).status).toBe(401);
    expect((await phone().get(`/api/v1/reservations/${reservationId}`).set('x-capture-device', deviceSecret)).status).toBe(401);
  });

  it('a document counts as received only after the server verifies size and SHA-256', async () => {
    const bytes = jpeg(4096);
    const req = await phone().post(`/api/v1/capture/${token}/uploads`).set('x-resortos', '1').set('x-capture-device', deviceSecret)
      .send({ docType: 'id_front', idType: 'driving_licence', occupantKey: 'r0a0', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) }).expect(201);

    const early = await phone().post(`/api/v1/capture/${token}/uploads/${req.body.documentId}/confirm`).set('x-resortos', '1').set('x-capture-device', deviceSecret);
    expect(early.status).toBe(409);
    expect(early.body.details.retryable).toBe(true);

    const pending = await desk.get(`/api/v1/check-in-drafts/${draft.id}`).expect(200);
    expect(pending.body.problems.map((p: any) => p.message)).toContain("Meera Joshi's ID (front) is still uploading");

    // The signature binds type, size and checksum; storage enforces them.
    expect(await putFile(req.body.upload, bytes, { 'content-type': 'image/png' })).toMatchObject({ status: 403, code: 'SignatureDoesNotMatch' });
    expect(await putFile(req.body.upload, Buffer.concat([bytes, Buffer.from('extra')]))).toMatchObject({ status: 403 });
    expect((await putFile({ ...req.body.upload, url: req.body.upload.url.replace(/X-Amz-Signature=\w+/, 'X-Amz-Signature=' + '0'.repeat(64)) }, bytes)).status).toBe(403);

    expect((await putFile(req.body.upload, bytes)).status).toBe(200);
    expect(await putFile(req.body.upload, bytes)).toMatchObject({ status: 412, code: 'PreconditionFailed' }); // write-once

    const ok = await phone().post(`/api/v1/capture/${token}/uploads/${req.body.documentId}/confirm`).set('x-resortos', '1').set('x-capture-device', deviceSecret).expect(200);
    expect(ok.body.status).toBe('verified');
    const [session] = await sql(`SELECT files_received FROM capture_sessions WHERE token_hash = $1`, [tokenHash(token)]);
    expect(session.files_received).toBe(1);
  });

  it('bytes that do not match the declared checksum are refused by storage and never count as received', async () => {
    const declared = jpeg(1000);
    const actual = Buffer.from(declared);
    actual[500] = actual[500]! ^ 0xff; // one flipped byte, same size
    const req = await phone().post(`/api/v1/capture/${token}/uploads`).set('x-resortos', '1').set('x-capture-device', deviceSecret)
      .send({ docType: 'id_back', idType: 'driving_licence', occupantKey: 'r0a0', contentType: 'image/jpeg', sizeBytes: declared.length, sha256: sha(declared) }).expect(201);
    expect(await putFile(req.body.upload, actual)).toMatchObject({ status: 400, code: 'XAmzContentChecksumMismatch' });
    const res = await phone().post(`/api/v1/capture/${token}/uploads/${req.body.documentId}/confirm`).set('x-resortos', '1').set('x-capture-device', deviceSecret);
    expect(res.status).toBe(409);
    const [doc] = await sql(`SELECT status FROM guest_documents WHERE id = $1`, [req.body.documentId]);
    expect(doc.status).toBe('pending');
  });

  it('Aadhaar images must be masked on the device (API and database)', async () => {
    const res = await phone().post(`/api/v1/capture/${token}/uploads`).set('x-resortos', '1').set('x-capture-device', deviceSecret)
      .send({ docType: 'id_front', idType: 'aadhaar', occupantKey: 'r0a1', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'b'.repeat(64) });
    expect(res.status).toBe(400);
    await expect(sql(
      `INSERT INTO guest_documents (property_id, draft_id, doc_type, id_type, masked_on_device, storage_key, content_type, size_bytes, sha256, source)
       SELECT property_id, id, 'id_front', 'aadhaar', false, 'k-' || gen_random_uuid(), 'image/jpeg', 10, decode(repeat('ab', 32), 'hex'), 'phone_scanner' FROM check_in_drafts WHERE id = $1`,
      [draft.id],
    )).rejects.toThrow(/check constraint/);
  });

  it('expired and closed sessions refuse the phone', async () => {
    const expiredToken = randomBytes(32).toString('base64url');
    await sql(
      `INSERT INTO capture_sessions (property_id, draft_id, token_hash, created_by, created_at, expires_at)
       SELECT property_id, id, $2, created_by, now() - interval '11 minutes', now() - interval '1 minute' FROM check_in_drafts WHERE id = $1`,
      [draft.id, tokenHash(expiredToken)],
    );
    const expired = await phone().post(`/api/v1/capture/${expiredToken}/claim`).set('x-resortos', '1');
    expect(expired.status).toBe(403);
    expect(expired.body.message).toMatch(/expired/);
    await expect(sql(`UPDATE capture_sessions SET expires_at = now() + interval '1 hour' WHERE token_hash = $1`, [tokenHash(expiredToken)])).rejects.toThrow(/immutable/);

    const [s] = await sql(`SELECT id FROM capture_sessions WHERE token_hash = $1`, [tokenHash(token)]);
    await post(desk, `/capture-sessions/${s.id}/close`, {}, null).expect(200);
    const afterClose = await phone().post(`/api/v1/capture/${token}/uploads`).set('x-resortos', '1').set('x-capture-device', deviceSecret)
      .send({ docType: 'guest_photo', occupantKey: 'r0a0', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'c'.repeat(64) });
    expect(afterClose.status).toBe(403);
  });
});

describe('confirm check-in (spec §18.3, §19.6)', () => {
  it('lists exactly what is still missing', async () => {
    const res = await post(desk, `/check-in-drafts/${draft.id}/confirm`, {});
    expect(res.status).toBe(400);
    const messages = res.body.details.problems.map((p: any) => p.message);
    expect(messages).toEqual(expect.arrayContaining([
      "Meera Joshi's ID (back) is still uploading",
      "Arjun Joshi's ID (front) is missing",
      'guest photo of Meera Joshi is missing',
      'Guest signature is missing',
      'The guest must accept the stay and legal-compliance notice',
    ]));
  });

  it('confirms once all documents are verified; a double click does not check in twice', async () => {
    await deskDocument(draft.id, 'id_back', { idType: 'driving_licence', occupantKey: 'r0a0' });
    await deskDocument(draft.id, 'id_front', { idType: 'passport', occupantKey: 'r0a1' });
    await deskDocument(draft.id, 'guest_photo', { occupantKey: 'r0a0' });
    await deskDocument(draft.id, 'signature');
    const current = await desk.get(`/api/v1/check-in-drafts/${draft.id}`).expect(200);
    const data = { ...current.body.data, consents: { stayAndCompliance: true, marketing: false } };
    await desk.patch(`/api/v1/check-in-drafts/${draft.id}`).set('x-resortos', '1').send({ version: current.body.version, step: 7, data }).expect(200);

    const k = key();
    const [a, b] = await Promise.all([post(desk, `/check-in-drafts/${draft.id}/confirm`, {}, k), post(desk, `/check-in-drafts/${draft.id}/confirm`, {}, k)]);
    const ok = [a, b].filter((r) => r.status === 200);
    if (ok.length === 0) console.log('CONFIRM FAILED', JSON.stringify([a.body, b.body]));
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const [count] = await sql(`SELECT count(*)::int AS n FROM stays WHERE reservation_id = $1`, [reservationId]);
    expect(count.n).toBe(1);
    const again = await post(desk, `/check-in-drafts/${draft.id}/confirm`, {});
    expect(again.body.code).toBe('INVALID_TRANSITION');

    const reservation = await desk.get(`/api/v1/reservations/${reservationId}`).expect(200);
    expect(reservation.body.status).toBe('checked_in');
    const rooms = await desk.get('/api/v1/rooms').expect(200);
    expect(rooms.body.find((r: any) => r.number === '205').occupancy).toBe('occupied');
    const [session] = await sql(`SELECT closed_reason FROM capture_sessions WHERE draft_id = $1 ORDER BY created_at DESC LIMIT 1`, [draft.id]);
    expect(['confirmed', 'done']).toContain(session.closed_reason);

    const stay = await desk.get(`/api/v1/stays/${ok[0]!.body.stays[0].id}`).expect(200);
    expect(stay.body.occupants.map((o: any) => o.idLast4)).toEqual(['4321', 'Z9K1']);
    expect(stay.body.vehicles[0].registration).toBe('RJ27CB1234');
    expect(stay.body.documents.filter((d: any) => d.status === 'verified').length).toBe(5);
    draft.stayId = stay.body.id;
  });

  it('document images open only through a short-lived signed link, and every view is logged', async () => {
    const stay = await desk.get(`/api/v1/stays/${draft.stayId}`).expect(200);
    const doc = stay.body.documents.find((d: any) => d.docType === 'guest_photo');
    const link = await desk.get(`/api/v1/documents/${doc.id}/view-url`).expect(200);
    expect(new Date(link.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(61_000);
    const file = await fetch(link.body.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    expect((await fetch(link.body.url.replace(/X-Amz-Signature=\w+/, 'X-Amz-Signature=' + 'f'.repeat(64)))).status).toBe(403);
    expect((await fetch(link.body.url.replace(/X-Amz-Expires=\d+/, 'X-Amz-Expires=86400'))).status).toBe(403);
    const [log] = await sql(`SELECT count(*)::int AS n FROM document_access_log WHERE document_id = $1`, [doc.id]);
    expect(log.n).toBe(1);
  });
});

describe('room shift (spec §21)', () => {
  it('refuses an occupied room and moves the guest to a free one', async () => {
    const busy = await post(desk, `/stays/${draft.stayId}/shift-room`, { toRoomId: f.room('204'), reason: 'AC not working' });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('ROOM_UNAVAILABLE');

    const moved = await post(desk, `/stays/${draft.stayId}/shift-room`, { toRoomId: f.room('203'), reason: 'AC not working' }).expect(200);
    expect(moved.body.roomNumber).toBe('203');
    expect(moved.body.shifts[0]).toMatchObject({ from: '205', to: '203', reason: 'AC not working', rateDecision: 'keep_rate' });
    const rooms = await desk.get('/api/v1/rooms').expect(200);
    expect(rooms.body.find((r: any) => r.number === '205').housekeeping).toBe('dirty');
    expect(rooms.body.find((r: any) => r.number === '203').occupancy).toBe('occupied');
  });
});

describe('checkout (status change with extension points, spec §22)', () => {
  it('runs step checks in order and applies steps before closing the stay', async () => {
    const calls: string[] = [];
    const steps: CheckoutStep[] = [
      { name: 'invoice-finalize', order: 30, check: async () => { calls.push('check:invoice'); return []; }, apply: async () => { calls.push('apply:invoice'); } },
      { name: 'settlement', order: 20, check: async () => { calls.push('check:settlement'); return [{ step: 'settlement', message: 'Balance ₹500 is due' }]; } },
    ];
    const ctx = {} as never;
    expect(await collectBlockers(steps, ctx)).toEqual([{ step: 'settlement', message: 'Balance ₹500 is due' }]);
    expect(await applySteps(steps, ctx)).toEqual(['invoice-finalize']);
    expect(calls).toEqual(['check:settlement', 'check:invoice', 'apply:invoice']);
  });

  it('checks the guest out, frees and dirties the room, and cannot run twice', async () => {
    const preview = await desk.get(`/api/v1/stays/${draft.stayId}/checkout-preview`).expect(200);
    expect(preview.body).toMatchObject({ blockers: [], earlyDeparture: true, steps: [] });

    const out = await post(desk, `/stays/${draft.stayId}/checkout`, {}).expect(200);
    expect(out.body).toMatchObject({ status: 'checked_out', earlyDeparture: true, businessDateOut: '2026-09-16' });
    const rooms = await desk.get('/api/v1/rooms').expect(200);
    const r203 = rooms.body.find((r: any) => r.number === '203');
    expect([r203.occupancy, r203.housekeeping]).toEqual(['vacant', 'dirty']);
    const reservation = await desk.get(`/api/v1/reservations/${reservationId}`).expect(200);
    expect(reservation.body.status).toBe('checked_out');

    expect((await post(desk, `/stays/${draft.stayId}/checkout`, {})).body.code).toBe('INVALID_TRANSITION');
    await expect(sql(`UPDATE stays SET status = 'in_house', checked_out_at = NULL WHERE id = $1`, [draft.stayId])).rejects.toThrow(/cannot change/);
  });
});

describe('resuming uploads', () => {
  it('phone status shows only its own documents; a fresh upload link for the same pending document can be issued', async () => {
    const created = await post(owner, '/reservations', { ...booking({ roomTypeId: f.type('PCOT'), roomId: f.room('C3'), arrival: '2026-09-16', departure: '2026-09-17' }), guest: { firstName: 'Resume', lastName: 'Test', mobile: '9829066601' } }).expect(201);
    const d = await post(desk, '/check-in-drafts', { reservationId: created.body.id }, null).expect(200);
    expect(d.body.reservation).toMatchObject({ number: created.body.number, guestName: 'Resume Test', rooms: [{ roomNumber: 'C3', adults: 2 }] });
    const session = await post(desk, `/check-in-drafts/${d.body.id}/capture-sessions`, {}, null).expect(201);
    const claim = await phone().post(`/api/v1/capture/${session.body.token}/claim`).set('x-resortos', '1').expect(200);
    const dev = claim.body.deviceSecret;
    const bytes = jpeg(500);
    const req = await phone().post(`/api/v1/capture/${session.body.token}/uploads`).set('x-resortos', '1').set('x-capture-device', dev)
      .send({ docType: 'guest_photo', occupantKey: 'r0a0', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) }).expect(201);

    const status = await phone().post(`/api/v1/capture/${session.body.token}/status`).set('x-resortos', '1').set('x-capture-device', dev).expect(200);
    expect(status.body.documents).toEqual([{ id: req.body.documentId, docType: 'guest_photo', occupantKey: 'r0a0', status: 'pending', failureReason: null }]);
    expect(JSON.stringify(status.body)).not.toContain('Resume');

    const fresh = await phone().post(`/api/v1/capture/${session.body.token}/uploads/${req.body.documentId}/grant`).set('x-resortos', '1').set('x-capture-device', dev).expect(200);
    expect(fresh.body.documentId).toBe(req.body.documentId);
    expect((await putFile(fresh.body.upload, bytes)).status).toBe(200);
    await phone().post(`/api/v1/capture/${session.body.token}/uploads/${req.body.documentId}/confirm`).set('x-resortos', '1').set('x-capture-device', dev).expect(200);
    const done = await phone().post(`/api/v1/capture/${session.body.token}/uploads/${req.body.documentId}/grant`).set('x-resortos', '1').set('x-capture-device', dev);
    expect(done.body.code).toBe('INVALID_TRANSITION');
  });
});

describe('idempotent document creation', () => {
  it('retrying with the same client upload id returns the same document; a different photo under that id is refused', async () => {
    const created = await post(owner, '/reservations', { ...booking({ roomTypeId: f.type('PCOT'), roomId: f.room('C2'), arrival: '2026-09-16', departure: '2026-09-17' }), guest: { firstName: 'Retry', lastName: 'Test', mobile: '9829066602' } }).expect(201);
    const d = await post(desk, '/check-in-drafts', { reservationId: created.body.id }, null).expect(200);
    const bytes = jpeg(300);
    const body = { source: 'desk_camera', clientUploadId: '0b8f2a7c-7c1e-4a5b-9d51-6c0e1f2a3b4c', docType: 'guest_photo', occupantKey: 'r0a0', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha(bytes) };
    const first = await post(desk, `/check-in-drafts/${d.body.id}/documents`, body, null).expect(201);
    const retry = await post(desk, `/check-in-drafts/${d.body.id}/documents`, body, null).expect(201);
    expect(retry.body.documentId).toBe(first.body.documentId);
    const [n] = await sql(`SELECT count(*)::int AS n FROM guest_documents WHERE draft_id = $1`, [d.body.id]);
    expect(n.n).toBe(1);
    const other = jpeg(300);
    const clash = await post(desk, `/check-in-drafts/${d.body.id}/documents`, { ...body, sizeBytes: other.length, sha256: sha(other) }, null);
    expect(clash.body.code).toBe('IDEMPOTENCY_MISMATCH');
  });
});
