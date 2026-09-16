import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve, booking, bootApp, createStaff, fixtures, login, post, sql, type Agent } from './helpers';

/** Owner PIN approvals (spec §4.5): single use, 2-minute expiry, bound to exact values. Real PostgreSQL. */
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

const lowRate = (rate: string, arrival = '2027-02-02', departure = '2027-02-03', mobile = '9811100001') => ({
  ...booking({ roomTypeId: f.type('DLX'), arrival, departure, nightlyRate: rate }),
  guest: { firstName: 'Pin', lastName: 'Test', mobile },
});

async function pendingFor(body: object) {
  const res = await post(desk, '/reservations', body);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('OWNER_PIN_REQUIRED');
  return res.body.details.authorisationId as string;
}

describe('owner authorisation lifecycle', () => {
  it('explains exactly what needs approval', async () => {
    const res = await post(desk, '/reservations', lowRate('2000'));
    expect(res.body.code).toBe('OWNER_PIN_REQUIRED');
    expect(res.body.details.description).toBe('Rate ₹2,000 is below the minimum ₹3,200');
  });

  it('cannot be used before the owner approves it', async () => {
    const body = lowRate('2000');
    const id = await pendingFor(body);
    const res = await post(desk, '/reservations', { ...body, ownerAuthorisationId: id });
    expect(res.body.code).toBe('OWNER_AUTHORISATION_INVALID');
    expect(res.body.details.problem).toMatch(/not approved/);
  });

  it('is bound to the exact values: a different rate is refused and the approval stays unused', async () => {
    const body = lowRate('2000', '2027-02-04', '2027-02-05', '9811100002');
    const id = await pendingFor(body);
    await approve(desk, id, f.ownerId).expect(200);

    const tampered = await post(desk, '/reservations', { ...lowRate('1500', '2027-02-04', '2027-02-05', '9811100002'), ownerAuthorisationId: id });
    expect(tampered.body.code).toBe('OWNER_AUTHORISATION_INVALID');
    expect(tampered.body.details.problem).toMatch(/changed after the owner approved/);
    const [row] = await sql(`SELECT used_at FROM owner_authorisations WHERE id = $1`, [id]);
    expect(row.used_at).toBeNull();

    const otherDates = await post(desk, '/reservations', { ...lowRate('2000', '2027-02-06', '2027-02-07', '9811100002'), ownerAuthorisationId: id });
    expect(otherDates.body.code).toBe('OWNER_AUTHORISATION_INVALID');

    const ok = await post(desk, '/reservations', { ...body, ownerAuthorisationId: id });
    expect(ok.status).toBe(201);
    expect(ok.body.overrides).toHaveLength(1);
    expect(ok.body.overrides[0]).toMatchObject({ description: 'Rate ₹2,000 is below the minimum ₹3,200', authorisedBy: 'Vikram Rathore', authorisedByRole: 'owner', performedBy: 'Priya Sharma' });
  });

  it('is single-use: the same approval cannot create a second booking', async () => {
    const body = lowRate('2000', '2027-02-10', '2027-02-11', '9811100003');
    const id = await pendingFor(body);
    await approve(desk, id, f.ownerId).expect(200);
    await post(desk, '/reservations', { ...body, ownerAuthorisationId: id }).expect(201);
    const again = await post(desk, '/reservations', { ...body, ownerAuthorisationId: id });
    expect(again.body.code).toBe('OWNER_AUTHORISATION_INVALID');
    expect(again.body.details.problem).toMatch(/already used/);
  });

  it('is single-use under concurrency: two simultaneous uses, one booking', async () => {
    const body = lowRate('2000', '2027-02-12', '2027-02-13', '9811100004');
    const id = await pendingFor(body);
    await approve(desk, id, f.ownerId).expect(200);
    const results = await Promise.all([post(desk, '/reservations', { ...body, ownerAuthorisationId: id }), post(desk, '/reservations', { ...body, ownerAuthorisationId: id })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
    const [n] = await sql(`SELECT count(*)::int AS n FROM owner_overrides WHERE authorisation_id = $1`, [id]);
    expect(n.n).toBe(1);
  });

  it('expires 2 minutes after approval', async () => {
    const body = lowRate('2000', '2027-02-14', '2027-02-15', '9811100005');
    const id = await pendingFor(body);
    await sql(`UPDATE owner_authorisations SET approved_by = $2, approved_at = now() - interval '3 minutes', expires_at = now() - interval '1 minute' WHERE id = $1`, [id, f.ownerId]);
    const res = await post(desk, '/reservations', { ...body, ownerAuthorisationId: id });
    expect(res.body.code).toBe('OWNER_AUTHORISATION_INVALID');
    expect(res.body.details.problem).toMatch(/expired/);
    const [row] = await sql(`SELECT expires_at <= approved_at + interval '2 minutes' AS within FROM owner_authorisations WHERE approved_at IS NOT NULL AND id <> $1 LIMIT 1`, [id]);
    expect(row.within).toBe(true);
  });

  it('cannot be used by another staff member', async () => {
    const other = await createStaff(app, owner, 'desk.two');
    const body = lowRate('2000', '2027-02-16', '2027-02-17', '9811100006');
    const id = await pendingFor(body);
    await approve(desk, id, f.ownerId).expect(200);
    const res = await post(other, '/reservations', { ...body, ownerAuthorisationId: id });
    expect(res.body.code).toBe('OWNER_AUTHORISATION_INVALID');
    // and cannot approve someone else's request
    await approve(other, id, f.ownerId).expect(404);
  });

  it('cannot be approved twice, and the database refuses to rewrite an approval', async () => {
    const id = await pendingFor(lowRate('2000', '2027-02-18', '2027-02-19', '9811100007'));
    await approve(desk, id, f.ownerId).expect(200);
    const second = await approve(desk, id, f.ownerId);
    expect(second.body.code).toBe('OWNER_AUTHORISATION_INVALID');
    await expect(sql(`UPDATE owner_authorisations SET expires_at = now() + interval '1 hour' WHERE id = $1`, [id])).rejects.toThrow(/already approved|expires_at/);
    await expect(sql(`UPDATE owner_authorisations SET scope_hash = '\\x00' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
  });

  it('owner acting directly needs no PIN and is recorded as authorising', async () => {
    const res = await post(owner, '/reservations', lowRate('2100', '2027-02-20', '2027-02-21', '9811100008')).expect(201);
    expect(res.body.overrides[0]).toMatchObject({ description: 'Rate ₹2,100 is below the minimum ₹3,200', authorisedBy: 'Vikram Rathore', performedBy: 'Vikram Rathore' });
  });
});

describe('Owner PIN lock', () => {
  it('locks after 5 wrong PINs even though nothing else is saved; owner unlocks from their own login', async () => {
    const id = await pendingFor(lowRate('2000', '2027-03-01', '2027-03-02', '9811100009'));
    for (let i = 0; i < 5; i++) {
      const res = await approve(desk, id, f.ownerId, '000111');
      expect(res.body.code).toBe('OWNER_PIN_INVALID');
    }
    const locked = await approve(desk, id, f.ownerId);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    expect(locked.body.message).toMatch(/owner can unlock/);

    await post(owner, `/users/${f.ownerId}/unlock`, {}, null).expect(200);
    await approve(desk, id, f.ownerId).expect(200);
  });
});
