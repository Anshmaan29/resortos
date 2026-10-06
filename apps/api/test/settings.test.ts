import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootAppOnOwnDatabase, key, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/** Owner settings added in Sprint B (spec §4.5, §9–§11, §30, §34, §36, §40, §5.3). */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let owner: Agent;
let desk: Agent;

const patch = (agent: Agent, path: string, body: object) => agent.patch(`/api/v1${path}`).set('x-resortos', '1').send(body);

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('settings', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  owner = await login(app, 'owner');
  desk = await login(app, 'receptionist');
}, 120_000);
afterAll(async () => { await app.close(); });

describe('policies', () => {
  it('are the owner’s, versioned, audited, and email cannot be switched on without a sender', async () => {
    const { body: p } = await owner.get('/api/v1/property').expect(200);
    expect(p.policies).toMatchObject({ cashDifferenceThreshold: '100.00', receiptPaper: 'a4', emailEnabled: false, deskLockMinutes: 5, quietHoursStart: '21:30' });
    const next = { ...p.policies, version: p.version, cashDifferenceThreshold: '250', receiptPaper: 'thermal_80', emailEnabled: true, emailFromAddress: '' };
    await patch(desk, '/property/policies', next).expect(403);
    const refused = await patch(owner, '/property/policies', next).expect(400);
    expect(JSON.stringify(refused.body.details.fields)).toMatch(/sender address/);

    const saved = await patch(owner, '/property/policies', { ...next, emailFromAddress: 'stay@aravali.example' }).expect(200);
    expect(saved.body.policies).toMatchObject({ cashDifferenceThreshold: '250.00', receiptPaper: 'thermal_80', emailEnabled: true });
    await patch(owner, '/property/policies', { ...next, emailFromAddress: 'stay@aravali.example' }).expect(409);
    const [a] = await sql<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'property.policies_updated'`);
    expect(a).toBeTruthy();
  });
});

describe('rate plans and tax rules', () => {
  it('moves the default rate plan, and never leaves the property without one', async () => {
    const created = await post(owner, '/rate-plans', { code: 'CORP', name: 'Corporate', kind: 'corporate' }, null).expect(201);
    const plans = (await owner.get('/api/v1/rate-plans').expect(200)).body;
    const bar = plans.find((p: any) => p.isDefault);
    await patch(owner, `/rate-plans/${bar.id}`, { name: bar.name, kind: bar.kind, isActive: true, isDefault: false }).expect(400);
    await patch(owner, `/rate-plans/${created.body.id}`, { name: 'Corporate', kind: 'corporate', isActive: true, isDefault: true }).expect(200);
    const after = (await owner.get('/api/v1/rate-plans').expect(200)).body;
    expect(after.filter((p: any) => p.isDefault).map((p: any) => p.id)).toEqual([created.body.id]);
  });

  it('adds a dated tax rule, refuses an overlap, and closes a rule but never reopens it', async () => {
    const rules = (await owner.get('/api/v1/tax-rules').expect(200)).body;
    const laundry = rules.find((r: any) => r.taxCategory === 'laundry');
    // Overlaps the seeded open-ended laundry rule.
    await post(owner, '/tax-rules', { taxCategory: 'laundry', ratePercent: '12', sac: '999712', effectiveFrom: '2027-01-01' }).expect(409);
    await post(owner, `/tax-rules/${laundry.id}/close`, { effectiveTo: '2026-12-31' }).expect(200);
    await post(owner, '/tax-rules', { taxCategory: 'laundry', ratePercent: '12', sac: '999712', effectiveFrom: '2027-01-01', note: 'Confirmed by CA' }).expect(201);
    await post(owner, `/tax-rules/${laundry.id}/close`, { effectiveTo: '2027-06-30' }).expect(400);
    await desk.get('/api/v1/tax-rules').expect(200);
  });

  it('lets a receptionist change dated GST rules, with replay-safe writes and a recorded actor', async () => {
    const rules = (await desk.get('/api/v1/tax-rules').expect(200)).body;
    const activity = rules.find((r: any) => r.taxCategory === 'activity');
    const closeKey = key();
    await post(desk, `/tax-rules/${activity.id}/close`, { effectiveTo: '2039-12-31' }, closeKey).expect(200);
    await post(desk, `/tax-rules/${activity.id}/close`, { effectiveTo: '2039-12-31' }, closeKey).expect(200);
    const input = { taxCategory: 'activity', ratePercent: '7.25', sac: activity.sac, effectiveFrom: '2040-01-01' };
    await post(desk, '/tax-rules', input, null).expect(400);
    await post(desk, '/tax-rules', { ...input, ratePercent: '-1' }).expect(400);
    const createKey = key();
    const created = await post(desk, '/tax-rules', input, createKey).expect(201);
    const replay = await post(desk, '/tax-rules', input, createKey).expect(201);
    expect(replay.body).toEqual(created.body);
    const mismatch = await post(desk, '/tax-rules', { ...input, ratePercent: '8' }, createKey).expect(422);
    expect(mismatch.body.code).toBe('IDEMPOTENCY_MISMATCH');
    const [row] = await sql<{ rate_percent: string; role: string; changes: string; events: string }>(
      `SELECT t.rate_percent, u.role,
              (SELECT count(*) FROM audit_logs WHERE entity_id=t.id AND action='tax_rule.created')::text AS changes,
              (SELECT count(*) FROM outbox_events WHERE aggregate_id=t.id AND topic='tax_rule.created')::text AS events
         FROM tax_rules t JOIN users u ON u.id=t.created_by WHERE t.id=$1`, [created.body.id]);
    expect(row).toEqual({ rate_percent: '7.25', role: 'receptionist', changes: '1', events: '1' });
    const [closure] = await sql<{ count: string }>(`SELECT count(*)::text FROM audit_logs WHERE entity_id=$1 AND action='tax_rule.closed'`, [activity.id]);
    expect(closure!.count).toBe('1');
  });
});

describe('staff', () => {
  it('the owner sets a receptionist’s discount limit, and the server uses it', async () => {
    const users = (await owner.get('/api/v1/users').expect(200)).body;
    const priya = users.find((u: any) => u.role === 'receptionist');
    await patch(owner, `/users/${priya.id}`, { fullName: priya.fullName, discountLimitPercent: '25', canRunNightAudit: true }).expect(200);
    await patch(desk, `/users/${priya.id}`, { fullName: priya.fullName, discountLimitPercent: '100', canRunNightAudit: true }).expect(403);
    const again = await login(app, 'receptionist');
    expect((await again.get('/api/v1/auth/me').expect(200)).body.user.discountLimitPercent).toBe('25.00');
  });
});

describe('guests', () => {
  it('keep the language their messages go in', async () => {
    const created = await post(desk, '/guests', { firstName: 'Sita', lastName: 'Devi', mobile: '9820099001', preferredLanguage: 'hi' }, null).expect(201);
    expect(created.body.preferredLanguage).toBe('hi');
  });
});
