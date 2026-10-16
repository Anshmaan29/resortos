import { DbService } from '../src/db/db.service';
import type { AppConfig } from '../src/config';
import { addVilla } from './add-villa-lib';
/** Explicit controlled setup, never a startup seed. Supply a runtime database URL through the environment. */
async function main() {
  if (!process.argv.includes('--apply'))
    throw new Error('This command creates the second property. Use --apply only after validation.');
  const url = process.env.VILLA_SETUP_DATABASE_URL,
    source = process.env.VILLA_SOURCE_PROPERTY_ID,
    owner = process.env.VILLA_OWNER_ID,
    pin = process.env.VILLA_PIN_CODE;
  if (!url || !source || !owner || !pin)
    throw new Error(
      'Set VILLA_SETUP_DATABASE_URL, VILLA_SOURCE_PROPERTY_ID, VILLA_OWNER_ID and VILLA_PIN_CODE.',
    );
  const db = new DbService({ DATABASE_URL: url } as AppConfig);
  try {
    const result = await db.tx({ userId: owner }, (q) => addVilla(q, source, owner, pin));
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await db.onModuleDestroy();
  }
}
main().catch(() => {
  process.stderr.write(
    'Villa setup failed. No credentials were logged. Check the supplied IDs and database setup.\n',
  );
  process.exitCode = 1;
});
