import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService, type Queryable } from '../src/db/db.service';
import type { Actor } from '../src/common/request-context';
import { DailySummaryHandler } from '../src/messaging/daily-summary.handler';
import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { bootAppOnOwnDatabase, fixtures, key, login, post, type Agent } from './helpers';

const DATE = '2026-09-16';
let app: INestApplication;
let owner: Agent;
let desk: Agent;
let sql: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;
let f: Awaited<ReturnType<typeof fixtures>>;
let actor: Actor;
let db: DbService;
let upi: string;
let stay: { stayId: string; folioId: string; reservationId: string };
const observations: Record<string, unknown> = {};

function observe(name: string, value: unknown) {
  observations[name] = value;
}

beforeAll(async () => {
  process.env.RESORTOS_ENV = 'test';
  const boot = await bootAppOnOwnDatabase('marketaudit', DATE);
  app = boot.app;
  sql = boot.sql;
  owner = await login(app, 'owner');
  desk = await login(app, 'receptionist');
  f = await fixtures(sql);
  db = app.get(DbService);
  const me = await owner.get('/api/v1/auth/me').expect(200);
  actor = { user: me.body.user, sessionId: randomUUID(), ip: '127.0.0.1', device: 'market-audit', requestId: randomUUID() };
  upi = (await sql<{ id: string }>("SELECT id FROM payment_accounts WHERE kind = 'upi' LIMIT 1"))[0]!.id;
  stay = await makeStay('106', 'Reporting');
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  const directory = resolve(process.env.AUDIT_EVIDENCE_DIR ?? '/tmp/resortos-audit-evidence');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'probe-observations.json'), JSON.stringify(observations, null, 2) + '\n');
});

// Test-only setup, following the existing billing suites: the booking goes through
// the API, while confirmed stay rows are prepared with SQL. Every operation under
// audit (charges, money, checkout, exports, maintenance) uses the real API/database.
async function makeStay(room: string, name: string, arrivedAt: string | null = null, departure = '2026-09-18', businessDateIn = DATE) {
  const reservation = await post(owner, '/reservations', {
    guest: { firstName: 'Audit', lastName: name, mobile: `98${String(mobile++).padStart(8, '0')}` },
    source: 'walk_in', arrival: DATE, departure,
    rooms: [{ roomTypeId: f.type('PRE'), roomId: f.room(room), adults: 1, mealPlan: 'EP' }],
  }).expect(201);
  const [draft] = await sql<{ id: string }>(
    `INSERT INTO check_in_drafts (property_id, reservation_id, reservation_room_ids, status, confirmed_at, created_by)
     SELECT property_id, reservation_id, array_agg(id), 'confirmed', now(), created_by
       FROM reservation_rooms WHERE reservation_id = $1 GROUP BY property_id, reservation_id, created_by RETURNING id`,
    [reservation.body.id],
  );
  const [s] = await sql<{ id: string }>(
    `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id,
                        business_date_in, expected_departure, checked_in_by, checked_in_at)
     SELECT rr.property_id, rr.reservation_id, rr.id, rr.room_id, r.primary_guest_id, $2, $4::date, rr.departure, r.created_by, COALESCE($3::timestamptz, now())
       FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id WHERE rr.reservation_id = $1 RETURNING id`,
    [reservation.body.id, draft!.id, arrivedAt, businessDateIn],
  );
  await sql("UPDATE reservations SET status = 'checked_in' WHERE id = $1", [reservation.body.id]);
  await sql("UPDATE reservation_rooms SET status = 'checked_in' WHERE reservation_id = $1", [reservation.body.id]);
  await sql("UPDATE room_allocations SET status = 'checked_in' WHERE reservation_room_id IN (SELECT id FROM reservation_rooms WHERE reservation_id = $1)", [reservation.body.id]);
  const bill = await owner.get(`/api/v1/stays/${s!.id}/bill`).expect(200);
  return { stayId: s!.id, folioId: bill.body.id as string, reservationId: reservation.body.id as string };
}
let mobile = 76_100_000;

async function numbers() {
  // Exercise the reporting query against actual records, independent of message
  // delivery. It is private only to the handler, not a mocked implementation.
  const handler = app.get(DailySummaryHandler) as unknown as {
    numbers(q: Queryable, propertyId: string, date: string): Promise<Record<string, unknown>>;
  };
  return handler.numbers(db, actor.user.propertyId, DATE);
}

describe('billing and daily reporting launch requirements', () => {
  it('cannot finalize a stay with its agreed accommodation charges missing', async () => {
    const s = await makeStay('108', 'EarlyCheckout');
    await post(owner, `/folios/${s.folioId}/charges`, { lineType: 'food', name: 'Breakfast', quantity: 1, unitRate: '100' }).expect(200);
    await post(owner, `/folios/${s.folioId}/payments`, { method: 'upi', paymentAccountId: upi, amount: '105', reference: 'AUDIT-CHECKOUT' }).expect(200);
    const result = await post(desk, `/stays/${s.stayId}/checkout`, {});
    const invoices = await sql<{ grand_total: string }>('SELECT grand_total FROM invoices WHERE folio_id = $1', [s.folioId]);
    const nights = await sql<{ room_rate: string }>('SELECT room_rate FROM reservation_room_nights WHERE reservation_room_id = (SELECT reservation_room_id FROM stays WHERE id = $1) ORDER BY night_date', [s.stayId]);
    observe('unposted_room_checkout', { status: result.status, invoiceTotals: invoices.map((i) => i.grand_total), agreedNightRates: nights.map((n) => n.room_rate) });
    if (result.status === 200) {
      const [count] = await sql<{ n: string }>("SELECT count(*) AS n FROM invoice_lines il JOIN folio_lines fl ON fl.id = il.folio_line_id WHERE il.invoice_id IN (SELECT id FROM invoices WHERE folio_id = $1) AND fl.tax_category = 'accommodation'", [s.folioId]);
      expect(Number(count!.n), 'successful checkout must include agreed room charges').toBeGreaterThan(0);
    } else {
      expect([400, 409]).toContain(result.status);
    }
    await desk.get(`/api/v1/stays/${s.stayId}/checkout-preview`).expect(200);
    const completed = (await desk.get(`/api/v1/stays/${s.stayId}/bill`).expect(200)).body;
    await desk.get(`/api/v1/stays/${s.stayId}/checkout-preview`).expect(200);
    const again = (await desk.get(`/api/v1/stays/${s.stayId}/bill`).expect(200)).body;
    expect(again.balance).toBe(completed.balance);
    const posted = await sql<{ business_date: string; amount: string }>("SELECT business_date, amount FROM folio_lines WHERE folio_id=$1 AND source='night_audit' AND voided_at IS NULL", [s.folioId]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.business_date).toBe(DATE);
    expect(posted[0]!.amount).toBe(nights[0]!.room_rate);
    await post(desk, `/folios/${s.folioId}/payments`, { method: 'upi', paymentAccountId: upi, amount: again.balance, reference: 'AUDIT-FULL-SETTLEMENT' }).expect(200);
    await post(desk, `/stays/${s.stayId}/checkout`, {}).expect(200);
    const final = (await desk.get(`/api/v1/stays/${s.stayId}/bill`).expect(200)).body;
    expect(final.balance).toBe('0.00');
    expect(final.status).toBe('closed');
    observe('complete_early_checkout', { chargedNights: posted.map((n) => n.business_date), agreedRate: nights[0]!.room_rate, invoice: final.documents[0].number });
  });

  it('nets a returned security deposit to zero collections', async () => {
    const before = await numbers();
    await post(owner, `/folios/${stay.folioId}/payments`, { entryType: 'deposit', method: 'upi', paymentAccountId: upi, amount: '500', reference: 'AUDIT-DEPOSIT' }).expect(200);
    await post(owner, `/folios/${stay.folioId}/deposit/settle`, { adjust: '0', refund: '500', refundMethod: 'upi', refundAccountId: upi }).expect(200);
    const after = await numbers();
    const delta = Number(after.collected) - Number(before.collected);
    observe('returned_deposit_collections_delta', delta);
    expect(delta).toBe(0);
  });

  it('removes a reversed payment from collections', async () => {
    const before = await numbers();
    await post(owner, `/folios/${stay.folioId}/payments`, { method: 'upi', paymentAccountId: upi, amount: '123', reference: 'AUDIT-REVERSE' }).expect(200);
    const [payment] = await sql<{ id: string }>("SELECT id FROM payments WHERE reference = 'AUDIT-REVERSE' AND reverses_payment_id IS NULL");
    await post(owner, `/payments/${payment!.id}/reverse`, { reason: 'Entered twice by mistake' }).expect(200);
    const after = await numbers();
    const delta = Number(after.collected) - Number(before.collected);
    observe('reversed_payment_collections_delta', delta);
    expect(delta).toBe(0);
  });

  it('excludes voided food charges from earned revenue', async () => {
    const before = await numbers();
    await post(owner, `/folios/${stay.folioId}/charges`, { lineType: 'food', name: 'Void audit food', quantity: 1, unitRate: '300' }).expect(200);
    const [line] = await sql<{ id: string }>("SELECT id FROM folio_lines WHERE folio_id = $1 AND name = 'Void audit food'", [stay.folioId]);
    await post(owner, `/folio-lines/${line!.id}/void`, { reason: 'Guest never received this item' }).expect(200);
    const after = await numbers();
    const delta = Number(after.food) - Number(before.food);
    observe('voided_food_revenue_delta', delta);
    expect(delta).toBe(0);
  });
});

describe('maintenance reliability launch requirements', () => {
  it('replaying one creation key creates one ticket', async () => {
    const body = { area: 'Lobby', title: 'Audit duplicate ticket' };
    const idempotencyKey = key();
    const a = await post(desk, '/maintenance/tickets', body, idempotencyKey).expect(201);
    const b = await post(desk, '/maintenance/tickets', body, idempotencyKey).expect(201);
    observe('maintenance_ticket_replay', { firstId: a.body.id, replayId: b.body.id });
    expect(b.body.id).toBe(a.body.id);
  });

  it('replaying one creation key creates one preventive schedule', async () => {
    const body = { area: 'Pump', name: 'Audit duplicate schedule', everyDays: 30, nextDue: '2027-01-01' };
    const idempotencyKey = key();
    const a = await post(owner, '/maintenance/schedules', body, idempotencyKey).expect(201);
    const b = await post(owner, '/maintenance/schedules', body, idempotencyKey).expect(201);
    observe('maintenance_schedule_replay', { firstId: a.body.id, replayId: b.body.id });
    expect(b.body.id).toBe(a.body.id);
  });

  it('a room preventive schedule opens its ticket without aborting night audit', async () => {
    await post(owner, '/maintenance/schedules', { name: 'Audit room AC service', roomId: f.room('206'), everyDays: 30, nextDue: DATE }).expect(201);
    let error: unknown;
    let result: unknown;
    try {
      result = await db.tx({ userId: actor.user.id }, (q) => app.get(MaintenanceService).openDueSchedules(q, actor, actor.user.propertyId, DATE));
    } catch (err) { error = err; }
    observe('room_preventive_schedule', { result, error: error instanceof Error ? error.message : null });
    expect(error, 'the registered night-audit step must accept a room schedule').toBeUndefined();
  });

  it('a schedule edit actually changes the room selected by the owner', async () => {
    const created = await post(owner, '/maintenance/schedules', { name: 'Audit room edit', roomId: f.room('207'), everyDays: 30, nextDue: '2027-01-01' }).expect(201);
    await owner.patch(`/api/v1/maintenance/schedules/${created.body.id}`).set('x-resortos', '1').set('idempotency-key', key()).send({ version: 1, roomId: f.room('208') }).expect(200);
    const [saved] = await sql<{ room_id: string }>('SELECT room_id FROM maintenance_schedules WHERE id = $1', [created.body.id]);
    observe('schedule_room_edit', { expectedRoomId: f.room('208'), actualRoomId: saved!.room_id });
    expect(saved!.room_id).toBe(f.room('208'));
  });

  it('does not assign a ticket to an inactive staff account', async () => {
    const [user] = await sql<{ id: string }>(
      `INSERT INTO users (property_id, full_name, username, role, password_hash, is_active)
       SELECT property_id, 'Inactive Audit Staff', 'inactive.audit', 'receptionist', password_hash, false FROM users WHERE id = $1 RETURNING id`, [actor.user.id],
    );
    const res = await post(owner, '/maintenance/tickets', { area: 'Lobby', title: 'Inactive assignee audit', assignedTo: user!.id });
    observe('inactive_maintenance_assignee_status', res.status);
    expect([400, 404]).toContain(res.status);
  });
});

describe('owner exports launch requirements', () => {
  it('GSTR tax totals reconcile to the issued invoice rather than rounding each line again', async () => {
    const s = await makeStay('209', 'TaxRounding');
    for (const name of ['Tea', 'Snack']) await post(owner, `/folios/${s.folioId}/charges`, { lineType: 'food', name, quantity: 1, unitRate: '100.10' }).expect(200);
    await owner.get(`/api/v1/stays/${s.stayId}/checkout-preview`).expect(200);
    const bill = await owner.get(`/api/v1/stays/${s.stayId}/bill`).expect(200);
    await post(owner, `/folios/${s.folioId}/payments`, { method: 'upi', paymentAccountId: upi, amount: bill.body.balance, reference: 'AUDIT-ROUNDING' }).expect(200);
    await post(owner, `/stays/${s.stayId}/checkout`, {}).expect(200);
    const [ledger] = await sql<{ total: string }>("SELECT sum(cgst_total)::text AS total FROM invoices WHERE property_id = $1 AND invoice_date = $2::date AND buyer_gstin IS NULL AND document_type IN ('tax_invoice', 'bill_of_supply')", [actor.user.propertyId, DATE]);
    const result = await app.get((await import('../src/exports/exports.service')).ExportsService).gstr1(actor, DATE, DATE);
    const exported = result.csv.split('\r\n').slice(1).filter((line) => line.startsWith('B2C,')).reduce((n, line) => n + Number(line.split(',')[10]), 0);
    observe('gstr_cgst_reconciliation', { invoiceLedger: ledger!.total, exported });
    expect(exported).toBe(Number(ledger!.total));
  });

  it('Tally vouchers use the documented YYYYMMDD date format', async () => {
    const result = await app.get((await import('../src/exports/exports.service')).ExportsService).tallyXml(actor, DATE, DATE);
    const dates = [...result.xml.matchAll(/<DATE>(.*?)<\/DATE>/g)].map((match) => match[1]);
    observe('tally_dates', dates);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((date) => /^\d{8}$/.test(date!))).toBe(true);
  });

  it('Tally receipts exclude money that was reversed', async () => {
    const [reversed] = await sql<{ number: string }>("SELECT p.number FROM payments p WHERE EXISTS (SELECT 1 FROM payments x WHERE x.reverses_payment_id = p.id) AND p.entry_type = 'payment' LIMIT 1");
    const result = await app.get((await import('../src/exports/exports.service')).ExportsService).tallyXml(actor, DATE, DATE);
    observe('tally_keeps_reversed_payment', result.xml.includes(reversed!.number));
    expect(result.xml).not.toContain(reversed!.number);
  });

  it('bookings export respects the selected date range', async () => {
    const result = await app.get((await import('../src/exports/exports.service')).ExportsService).download(actor, 'bookings', 'csv', '2030-01-01', '2030-01-02');
    observe('future_bookings_export_rows', result.rows);
    expect(result.rows).toBe(0);
  });

  it('stays export respects the selected date range', async () => {
    const result = await app.get((await import('../src/exports/exports.service')).ExportsService).download(actor, 'in-house', 'csv', '2030-01-01', '2030-01-02');
    observe('future_stays_export_rows', result.rows);
    expect(result.rows).toBe(0);
  });

  it('marks payment reversals distinctly in the CSV', async () => {
    const result = await app.get((await import('../src/exports/exports.service')).ExportsService).download(actor, 'payments', 'csv', DATE, DATE);
    const csv = result.body.toString('utf8');
    observe('payments_csv_marks_reversals', csv.includes('(reversed)'));
    expect(csv).toContain('(reversed)');
  });

  it('does not count both a reversed expense and its correction as positive expense', async () => {
    const [category] = await sql<{ id: string }>('SELECT id FROM expense_categories LIMIT 1');
    const body = { expenseDate: DATE, categoryId: category!.id, amount: '450', method: 'upi', paymentAccountId: upi, paidTo: 'Audit contractor' };
    const expense = await post(owner, '/expenses', body).expect(201);
    await post(owner, `/expenses/${expense.body.id}/correct`, { ...body, amount: '550', reason: 'Correct amount on the receipt' }).expect(200);
    const result = await app.get((await import('../src/exports/exports.service')).ExportsService).download(actor, 'expenses', 'csv', DATE, DATE);
    const sum = result.body.toString('utf8').split('\r\n').slice(1).filter((line) => line.includes('Audit contractor')).reduce((total, line) => total + Number(line.split(',')[6] || 0), 0);
    observe('corrected_expense_csv_sum', sum);
    expect(sum).toBe(550);
  });
});

describe('compliance dates and local concurrency', () => {
  it('paginates a 100-row police register without producing mostly empty pages', async () => {
    const service = app.get((await import('../src/exports/exports.service')).ExportsService) as unknown as {
      registerPdf(sheet: { title: string; columns: string[]; rows: string[][] }, from: string, to: string): Promise<Buffer>;
    };
    const body = await service.registerPdf({ title: 'Audit Police Register', columns: ['Serial', 'Name', 'Room', 'Arrival'], rows: Array.from({ length: 100 }, (_, i) => [String(i + 1), `Audit Guest ${i + 1}`, '208', '17 Sep 2026']) }, DATE, DATE);
    const directory = resolve(process.env.AUDIT_EVIDENCE_DIR ?? '/tmp/resortos-audit-evidence');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'police-register-100-rows.pdf'), body);
    const pages = [...body.toString('latin1').matchAll(/\/Type \/Page\s/g)].length;
    observe('police_register_100_rows_pages', pages);
    expect(pages).toBeLessThanOrEqual(6);
  });

  it('police register reports the India arrival date at 00:30 IST', async () => {
    const midnightStay = await makeStay('208', 'Midnight', '2026-09-17T00:30:00+05:30');
    await sql(`INSERT INTO stay_occupants (property_id, stay_id, occupant_key, full_name, is_primary, nationality, id_type, created_by)
      VALUES ($1, $2, 'audit-timezone', 'Audit Midnight Arrival', true, 'IN', 'none', $3)`, [actor.user.propertyId, midnightStay.stayId, actor.user.id]);
    const register = await app.get((await import('../src/compliance/police-register.service')).PoliceRegisterService).rows(actor.user.propertyId, DATE, DATE);
    const index = register.columns.findIndex((c) => c.key === 'arrival');
    const nameIndex = register.columns.findIndex((c) => c.key === 'name');
    const row = register.rows.find((r) => r[nameIndex] === 'Audit Midnight Arrival')!;
    observe('police_midnight_arrival', row[index]);
    expect(row[index]).toContain('17 Sep 2026');
  });

  it('serves a burst of 50 authenticated reads without server errors', async () => {
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 50 }, async (_, i) => {
      const start = performance.now();
      const result = await owner.get(i % 2 ? '/api/v1/maintenance/tickets' : '/api/v1/exports/payments.csv?from=2026-09-16&to=2026-09-16');
      return { status: result.status, latencyMs: performance.now() - start };
    }));
    const timings = results.map((r) => r.latencyMs).sort((a, b) => a - b);
    observe('local_read_burst', { requests: results.length, elapsedMs: Math.round(performance.now() - started), p95Ms: Math.round(timings[47]!), statuses: results.reduce<Record<string, number>>((counts, r) => { counts[r.status] = (counts[r.status] ?? 0) + 1; return counts; }, {}) });
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('security controls and property separation', () => {
  it('refuses requests without a session', async () => {
    const request = (await import('supertest')).default;
    await request(app.getHttpServer()).get('/api/v1/maintenance/tickets').expect(401);
  });

  it('refuses owner records to a receptionist', async () => {
    await desk.get('/api/v1/exports/payments.csv').expect(403);
  });

  it('refuses unsafe authenticated requests without the CSRF header', async () => {
    await owner.post('/api/v1/maintenance/tickets').send({ area: 'Lobby', title: 'Blocked audit request' }).expect(403);
  });

  it('refuses a maintenance assignee belonging to another property', async () => {
    const [property] = await sql<{ id: string }>(
      `INSERT INTO properties (name, legal_name, address_line1, city, state_code, pin_code, phone, current_business_date)
       VALUES ('Audit Other Property', 'Audit Other Property', 'Test Road', 'Jaipur', '08', '302001', '9876543210', $1) RETURNING id`, [DATE],
    );
    const [user] = await sql<{ id: string }>(
      `INSERT INTO users (property_id, full_name, username, role, password_hash, must_change_password)
       SELECT $1, 'Other Property Audit Staff', 'other.audit', 'receptionist', password_hash, false FROM users WHERE id = $2 RETURNING id`, [property!.id, actor.user.id],
    );
    const result = await post(owner, '/maintenance/tickets', { area: 'Lobby', title: 'Other property assignee audit', assignedTo: user!.id });
    const list = await owner.get('/api/v1/maintenance/tickets').expect(200);
    const saved = list.body.find((ticket: { id: string }) => ticket.id === result.body.id);
    observe('other_property_assignee', { status: result.status, exposedName: saved?.assignedTo?.name ?? null });
    expect([400, 404]).toContain(result.status);
  });
});


describe('elapsed nights and historical receipt corrections', () => {
  it('charges elapsed nights, excludes unused future nights and days before a late check-in', async () => {
    const normal = await makeStay('108','Elapsed',null,'2026-09-19');
    const late = await makeStay('209','LateArrival',null,'2026-09-19','2026-09-17');
    await sql(`UPDATE properties SET current_business_date='2026-09-18' WHERE id=$1`,[actor.user.propertyId]);
    for (const [current,dates] of [[normal,['2026-09-16','2026-09-17']],[late,['2026-09-17']]] as const) {
      await desk.get(`/api/v1/stays/${current.stayId}/checkout-preview`).expect(200);
      const posted=await sql<{business_date:string}>(`SELECT business_date FROM folio_lines WHERE folio_id=$1 AND source='night_audit' ORDER BY business_date`,[current.folioId]);
      expect(posted.map((r)=>r.business_date)).toEqual(dates);
      const bill=(await desk.get(`/api/v1/stays/${current.stayId}/bill`).expect(200)).body;
      await post(desk,`/folios/${current.folioId}/payments`,{method:'upi',paymentAccountId:upi,amount:bill.balance,reference:`ELAPSED-${current.stayId}`}).expect(200);
      await post(desk,`/stays/${current.stayId}/checkout`,{}).expect(200);
      expect((await desk.get(`/api/v1/stays/${current.stayId}/bill`).expect(200)).body.balance).toBe('0.00');
    }
    observe('elapsed_and_late_checkout',{normalNights:2,lateArrivalNights:1,unusedNightsCharged:0});
  });

  it('retains an earlier-period receipt and exports a later reversal as a balanced payment voucher', async () => {
    await sql(`UPDATE properties SET current_business_date='2026-09-18' WHERE id=$1`,[actor.user.propertyId]);
    await post(owner,`/folios/${stay.folioId}/payments`,{method:'upi',paymentAccountId:upi,amount:'321.24',reference:'PERIOD-REVERSAL'}).expect(200);
    const original=(await sql<{id:string;number:string}>(`SELECT id,number FROM payments WHERE reference='PERIOD-REVERSAL'`))[0]!;
    await sql(`UPDATE properties SET current_business_date='2026-09-19' WHERE id=$1`,[actor.user.propertyId]);
    await post(owner,`/payments/${original.id}/reverse`,{reason:'Incorrect earlier-period receipt'}).expect(200);
    const service=app.get((await import('../src/exports/exports.service')).ExportsService);
    const before=await service.tallyXml(actor,'2026-09-18','2026-09-18');
    const after=await service.tallyXml(actor,'2026-09-19','2026-09-19');
    expect(before.xml).toContain(original.number);
    expect(after.xml).toContain('VCHTYPE="Payment"');
    expect(after.xml).toContain('<AMOUNT>-321.24</AMOUNT>');
    for(const result of [before,after]) for(const voucher of result.xml.matchAll(/<VOUCHER[\s\S]*?<\/VOUCHER>/g)) {
      const values=[...voucher[0].matchAll(/<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g)].map((m)=>Number(m[1]));
      expect(Math.abs(values.reduce((a,b)=>a+b,0))).toBeLessThan(0.00001);
    }
  });
});
