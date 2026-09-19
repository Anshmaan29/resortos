import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GRC_FONT_PATH, renderGrcPdf, type GrcPdfInput } from '../src/stays/grc-pdf';
import { StorageService } from '../src/storage/storage.service';
import { booking, bootApp, fixtures, key, login, post, sql, type Agent } from './helpers';

/** Milestone 1.8 step 3: guest registration card (spec §20) — reproducible PDF, verified checksum, versions. */
let app: INestApplication;
let desk: Agent;
let owner: Agent;
let f: Awaited<ReturnType<typeof fixtures>>;
/** This suite's own rooms: a check-in can only start on the business date, and the demo seed
 *  plus the other suites already occupy most rooms on that date. */
let roomTypeId: string;
const rooms: string[] = [];

beforeAll(async () => {
  app = await bootApp();
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  f = await fixtures();

  const type = await post(owner, '/room-types', {
    name: 'Registration Test Suite', code: 'GRCT', baseOccupancy: 2, maxOccupancy: 4,
    baseRate: '4000.00', minRate: '3200.00', extraAdultRate: '1000.00', extraChildRate: '600.00',
  }, null).expect(201);
  roomTypeId = type.body.id;
  for (const number of ['G1', 'G2', 'G3', 'G4']) {
    const room = await post(owner, '/rooms', { number, roomTypeId, unitType: 'room' }, null).expect(201);
    rooms.push(room.body.id);
  }
});
afterAll(async () => { await app.close(); });

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const phone = () => request(app.getHttpServer());

/**
 * A real PNG — pdfkit parses the image it embeds, so the random bytes the other suites use as
 * stand-in photos cannot stand in for a signature.
 */
function png(width = 240, height = 60): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(head));
    return Buffer.concat([len, head, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // 8-bit
  ihdr[9] = 0;    // greyscale
  // One filter byte per row, then a diagonal stroke so the image is not blank.
  const raw = Buffer.alloc(height * (width + 1), 0xff);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    const x = Math.floor((y / height) * width);
    raw[y * (width + 1) + 1 + x] = 0x10;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const jpeg = (n = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(n)]);

async function putFile(grant: { url: string; headers: Record<string, string> }, bytes: Buffer) {
  const res = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: bytes });
  expect(res.status).toBe(200);
}

/** Desk-side document upload: request a grant, PUT to storage, confirm so the server verifies it. */
async function deskDocument(draftId: string, docType: string, source: string, bytes: Buffer, contentType: string, extra: Record<string, unknown> = {}) {
  const res = await post(desk, `/check-in-drafts/${draftId}/documents`, {
    source, docType, contentType, sizeBytes: bytes.length, sha256: sha(bytes), ...extra,
  }, null).expect(201);
  await putFile(res.body.upload, bytes);
  return post(desk, `/check-in-drafts/${draftId}/documents/${res.body.documentId}/confirm`, {}, null).expect(200);
}

/** The same document, captured through a phone scanner session instead of the desk. */
async function phoneDocument(draftId: string, docType: string, bytes: Buffer, contentType: string) {
  const session = await post(desk, `/check-in-drafts/${draftId}/capture-sessions`, {}, null).expect(201);
  const claim = await phone().post(`/api/v1/capture/${session.body.token}/claim`).set('x-resortos', '1').expect(200);
  const secret = claim.body.deviceSecret;
  const req = await phone().post(`/api/v1/capture/${session.body.token}/uploads`).set('x-resortos', '1').set('x-capture-device', secret)
    .send({ docType, contentType, sizeBytes: bytes.length, sha256: sha(bytes) }).expect(201);
  await putFile(req.body.upload, bytes);
  await phone().post(`/api/v1/capture/${session.body.token}/uploads/${req.body.documentId}/confirm`)
    .set('x-resortos', '1').set('x-capture-device', secret).expect(200);
}

interface StayFixture { stayId: string; draftId: string; reservationId: string }

/** Books a room, checks in with every required document, and returns the stay. */
async function checkIn(options: { room: number; signature: 'touchscreen' | 'phone' | 'paper_scan'; guest?: { firstName: string; lastName: string; mobile: string } }): Promise<StayFixture> {
  const created = await post(owner, '/reservations', {
    ...booking({ roomTypeId, roomId: rooms[options.room], arrival: '2026-09-16', departure: '2026-09-18', adults: 2 }),
    ...(options.guest ? { guest: options.guest } : {}),
  }).expect(201);
  const reservationId = created.body.id;
  const started = await post(desk, '/check-in-drafts', { reservationId }, null).expect(200);
  const draftId = started.body.id;

  const data = structuredClone(started.body.data);
  data.rooms[0].occupants[0] = { ...data.rooms[0].occupants[0], idType: 'driving_licence', idLast4: '4321', nationality: 'IN' };
  data.rooms[0].occupants[1] = { ...data.rooms[0].occupants[1], fullName: 'Second Guest', idType: 'passport', idLast4: 'Z9K1', nationality: 'GB' };
  data.rooms[0].vehicles = [{ registration: 'RJ 14 CX 1234', vehicleType: 'car', parkingSlot: 'P3' }];
  data.consents = { stayAndCompliance: true, marketing: true };
  await desk.patch(`/api/v1/check-in-drafts/${draftId}`).set('x-resortos', '1').send({ version: started.body.version, step: 6, data }).expect(200);

  await deskDocument(draftId, 'id_back', 'desk_camera', jpeg(), 'image/jpeg', { idType: 'driving_licence', occupantKey: 'r0a0' });
  await deskDocument(draftId, 'id_front', 'desk_camera', jpeg(), 'image/jpeg', { idType: 'driving_licence', occupantKey: 'r0a0' });
  await deskDocument(draftId, 'id_front', 'desk_camera', jpeg(), 'image/jpeg', { idType: 'passport', occupantKey: 'r0a1' });
  await deskDocument(draftId, 'guest_photo', 'desk_camera', jpeg(), 'image/jpeg', { occupantKey: 'r0a0' });

  // The three ways a guest can sign (spec §20).
  if (options.signature === 'touchscreen') await deskDocument(draftId, 'signature', 'signature_pad', png(), 'image/png');
  else if (options.signature === 'phone') await phoneDocument(draftId, 'signature', png(), 'image/png');
  else await deskDocument(draftId, 'signature', 'file_upload', png(300, 80), 'image/png');

  const confirmed = await post(desk, `/check-in-drafts/${draftId}/confirm`, {}).expect(200);
  return { stayId: confirmed.body.stays[0].id, draftId, reservationId };
}

// ---------------------------------------------------------------------------

describe('registration card PDF (spec §20)', () => {
  const input: GrcPdfInput = {
    number: 'GRC-000042',
    version: 1,
    property: {
      name: 'Aravali Hills Resort', legalName: 'Aravali Hospitality Private Limited',
      addressLines: ['Village Road', 'Kumbhalgarh 313325'], gstin: '08AABCU9603R1ZM',
      phone: '+919829000000', email: 'stay@example.com', checkOutTime: '11:00:00', timezone: 'Asia/Kolkata',
    },
    stay: {
      reservationNumber: 'BK-000183', roomNumber: '204', roomTypeName: 'Deluxe', mealPlan: 'CP',
      nightlyRate: '4000.00', arrival: '2026-09-16', departure: '2026-09-18', nights: 2,
      checkedInAt: new Date('2026-09-16T08:30:00.000Z'),
    },
    guest: { name: 'Rahul Sharma', mobile: '+919849012345', addressLines: ['12 MG Road', 'Jaipur Rajasthan 302001', 'IN'] },
    occupants: [
      { fullName: 'Rahul Sharma', isChild: false, age: null, relation: null, nationality: 'IN', idType: 'driving_licence', idLast4: '4321' },
      { fullName: 'Anita Sharma', isChild: false, age: null, relation: 'Spouse', nationality: 'GB', idType: 'passport', idLast4: 'Z9K1' },
      { fullName: 'Ishan Sharma', isChild: true, age: 7, relation: 'Son', nationality: 'IN', idType: 'none', idLast4: null },
    ],
    vehicles: [{ registration: 'RJ14CX1234', vehicleType: 'car', parkingSlot: 'P3' }],
    consents: { stayAndCompliance: true, marketing: false },
    houseRules: { en: ['1. Checkout by 11:00 AM.'], hi: ['1. चेक-आउट सुबह 11:00 बजे तक।'] },
    notice: { version: '2026-09-a', en: 'We collect your details to provide your stay.', hi: 'हम आपके ठहरने के लिए विवरण एकत्र करते हैं।' },
    signature: {
      image: png(), contentType: 'image/png', method: 'touchscreen',
      signedAt: new Date('2026-09-16T08:29:00.000Z'), signedBy: 'Rahul Sharma',
    },
    generatedAt: new Date('2026-09-16T08:31:00.000Z'),
    generatedBy: 'Priya Receptionist',
  };

  it('renders the same bytes every time, so the recorded SHA-256 means something', async () => {
    const first = await renderGrcPdf(input);
    await new Promise((r) => setTimeout(r, 1100)); // a second boundary would break a clock-dependent render
    const second = await renderGrcPdf(structuredClone(input));

    expect(sha(first)).toBe(sha(second));
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('embeds the pinned font, so Hindi is real text and not missing glyphs', async () => {
    // The checksum is asserted here on purpose: swapping the font file changes every stored hash.
    expect(sha(readFileSync(GRC_FONT_PATH))).toBe('14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e');
    const pdf = await renderGrcPdf(input);
    const text = pdf.toString('latin1');
    expect(text).toContain('NotoSansDevanagari');
    expect(text).toContain('/FontFile2');   // the glyph programme travels with the file
    expect(text).toContain('/Subtype /Type0'); // composite font, so non-Latin text is real text
  });

  it('changes bytes when the card changes', async () => {
    const other = await renderGrcPdf({ ...input, version: 2, occupants: input.occupants.slice(0, 1) });
    expect(sha(other)).not.toBe(sha(await renderGrcPdf(input)));
  });

  it('refuses a signature image it cannot embed', async () => {
    await expect(renderGrcPdf({ ...input, signature: { ...input.signature, contentType: 'image/webp' } })).rejects.toThrow(/PNG or JPEG/);
  });
});

describe('generating and reprinting a card', () => {
  let stay: StayFixture;
  let cardId: string;

  it('is generated from a verified signature and stored bytes that the server re-read', async () => {
    stay = await checkIn({ room: 0, signature: 'touchscreen', guest: { firstName: 'Meera', lastName: 'Kapoor', mobile: '9829077771' } });

    const res = await post(desk, `/stays/${stay.stayId}/grc`, {}).expect(200);
    expect(res.body.created).toBe(true);
    expect(res.body.grc.number).toMatch(/^GRC-\d{6}$/);
    expect(res.body.grc.version).toBe(1);
    expect(res.body.grc.signatureMethod).toBe('touchscreen');
    expect(res.body.grc.noticeVersion).toBe('2026-09-a');
    cardId = res.body.grc.id;

    // The stored object really is the bytes whose hash was recorded.
    const [row] = await sql(`SELECT storage_key, sha256, size_bytes FROM grc_documents WHERE id = $1`, [cardId]);
    const stored = await app.get(StorageService).getObject(row.storage_key);
    expect(sha(stored)).toBe(row.sha256.toString('hex'));
    expect(stored.length).toBe(row.size_bytes);
    expect(res.body.grc.sha256).toBe(row.sha256.toString('hex'));
  });

  it('a reprint returns the stored card and never creates a version', async () => {
    const reprint = await post(desk, `/stays/${stay.stayId}/grc`, {}).expect(200);
    expect(reprint.body.created).toBe(false);
    expect(reprint.body.grc.id).toBe(cardId);

    const k = key();
    const [a, b] = await Promise.all([post(desk, `/stays/${stay.stayId}/grc`, {}, k), post(desk, `/stays/${stay.stayId}/grc`, {}, k)]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const [count] = await sql(`SELECT count(*)::int AS n FROM grc_documents WHERE stay_id = $1`, [stay.stayId]);
    expect(count.n).toBe(1);
    const versions = await desk.get(`/api/v1/stays/${stay.stayId}/grc`).expect(200);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.current.id).toBe(cardId);
  });

  it('opens only through a short-lived signed link, and every view is logged', async () => {
    const link = await desk.get(`/api/v1/grc-documents/${cardId}/view-url`).expect(200);
    expect(new Date(link.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(61_000);
    const file = await fetch(link.body.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect((await fetch(link.body.url.replace(/X-Amz-Signature=\w+/, 'X-Amz-Signature=' + 'f'.repeat(64)))).status).toBe(403);

    const [log] = await sql(`SELECT count(*)::int AS n FROM document_access_log WHERE grc_document_id = $1`, [cardId]);
    expect(log.n).toBe(1);
  });

  it('a new version is linked to the old one; neither the row nor the file is overwritten', async () => {
    const noReason = await post(desk, `/stays/${stay.stayId}/grc/regenerate`, { reason: 'x' });
    expect(noReason.status).toBe(400);

    const again = await post(desk, `/stays/${stay.stayId}/grc/regenerate`, { reason: 'Extra occupant added after arrival' }).expect(200);
    expect(again.body.grc.version).toBe(2);
    expect(again.body.grc.supersedesId).toBe(cardId);
    expect(again.body.grc.number).toBe((await desk.get(`/api/v1/stays/${stay.stayId}/grc`)).body.versions[1].number);

    const rows = await sql(`SELECT id, version, storage_key, reason FROM grc_documents WHERE stay_id = $1 ORDER BY version`, [stay.stayId]);
    expect(rows).toHaveLength(2);
    expect(rows[0].storage_key).not.toBe(rows[1].storage_key);
    expect(rows[1].reason).toBe('Extra occupant added after arrival');

    // Version 1's file is still readable: nothing was replaced in storage.
    const old = await app.get(StorageService).getObject(rows[0].storage_key);
    expect(old.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('a card is never edited in the database', async () => {
    await expect(sql(`UPDATE grc_documents SET reason = 'tampered' WHERE id = $1`, [cardId])).rejects.toThrow(/new version, never changed/);
    await expect(sql(`DELETE FROM grc_documents WHERE id = $1`, [cardId])).rejects.toThrow(/registration cards are kept/);
  });
});

describe('the three ways a guest signs (spec §20)', () => {
  it('records the phone scanner session as the signature method', async () => {
    const stay = await checkIn({ room: 1, signature: 'phone', guest: { firstName: 'Vikram', lastName: 'Rao', mobile: '9829077772' } });
    const res = await post(desk, `/stays/${stay.stayId}/grc`, {}).expect(200);
    expect(res.body.grc.signatureMethod).toBe('phone');
  });

  it('records a scanned paper signature', async () => {
    const stay = await checkIn({ room: 2, signature: 'paper_scan', guest: { firstName: 'Neha', lastName: 'Gupta', mobile: '9829077773' } });
    const res = await post(desk, `/stays/${stay.stayId}/grc`, {}).expect(200);
    expect(res.body.grc.signatureMethod).toBe('paper_scan');
  });
});

describe('a card is not recorded unless its file is safely stored', () => {
  it('a checksum mismatch leaves no row and no GRC number gap', async () => {
    const stay = await checkIn({ room: 3, signature: 'touchscreen', guest: { firstName: 'Kabir', lastName: 'Sen', mobile: '9829077774' } });
    const storage = app.get(StorageService);
    const [before] = await sql(`SELECT last_number FROM reference_counters WHERE name = 'grc'`);

    const spy = vi.spyOn(storage, 'verify').mockResolvedValueOnce({ ok: false, reason: 'checksum_mismatch' });
    const res = await post(desk, `/stays/${stay.stayId}/grc`, {});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/could not be stored safely/);
    spy.mockRestore();

    const rows = await sql(`SELECT id FROM grc_documents WHERE stay_id = $1`, [stay.stayId]);
    expect(rows).toHaveLength(0);
    // The number was rolled back with the transaction, so the series has no gap.
    const [after] = await sql(`SELECT last_number FROM reference_counters WHERE name = 'grc'`);
    expect(after.last_number).toBe(before.last_number);

    // Retrying after the fault produces the card normally.
    const ok = await post(desk, `/stays/${stay.stayId}/grc`, {}).expect(200);
    expect(ok.body.grc.version).toBe(1);
  });

  it('refuses to print before the guest has signed', async () => {
    const [seeded] = await sql(`SELECT id FROM reservations WHERE number = 'BK-000001'`);
    const started = await post(desk, '/check-in-drafts', { reservationId: seeded.id }, null).expect(200);
    // BK-000001 is the demo booking that arrives on the test business date.
    // A stay with no signature cannot exist through the API, so check the guard directly.
    const [stay] = await sql(
      `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id, checked_in_by, business_date_in, expected_departure)
       SELECT d.property_id, d.reservation_id, rr.id, rr.room_id, r.primary_guest_id, d.id, d.created_by, '2026-09-16', rr.departure
         FROM check_in_drafts d JOIN reservations r ON r.id = d.reservation_id
         JOIN reservation_rooms rr ON rr.id = d.reservation_room_ids[1]
        WHERE d.id = $1 RETURNING id`,
      [started.body.id],
    );
    // The rest of what a real check-in does to the booking. Without it this fixture leaves an
    // in-house stay whose room is only 'reserved' — an impossible state that the restore test's
    // integrity checks correctly report as a finding (ops/backup/integrity.sql).
    await sql(`UPDATE room_allocations SET status = 'checked_in' WHERE reservation_room_id = (SELECT reservation_room_id FROM stays WHERE id = $1)`, [stay.id]);
    await sql(`UPDATE reservation_rooms SET status = 'checked_in' WHERE id = (SELECT reservation_room_id FROM stays WHERE id = $1)`, [stay.id]);
    await sql(`UPDATE reservations SET status = 'checked_in' WHERE id = (SELECT reservation_id FROM stays WHERE id = $1)`, [stay.id]);

    const res = await post(desk, `/stays/${stay.id}/grc`, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/signature/i);
  });
});
