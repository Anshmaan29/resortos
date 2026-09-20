import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootAppOnOwnDatabase, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/**
 * Expenses (spec §39): money out, recorded the way money in is — append-only, into an account,
 * corrected by a reversing row and never edited.
 */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let accounts: Record<string, string> = {};
let categories: Record<string, string> = {};

const shiftNow = async (agent: Agent) => (await agent.get('/api/v1/shifts/current').expect(200)).body;

/** Closes whatever the audit is waiting on and moves the business date on. */
async function runNightAudit() {
  for (;;) {
    const { body } = await owner.get('/api/v1/night-audit').expect(200);
    const blocking = body.steps.filter((st: any) => st.blocking && st.items.length > 0);
    if (!blocking.length) return post(owner, '/night-audit/complete', { businessDate: body.businessDate }).expect(200);
    for (const item of blocking.flatMap((st: any) => st.items)) {
      if (item.actions.includes('close_shift')) {
        const shift = await owner.get(`/api/v1/shifts/${item.id}`).expect(200);
        await post(owner, `/shifts/${item.id}/close`, { countedCash: shift.body.expectedCash, version: shift.body.version }).expect(200);
      } else if (item.actions.includes('no_show')) await post(owner, `/reservations/${item.id}/no-show`, {}).expect(200);
      else if (item.actions.includes('cancel')) await post(owner, `/reservations/${item.id}/cancel`, { reason: 'change_of_plans' }).expect(200);
      else await post(owner, `/stays/${item.id}/checkout`, { steps: { settlement: { pendingBalance: true } } }).expect(200);
    }
  }
}

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('expenses', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  for (const [name, kind] of [['Cash counter', 'cash'], ['HDFC current', 'bank']] as const) {
    const created = await post(owner, '/payment-accounts', { name, kind }).expect(201);
    accounts[kind] = created.body.id;
  }
  for (const c of (await owner.get('/api/v1/expense-categories').expect(200)).body) categories[c.name] = c.id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('recording', () => {
  it('starts with the categories from the spec, which only the owner changes', async () => {
    expect(Object.keys(categories)).toEqual(expect.arrayContaining(['Electricity', 'Salaries', 'Groceries', 'Repairs', 'Diesel', 'Marketing', 'Other']));
    await post(desk, '/expense-categories', { name: 'Gardening' }).expect(403);
    const created = await post(owner, '/expense-categories', { name: 'Gardening', sortOrder: 7 }).expect(201);
    expect(created.body.id).toBeTruthy();
  });

  it('needs an open shift for cash, and takes that cash out of the shift', async () => {
    const entry = {
      categoryId: categories.Diesel, expenseDate: TEST_BUSINESS_DATE, method: 'cash',
      paymentAccountId: accounts.cash, amount: '1500', paidTo: 'Bharat Petroleum',
    };
    const refused = await post(desk, '/expenses', entry).expect(409);
    expect(refused.body.details).toMatchObject({ action: 'open_shift' });

    await post(desk, '/shifts/open', { openingCash: '2000', paymentAccountId: accounts.cash }).expect(200);
    const before = await shiftNow(desk);
    const created = await post(desk, '/expenses', entry).expect(201);
    expect(created.body.number).toMatch(/^EXP-/);

    const after = await shiftNow(desk);
    expect(Number(after.expectedCash)).toBe(Number(before.expectedCash) - 1500);
    const [ledger] = await sql<{ source: string; amount: string; reference: string }>(
      `SELECT source, amount, reference FROM account_ledger WHERE source = 'expense'`,
    );
    expect(ledger).toMatchObject({ source: 'expense', amount: '-1500.00', reference: created.body.number });
  });

  it('refuses a future date and an account that does not match the method', async () => {
    await post(desk, '/expenses', {
      categoryId: categories.Repairs, expenseDate: '2030-01-01', method: 'cash', paymentAccountId: accounts.cash,
      amount: '100', paidTo: 'Someone',
    }).expect(400);
    await post(desk, '/expenses', {
      categoryId: categories.Repairs, expenseDate: TEST_BUSINESS_DATE, method: 'cash', paymentAccountId: accounts.bank,
      amount: '100', paidTo: 'Someone',
    }).expect(400);
  });
});

describe('correcting', () => {
  it('writes a reversal and the right entry together, and never edits the original', async () => {
    const original = await post(desk, '/expenses', {
      categoryId: categories.Groceries, expenseDate: TEST_BUSINESS_DATE, method: 'bank_transfer',
      paymentAccountId: accounts.bank, amount: '8000', paidTo: 'Sabzi Mandi', note: 'Weekly vegetables',
    }).expect(201);

    const corrected = await post(desk, `/expenses/${original.body.id}/correct`, {
      categoryId: categories.Groceries, expenseDate: TEST_BUSINESS_DATE, method: 'bank_transfer',
      paymentAccountId: accounts.bank, amount: '6800', paidTo: 'Sabzi Mandi', note: 'Weekly vegetables',
      reason: 'Bill read wrong',
    }).expect(200);
    expect(corrected.body).toMatchObject({ number: expect.stringMatching(/^EXP-/), reversalNumber: expect.stringMatching(/^EXP-/) });

    const list = (await desk.get(`/api/v1/expenses?from=${TEST_BUSINESS_DATE}&to=${TEST_BUSINESS_DATE}`).expect(200)).body;
    const groceries = list.byCategory.find((c: any) => c.category === 'Groceries');
    expect(groceries.total).toBe('6800.00');
    expect(list.expenses.find((e: any) => e.id === original.body.id)).toMatchObject({ reversed: true });

    // Once corrected, that entry is finished with.
    await post(desk, `/expenses/${original.body.id}/correct`, {
      categoryId: categories.Groceries, expenseDate: TEST_BUSINESS_DATE, method: 'bank_transfer',
      paymentAccountId: accounts.bank, amount: '1', paidTo: 'Sabzi Mandi', reason: 'Again',
    }).expect(409);
    await expect(sql(`UPDATE expenses SET amount = 1 WHERE id = $1`, [original.body.id])).rejects.toThrow(/never edited/);
  });

  it('belongs to whoever recorded it while the day is open, and to the owner once it is closed', async () => {
    const mine = await post(owner, '/expenses', {
      categoryId: categories.Marketing, expenseDate: TEST_BUSINESS_DATE, method: 'bank_transfer',
      paymentAccountId: accounts.bank, amount: '2500', paidTo: 'Print shop',
    }).expect(201);
    // The receptionist did not record it and it is not their day to correct.
    await post(desk, `/expenses/${mine.body.id}/reverse`, { reason: 'Not mine to reverse' }).expect(403);

    const yesterday = await post(owner, '/expenses', {
      categoryId: categories.Electricity, expenseDate: TEST_BUSINESS_DATE, method: 'bank_transfer',
      paymentAccountId: accounts.bank, amount: '12000', paidTo: 'JVVNL',
    }).expect(201);
    // Night audit closes the day; from now on that entry belongs to a day the desk cannot touch.
    await runNightAudit();
    await post(desk, `/expenses/${yesterday.body.id}/reverse`, { reason: 'Wrong meter' }).expect(403);
    const byOwner = await post(owner, `/expenses/${yesterday.body.id}/reverse`, { reason: 'Wrong meter' }).expect(200);
    expect(byOwner.body.number).toMatch(/^EXP-/);
  });
});

describe('the monthly report', () => {
  it('adds up what was spent per category, net of corrections, for the owner only', async () => {
    const month = TEST_BUSINESS_DATE.slice(0, 7);
    await desk.get(`/api/v1/expenses/monthly?month=${month}`).expect(403);
    const report = (await owner.get(`/api/v1/expenses/monthly?month=${month}`).expect(200)).body;
    const groceries = report.categories.find((c: any) => c.category === 'Groceries');
    expect(groceries).toMatchObject({ total: '6800.00', entries: 2 });
    const diesel = report.categories.find((c: any) => c.category === 'Diesel');
    expect(diesel.total).toBe('1500.00');
    // Electricity was reversed in full, so the month shows nothing for it.
    expect(report.categories.find((c: any) => c.category === 'Electricity')?.total ?? '0.00').toBe('0.00');
  });
});
