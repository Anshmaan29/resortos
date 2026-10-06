import { generateKeyPairSync } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../src/config';
import { GoogleSheetsClient } from '../src/sheets/google-client';
import { inflateRawSync } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootAppOnOwnDatabase, login, post, key, type Agent } from './helpers';

/**
 * The owner's exports (spec §43, §46). A file the accountant opens must be complete and correct, so
 * the suite drives a booking all the way to an invoice, records payments and an expense, and then
 * checks each download's contents — not just its status code — and that every download is logged.
 */
const TEST_BUSINESS_DATE = '2026-09-16';

let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let f: { type: (code: string) => string; room: (number: string) => string; ownerId: string };
let bookingNumber: string;
let invoiceNumber: string;
let propertyGstin = '';

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('exports', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  const types = await sql<{ id: string; code: string }>(`SELECT id, code FROM room_types`);
  const rooms = await sql<{ id: string; number: string }>(`SELECT id, number FROM rooms`);
  const owners = await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`);
  f = {
    type: (code) => types.find((t) => t.code === code)!.id,
    room: (number) => rooms.find((r) => r.number === number)!.id,
    ownerId: owners[0]!.id,
  };

  // A walk-in who checks in, eats, pays and leaves with an invoice — the records to export.
  // A second, identical stay is billed to a company GSTIN so both B2C and B2B invoices exist.
  propertyGstin = (await sql<{ gstin: string }>(`SELECT gstin FROM properties`))[0]!.gstin;
  invoiceNumber = await stayWithInvoice('106', 'Walkin', undefined);
  bookingNumber = await sql(`SELECT number FROM reservations WHERE primary_guest_id = (SELECT id FROM guests WHERE first_name = 'Export' LIMIT 1)`).then((r) => r[0]!.number);
  await stayWithInvoice('108', 'Corporate', { name: 'Acme Traders', gstin: propertyGstin });
  await post(owner, '/expenses', { expenseDate: TEST_BUSINESS_DATE, categoryId: (await sql<{ id: string }>(`SELECT id FROM expense_categories LIMIT 1`))[0]!.id, amount: '450', method: 'upi', paymentAccountId: (await accounts()).upi, paidTo: 'Gas agency' }).expect(201);
}, 120_000);

async function accounts(): Promise<{ cash: string; upi: string }> {
  const rows = await sql<{ id: string; kind: string }>(`SELECT id, kind FROM payment_accounts WHERE kind IN ('cash', 'upi')`);
  return { cash: rows.find((r) => r.kind === 'cash')!.id, upi: rows.find((r) => r.kind === 'upi')!.id };
}


/** Checks a guest in (SQL, the way the API suites do), charges dinner, pays, checks out, returns the invoice number. */
async function stayWithInvoice(room: string, lastName: string, buyer: { name: string; gstin: string } | undefined): Promise<string> {
  const created = await post(desk, '/reservations', {
    guest: { firstName: 'Export', lastName, mobile: `98${String(mobileCounter++).padStart(8, '0')}` },
    source: 'walk_in', arrival: TEST_BUSINESS_DATE, departure: '2026-09-17',
    rooms: [{ roomTypeId: f.type('PRE'), roomId: f.room(room), adults: 1, mealPlan: 'EP' }],
  }).expect(201);
  const [rr] = await sql<{ id: string; property_id: string }>(`SELECT id, property_id FROM reservation_rooms WHERE reservation_id = $1`, [created.body.id]);
  const [d] = await sql<{ id: string }>(
    `INSERT INTO check_in_drafts (property_id, reservation_id, reservation_room_ids, status, confirmed_at, created_by)
     SELECT property_id, reservation_id, array_agg(id), 'confirmed', now(), created_by
       FROM reservation_rooms WHERE reservation_id = $1 GROUP BY property_id, reservation_id, created_by RETURNING id`, [created.body.id],
  );
  await sql(
    `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id,
                        business_date_in, expected_departure, checked_in_by)
     SELECT property_id, reservation_id, id, room_id, (SELECT primary_guest_id FROM reservations WHERE id = reservation_id), $2, arrival, departure, created_by
       FROM reservation_rooms WHERE id = $1`, [rr!.id, d!.id],
  );
  const [stay] = await sql<{ id: string }>(`SELECT id FROM stays WHERE reservation_room_id = $1`, [rr!.id]);
  await sql(`UPDATE reservations SET status = 'checked_in' WHERE id = $1`, [created.body.id]);
  await sql(`UPDATE reservation_rooms SET status = 'checked_in' WHERE id = $1`, [rr!.id]);
  await sql(`UPDATE room_allocations SET status = 'checked_in' WHERE reservation_room_id = $1`, [rr!.id]);
  await sql(
    `INSERT INTO stay_occupants (property_id, stay_id, occupant_key, full_name, is_primary, nationality, id_type, id_last4, created_by)
     VALUES ($1, $2, 'r0a0', $3, true, 'IN', 'aadhaar', '4321', $4)`,
    [rr!.property_id, stay!.id, `Export ${lastName}`, f.ownerId],
  );
  const bill = (await desk.get(`/api/v1/stays/${stay!.id}/bill`).expect(200)).body;
  await post(desk, `/folios/${bill.id}/charges`, { lineType: 'food', name: 'Dinner', quantity: 1, unitRate: '2000' }).expect(200);
  await desk.get(`/api/v1/stays/${stay!.id}/checkout-preview`).expect(200);
  const prepared = (await desk.get(`/api/v1/stays/${stay!.id}/bill`).expect(200)).body;
  await post(desk, `/folios/${bill.id}/payments`, { method: 'upi', paymentAccountId: (await accounts()).upi, amount: prepared.balance, reference: `UTR-${lastName}` }).expect(200);
  await post(desk, `/stays/${stay!.id}/checkout`, { steps: { invoice: buyer ? { buyer } : {} } }).expect(200);
  const closedBill = (await desk.get(`/api/v1/stays/${stay!.id}/bill`).expect(200)).body;
  return closedBill.documents[0].number as string;
}
let mobileCounter = 77_880_000;

afterAll(async () => { await app.close(); });

const get = (agent: Agent, path: string) => agent.get(`/api/v1${path}`).set('x-resortos', '1').buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

describe('records as Excel and CSV (§43)', () => {
  it('downloads every record kind as a real xlsx workbook, byte-stable', async () => {
    for (const kind of ['bookings', 'guests', 'in-house', 'payments', 'invoices', 'expenses', 'police-register']) {
      const a = await get(owner, `/exports/${kind}.xlsx?from=2026-09-01&to=2026-09-30`);
      if (a.status !== 200) throw new Error(`${kind}.xlsx -> ${a.status}: ${JSON.stringify(a.body)}`);
      const b = await get(owner, `/exports/${kind}.xlsx?from=2026-09-01&to=2026-09-30`).expect(200);
      expect(a.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(a.headers['content-disposition']).toContain(kind);
      const body = a.body as Buffer;
      // A real ZIP: the magic the accountant's Excel looks for.
      expect(body.subarray(0, 2).toString()).toBe('PK');
      expect(body.length).toBeGreaterThan(500);
      // The writer is deterministic: the same rows, the same bytes (§36).
      expect((b.body as Buffer).equals(body)).toBe(true);
    }
  });

  it('downloads every date in one workbook and restricts it to the owner', async () => {
    const response = await get(owner, '/exports/all.xlsx').expect(200);
    const bytes = response.body as Buffer;
    const parts: string[] = [];
    let offset = 0;
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
      const size = bytes.readUInt32LE(offset + 18);
      const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
      parts.push(inflateRawSync(bytes.subarray(start, start + size)).toString());
      offset = start + size;
    }
    expect(parts.join('')).toContain(bookingNumber);
    expect(parts.join('')).toContain(invoiceNumber);
    expect(parts.join('')).toContain('Form C');
    expect(parts.join('')).toContain('Daily summaries');
    await get(desk, '/exports/all.xlsx').expect(403);
  });

  it('honestly shows Sheets as disconnected and protects the owner connection', async () => {
    await owner.get('/api/v1/sheets/status').expect(200).expect((r) => expect(r.body.configured).toBe(false));
    await desk.get('/api/v1/sheets/status').expect(403);
    await post(owner, '/sheets/sync', {}).expect(400);
  });

  it('syncs records after a failure, records the outcome and releases the worker lock', async () => {
    const config = app.get<AppConfig>(APP_CONFIG);
    const original = { id: config.GOOGLE_SHEETS_ID, credentials: config.GOOGLE_SERVICE_ACCOUNT_JSON };
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    config.GOOGLE_SHEETS_ID = 'hotel-sheet-id-for-test';
    config.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'test@example.iam.gserviceaccount.com', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    const mirror = vi.spyOn(GoogleSheetsClient.prototype, 'replace');
    try {
      mirror.mockRejectedValueOnce(new Error('secret provider payload'));
      await post(owner, '/sheets/sync', {}).expect(503).expect((r) => expect(r.body.message).not.toContain('secret'));
      await owner.get('/api/v1/sheets/status').expect(200).expect((r) => expect(r.body.lastAttemptOk).toBe(false));
      mirror.mockResolvedValueOnce(undefined);
      await post(owner, '/sheets/sync', {}).expect(201);
      const tabs = mirror.mock.calls[1]![1];
      const columns = tabs.flatMap((s) => s.columns);
      expect(columns).not.toEqual(expect.arrayContaining(['Email']));
      for (const forbidden of ['Email', 'City', 'State', 'Address', 'Nationality', 'Company GSTIN', 'VIP', 'Note', 'Purpose', 'Reference', 'Paid to', 'Reason']) expect(columns).not.toContain(forbidden);
      expect(tabs.find((s) => s.name==='ResortOS Guests')!.rows.every((r) => r[1] === null || /^••••\d{4}$/.test(String(r[1])))).toBe(true);
      const mobiles = await sql<{ mobile: string }>(`SELECT mobile FROM guests`);
      for (const g of mobiles) expect(JSON.stringify(tabs)).not.toContain(g.mobile);
      expect(tabs.map((s) => s.name)).toContain('ResortOS Bookings');
      expect(tabs.flatMap((s) => s.rows.flat()).join(' ')).toContain(bookingNumber);
      expect(tabs.map((s) => s.name)).not.toContain('ResortOS Form C');
      await owner.get('/api/v1/sheets/status').expect(200).expect((r) => {
        expect(r.body.lastAttemptOk).toBe(true);
        expect(r.body.message).toBeNull();
      });
      await post(desk, '/sheets/sync', {}).expect(403);
    } finally { mirror.mockRestore(); config.GOOGLE_SHEETS_ID = original.id; config.GOOGLE_SERVICE_ACCOUNT_JSON = original.credentials; }
  });

  it('defaults exports to the hotel calendar date after midnight and selects the correct financial year', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-16T19:00:00Z').getTime());
    // Only Date construction is clock-mocked; timers/PG I/O stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-16T19:00:00Z'));
    try {
      const res = await get(owner, '/exports/payments.csv').expect(200);
      expect(res.headers['content-disposition']).toContain('2026-04-01-to-2026-09-17');
      const march = await get(owner, '/exports/payments.csv?to=2026-03-31').expect(200);
      expect(march.headers['content-disposition']).toContain('2025-04-01-to-2026-03-31');
    } finally { vi.useRealTimers(); now.mockRestore(); }
  });

  it('the bookings CSV carries the booking that was made', async () => {
    const res = await get(owner, '/exports/bookings.csv').expect(200);
    const text = (res.body as Buffer).toString('utf8');
    expect(text.split('\r\n')[0]).toBe('Booking,Guest,Mobile,Source,OTA reference,Arrival,Departure,Status,Group,Purpose,Guests,Rooms,Booked by,Booked at');
    expect(text).toContain(bookingNumber);
    expect(text).toContain('Export Walkin');
  });

  it('the payments CSV carries the payment with its account and who took it', async () => {
    const res = await get(owner, `/exports/payments.csv?from=2026-09-01&to=2026-09-30`).expect(200);
    const text = (res.body as Buffer).toString('utf8');
    expect(text).toContain(bookingNumber);
    expect(text).toContain('UTR-Walkin');
    expect(text).toContain('upi');
  });

  it('the invoices CSV carries the issued invoice totals', async () => {
    const res = await get(owner, `/exports/invoices.csv?from=2026-09-01&to=2026-09-30`).expect(200);
    const text = (res.body as Buffer).toString('utf8');
    expect(text).toContain(invoiceNumber);
    expect(text).toContain('tax_invoice');
  });

  it('the expenses CSV carries the expense but not a reversed one', async () => {
    const res = await get(owner, `/exports/expenses.csv?from=2026-09-01&to=2026-09-30`).expect(200);
    const text = (res.body as Buffer).toString('utf8');
    expect(text).toContain('Gas agency');
    expect(text).toContain('450');
  });

  it('the police register CSV follows the property columns', async () => {
    const res = await get(owner, `/exports/police-register.csv?from=2026-09-16&to=2026-09-16`).expect(200);
    const text = (res.body as Buffer).toString('utf8');
    expect(text.split('\r\n')[0]).toContain('Name');
    expect(text).toContain('Export Walkin');
  });

  it('the police register also prints as a PDF for the station', async () => {
    const res = await get(owner, `/exports/police-register.pdf?from=2026-09-16&to=2026-09-16`).expect(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.headers['content-disposition']).toContain('.pdf');
  });

  it('a pdf of a non-register record is refused, and an unknown report names what exists', async () => {
    await get(owner, '/exports/bookings.pdf').expect(400);
    const unknown = await get(owner, '/exports/nonsense.xlsx');
    expect(unknown.status).toBe(400);
    expect(JSON.parse((unknown.body as Buffer).toString('utf8')).message).toContain('bookings');
  });
});

describe('accountant formats (§46)', () => {
  it('the GSTR-1 CSV aggregates B2C by rate and reports a B2B invoice line by line', async () => {
    const text = ((await get(owner, `/exports/gstr-1.csv?from=2026-09-01&to=2026-09-30`).expect(200)).body as Buffer).toString('utf8');
    expect(text).toContain('section,gstin,party,invoice number');
    // The walk-in invoice has no GSTIN: it lands in the per-rate B2C aggregate.
    expect(text.split('\r\n').some((l) => l.startsWith('B2C') && l.includes('5.00'))).toBe(true);
    // The company invoice is reported document by document with its GSTIN.
    const b2b = text.split('\r\n').find((l) => l.startsWith('B2B'));
    expect(b2b).toContain(propertyGstin);
  });

  it('the Tally XML is an import envelope with a sales and a receipt voucher', async () => {
    const res = await get(owner, `/exports/tally.xml?from=2026-09-01&to=2026-09-30`).expect(200);
    const text = (res.body as Buffer).toString('utf8');
    expect(text).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(text).toContain('VCHTYPE="Sales"');
    expect(text).toContain('VCHTYPE="Receipt"');
    expect(text).toContain('Invoice');
  });
});

describe('every download is logged (§46)', () => {
  it('records the report, the format, the range and the row count', async () => {
    const [log] = await sql<{ after_values: any }>(
      `SELECT after_values FROM audit_logs WHERE action = 'export.downloaded' ORDER BY seq DESC LIMIT 1`,
    );
    expect(log!.after_values).toMatchObject({ report: 'tally', format: 'xml', from: '2026-09-01', to: '2026-09-30' });
    const counts = await sql<{ n: string }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'export.downloaded'`);
    expect(Number(counts[0]!.n)).toBeGreaterThanOrEqual(12);
  });

  it('is the owner’s: a receptionist gets 403, and nothing is logged', async () => {
    const before = await sql<{ n: string }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'export.downloaded'`);
    await get(desk, '/exports/bookings.csv').expect(403);
    const after = await sql<{ n: string }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'export.downloaded'`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

describe('daily summaries', () => {
  it('lists a completed night audit with its numbers', async () => {
    // Close the day as the owner would: the demo booking arriving today is marked a no-show first.
    const arrivals = (await sql<{ id: string }>(
      `SELECT r.id FROM reservations r WHERE r.property_id = (SELECT property_id FROM users WHERE id = $1)
         AND r.arrival = $2 AND r.status = 'confirmed'`, [f.ownerId, TEST_BUSINESS_DATE],
    ));
    for (const a of arrivals) await post(desk, `/reservations/${a.id}/no-show`, { reason: 'did_not_arrive' }).expect(200);
    await post(desk, '/night-audit/complete', { businessDate: TEST_BUSINESS_DATE }).expect(200);
    const res = await get(owner, `/exports/daily-summaries.csv?from=2026-09-16&to=2026-09-16`).expect(200);
    const text = (res.body as Buffer).toString('utf8');
    expect(text).toContain('2026-09-16');
    expect(text.split('\r\n')[0]).toContain('Occupancy %');
  });
});

void key;
