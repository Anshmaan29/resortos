import { migrate } from './migrate-lib';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set');
  process.exit(1);
}
migrate(url).catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
});
