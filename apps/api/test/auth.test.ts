import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, login, post, sql } from './helpers';

let app: INestApplication;
beforeAll(async () => { app = await bootApp(); });
afterAll(async () => { await app.close(); });

describe('login', () => {
  it('sets an HttpOnly SameSite session cookie and never returns secrets', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set('x-resortos', '1')
      .send({ login: 'owner', password: 'Aravali#Hills26' }).expect(200);
    const cookie = res.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|pin_hash|\$argon2/);
  });

  it('accepts phone number as login', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login').set('x-resortos', '1')
      .send({ login: '+91 98290 00002', password: 'Aravali#Desk26' }).expect(200);
  });

  it('uses one generic message for unknown user and wrong password', async () => {
    const a = await request(app.getHttpServer()).post('/api/v1/auth/login').set('x-resortos', '1').send({ login: 'nobody', password: 'whatever12345' });
    const b = await request(app.getHttpServer()).post('/api/v1/auth/login').set('x-resortos', '1').send({ login: 'priya', password: 'whatever12345' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('rejects mutations without the CSRF header', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ login: 'owner', password: 'x' });
    expect(res.status).toBe(403);
  });

  it('stores only a hash of the session token', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set('x-resortos', '1').send({ login: 'owner', password: 'Aravali#Hills26' });
    const token = /rsos_session=([^;]+)/.exec(res.headers['set-cookie']![0]!)![1]!;
    const rows = await sql(`SELECT 1 FROM sessions WHERE encode(token_hash, 'escape') = $1`, [token]);
    expect(rows).toHaveLength(0);
  });
});

describe('lockout and roles', () => {
  it('owner-created accounts start with a temporary password', async () => {
    const owner = await login(app, 'owner');
    await post(owner, '/users', { fullName: 'Lock Test', username: 'locktest', role: 'receptionist', temporaryPassword: 'Temporary#Pass1' }, null).expect(201);
  });

  it('forces a temporary password to be changed before any work', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/login').set('x-resortos', '1').send({ login: 'locktest', password: 'Temporary#Pass1' }).expect(200);
    const blocked = await agent.get('/api/v1/front-desk');
    expect(blocked.status).toBe(403);
    expect(blocked.body.details).toEqual({ mustChangePassword: true });

    const weak = await post(agent, '/auth/password/change', { currentPassword: 'Temporary#Pass1', newPassword: 'password123' }, null);
    expect(weak.status).toBe(400);
    await post(agent, '/auth/password/change', { currentPassword: 'Temporary#Pass1', newPassword: 'Desk-Shift#Morning7' }, null).expect(200);
    await agent.get('/api/v1/front-desk').expect(200);
  });

  it('keeps receptionists out of owner-only areas', async () => {
    const desk = await login(app, 'receptionist');
    await desk.get('/api/v1/users').expect(403);
    await desk.get('/api/v1/tax-rules').expect(403);
    await post(desk, '/room-types', {}, null).expect(403);
  });

  it('rejects requests after logout', async () => {
    const desk = await login(app, 'receptionist');
    await post(desk, '/auth/logout', {}, null).expect(200);
    await desk.get('/api/v1/front-desk').expect(401);
  });
});
