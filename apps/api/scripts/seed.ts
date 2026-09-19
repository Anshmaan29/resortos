import { DEMO_CREDENTIALS, seed } from './seed-lib';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set');
  process.exit(1);
}
seed(url, { demoStays: true })
  .then(() => {
    console.log('\nDemo logins (development only):');
    console.log(`  Owner         ${DEMO_CREDENTIALS.owner.username} / ${DEMO_CREDENTIALS.owner.password}   Owner PIN ${DEMO_CREDENTIALS.owner.pin}`);
    console.log(`  Receptionist  ${DEMO_CREDENTIALS.receptionist.username} / ${DEMO_CREDENTIALS.receptionist.password}`);
  })
  .catch((err) => {
    console.error(`✗ seed failed: ${(err as Error).message}`);
    process.exit(1);
  });
