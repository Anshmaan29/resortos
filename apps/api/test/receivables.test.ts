import type { INestApplication } from '@nestjs/common';
import { gstinCheckChar } from '@resortos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve, bootAppOnOwnDatabase, booking, fixtures, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/** Milestone 2.7 — company accounts and OTA bookings (spec §32, §33). */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let f: Awaited<ReturnType<typeof fixtures>>;
let bank: string;
let cash: string;
let mobile = 9820077000;

const ownerId = async () => (await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`))[0]!.id;

async function stayWithCharge(room: string, type: string, amount: string, extra: object = {}) {
  mobile += 1;
  const created = await post(owner, '/reservations', {
    ...booking({ roomTypeId: f.type(type), roomId: f.room(room), arrival: '2026-09-16', departure: '2026-09-18', extra }),
    guest: { firstName: 'Rec', lastName: `Guest${mobile}`, mobile: String(mobile) },
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
  await sql(`UPDATE reservation_rooms SET status = 'checked_in' WHERE reservation_id = $1`, [created.body.id]);
  await sql(`UPDATE room_allocations SET status = 'checked_in' WHERE reservation_room_id IN (SELECT id FROM reservation_rooms WHERE reservation_id = $1)`, [created.body.id]);
  await sql(`UPDATE reservations SET status = 'checked_in' WHERE id = $1`, [created.body.id]);
  const [s] = await sql<{ id: string }>(`SELECT s.id FROM stays s JOIN reservation_rooms rr ON rr.id = s.reservation_room_id WHERE rr.reservation_id = $1`, [created.body.id]);
  const bill = (await desk.get(`/api/v1/stays/${s!.id}/bill`).expect(200)).body;
  await post(desk, `/folios/${bill.id}/charges`, { lineType: 'other', name: 'Conference hall', quantity: 1, unitRate: amount }).expect(200);
  return { stayId: s!.id, folioId: bill.id as string, reservationId: created.body.id as string };
}

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('receivables', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  f = await fixtures(sql);
  bank = (await sql<{ id: string }>(`SELECT id FROM payment_accounts WHERE kind = 'bank' LIMIT 1`))[0]!.id;
  cash = (await sql<{ id: string }>(`SELECT id FROM payment_accounts WHERE kind = 'cash' LIMIT 1`))[0]!.id;
  await post(desk, '/shifts/open', { openingCash: '0' }).expect(200);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('company accounts', () => {
  let companyId: string;

  it('are the owner’s to set up, with a GSTIN checked on the way in', async () => {
    const valid = `08AAACA1234A1Z${gstinCheckChar('08AAACA1234A1Z')}`;
    const wrongCheck = valid.slice(0, 14) + (valid.endsWith('0') ? '1' : '0');
    await post(desk, '/companies', { name: 'Nope Ltd' }, null).expect(403);
    await post(owner, '/companies', { name: 'Bad GST Ltd', gstin: wrongCheck }, null).expect(400);
    const created = (await post(owner, '/companies', {
      name: 'Aravali Tours Pvt Ltd', gstin: valid, billingAddress: 'MI Road, Jaipur', creditLimit: '10000', paymentTermsDays: 15,
    }, null).expect(201)).body;
    companyId = created.id;
    expect(created.gstin).toBe(valid);
  });

  it('a bill moved to the company is invoiced in the company’s name, and the company then owes it', async () => {
    const s = await stayWithCharge('202', 'DLX', '5000');
    await desk.get(`/api/v1/stays/${s.stayId}/checkout-preview`).expect(200);
    const bill = (await desk.get(`/api/v1/stays/${s.stayId}/bill`).expect(200)).body;
    await post(desk, `/folios/${s.folioId}/payments`, { method: 'company_account', companyId, amount: bill.balance }).expect(200);
    await post(desk, `/stays/${s.stayId}/checkout`, {}).expect(200);

    const after = (await desk.get(`/api/v1/stays/${s.stayId}/bill`).expect(200)).body;
    const invoice = (await desk.get(`/api/v1/invoices/${after.documents[0].id}`).expect(200)).body;
    expect(invoice.buyer.name).toBe('Aravali Tours Pvt Ltd');
    expect(invoice.buyer.gstin).toMatch(/^08AAACA1234A1Z/);
    expect(invoice.buyer.mobile).toBeNull();

    const companies = (await desk.get('/api/v1/companies').expect(200)).body;
    expect(companies.find((c: any) => c.id === companyId).outstanding).toBe(bill.balance);
  });

  it('beyond the credit limit needs the owner', async () => {
    const s = await stayWithCharge('203', 'DLX', '8000');
    const bill = (await desk.get(`/api/v1/stays/${s.stayId}/bill`).expect(200)).body;
    const refused = await post(desk, `/folios/${s.folioId}/payments`, { method: 'company_account', companyId, amount: bill.balance }).expect(403);
    expect(refused.body.details.reasons[0].action).toBe('credit_limit_exceeded');
    const ok = await approve(desk, refused.body.details.authorisationId, await ownerId()).expect(200);
    await post(desk, `/folios/${s.folioId}/payments`, {
      method: 'company_account', companyId, amount: bill.balance, ownerAuthorisationId: ok.body.authorisationId,
    }).expect(200);
  });

  it('the statement runs a balance, ages what is owed oldest-first, and a payment reduces it', async () => {
    const before = (await owner.get(`/api/v1/companies/${companyId}/statement`).expect(200)).body;
    await post(desk, `/companies/${companyId}/receipts`, { method: 'bank_transfer', paymentAccountId: bank, amount: '3000', reference: 'NEFT-771' }).expect(200);
    const after = (await owner.get(`/api/v1/companies/${companyId}/statement`).expect(200)).body;
    expect(Number(after.outstanding)).toBe(Number(before.outstanding) - 3000);
    expect(after.lines.at(-1).balance).toBe(after.outstanding);
    expect(after.ageing[0].label).toBe('0–30 days');
    expect(Number(after.ageing[0].amount)).toBe(Number(after.outstanding));

    // The receipt shows in the bank account's ledger too — one ledger, whatever recorded the money.
    const ledger = (await owner.get(`/api/v1/payment-accounts/${bank}/ledger`).expect(200)).body;
    expect(ledger.lines.map((l: any) => l.source)).toContain('company_receipt');
  });

  it('a receipt is corrected by a reversal, never an edit', async () => {
    const [r] = await sql<{ id: string }>(`SELECT id FROM company_receipts LIMIT 1`);
    await expect(sql(`UPDATE company_receipts SET amount = 1 WHERE id = $1`, [r!.id])).rejects.toThrow(/never edited/);
    await post(desk, `/company-receipts/${r!.id}/reverse`, { reason: 'Bounced' }).expect(403);
    await post(owner, `/company-receipts/${r!.id}/reverse`, { reason: 'Bounced' }).expect(200);
    await post(owner, `/company-receipts/${r!.id}/reverse`, { reason: 'Again' }).expect(409);
  });

  it('the database insists a company settlement names its company', async () => {
    await expect(sql(
      `INSERT INTO payments (property_id, number, reservation_id, guest_id, entry_type, method, amount, business_date, received_by)
       SELECT r.property_id, 'PAY-RAW-C', r.id, r.primary_guest_id, 'payment', 'company_account', 10, '2026-09-16', u.id
         FROM reservations r, users u WHERE u.role = 'owner' LIMIT 1`,
    )).rejects.toThrow(/payments_company_when_company_account/);
  });
});

describe('OTA bookings', () => {
  let reservationId: string;
  beforeAll(async () => {
    const created = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('PRE'), roomId: f.room('108'), arrival: '2026-09-20', departure: '2026-09-22', extra: { source: 'booking_com', otaReference: 'BDC-99812' } }),
    }).expect(201);
    reservationId = created.body.id;
  });

  it('records commission and deductions, and works out the expected payout', async () => {
    const saved = await desk.put(`/api/v1/reservations/${reservationId}/ota`).set('x-resortos', '1')
      .send({ paymentMode: 'prepaid_to_ota', grossAmount: '13000', commissionAmount: '2340', taxWithheld: '130' }).expect(200);
    expect(saved.body.expectedPayout).toBe('10530.00');
  });

  it('only on a booking that came from an OTA', async () => {
    const direct = await post(owner, '/reservations', booking({ roomTypeId: f.type('PRE'), roomId: f.room('209'), arrival: '2026-09-20', departure: '2026-09-21' })).expect(201);
    await desk.put(`/api/v1/reservations/${direct.body.id}/ota`).set('x-resortos', '1')
      .send({ paymentMode: 'prepaid_to_ota', grossAmount: '100' }).expect(400);
  });

  it('a payout lands in the bank, and the receivables report shows what is still pending', async () => {
    await post(desk, `/reservations/${reservationId}/ota/payouts`, { paymentAccountId: bank, amount: '10000', reference: 'BDC-PAYOUT-1' }).expect(403);
    await post(owner, `/reservations/${reservationId}/ota/payouts`, { paymentAccountId: cash, amount: '10000', reference: 'BDC-PAYOUT-1' }).expect(400);
    await post(owner, `/reservations/${reservationId}/ota/payouts`, { paymentAccountId: bank, amount: '10000', reference: 'BDC-PAYOUT-1' }).expect(200);
    const report = (await owner.get('/api/v1/ota/receivables').expect(200)).body;
    const row = report.items.find((i: any) => i.reservationId === reservationId);
    expect(row).toMatchObject({ expectedPayout: '10530.00', received: '10000.00', pending: '530.00', difference: '-530.00' });
    // The seeded OTA bookings without terms still show, flagged, so nothing is missed.
    expect(report.items.some((i: any) => i.termsMissing)).toBe(true);
  });

  it('every booking made today is on the "availability changed today" list', async () => {
    const list = (await desk.get('/api/v1/availability-changes/today').expect(200)).body;
    expect(list.some((e: any) => String(e.what).includes('booking_com'))).toBe(true);
  });
});
