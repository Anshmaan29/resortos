import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve, bootAppOnOwnDatabase, booking, fixtures, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/**
 * Milestone 2.3 — payments, payment accounts and reversals (spec §25, §26).
 *
 * Own database, like the other Phase 2 suites: the interesting behaviour is what happens either
 * side of a night audit.
 */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let f: Awaited<ReturnType<typeof fixtures>>;
let stayId: string;
let folioId: string;
let accounts: Record<string, string> = {};
let companyId: string;

const bill = (agent: Agent = desk) => agent.get(`/api/v1/stays/${stayId}/bill`).expect(200);
const ownerId = async () => (await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`))[0]!.id;

async function checkInBySql(room: string, type: string, name: string, mobile: string): Promise<string> {
  const created = await post(owner, '/reservations', {
    ...booking({ roomTypeId: f.type(type), roomId: f.room(room), arrival: '2026-09-16', departure: '2026-09-19' }),
    guest: { firstName: name, lastName: 'Guest', mobile },
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
  const [stay] = await sql<{ id: string }>(`SELECT s.id FROM stays s JOIN reservation_rooms rr ON rr.id = s.reservation_room_id WHERE rr.reservation_id = $1`, [created.body.id]);
  return stay!.id;
}

async function runNightAudit(agent: Agent) {
  for (;;) {
    const { body } = await agent.get('/api/v1/night-audit').expect(200);
    const blocking = body.steps.filter((s: any) => s.blocking && s.items.length > 0);
    if (!blocking.length) return post(agent, '/night-audit/complete', { businessDate: body.businessDate }).expect(200);
    for (const step of blocking) {
      for (const item of step.items) {
        if (item.actions.includes('close_shift')) {
          const shift = await agent.get(`/api/v1/shifts/${item.id}`).expect(200);
          await post(agent, `/shifts/${item.id}/close`, { countedCash: shift.body.expectedCash, version: shift.body.version }).expect(200);
        } else if (item.actions.includes('no_show')) await post(agent, `/reservations/${item.id}/no-show`, {}).expect(200);
        else if (item.actions.includes('cancel')) await post(agent, `/reservations/${item.id}/cancel`, { reason: 'change_of_plans' }).expect(200);
        else await post(agent, `/stays/${item.id}/checkout`, { steps: { settlement: { pendingBalance: true } } }).expect(200);
      }
    }
  }
}

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('payments', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  f = await fixtures(sql);
  stayId = await checkInBySql('202', 'DLX', 'Pay', '9820044001');
  folioId = (await bill()).body.id;

  for (const [name, kind] of [['Cash counter', 'cash'], ['HDFC current', 'bank'], ['UPI — resort QR', 'upi'], ['Card machine', 'card_pos']] as const) {
    const created = await post(owner, '/payment-accounts', { name, kind }).expect(201);
    accounts[kind] = created.body.id;
  }
  await post(desk, '/shifts/open', { openingCash: '2000' }).expect(200);
  companyId = (await post(owner, '/companies', { name: 'Acme Travels', gstin: '' }, null).expect(201)).body.id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('where the money landed', () => {
  it('records a payment against an account, and the bill balance follows', async () => {
    const before = await bill();
    const after = await post(desk, `/folios/${folioId}/payments`, {
      method: 'cash', paymentAccountId: accounts.cash, amount: '5000',
    }).expect(200);

    expect(after.body.paid).toBe('5000.00');
    expect(Number(after.body.balance)).toBe(Number(before.body.balance) - 5000);
    const payment = after.body.payments.at(-1);
    expect(payment.number).toMatch(/^PAY-\d{6}$/);
    expect(payment.method).toBe('cash');
    expect(payment.accountName).toBe('Cash counter');
    expect(payment.status).toBe('recorded');
    expect(payment.businessDate).toBe('2026-09-16');
  });

  it('refuses UPI money into the cash counter — in the API and again in the database', async () => {
    const refused = await post(desk, `/folios/${folioId}/payments`, {
      method: 'upi', paymentAccountId: accounts.cash, amount: '1000', reference: 'UTR123',
    }).expect(400);
    expect(refused.body.message).toMatch(/upi money cannot be recorded against a cash account/i);

    // The API's check is a courtesy; this is the one that makes it true.
    await expect(sql(
      `INSERT INTO payments (property_id, number, folio_id, reservation_id, guest_id, entry_type, method,
                             payment_account_id, account_kind, amount, business_date, received_by)
       SELECT f.property_id, 'PAY-RAW-1', f.id, f.reservation_id, r.primary_guest_id, 'payment', 'upi',
              a.id, a.kind, 100, '2026-09-16', u.id
         FROM folios f JOIN reservations r ON r.id = f.reservation_id, payment_accounts a, users u
        WHERE f.id = $1 AND a.kind = 'cash' AND u.role = 'owner'`,
      [folioId],
    )).rejects.toThrow(/payments_account_matches_method/);
  });

  it('asks for the reference the method needs, and no account for a settlement that moves no money', async () => {
    const noRef = await post(desk, `/folios/${folioId}/payments`, {
      method: 'upi', paymentAccountId: accounts.upi, amount: '1000',
    }).expect(400);
    expect(JSON.stringify(noRef.body.details.fields)).toMatch(/UTR or transaction ID/i);

    const withAccount = await post(desk, `/folios/${folioId}/payments`, {
      method: 'company_account', companyId, paymentAccountId: accounts.bank, amount: '1000',
    }).expect(400);
    expect(JSON.stringify(withAccount.body.details.fields)).toMatch(/moves no money/i);

    // Company account settles the bill without money changing hands, so it takes no account.
    const ok = await post(desk, `/folios/${folioId}/payments`, { method: 'company_account', companyId, amount: '1000' }).expect(200);
    expect(ok.body.payments.at(-1).accountId).toBeNull();
  });

  it('keeps an account-wise ledger, recalculated from the rows', async () => {
    const ledger = await owner.get('/api/v1/payment-accounts/balances').expect(200);
    const cash = ledger.body.find((a: any) => a.id === accounts.cash);
    expect(cash.balance).toBe('5000.00');
    expect(cash.entries).toBe(1);
    const card = ledger.body.find((a: any) => a.id === accounts.card_pos);
    expect(card.balance).toBe('0.00');
  });

  it('will not let an account change kind once money has gone through it', async () => {
    const [account] = await sql<{ id: string; version: number }>(`SELECT id, version FROM payment_accounts WHERE id = $1`, [accounts.cash]);
    const refused = await owner.patch(`/api/v1/payment-accounts/${account!.id}`).set('x-resortos', '1')
      .send({ name: 'Cash counter', kind: 'bank', version: account!.version }).expect(409);
    expect(refused.body.message).toMatch(/already has payments against it/);
  });
});

describe('advances taken before the guest arrives', () => {
  it('are recorded on the booking and carry to the bill once there is one', async () => {
    const future = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('PRE'), roomId: f.room('108'), arrival: '2026-09-17', departure: '2026-09-18' }),
      guest: { firstName: 'Advance', lastName: 'Guest', mobile: '9820044002' },
    }).expect(201);

    const advance = await post(desk, `/reservations/${future.body.id}/advance`, {
      method: 'upi', paymentAccountId: accounts.upi, amount: '3000', reference: 'UTR-4821',
    }).expect(200);
    expect(advance.body.number).toMatch(/^PAY-\d{6}$/);

    const [row] = await sql<{ entry_type: string; folio_id: string | null; signed_amount: string }>(
      `SELECT entry_type, folio_id, bill_effect AS signed_amount FROM payments WHERE number = $1`, [advance.body.number],
    );
    expect(row!.entry_type).toBe('advance');
    // No bill yet — it belongs to the booking until the guest checks in.
    expect(row!.folio_id).toBeNull();
    expect(row!.signed_amount).toBe('3000.00');
  });
});

describe('an advance on a booking that is then cancelled (spec §15.1)', () => {
  it('must be decided, and "keep as credit" puts it in the guest credit ledger', async () => {
    const res = await post(owner, '/reservations', booking({ roomTypeId: f.type('EXE'), roomId: f.room('107'), arrival: '2026-09-25', departure: '2026-09-26' })).expect(201);
    await post(desk, `/reservations/${res.body.id}/advance`, { method: 'upi', paymentAccountId: accounts.upi, amount: '2000', reference: 'UTR-C1' }).expect(200);
    expect((await owner.get(`/api/v1/reservations/${res.body.id}`).expect(200)).body.advancePaid).toBe('2000.00');

    const undecided = await post(owner, `/reservations/${res.body.id}/cancel`, { reason: 'change_of_plans' }).expect(400);
    expect(undecided.body.message).toMatch(/advance of ₹2,000/);
    await post(owner, `/reservations/${res.body.id}/cancel`, { reason: 'change_of_plans', moneyOption: 'guest_credit' }).expect(200);
    const [credit] = await sql<{ amount: string }>(`SELECT amount FROM guest_credit_entries WHERE reservation_id = $1`, [res.body.id]);
    expect(credit!.amount).toBe('2000.00');
  });

  it('can be refunded after cancelling, with Owner PIN like every refund', async () => {
    const res = await post(owner, '/reservations', booking({ roomTypeId: f.type('EXE'), roomId: f.room('107'), arrival: '2026-09-27', departure: '2026-09-28' })).expect(201);
    await post(desk, `/reservations/${res.body.id}/advance`, { method: 'upi', paymentAccountId: accounts.upi, amount: '1500', reference: 'UTR-C2' }).expect(200);
    await post(owner, `/reservations/${res.body.id}/cancel`, { reason: 'guest_request', moneyOption: 'refund' }).expect(200);
    await post(desk, `/reservations/${res.body.id}/advance`, { method: 'upi', paymentAccountId: accounts.upi, amount: '10', reference: 'x' }).expect(409);
    const refused = await post(desk, `/reservations/${res.body.id}/advance`, { entryType: 'refund', method: 'upi', paymentAccountId: accounts.upi, amount: '1500', reference: 'UTR-R2' }).expect(403);
    expect(refused.body.code).toBe('OWNER_PIN_REQUIRED');
    await post(owner, `/reservations/${res.body.id}/advance`, { entryType: 'refund', method: 'upi', paymentAccountId: accounts.upi, amount: '1500', reference: 'UTR-R2' }).expect(200);
    expect((await owner.get(`/api/v1/reservations/${res.body.id}`).expect(200)).body.advancePaid).toBe('0.00');
  });
});

describe('a refund', () => {
  it('needs Owner PIN, and takes money out rather than putting it in', async () => {
    const refused = await post(desk, `/folios/${folioId}/payments`, {
      entryType: 'refund', method: 'cash', paymentAccountId: accounts.cash, amount: '500',
    }).expect(403);
    expect(refused.body.code).toBe('OWNER_PIN_REQUIRED');
    expect(refused.body.details.reasons[0].description).toMatch(/Refund of ₹500/);

    const approved = await approve(desk, refused.body.details.authorisationId, await ownerId()).expect(200);
    const done = await post(desk, `/folios/${folioId}/payments`, {
      entryType: 'refund', method: 'cash', paymentAccountId: accounts.cash, amount: '500',
      ownerAuthorisationId: approved.body.authorisationId,
    }).expect(200);

    const refund = done.body.payments.at(-1);
    expect(refund.entryType).toBe('refund');
    expect(refund.billEffect).toBe('-500.00');
    expect(Number(done.body.paid)).toBe(5000 + 1000 - 500);
  });
});

describe('correcting a payment', () => {
  it('is a new row that reverses the old one — nothing is overwritten', async () => {
    const { body: before } = await bill();
    const target = before.payments.find((p: any) => p.method === 'cash' && !p.isReversal && !p.reversed);
    const paidBefore = Number(before.paid);

    const reversal = await post(desk, `/payments/${target.id}/reverse`, { reason: 'Counted twice' }).expect(200);
    expect(reversal.body.number).toMatch(/^PAY-\d{6}$/);

    const { body: after } = await bill();
    const original = after.payments.find((p: any) => p.id === target.id);
    // The original is untouched and still shows its own numbers.
    expect(original.amount).toBe(target.amount);
    expect(original.status).toBe('reversed');
    expect(original.reversedReason).toBe('Counted twice');

    const row = after.payments.find((p: any) => p.reverses === target.id);
    expect(row.isReversal).toBe(true);
    expect(row.billEffect).toBe(`-${target.amount}`);
    expect(Number(after.paid)).toBe(paidBefore - Number(target.amount));
  });

  it('can only happen once, and never to a reversal', async () => {
    const { body } = await bill();
    const reversed = body.payments.find((p: any) => p.reversed);
    await post(desk, `/payments/${reversed.id}/reverse`, { reason: 'Again' }).expect(409);

    const reversal = body.payments.find((p: any) => p.isReversal);
    await post(desk, `/payments/${reversal.id}/reverse`, { reason: 'Undo the undo' }).expect(409);

    // And the database refuses a second reversal even by hand.
    await expect(sql(
      `INSERT INTO payments (property_id, number, folio_id, reservation_id, guest_id, entry_type, method,
                             amount, business_date, received_by, reverses_payment_id, reversal_reason)
       SELECT p.property_id, 'PAY-RAW-2', p.folio_id, p.reservation_id, p.guest_id, p.entry_type, 'guest_credit',
              p.amount, p.business_date, p.received_by, p.id, 'twice'
         FROM payments p WHERE p.id = $1`,
      [reversed.id],
    )).rejects.toThrow(/payments_one_reversal/);
  });

  it('is never an edit: the database refuses to change or delete a payment', async () => {
    const [payment] = await sql<{ id: string }>(`SELECT id FROM payments LIMIT 1`);
    await expect(sql(`UPDATE payments SET amount = 1 WHERE id = $1`, [payment!.id])).rejects.toThrow(/never edited/);
    await expect(sql(`DELETE FROM payments WHERE id = $1`, [payment!.id])).rejects.toThrow(/payments are kept/);
  });
});

describe('an advance taken before arrival', () => {
  it('counts on the bill once the guest is in house, without the payment row being changed', async () => {
    const stay2 = await checkInBySql('203', 'DLX', 'Adv', '9820044010');
    const [res] = await sql<{ reservation_id: string }>(`SELECT reservation_id FROM stays WHERE id = $1`, [stay2]);
    // Taken before there was a bill: the row has no folio.
    await sql(`UPDATE reservations SET status = 'confirmed' WHERE id = $1`, [res!.reservation_id]).catch(() => undefined);
    const [row] = await sql<{ id: string }>(
      `INSERT INTO payments (property_id, number, reservation_id, guest_id, entry_type, method, payment_account_id, account_kind,
                             amount, reference, business_date, received_by)
       SELECT r.property_id, 'PAY-ADV-1', r.id, r.primary_guest_id, 'advance', 'upi', a.id, a.kind, 2500, 'UTR-9', '2026-09-16', u.id
         FROM reservations r, payment_accounts a, users u
        WHERE r.id = $1 AND a.id = $2 AND u.role = 'owner' RETURNING id`,
      [res!.reservation_id, accounts.upi],
    );
    const { body } = await desk.get(`/api/v1/stays/${stay2}/bill`).expect(200);
    expect(body.paid).toBe('2500.00');
    expect(body.payments.map((p: any) => p.id)).toContain(row!.id);
    const [still] = await sql<{ folio_id: string | null }>(`SELECT folio_id FROM payments WHERE id = $1`, [row!.id]);
    expect(still!.folio_id).toBeNull();
  });
});

describe('a security deposit', () => {
  let depositStay: string;
  let depositFolio: string;

  beforeAll(async () => {
    depositStay = await checkInBySql('103', 'DLX', 'Dep', '9820044011');
    depositFolio = (await desk.get(`/api/v1/stays/${depositStay}/bill`).expect(200)).body.id;
    await post(desk, `/folios/${depositFolio}/charges`, { lineType: 'food', name: 'Dinner', quantity: 1, unitRate: '1000' }).expect(200);
  });

  it('is held, not paid: it does not reduce the balance and is not income', async () => {
    const before = (await desk.get(`/api/v1/stays/${depositStay}/bill`).expect(200)).body;
    const after = (await post(desk, `/folios/${depositFolio}/payments`, {
      entryType: 'deposit', method: 'cash', paymentAccountId: accounts.cash, amount: '3000',
    }).expect(200)).body;
    expect(after.depositHeld).toBe('3000.00');
    expect(after.paid).toBe('0.00');
    expect(after.balance).toBe(before.balance);
  });

  it('is refused as a settlement that moves no money', async () => {
    const refused = await post(desk, `/folios/${depositFolio}/payments`, {
      entryType: 'deposit', method: 'company_account', companyId, amount: '100',
    }).expect(400);
    expect(JSON.stringify(refused.body.details.fields)).toMatch(/real money/);
  });

  it('must be fully accounted for, and an unusual split needs the owner', async () => {
    const { body } = await desk.get(`/api/v1/stays/${depositStay}/bill`).expect(200);
    const due = Number(body.balance);
    // Adding up to less than what is held is refused outright.
    await post(desk, `/folios/${depositFolio}/deposit/settle`, {
      adjust: '0', refund: '1000', refundMethod: 'cash', refundAccountId: accounts.cash,
    }).expect(400);
    // Applying more than the bill owes (keeping money the bill does not explain) needs Owner PIN.
    const odd = await post(desk, `/folios/${depositFolio}/deposit/settle`, {
      adjust: String(due + 500), refund: String(3000 - due - 500), refundMethod: 'cash', refundAccountId: accounts.cash,
    }).expect(403);
    expect(odd.body.details.reasons[0].action).toBe('deposit_part_refund');
  });

  it('applies what the bill owes and gives back the rest, with no PIN', async () => {
    const { body } = await desk.get(`/api/v1/stays/${depositStay}/bill`).expect(200);
    const due = Number(body.balance);
    const done = (await post(desk, `/folios/${depositFolio}/deposit/settle`, {
      adjust: String(due), refund: String(3000 - due), refundMethod: 'cash', refundAccountId: accounts.cash,
    }).expect(200)).body;
    expect(done.depositHeld).toBe('0.00');
    expect(done.balance).toBe('0.00');
    const types = done.payments.map((p: any) => p.entryType);
    expect(types).toEqual(expect.arrayContaining(['deposit', 'deposit_adjustment', 'deposit_refund']));
  });
});

describe('guest credit', () => {
  it('can be spent only up to what the guest has, and a reversal gives it back', async () => {
    const [guest] = await sql<{ guest_id: string; property_id: string; reservation_id: string }>(
      `SELECT r.primary_guest_id AS guest_id, r.property_id, r.id AS reservation_id FROM folios f JOIN reservations r ON r.id = f.reservation_id WHERE f.id = $1`, [folioId],
    );
    await sql(`INSERT INTO guest_credit_entries (property_id, guest_id, amount, note) VALUES ($1,$2,700,'Kept from a cancellation')`, [guest!.property_id, guest!.guest_id]);

    const tooMuch = await post(desk, `/folios/${folioId}/payments`, { method: 'guest_credit', amount: '800' }).expect(400);
    expect(tooMuch.body.message).toMatch(/₹700/);

    const used = await post(desk, `/folios/${folioId}/payments`, { method: 'guest_credit', amount: '700' }).expect(200);
    const credit = async () => (await sql<{ s: string }>(`SELECT COALESCE(sum(amount),0) AS s FROM guest_credit_entries WHERE guest_id = $1`, [guest!.guest_id]))[0]!.s;
    expect(await credit()).toBe('0.00');

    await post(desk, `/payments/${used.body.payments.at(-1).id}/reverse`, { reason: 'Wrong guest' }).expect(200);
    expect(await credit()).toBe('700.00');
  });
});

describe('cashier shifts', () => {
  it('refuses cash with no shift open — in the API and in the database', async () => {
    const other = await login(app, 'owner');
    // The owner has no shift of their own.
    const refused = await post(other, `/folios/${folioId}/payments`, { method: 'cash', paymentAccountId: accounts.cash, amount: '10' }).expect(409);
    expect(refused.body.details.action).toBe('open_shift');
    await expect(sql(
      `INSERT INTO payments (property_id, number, reservation_id, guest_id, entry_type, method, payment_account_id, account_kind,
                             amount, business_date, received_by)
       SELECT r.property_id, 'PAY-RAW-3', r.id, r.primary_guest_id, 'payment', 'cash', a.id, a.kind, 10, '2026-09-16', u.id
         FROM reservations r, payment_accounts a, users u WHERE a.kind = 'cash' AND u.role = 'owner' LIMIT 1`,
    )).rejects.toThrow(/payments_cash_in_shift/);
  });

  it("will not put money into someone else's shift", async () => {
    const [shift] = await sql<{ id: string }>(`SELECT id FROM cashier_shifts WHERE closed_at IS NULL LIMIT 1`);
    await expect(sql(
      `INSERT INTO payments (property_id, number, reservation_id, guest_id, entry_type, method, payment_account_id, account_kind,
                             amount, business_date, received_by, cashier_shift_id)
       SELECT r.property_id, 'PAY-RAW-4', r.id, r.primary_guest_id, 'payment', 'cash', a.id, a.kind, 10, '2026-09-16', u.id, $1
         FROM reservations r, payment_accounts a, users u WHERE a.kind = 'cash' AND u.role = 'owner' LIMIT 1`, [shift!.id],
    )).rejects.toThrow(/shift of the person who took it/);
  });

  it('expects opening cash plus the cash taken, and wants a reason for a difference above the threshold', async () => {
    const current = (await desk.get('/api/v1/shifts/current').expect(200)).body.shift;
    const cashIn = current.accounts.filter((a: any) => a.kind === 'cash').reduce((t: number, a: any) => t + Number(a.amount), 0);
    expect(Number(current.expectedCash)).toBe(2000 + cashIn);

    const short = await post(desk, `/shifts/${current.id}/close`, {
      countedCash: String(Number(current.expectedCash) - 500), version: current.version,
    }).expect(400);
    expect(short.body.message).toMatch(/short by ₹500/);

    // Within the ₹100 threshold, no reason is needed.
    const closed = (await post(desk, `/shifts/${current.id}/close`, {
      countedCash: String(Number(current.expectedCash) - 50), version: current.version, handoverNote: 'Key for 107 at the desk',
    }).expect(200)).body;
    expect(closed.status).toBe('closed');
    expect(closed.cashDifference).toBe('-50.00');
  });

  it('a closed shift is locked, and takes no more money', async () => {
    const [shift] = await sql<{ id: string }>(`SELECT id FROM cashier_shifts WHERE closed_at IS NOT NULL LIMIT 1`);
    await expect(sql(`UPDATE cashier_shifts SET counted_cash = 1 WHERE id = $1`, [shift!.id])).rejects.toThrow(/closed shift cannot be changed/);
    await expect(sql(`DELETE FROM cashier_shifts WHERE id = $1`, [shift!.id])).rejects.toThrow(/shift history is kept/);
  });

  it('two shifts at once for one person are refused by the database', async () => {
    const opened = await Promise.allSettled([0, 1, 2].map(() => post(desk, '/shifts/open', { openingCash: '100' })));
    const ok = opened.filter((r) => r.status === 'fulfilled' && r.value.status === 200);
    expect(ok).toHaveLength(1);
  });

  it('the ledger shows every movement with a running balance', async () => {
    const ledger = (await owner.get(`/api/v1/payment-accounts/${accounts.cash}/ledger`).expect(200)).body;
    const total = ledger.lines.reduce((t: number, l: any) => t + Number(l.amount), 0);
    expect(Number(ledger.closingBalance)).toBe(total);
    expect(ledger.lines.at(-1).balance).toBe(ledger.closingBalance);
  });
});

describe('after night audit has closed the day', () => {
  it('refuses new money on the closed date and says where to put it', async () => {
    await runNightAudit(owner);
    const refused = await post(desk, `/folios/${folioId}/payments`, {
      method: 'cash', paymentAccountId: accounts.cash, amount: '100', businessDate: '2026-09-16',
    }).expect(409);
    expect(refused.body.message).toMatch(/Night audit has closed 16 Sep 2026\./);
  });

  it('needs Owner PIN to reverse a payment from it, and records the reversal on today', async () => {
    await post(desk, '/shifts/open', { openingCash: '0' }).expect(200);
    const { body } = await bill();
    const old = body.payments.find((p: any) => p.businessDate === '2026-09-16' && !p.reversed && !p.isReversal);
    const refused = await post(desk, `/payments/${old.id}/reverse`, { reason: 'Wrong guest' }).expect(403);
    expect(refused.body.code).toBe('OWNER_PIN_REQUIRED');

    const approved = await approve(desk, refused.body.details.authorisationId, await ownerId()).expect(200);
    const done = await post(desk, `/payments/${old.id}/reverse`, { reason: 'Wrong guest', ownerAuthorisationId: approved.body.authorisationId }).expect(200);

    const [row] = await sql<{ business_date: string; authorised_by: string | null }>(
      `SELECT business_date, authorised_by FROM payments WHERE number = $1`, [done.body.number],
    );
    // The correction happens now, not in the closed past.
    expect(row!.business_date).toBe('2026-09-17');
    expect(row!.authorised_by).toBeTruthy();
  });
});

describe('the nightly integrity check', () => {
  it('reports what is wrong and repairs nothing', async () => {
    const preview = await owner.get('/api/v1/night-audit').expect(200);
    const step = preview.body.steps.find((s: any) => s.name === 'integrity_check');
    expect(step).toBeTruthy();
    expect(step.blocking).toBe(false);

    // Break something the check looks for, by hand — the app has no way to do this.
    const [payment] = await sql<{ id: string; number: string }>(
      `SELECT id, number FROM payments WHERE folio_id IS NOT NULL AND reverses_payment_id IS NULL LIMIT 1`,
    );
    const [other] = await sql<{ id: string }>(`SELECT id FROM reservations WHERE id <> (SELECT reservation_id FROM payments WHERE id = $1) LIMIT 1`, [payment!.id]);
    await sql(`ALTER TABLE payments DISABLE TRIGGER payments_no_update`);
    await sql(`UPDATE payments SET reservation_id = $2 WHERE id = $1`, [payment!.id, other!.id]);
    await sql(`ALTER TABLE payments ENABLE TRIGGER payments_no_update`);

    const after = await owner.get('/api/v1/night-audit').expect(200);
    const found = after.body.steps.find((s: any) => s.name === 'integrity_check');
    expect(found.warnings.join(' ')).toContain(payment!.number);
    expect(found.warnings.join(' ')).toMatch(/bill for a different booking/);
    expect(after.body.summary.integrityFindings).toBeGreaterThan(0);

    // Reported, not repaired: the row is exactly as it was left.
    const [still] = await sql<{ reservation_id: string }>(`SELECT reservation_id FROM payments WHERE id = $1`, [payment!.id]);
    expect(still!.reservation_id).toBe(other!.id);
  });
});
