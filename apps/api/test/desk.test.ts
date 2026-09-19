import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_CREDENTIALS } from '../scripts/seed-lib';
import { bootAppOnOwnDatabase, createStaff, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/** Shared front-desk computers and quick PIN switching (spec §5.3). */
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let owner: Agent;
let desk: Agent;
/** The shared computer at reception: a browser with the trusted-device cookie. */
let counter: Agent;
let receptionistId: string;

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('desk', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  owner = await login(app, 'owner');
  desk = await login(app, 'receptionist');
  counter = await login(app, 'owner');
  [{ id: receptionistId }] = await sql<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [DEMO_CREDENTIALS.receptionist.username]) as [{ id: string }];
}, 120_000);
afterAll(async () => { await app.close(); });

describe('setting a PIN', () => {
  it('needs your password, and refuses a PIN that is easy to guess', async () => {
    await post(desk, '/auth/staff-pin', { password: 'wrong', pin: '4829' }, null).expect(401);
    for (const pin of ['1111', '1234', '98765', '12', '1234567', 'abcd']) {
      await post(desk, '/auth/staff-pin', { password: DEMO_CREDENTIALS.receptionist.password, pin }, null).expect(400);
    }
    await post(desk, '/auth/staff-pin', { password: DEMO_CREDENTIALS.receptionist.password, pin: '4829' }, null).expect(200);
    const [row] = await sql<{ staff_pin_hash: string }>(`SELECT staff_pin_hash FROM users WHERE id = $1`, [receptionistId]);
    expect(row!.staff_pin_hash).toMatch(/^\$argon2id\$/);
  });
});

describe('a shared desk', () => {
  it('is the owner’s to mark, and a computer that is not one offers nobody', async () => {
    await post(desk, '/desk/trust', { name: 'Reception' }, null).expect(403);
    const stranger = request.agent(app.getHttpServer());
    expect((await stranger.get('/api/v1/desk').expect(200)).body).toEqual({ trusted: false });
    await stranger.post('/api/v1/desk/switch').set('x-resortos', '1').send({ userId: receptionistId, pin: '4829' }).expect(403);

    await post(counter, '/desk/trust', { name: 'Reception' }, null).expect(200);
    const status = (await counter.get('/api/v1/desk').expect(200)).body;
    expect(status).toMatchObject({ trusted: true, device: { name: 'Reception' }, lockMinutes: 5 });
    expect(status.people.map((p: any) => p.id)).toContain(receptionistId);
  });

  it('switches to someone by PIN, ending the previous session first', async () => {
    const before = (await counter.get('/api/v1/auth/me').expect(200)).body.user;
    expect(before.role).toBe('owner');
    await post(counter, '/desk/switch', { userId: receptionistId, pin: '4829' }, null).expect(200);
    expect((await counter.get('/api/v1/auth/me').expect(200)).body.user.id).toBe(receptionistId);
    const [owners] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE u.role = 'owner' AND s.revoked_reason = 'desk_switch'`,
    );
    expect(owners!.n).toBe(1);
    const [session] = await sql<{ trusted_device_id: string | null }>(
      `SELECT trusted_device_id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [receptionistId],
    );
    expect(session!.trusted_device_id).toBeTruthy();
  });

  it('only for someone who logged in with their password earlier today', async () => {
    const newcomer = await createStaff(app, owner, 'kiran.desk');
    await post(newcomer, '/auth/staff-pin', { password: 'Staff-Password#2026', pin: '7351' }, null).expect(200);
    const [{ id }] = await sql<{ id: string }>(`SELECT id FROM users WHERE username = 'kiran.desk'`) as [{ id: string }];
    // Their password logins were yesterday, as far as the desk is concerned.
    await sql(`UPDATE auth_attempts SET created_at = created_at - interval '2 days' WHERE user_id = $1 AND kind = 'password'`, [id]);
    const status = (await counter.get('/api/v1/desk').expect(200)).body;
    expect(status.people.map((p: any) => p.id)).not.toContain(id);
    const refused = await post(counter, '/desk/switch', { userId: id, pin: '7351' }, null).expect(403);
    expect(refused.body.message).toMatch(/password first today/);
  });

  it('stops taking a person’s PIN after five wrong tries', async () => {
    await post(owner, '/auth/staff-pin', { password: DEMO_CREDENTIALS.owner.password, pin: '6152' }, null).expect(200);
    const [{ id }] = await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`) as [{ id: string }];
    for (let i = 0; i < 5; i += 1) await post(counter, '/desk/switch', { userId: id, pin: '0000' }, null).expect(401);
    const locked = await post(counter, '/desk/switch', { userId: id, pin: '6152' }, null).expect(429);
    expect(locked.body.message).toMatch(/Too many wrong PINs/);
  });

  it('locking ends the session, and unlocking is a PIN switch', async () => {
    await post(counter, '/desk/switch', { userId: receptionistId, pin: '4829' }, null).expect(200);
    await post(counter, '/desk/lock', {}, null).expect(200);
    await counter.get('/api/v1/auth/me').expect(401);
    await post(counter, '/desk/switch', { userId: receptionistId, pin: '4829' }, null).expect(200);
    await counter.get('/api/v1/auth/me').expect(200);
  });

  it('once the owner revokes the desk, its PIN sessions end and it takes no more PINs', async () => {
    const [{ id }] = await sql<{ id: string }>(`SELECT id FROM trusted_devices WHERE name = 'Reception'`) as [{ id: string }];
    await post(owner, `/desk/devices/${id}/revoke`, {}, null).expect(200);
    await counter.get('/api/v1/auth/me').expect(401);
    await post(counter, '/desk/switch', { userId: receptionistId, pin: '4829' }, null).expect(403);
    await expect(sql(`DELETE FROM trusted_devices WHERE id = $1`, [id])).rejects.toThrow(/revoked, not deleted/);
  });
});
