import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { loadConfig } from './config';
import { DbService } from './db/db.service';
import { assertProductionSafe } from './safety/production-guard';

async function main() {
  const config = loadConfig();
  const app = await createApp();
  if (config.NODE_ENV === 'production') {
    await assertProductionSafe(app.get(DbService));
  }
  await app.listen(config.API_PORT);
  new Logger('ResortOS').log(`API listening on http://localhost:${config.API_PORT}/api/v1`);
}

main().catch((err) => {
  new Logger('ResortOS').error((err as Error).message);
  process.exit(1);
});
