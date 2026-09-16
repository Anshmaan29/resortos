import { Client } from 'pg';
import { migrate } from '../scripts/migrate-lib';
import { seed } from '../scripts/seed-lib';

export const TEST_BUSINESS_DATE = '2026-09-16';

/** Rebuilds the isolated test database from migrations before the suite runs. */
export default async function setup() {
  process.env.RESORTOS_ENV = 'test';
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://resortos_migrator:migrator_dev_password@localhost:5433/resortos_test';
  const client = new Client({ connectionString: url });
  await client.connect();
  const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
  if (!rows[0]!.db.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${rows[0]!.db}"`);
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; REVOKE ALL ON SCHEMA public FROM PUBLIC;');
  await client.end();
  await migrate(url, () => undefined);
  await seed(url, { businessDate: TEST_BUSINESS_DATE, log: () => undefined });
}
