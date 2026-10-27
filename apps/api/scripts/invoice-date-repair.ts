import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { applyInvoiceDateRepair, planInvoiceDateRepair, type InvoiceDateRepair } from './invoice-date-repair-lib';

async function main() {
  const [mode,path] = process.argv.slice(2);
  if (!['--plan','--apply'].includes(mode ?? '') || !path || !process.env.MIGRATION_DATABASE_URL) {
    throw new Error('Use --plan <private manifest> or --apply <reviewed manifest> with MIGRATION_DATABASE_URL');
  }
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL, connectionTimeoutMillis:15_000 });
  await client.connect();
  try {
    if (mode === '--plan') {
      await client.query('BEGIN READ ONLY');
      const plan = await planInvoiceDateRepair(client);
      await client.query('ROLLBACK');
      writeFileSync(path,JSON.stringify(plan,null,2),{ mode:0o600,flag:'wx' });
      console.log(`Read-only manifest: ${plan.length} invoice dates. No data changed.`);
    } else {
      const plan = JSON.parse(readFileSync(path,'utf8')) as InvoiceDateRepair[];
      console.log(`Corrected ${await applyInvoiceDateRepair(client,plan)} invoice dates; all non-date fields preserved.`);
    }
  } finally { await client.end(); }
}
main().catch(error => { console.error((error as Error).message); process.exitCode=1; });
