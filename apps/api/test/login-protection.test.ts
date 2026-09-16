import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delayForFailures } from '../src/auth/auth.service';
import { createStaff, login, post, sql } from './helpers';
import { bootApp } from './helpers';

/** Lockout abuse (spec §5.1): strangers must not be able to lock staff or the owner out. Real PostgreSQL. */
let app: INestApplication;
const PASSWORD = 'Staff-Password#2026';

beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });

const attempt = (login: string, password: string, ip: string, agent?: ReturnType<typeof request.agent>) =>
  (agent ?? request(app.getHttpServer())).post('/api/v1/auth/login').set('x-resortos', '1').set('x-forwarded-for', ip).send({ login, password });

describe('progressive delays', () => {
  it('grows 30 s, 1 min, 2 min … up to 15 min', () => {
    expect([4, 5, 6, 7, 20].map(delayForFailures)).toEqual([0, 30, 60, 120, 900]);
  });
});

describe('login throttling without lockout abuse', () => {
  it('an attacker on another network does not block the real user', async () => {
    const owner = await login(app, 'owner');
    await createStaff(app, owner, 'victim.one');
    for (let i = 0; i < 5; i++) await attempt('victim.one', 'wrong-password-x', '198.51.100.7').expect(401);
    const blocked = await attempt('victim.one', PASSWORD, '198.51.100.7');
    expect(blocked.status).toBe(429);
    expect(blocked.body.details.retryAfterSeconds).toBeGreaterThan(0);
    await attempt('victim.one', PASSWORD, '203.0.113.20').expect(200);
  });

  it("a known device keeps working even on the attacker's network", async () => {
    const owner = await login(app, 'owner');
    await createStaff(app, owner, 'victim.two');
    const desk = request.agent(app.getHttpServer());
    await attempt('victim.two', PASSWORD, '198.51.100.8', desk).expect(200); // device becomes known
    for (let i = 0; i < 6; i++) await attempt('victim.two', 'wrong-password-x', '198.51.100.8');
    expect((await attempt('victim.two', PASSWORD, '198.51.100.8')).status).toBe(429);
    await attempt('victim.two', PASSWORD, '198.51.100.8', desk).expect(200);
  });

  it('many failures on one network block that network, but not known devices', async () => {
    const owner = await login(app, 'owner');
    await createStaff(app, owner, 'victim.three');
    const desk = request.agent(app.getHttpServer());
    await attempt('victim.three', PASSWORD, '203.0.113.50', desk).expect(200);
    for (let i = 0; i < 20; i++) await attempt(`nobody${i}`, 'wrong-password-x', '198.51.100.9');
    expect((await attempt('victim.three', PASSWORD, '198.51.100.9')).status).toBe(429);
    await attempt('victim.three', PASSWORD, '198.51.100.9', desk).expect(200);
  });

  it('a distributed attack slows unknown devices only', async () => {
    const owner = await login(app, 'owner');
    await createStaff(app, owner, 'victim.four');
    const desk = request.agent(app.getHttpServer());
    await attempt('victim.four', PASSWORD, '203.0.113.60', desk).expect(200);
    for (let i = 0; i < 30; i++) await attempt('victim.four', 'wrong-password-x', `192.0.2.${i + 1}`);
    expect((await attempt('victim.four', PASSWORD, '192.0.2.200')).status).toBe(429);
    await attempt('victim.four', PASSWORD, '192.0.2.201', desk).expect(200);
  });

  it('the owner can clear throttling for a staff member', async () => {
    const owner = await login(app, 'owner');
    await createStaff(app, owner, 'victim.five');
    for (let i = 0; i < 5; i++) await attempt('victim.five', 'wrong-password-x', '198.51.100.30');
    expect((await attempt('victim.five', PASSWORD, '198.51.100.30')).status).toBe(429);
    const [u] = await sql(`SELECT id FROM users WHERE username = 'victim.five'`);
    await post(owner, `/users/${u.id}/unlock`, {}, null).expect(200);
    await attempt('victim.five', PASSWORD, '198.51.100.30').expect(200);
  });
});

describe('owner recovery codes (spec §5.2)', () => {
  const recover = (code: string, newPassword: string, ip = '203.0.113.99') =>
    request(app.getHttpServer()).post('/api/v1/auth/recover').set('x-resortos', '1').set('x-forwarded-for', ip).send({ login: 'owner', recoveryCode: code, newPassword });

  it('a wrong code is refused with a generic message', async () => {
    const res = await recover('ZZZZ-ZZZZ-ZZZZ', 'Recovered#Pass26');
    expect(res.status).toBe(401);
  });

  it('a printed code resets the password, clears throttles and the PIN lock, logs out sessions, and works once', async () => {
    const before = await login(app, 'owner');
    for (let i = 0; i < 6; i++) await attempt('owner', 'wrong-password-x', '198.51.100.77');
    await sql(`UPDATE users SET owner_pin_locked_until = now() + interval '30 minutes' WHERE username = 'owner'`);

    const res = await recover('DEMO-AAAA-2222', 'Recovered#Pass26');
    expect(res.status).toBe(200);
    expect(res.body.remainingCodes).toBe(2);
    await before.get('/api/v1/front-desk').expect(401);
    await attempt('owner', 'Recovered#Pass26', '198.51.100.77').expect(200);
    const [u] = await sql(`SELECT owner_pin_locked_until FROM users WHERE username = 'owner'`);
    expect(u.owner_pin_locked_until).toBeNull();

    expect((await recover('DEMO-AAAA-2222', 'Another#Owner2026')).status).toBe(401);
    // restore the demo password for other test files
    await recover('DEMO-BBBB-3333', 'Aravali#Hills26').expect(200);
  });

  it('recovery attempts are limited per network', async () => {
    for (let i = 0; i < 5; i++) await recover('ZZZZ-ZZZZ-ZZZZ', 'Whatever#Pass2026', '198.51.100.88');
    expect((await recover('DEMO-CCCC-4444', 'Whatever#Pass2026', '198.51.100.88')).status).toBe(429);
  });
});
