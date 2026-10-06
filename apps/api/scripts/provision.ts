import { readFileSync } from 'node:fs';
import { ZodError } from 'zod';
import { provisionFirstOwner } from './provision-lib';

async function main() {
  const path = process.argv[2];
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  const password = process.env.PROVISION_OWNER_PASSWORD;
  const pin = process.env.PROVISION_OWNER_PIN;
  if (!path || !databaseUrl || !password || !pin) throw new Error('Provide a property JSON file and MIGRATION_DATABASE_URL, PROVISION_OWNER_PASSWORD, PROVISION_OWNER_PIN in the local environment. See ops/runbooks/provision.md.');
  const result = await provisionFirstOwner(databaseUrl,JSON.parse(readFileSync(path,'utf8')),password,pin);
  console.log(`Created property ${result.propertyId}. Owner login: ${result.username}. Complete rooms, rates, meals, tax rules and payment accounts in Settings before opening bookings. Print recovery codes after signing in.`);
}
main().catch((error: unknown) => {
  const message = error instanceof ZodError ? `Invalid configuration fields: ${error.issues.map((i) => i.path.join('.')).join(', ')}` : error instanceof Error ? error.message : 'Provisioning failed';
  console.error(message);
  process.exitCode=1;
});
