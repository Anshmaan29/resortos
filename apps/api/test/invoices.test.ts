import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve, bootAppOnOwnDatabase, booking, fixtures, login, MIGRATOR_URL, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/**
 * Milestone 2.6 — GST invoices, credit and debit notes, gap-free numbering (spec §29–§31), and the
 * billing steps of checkout (§22).
 */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let f: Awaited<ReturnType<typeof fixtures>>;
let cash: string;
let mobile = 9820066000;

const ownerId = async () => (await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`))[0]!.id;
const billOf = async (stayId: string, agent: Agent = desk) => (await agent.get(`/api/v1/stays/${stayId}/bill`).expect(200)).body;

/** A guest in house, with a room night posted as night audit would post it. */
async function stay(room: string, type: string, nights: { date: string; rate: string }[] = [{ date: '2026-09-16', rate: '4000.00' }]) {
  mobile += 1;
  const created = await post(owner, '/reservations', {
    ...booking({ roomTypeId: f.type(type), roomId: f.room(room), arrival: '2026-09-16', departure: '2026-09-18' }),
    guest: { firstName: 'Inv', lastName: `Guest${mobile}`, mobile: String(mobile) },
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
  const [s] = await sql<{ id: string; room_id: string }>(
    `SELECT s.id, s.room_id FROM stays s JOIN reservation_rooms rr ON rr.id = s.reservation_room_id WHERE rr.reservation_id = $1`, [created.body.id],
  );
  const bill = await billOf(s!.id);
  for (const n of nights) {
    await sql(
      `INSERT INTO folio_lines (property_id, folio_id, business_date, line_type, name, quantity, unit_rate, amount, tax_category, source, room_id, created_by)
       SELECT f.property_id, f.id, $2, 'room_night', 'Room — Deluxe', 1, $3, $3, 'accommodation', 'night_audit', $4, u.id
         FROM folios f, users u WHERE f.id = $1 AND u.role = 'owner'`,
      [bill.id, n.date, n.rate, s!.room_id],
    );
  }
  return { stayId: s!.id, folioId: bill.id as string };
}

async function payInFull(folioId: string, stayId: string) {
  const bill = await billOf(stayId);
  if (Number(bill.balance) > 0) {
    await post(desk, `/folios/${folioId}/payments`, { method: 'cash', paymentAccountId: cash, amount: bill.balance }).expect(200);
  }
}

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('invoices', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  f = await fixtures(sql);
  cash = (await sql<{ id: string }>(`SELECT id FROM payment_accounts WHERE kind = 'cash' LIMIT 1`))[0]!.id;
  await post(desk, '/shifts/open', { openingCash: '0' }).expect(200);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('checkout settles the bill and issues the invoice', () => {
  let s: { stayId: string; folioId: string };
  beforeAll(async () => {
    s = await stay('202', 'DLX');
    await post(desk, `/folios/${s.folioId}/charges`, { lineType: 'food', name: 'Paneer Tikka', quantity: 2, unitRate: '280' }).expect(200);
    await post(desk, `/folios/${s.folioId}/charges`, { lineType: 'activity', name: 'Jeep Safari', quantity: 2, unitRate: '1500' }).expect(200);
  });

  it('refuses to check out while money is owed, and says how much', async () => {
    const preview = (await desk.get(`/api/v1/stays/${s.stayId}/checkout-preview`).expect(200)).body;
    expect(preview.blockers.map((b: any) => b.step)).toEqual(['settlement']);
    const refused = await post(desk, `/stays/${s.stayId}/checkout`, {}).expect(400);
    expect(refused.body.message).toMatch(/still to pay/);
  });

  it('refuses while a security deposit is still held', async () => {
    await post(desk, `/folios/${s.folioId}/payments`, { entryType: 'deposit', method: 'cash', paymentAccountId: cash, amount: '1000' }).expect(200);
    const preview = (await desk.get(`/api/v1/stays/${s.stayId}/checkout-preview`).expect(200)).body;
    expect(preview.blockers.map((b: any) => b.step)).toContain('deposit');
    const bill = await billOf(s.stayId);
    await post(desk, `/folios/${s.folioId}/deposit/settle`, { adjust: '1000', refund: '0' }).expect(200);
    expect(Number((await billOf(s.stayId)).balance)).toBe(Number(bill.balance) - 1000);
  });

  it('with a mixed-rate bill paid, issues INV/26-27/00001, closes the bill, and the invoice adds up', async () => {
    const preview = (await post(desk, `/folios/${s.folioId}/invoice/preview`, {}, null).expect(200)).body;
    expect(preview.documentType).toBe('tax_invoice');
    expect(preview.groups.map((g: any) => g.ratePercent)).toEqual(['5.00', '18.00']);

    await payInFull(s.folioId, s.stayId);
    await post(desk, `/stays/${s.stayId}/checkout`, {}).expect(200);

    const bill = await billOf(s.stayId);
    expect(bill.status).toBe('closed');
    expect(bill.balance).toBe('0.00');
    const [doc] = bill.documents;
    expect(doc.number).toBe('INV/26-27/00001');

    const invoice = (await desk.get(`/api/v1/invoices/${doc.id}`).expect(200)).body;
    // Room 4,000 + food 560 at 5%; safari 3,000 at 18%.
    expect(invoice.groups).toEqual([
      expect.objectContaining({ ratePercent: '5.00', taxableValue: '4560.00', cgst: '114.00', sgst: '114.00' }),
      expect.objectContaining({ ratePercent: '18.00', taxableValue: '3000.00', cgst: '270.00', sgst: '270.00' }),
    ]);
    expect(invoice.grandTotal).toBe('8328.00');
    expect(invoice.lines.map((l: any) => l.description)).toEqual(['Room — Deluxe · Room 202', 'Paneer Tikka', 'Jeep Safari']);
    expect(invoice.placeOfSupply).toBe(invoice.seller.stateCode);
    expect(invoice.paid.reduce((t: number, p: any) => t + Number(p.amount), 0)).toBe(8328);
  });

  it('a pending balance needs the owner, and is recorded as authorised', async () => {
    const t = await stay('203', 'DLX');
    const refused = await post(desk, `/stays/${t.stayId}/checkout`, { steps: { settlement: { pendingBalance: true } } }).expect(403);
    expect(refused.body.details.reasons[0].action).toBe('pending_balance_checkout');
    const ok = await approve(desk, refused.body.details.authorisationId, await ownerId()).expect(200);
    await post(desk, `/stays/${t.stayId}/checkout`, { steps: { settlement: { pendingBalance: true, ownerAuthorisationId: ok.body.authorisationId } } }).expect(200);
    const bill = await billOf(t.stayId);
    expect(Number(bill.balance)).toBeGreaterThan(0);
    const [override] = await sql<{ action: string }>(`SELECT action FROM owner_overrides WHERE entity_id = $1`, [t.folioId]);
    expect(override!.action).toBe('pending_balance_checkout');
  });
});

describe('numbering (spec §31)', () => {
  it('bills finalised at the same moment get consecutive numbers — no gap, no duplicate', async () => {
    const stays = [];
    for (const room of ['103', '205', 'C2', 'C3', 'V2']) {
      const type = room.startsWith('C') ? 'PCOT' : room.startsWith('V') ? 'VILLA' : room.startsWith('1') ? 'STD' : 'DLX';
      const s2 = await stay(room, type);
      await payInFull(s2.folioId, s2.stayId);
      stays.push(s2);
    }
    const results = await Promise.all(stays.map((x) => post(owner, `/stays/${x.stayId}/checkout`, {})));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const seqs = (await sql<{ seq: number }>(`SELECT seq FROM invoices WHERE series = 'INV' ORDER BY seq`)).map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it('a rolled-back finalisation gives its number back', async () => {
    const [p] = await sql<{ id: string }>(`SELECT id FROM properties`);
    const c = new Client({ connectionString: MIGRATOR_URL.replace(/\/[^/]+$/, '/resortos_invoices_test') });
    await c.connect();
    try {
      await c.query('BEGIN');
      const taken = (await c.query(`SELECT next_document_number($1, 'INV', '26-27') AS n`, [p!.id])).rows[0].n;
      await c.query('ROLLBACK');
      const again = (await c.query(`SELECT next_document_number($1, 'INV', '26-27') AS n`, [p!.id])).rows[0].n;
      expect(again).toBe(taken);
      // Put the counter back where the application left it; the test above already proved the point.
      await c.query(`ALTER TABLE document_counters DISABLE TRIGGER document_counters_forward`);
      await c.query(`UPDATE document_counters SET last_number = last_number - 1 WHERE series = 'INV'`);
      await c.query(`ALTER TABLE document_counters ENABLE TRIGGER document_counters_forward`);
    } finally {
      await c.end();
    }
  });
});

describe('a finalised invoice never changes', () => {
  it('refuses update, delete, a line added later, and voiding a charge it contains', async () => {
    const [inv] = await sql<{ id: string; folio_id: string }>(`SELECT id, folio_id FROM invoices WHERE series = 'INV' ORDER BY seq LIMIT 1`);
    await expect(sql(`UPDATE invoices SET grand_total = 1 WHERE id = $1`, [inv!.id])).rejects.toThrow(/never changed/);
    await expect(sql(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [inv!.id])).rejects.toThrow(/never changed/);
    await expect(sql(
      `INSERT INTO invoice_lines (invoice_id, series, line_no, folio_line_id, business_date, description, sac, quantity, rate,
                                  gross_amount, discount_amount, taxable_value, gst_rate)
       SELECT $1, 'INV', 99, NULL, '2026-09-16', 'Extra', '996311', 1, 1, 1, 0, 1, 5`, [inv!.id],
    )).rejects.toThrow(/written whole/);
    const [line] = await sql<{ folio_line_id: string }>(`SELECT folio_line_id FROM invoice_lines WHERE invoice_id = $1 LIMIT 1`, [inv!.id]);
    await expect(sql(`UPDATE folio_lines SET voided_at = now(), voided_by = created_by, void_reason = 'test' WHERE id = $1`, [line!.folio_line_id]))
      .rejects.toThrow(/on an issued invoice/);
  });

  it('an invoice whose totals disagree with its lines does not commit', async () => {
    const [inv] = await sql<{ folio_id: string; property_id: string }>(`SELECT folio_id, property_id FROM invoices LIMIT 1`);
    await expect(sql(
      `INSERT INTO invoices (property_id, folio_id, document_type, series, financial_year, seq, number, invoice_date,
                             seller_legal_name, seller_address, seller_state_code, buyer_name, place_of_supply, supply_type,
                             taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, paid_at_issue, finalized_by)
       SELECT $1, $2, 'debit_note', 'DN', '26-27', 900, 'DN/26-27/00900', '2026-09-16', 'x', 'x', '08', 'x', '08', 'intra_state',
              100, 0, 0, 0, 0, 100, 0, u.id FROM users u WHERE u.role = 'owner'`,
      [inv!.property_id, inv!.folio_id],
    )).rejects.toThrow();
  });
});

describe('credit notes (spec §29.4)', () => {
  it('are the owner’s; a full one equals the original to the paisa, and nothing is left to credit after it', async () => {
    const [inv] = await sql<{ id: string }>(`SELECT id FROM invoices WHERE number = 'INV/26-27/00001'`);
    await post(desk, `/invoices/${inv!.id}/credit-note`, { reason: 'Cancelled' }).expect(403);
    const cn = (await post(owner, `/invoices/${inv!.id}/credit-note`, { reason: 'Guest disputed the whole stay' }).expect(200)).body;
    const original = (await owner.get(`/api/v1/invoices/${inv!.id}`).expect(200)).body;
    expect(cn.number).toBe('CN/26-27/00001');
    expect(cn.grandTotal).toBe(original.grandTotal);
    expect(cn.groups).toEqual(original.groups);
    expect(original.corrections.map((c: any) => c.number)).toEqual(['CN/26-27/00001']);
    await post(owner, `/invoices/${inv!.id}/credit-note`, { reason: 'Again' }).expect(400);
  });

  it('can credit part of one line, at the rate it was invoiced at, and never more than was sold', async () => {
    const [inv] = await sql<{ id: string }>(`SELECT id FROM invoices WHERE number = 'INV/26-27/00002'`);
    const detail = (await owner.get(`/api/v1/invoices/${inv!.id}`).expect(200)).body;
    const room = detail.lines[0];
    const cn = (await post(owner, `/invoices/${inv!.id}/credit-note`, {
      reason: 'AC not working one night', lines: [{ invoiceLineId: room.id, amount: '500' }],
    }).expect(200)).body;
    expect(cn.lines[0].gstRate).toBe(room.gstRate);
    expect(cn.taxableTotal).toBe('500.00');
    await post(owner, `/invoices/${inv!.id}/credit-note`, {
      reason: 'Too much', lines: [{ invoiceLineId: room.id, amount: String(Number(room.taxable) - 499) }],
    }).expect(400);
  });
});

describe('late charges (spec §22)', () => {
  it('only the owner adds one to a closed bill, and it goes on a debit note — the invoice is untouched', async () => {
    const [inv] = await sql<{ id: string; folio_id: string; grand_total: string }>(`SELECT id, folio_id, grand_total FROM invoices WHERE number = 'INV/26-27/00002'`);
    await post(desk, `/folios/${inv!.folio_id}/charges`, { lineType: 'other', name: 'Minibar', quantity: 1, unitRate: '300' }).expect(409);
    const bill = (await post(owner, `/folios/${inv!.folio_id}/charges`, { lineType: 'other', name: 'Minibar', quantity: 1, unitRate: '300' }).expect(200)).body;
    expect(bill.pendingInvoice).toBe(true);

    const dn = (await post(owner, `/folios/${inv!.folio_id}/debit-note`, { reason: 'Minibar found after checkout' }).expect(200)).body;
    expect(dn.number).toBe('DN/26-27/00001');
    expect(dn.original.id).toBe(inv!.id);
    expect(dn.lines.map((l: any) => l.description)).toEqual(['Minibar']);
    const [still] = await sql<{ grand_total: string }>(`SELECT grand_total FROM invoices WHERE id = $1`, [inv!.id]);
    expect(still!.grand_total).toBe(inv!.grand_total);
  });
});

describe('what the invoice is', () => {
  it('a property without a GSTIN issues a bill of supply with no tax', async () => {
    const [{ gstin }] = await sql<{ gstin: string }>(`SELECT gstin FROM properties`) as [{ gstin: string }];
    await sql(`UPDATE properties SET gstin = NULL`);
    try {
      const s = await stay('102', 'STD', [{ date: '2026-09-16', rate: '3000.00' }]);
      const preview = (await post(desk, `/folios/${s.folioId}/invoice/preview`, {}, null).expect(200)).body;
      expect(preview.documentType).toBe('bill_of_supply');
      expect(preview.cgstTotal).toBe('0.00');
    } finally {
      await sql(`UPDATE properties SET gstin = $1`, [gstin]);
    }
  });

  it('a rate that changes in the middle of a stay applies to each night by its own date', async () => {
    // Close the 5% accommodation band on the 16th and open a 12% one from the 17th.
    await sql(`UPDATE tax_rules SET effective_to = '2026-09-16' WHERE tax_category = 'accommodation' AND unit_value_up_to = 7500 AND effective_to IS NULL`);
    await sql(
      `INSERT INTO tax_rules (property_id, tax_category, unit_value_above, unit_value_up_to, rate_percent, sac, effective_from, note, origin)
       SELECT property_id, 'accommodation', NULL, 7500, 12, '996311', '2026-09-17', 'test', origin FROM tax_rules LIMIT 1`,
    );
    const s = await stay('V1', 'VILLA', [{ date: '2026-09-16', rate: '5000.00' }, { date: '2026-09-17', rate: '5000.00' }]);
    const preview = (await post(desk, `/folios/${s.folioId}/invoice/preview`, {}, null).expect(200)).body;
    expect(preview.lines.map((l: any) => l.gstRate)).toEqual(['5.00', '12.00']);
  });
});
