import type { Client } from 'pg';
import { financialYearLabel } from '@resortos/shared';
import { AuditService } from '../src/common/audit.service';
import { OutboxService } from '../src/common/outbox.service';

export interface InvoiceDateRepair {
  id: string; property_id: string; number: string; old_date: string; new_date: string;
  financial_year: string; preserved_hash: string;
}

/** Operator-only manifest. Does not contain guest details or invoice attachments. */
export async function planInvoiceDateRepair(client: Client): Promise<InvoiceDateRepair[]> {
  const result = await client.query<InvoiceDateRepair>(`
    SELECT i.id,i.property_id,i.number,i.invoice_date::text AS old_date,
           (i.finalized_at AT TIME ZONE p.timezone)::date::text AS new_date,
           i.financial_year,md5((to_jsonb(i)-'invoice_date')::text) AS preserved_hash
      FROM invoices i JOIN properties p ON p.id=i.property_id
     WHERE p.data_origin='live' AND i.invoice_date<>(i.finalized_at AT TIME ZONE p.timezone)::date
     ORDER BY i.property_id,i.seq`);
  return result.rows;
}

/**
 * Explicit owner-authorised historical repair, never a runtime app capability.
 * Only invoice_date may change. The original number, fiscal year, parties, amounts,
 * payments, tax/service lines and issue timestamp must retain their exact hashes.
 * A table lock keeps other writers out while the immutable trigger is transactionally
 * suspended. Any mismatch/error rolls back both data and trigger state.
 */
export async function applyInvoiceDateRepair(client: Client, plan: InvoiceDateRepair[]): Promise<number> {
  if (!Array.isArray(plan) || new Set(plan.map(r => r.id)).size !== plan.length) throw new Error('Invalid repair manifest');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    const { rows: roles } = await client.query<{ role: string }>('SELECT current_user AS role');
    if (roles[0]?.role !== 'resortos_migrator') throw new Error('Historical repair requires the operator migration role');
    // Keep invoice reads available, and yield immediately to any current writer.
    await client.query('LOCK TABLE invoices IN SHARE ROW EXCLUSIVE MODE NOWAIT');
    for (const propertyId of [...new Set(plan.map(r => r.property_id))].sort()) {
      const { rows } = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('audit_chain:' || $1::text,0)) AS acquired",[propertyId]);
      if (!rows[0]?.acquired) throw new Error('A live transaction is using the audit chain; retry the repair later');
    }
    const { rows: current } = await client.query<InvoiceDateRepair>(`
      SELECT i.id,i.property_id,i.number,i.invoice_date::text AS old_date,
             (i.finalized_at AT TIME ZONE p.timezone)::date::text AS new_date,
             i.financial_year,md5((to_jsonb(i)-'invoice_date')::text) AS preserved_hash
        FROM invoices i JOIN properties p ON p.id=i.property_id
       WHERE i.id=ANY($1::uuid[]) AND p.data_origin='live'`,[plan.map(r => r.id)]);
    const byId = new Map(current.map(r => [r.id,r]));
    const pending: InvoiceDateRepair[] = [];
    for (const item of plan) {
      const live = byId.get(item.id);
      if (!live || live.property_id !== item.property_id || live.number !== item.number
        || live.new_date !== item.new_date || live.financial_year !== item.financial_year
        || live.preserved_hash !== item.preserved_hash
        || ![item.old_date, item.new_date].includes(live.old_date)) throw new Error('Invoice no longer matches the reviewed manifest');
      if (financialYearLabel(item.new_date) !== item.financial_year) throw new Error('A date repair cannot move an invoice into another financial year');
      if (live.old_date !== item.new_date) pending.push(item);
    }
    if (pending.length) {
      await client.query('ALTER TABLE invoices DISABLE TRIGGER invoices_immutable');
      const { rows: updated } = await client.query<{ id: string; hash: string }>(`
        UPDATE invoices i SET invoice_date=x.new_date::date
          FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,old_date text,new_date text)
         WHERE i.id=x.id AND i.invoice_date=x.old_date::date
         RETURNING i.id,md5((to_jsonb(i)-'invoice_date')::text) AS hash`,[JSON.stringify(pending)]);
      if (updated.length !== pending.length || updated.some(r => r.hash !== byId.get(r.id)?.preserved_hash)) {
        throw new Error('A non-date invoice field changed; repair rolled back');
      }
      await client.query('ALTER TABLE invoices ENABLE TRIGGER invoices_immutable');
      const audit = new AuditService(); const outbox = new OutboxService();
      for (const item of pending) {
        await audit.recordSystem(client, item.property_id, {
          action: 'invoice.calendar_date_corrected', entityType: 'invoice', entityId: item.id,
          before: { invoiceDate: item.old_date }, after: { invoiceDate: item.new_date, preservedHash: item.preserved_hash },
          reason: 'Owner requested actual local issue date instead of delayed business date',
        });
        // Informational event only: never re-issue or automatically resend an old invoice.
        await outbox.emit(client,item.property_id,'invoice.calendar_date_corrected',{ type:'invoice',id:item.id },{ previousDate:item.old_date,invoiceDate:item.new_date });
      }
    }
    await client.query('COMMIT');
    return pending.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
