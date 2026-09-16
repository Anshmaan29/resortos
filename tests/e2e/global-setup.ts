import { Client } from 'pg';
import { migrate } from '../../apps/api/scripts/migrate-lib';
import { seed } from '../../apps/api/scripts/seed-lib';

export default async function globalSetup() {
  process.env.RESORTOS_ENV = 'test';
  const url = 'postgres://resortos_migrator:migrator_dev_password@localhost:5433/resortos_test';
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; REVOKE ALL ON SCHEMA public FROM PUBLIC;');
  await client.end();
  await migrate(url, () => undefined);
  await seed(url, { businessDate: '2026-09-16', log: () => undefined });
}
