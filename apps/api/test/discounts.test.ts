import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve, bootAppOnOwnDatabase, booking, fixtures, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/**
 * Milestone 2.5 — discounts and the receptionist limit (spec §28, §4.5, §30.2).
 *
 * The point of most of these tests is GST: a discount is attached to the night it discounts, so the
 * slab is decided on what the guest actually pays for that night.
 */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let f: Awaited<ReturnType<typeof fixtures>>;

const ownerId = async () => (await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`))[0]!.id;

/** A stay whose bill has one room night at `rate`, posted as night audit would post it. */
async function stayWithNight(room: string, type: string, rate: string, mobile: string) {
  const created = await post(owner, '/reservations', {
    ...booking({ roomTypeId: f.type(type), roomId: f.room(room), arrival: '2026-09-16', departure: '2026-09-18' }),
    guest: { firstName: 'Disc', lastName: 'Guest', mobile },
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
  const [stay] = await sql<{ id: string; room_id: string }>(
    `SELECT s.id, s.room_id FROM stays s JOIN reservation_rooms rr ON rr.id = s.reservation_room_id WHERE rr.reservation_id = $1`, [created.body.id],
  );
  const bill = (await desk.get(`/api/v1/stays/${stay!.id}/bill`).expect(200)).body;
  await sql(
    `INSERT INTO folio_lines (property_id, folio_id, business_date, line_type, name, quantity, unit_rate, amount, tax_category, source, room_id, created_by)
     SELECT f.property_id, f.id, '2026-09-16', 'room_night', 'Room — Delux', 1, $2, $2, 'accommodation', 'night_audit', $3, u.id
       FROM folios f, users u WHERE f.id = $1 AND u.role = 'owner'`,
    [bill.id, rate, stay!.room_id],
  );
  return { stayId: stay!.id, folioId: bill.id as string };
}

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('discounts', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  f = await fixtures(sql);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('the GST slab follows the discount', () => {
  it('₹8,000 a night is 18%; a ₹1,000 discount on that night brings it to 5%, and the preview says so first', async () => {
    const { stayId, folioId } = await stayWithNight('202', 'DLX', '8000.00', '9820055001');
    const before = (await desk.get(`/api/v1/stays/${stayId}/bill`).expect(200)).body;
    expect(before.lines[0].gstRate).toBe('18.00');
    const night = before.lines[0].id;

    // 12.5% is above the receptionist's 10% limit, so do it as the owner here; the limit is tested below.
    const preview = (await post(owner, `/folios/${folioId}/discounts/preview`, {
      scope: 'line', lineId: night, kind: 'amount', value: '1000', reason: 'regular_guest',
    }, null).expect(200)).body;
    expect(preview.slabChanges).toEqual([expect.objectContaining({ lineId: night, fromRate: '18.00', toRate: '5.00' })]);
    expect(preview.after.taxTotal).toBe('350.00');
    // The preview saved nothing.
    expect((await desk.get(`/api/v1/stays/${stayId}/bill`).expect(200)).body.lines).toHaveLength(1);

    const after = (await post(owner, `/folios/${folioId}/discounts`, {
      scope: 'line', lineId: night, kind: 'amount', value: '1000', reason: 'regular_guest',
    }).expect(200)).body;
    const room = after.lines.find((l: any) => l.id === night);
    expect(room.net).toBe('7000.00');
    expect(room.gstRate).toBe('5.00');
    expect(after.tax.taxTotal).toBe('350.00');
    expect(after.charges).toBe('7000.00');
  });

  it('₹7,500.00 stays at 5% and ₹7,500.01 is 18% — the boundary is inclusive', async () => {
    const a = await stayWithNight('203', 'DLX', '7500.00', '9820055002');
    const b = await stayWithNight('205', 'DLX', '7500.01', '9820055003');
    expect((await desk.get(`/api/v1/stays/${a.stayId}/bill`).expect(200)).body.lines[0].gstRate).toBe('5.00');
    expect((await desk.get(`/api/v1/stays/${b.stayId}/bill`).expect(200)).body.lines[0].gstRate).toBe('18.00');
    // One paisa off moves it back across.
    const after = (await post(desk, `/folios/${b.folioId}/discounts`, {
      scope: 'bill', kind: 'amount', value: '0.01', reason: 'rounding',
    }).expect(200)).body;
    expect(after.lines[0].gstRate).toBe('5.00');
  });
});

describe('the receptionist limit', () => {
  let folioId: string;
  let stayId: string;
  beforeAll(async () => {
    ({ folioId, stayId } = await stayWithNight('108', 'PRE', '6000.00', '9820055004'));
    await post(desk, `/folios/${folioId}/charges`, { lineType: 'food', name: 'Dinner', quantity: 1, unitRate: '2000' }).expect(200);
  });

  it('is enforced by the server, and Owner PIN approves exactly what was asked', async () => {
    const refused = await post(desk, `/folios/${folioId}/discounts`, {
      scope: 'bill', kind: 'percent', value: '20', reason: 'complaint', note: 'AC not working',
    }).expect(403);
    expect(refused.body.code).toBe('OWNER_PIN_REQUIRED');
    expect(refused.body.details.reasons[0].description).toMatch(/20\.00%\) is above the 10\.00% limit/);

    const approved = await approve(desk, refused.body.details.authorisationId, await ownerId()).expect(200);
    // Asking for more than was approved is refused: the approval is bound to the exact amounts.
    await post(desk, `/folios/${folioId}/discounts`, {
      scope: 'bill', kind: 'percent', value: '25', reason: 'complaint', note: 'AC not working', ownerAuthorisationId: approved.body.authorisationId,
    }).expect(403);
  });

  it('within the limit needs nobody, and a bill discount is spread over every charge to the paisa', async () => {
    const after = (await post(desk, `/folios/${folioId}/discounts`, {
      scope: 'bill', kind: 'amount', value: '333.33', reason: 'long_stay',
    }).expect(200)).body;
    const parts = after.lines.filter((l: any) => l.lineType === 'discount' && !l.voided);
    expect(parts).toHaveLength(2);
    expect(parts.reduce((t: number, l: any) => t + Math.round(Number(l.amount) * 100), 0)).toBe(-33333);
    expect(new Set(parts.map((p: any) => p.discountGroupId)).size).toBe(1);
    // Food discounted as food, room as room: each part carries its charge's tax category.
    const room = after.lines.find((l: any) => l.lineType === 'room_night');
    expect(Number(room.net)).toBeLessThan(6000);
  });

  it('a bill discount is removed as one, and a discounted charge cannot be removed on its own', async () => {
    const { body } = await desk.get(`/api/v1/stays/${stayId}/bill`).expect(200);
    const room = body.lines.find((l: any) => l.lineType === 'room_night');
    const refused = await post(desk, `/folio-lines/${room.id}/void`, { reason: 'Wrong room' }).expect(409);
    expect(refused.body.message).toMatch(/Remove the discount first/);

    const part = body.lines.find((l: any) => l.lineType === 'discount' && !l.voided);
    const after = (await post(desk, `/folio-lines/${part.id}/void`, { reason: 'Given by mistake' }).expect(200)).body;
    expect(after.lines.filter((l: any) => l.lineType === 'discount' && !l.voided)).toHaveLength(0);
    expect(after.charges).toBe('8000.00');
  });
});

describe('the database', () => {
  it('refuses a discount larger than its charge, a discount of a discount, and editing either', async () => {
    const { folioId } = await stayWithNight('103', 'DLX', '3000.00', '9820055005');
    const [line] = await sql<{ id: string; room_id: string }>(`SELECT id, room_id FROM folio_lines WHERE folio_id = $1`, [folioId]);
    const insert = (amount: string, target: string) => sql(
      `INSERT INTO folio_lines (property_id, folio_id, business_date, line_type, name, quantity, unit_rate, amount, tax_category,
                                room_id, created_by, applies_to_line_id, discount_group_id, discount_percent, discount_reason)
       SELECT property_id, folio_id, business_date, 'discount', 'x', 1, $2, $2, tax_category, room_id, created_by, $3,
              gen_random_uuid(), 10, 'By hand'
         FROM folio_lines WHERE id = $1`, [line!.id, amount, target]);
    await expect(insert('-3000.01', line!.id)).rejects.toThrow(/more than the charge/);
    await insert('-100.00', line!.id);
    const [d] = await sql<{ id: string }>(`SELECT id FROM folio_lines WHERE applies_to_line_id = $1`, [line!.id]);
    await expect(insert('-1.00', d!.id)).rejects.toThrow(/cannot be discounted/);
    await expect(sql(`UPDATE folio_lines SET amount = -50 WHERE id = $1`, [d!.id])).rejects.toThrow(/never edited/);
    await expect(sql(`UPDATE folio_lines SET voided_at = now(), voided_by = created_by, void_reason = 'test' WHERE id = $1`, [line!.id]))
      .rejects.toThrow(/remove the discount on this charge/);
  });
});
