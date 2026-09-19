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
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
    S3_BUCKET: 'resortos-documents-test',
    S3_ACCESS_KEY_ID: 'resortos',
    S3_SECRET_ACCESS_KEY: 'resortos-dev-minio-secret',
    S3_FORCE_PATH_STYLE: 'true',
  });
  const { createApp } = await import('../src/bootstrap');
  const app = await createApp();
  // listen(0), not init(): supertest binds a never-listening server lazily, on the first request
  // it sends. Fire a burst in one tick and every request in that tick sees no address yet and calls
  // listen(0) itself, so the later sockets in the burst are reset — `read ECONNRESET` from a request
  // the app never saw. Binding an ephemeral port once here makes a burst behave like real traffic.
  await app.listen(0);
  return app;
}

export type Agent = ReturnType<typeof request.agent>;

/**
 * Boots the API against a database created for one suite alone, seeded at `businessDate`.
 *
 * Night audit exists to *move the business date*, and most suites assert the seeded 2026-09-16, so
 * it cannot share the fixture the rest of them use. A database of its own is both cheaper and more
 * honest than completing an audit and then disabling the very triggers that protect the date in
 * order to put it back.
 */
export async function bootAppOnOwnDatabase(name: string, businessDate: string): Promise<{
  app: INestApplication;
  /** Runs SQL against this suite's database as the migration role. */
  sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
}> {
  const dbName = `resortos_${name}_test`;
  if (!/^resortos_[a-z_]+_test$/.test(dbName)) throw new Error(`Unsafe test database name: ${dbName}`);
  const server = new Client({ connectionString: MIGRATOR_URL });
  await server.connect();
  try {
    await server.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await server.end();
  }

  const migratorUrl = MIGRATOR_URL.replace(/\/[^/]+$/, `/${dbName}`);
  const appUrl = APP_URL.replace(/\/[^/]+$/, `/${dbName}`);
  const { migrate } = await import('../scripts/migrate-lib');
  const { seed } = await import('../scripts/seed-lib');
  await migrate(migratorUrl, () => undefined);
  await seed(migratorUrl, { businessDate, log: () => undefined });

  Object.assign(process.env, {
    NODE_ENV: 'test',
    RESORTOS_ENV: 'test',
    DATABASE_URL: appUrl,
    SESSION_COOKIE_SECURE: 'false',
    WEB_ORIGIN: 'http://localhost:3000',
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
    S3_BUCKET: 'resortos-documents-test',
    S3_ACCESS_KEY_ID: 'resortos',
    S3_SECRET_ACCESS_KEY: 'resortos-dev-minio-secret',
    S3_FORCE_PATH_STYLE: 'true',
  });
  const { createApp } = await import('../src/bootstrap');
  const app = await createApp();
  await app.listen(0);

  const ownSql = async <T = any>(text: string, values: unknown[] = []): Promise<T[]> => {
    const c = new Client({ connectionString: migratorUrl });
    await c.connect();
    try {
      return (await c.query(text, values)).rows as T[];
    } finally {
      await c.end();
    }
  };
  return { app, sql: ownSql };
}

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

/** Ids from the seeded fixture. Pass a suite's own `sql` when it runs on its own database. */
export async function fixtures(q: <T = any>(text: string, values?: unknown[]) => Promise<T[]> = sql) {
  const types = await q<{ id: string; code: string }>(`SELECT id, code FROM room_types`);
  const rooms = await q<{ id: string; number: string }>(`SELECT id, number FROM rooms`);
  const owners = await q<{ id: string }>(`SELECT id FROM users WHERE role = 'owner'`);
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
