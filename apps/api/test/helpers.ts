import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { DEMO_CREDENTIALS } from '../scripts/seed-lib';

export const MIGRATOR_URL = process.env.TEST_DATABASE_URL ?? 'postgres://resortos_migrator:migrator_dev_password@localhost:5433/resortos_test';
export const APP_URL = 'postgres://resortos_app:app_dev_password@localhost:5433/resortos_test';

export async function bootApp(): Promise<INestApplication> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: APP_URL,
    SESSION_COOKIE_SECURE: 'false',
    WEB_ORIGIN: 'http://localhost:3000',
  });
  const { createApp } = await import('../src/bootstrap');
  const app = await createApp();
  await app.init();
  return app;
}

export type Agent = ReturnType<typeof request.agent>;

export async function login(app: INestApplication, who: 'owner' | 'receptionist' = 'receptionist'): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  const creds = DEMO_CREDENTIALS[who];
  await agent.post('/api/v1/auth/login').set('x-resortos', '1').send({ login: creds.username, password: creds.password }).expect(200);
  return agent;
}

export const key = () => `test-${randomUUID()}`;

export function post(agent: Agent, path: string, body: unknown, idempotencyKey: string | null = key()) {
  const req = agent.post(`/api/v1${path}`).set('x-resortos', '1');
  if (idempotencyKey) req.set('idempotency-key', idempotencyKey);
  return req.send(body as object);
}

export async function sql<T = any>(text: string, values: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: MIGRATOR_URL });
  await c.connect();
  try {
    return (await c.query(text, values)).rows as T[];
  } finally {
    await c.end();
  }
}

export async function fixtures() {
  const types = await sql<{ id: string; code: string }>(`SELECT id, code FROM room_types`);
  const rooms = await sql<{ id: string; number: string }>(`SELECT id, number FROM rooms`);
  const owners = await sql<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`);
  return {
    type: (code: string) => types.find((t) => t.code === code)!.id,
    room: (number: string) => rooms.find((r) => r.number === number)!.id,
    ownerId: owners[0]!.id,
  };
}

let mobileCounter = 0;
export function booking(input: { roomTypeId: string; roomId?: string; arrival: string; departure: string; adults?: number; nightlyRate?: string; extra?: object }) {
  mobileCounter += 1;
  return {
    guest: { firstName: 'Test', lastName: `Guest${mobileCounter}x${randomUUID().slice(0, 6)}`, mobile: `98${String(10_000_000 + mobileCounter).padStart(8, '0')}` },
    source: 'walk_in',
    arrival: input.arrival,
    departure: input.departure,
    rooms: [{ roomTypeId: input.roomTypeId, roomId: input.roomId, adults: input.adults ?? 2, nightlyRate: input.nightlyRate }],
    ...input.extra,
  };
}

/** Creates a staff account and completes the forced password change. Returns a logged-in agent. */
export async function createStaff(app: INestApplication, owner: Agent, username: string, role: 'receptionist' | 'owner' = 'receptionist'): Promise<Agent> {
  await post(owner, '/users', { fullName: `Test ${username}`, username, role, temporaryPassword: 'Temporary#Pass1' }, null).expect(201);
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/v1/auth/login').set('x-resortos', '1').send({ login: username, password: 'Temporary#Pass1' }).expect(200);
  await post(agent, '/auth/password/change', { currentPassword: 'Temporary#Pass1', newPassword: 'Staff-Password#2026' }, null).expect(200);
  return agent;
}

export function approve(agent: Agent, authorisationId: string, ownerUserId: string, pin = '482916') {
  return post(agent, `/owner-authorisations/${authorisationId}/approve`, { ownerUserId, pin }, null);
}
