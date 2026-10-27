import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { applyInvoiceDateRepair,planInvoiceDateRepair,type InvoiceDateRepair } from '../scripts/invoice-date-repair-lib';
import { booking,bootAppOnOwnDatabase,fixtures,login,MIGRATOR_URL,post,type Agent } from './helpers';

let app: INestApplication; let client: Client;
let sql: Awaited<ReturnType<typeof bootAppOnOwnDatabase>>['sql'];
let plan: InvoiceDateRepair[];
let owner: Agent;
beforeAll(async()=>{
  ({app,sql}=await bootAppOnOwnDatabase('invoice_date_repair','2026-09-16'));
  owner=await login(app,'owner');
  const f=await fixtures(sql);
  const created=await post(owner,'/reservations',booking({roomTypeId:f.type('DLX'),roomId:f.room('202'),arrival:'2026-09-16',departure:'2026-09-17',adults:1})).expect(201);
  const [draft]=await sql(`INSERT INTO check_in_drafts (property_id,reservation_id,reservation_room_ids,status,confirmed_at,created_by)
    SELECT r.property_id,r.id,array_agg(rr.id),'confirmed',now(),r.created_by FROM reservations r JOIN reservation_rooms rr ON rr.reservation_id=r.id
    WHERE r.id=$1 GROUP BY r.property_id,r.id,r.created_by RETURNING id`,[created.body.id]);
  const [stay]=await sql(`INSERT INTO stays (property_id,reservation_id,reservation_room_id,room_id,primary_guest_id,check_in_draft_id,business_date_in,expected_departure,checked_in_by)
    SELECT rr.property_id,r.id,rr.id,rr.room_id,r.primary_guest_id,$2,rr.arrival,rr.departure,r.created_by FROM reservations r JOIN reservation_rooms rr ON rr.reservation_id=r.id WHERE r.id=$1 RETURNING id`,[created.body.id,draft.id]);
  await sql(`UPDATE reservation_rooms SET status='checked_in' WHERE reservation_id=$1`,[created.body.id]);
  await sql(`UPDATE room_allocations SET status='checked_in' WHERE reservation_room_id IN(SELECT id FROM reservation_rooms WHERE reservation_id=$1)`,[created.body.id]);
  await sql(`UPDATE reservations SET status='checked_in' WHERE id=$1`,[created.body.id]);
  await post(owner,'/shifts/open',{openingCash:'0'}).expect(200);
  await owner.get(`/api/v1/stays/${stay.id}/checkout-preview`).expect(200);
  const bill=(await owner.get(`/api/v1/stays/${stay.id}/bill`).expect(200)).body;
  const [account]=await sql(`SELECT id FROM payment_accounts WHERE kind='cash' LIMIT 1`);
  if(Number(bill.balance)>0) await post(owner,`/folios/${bill.id}/payments`,{method:'cash',paymentAccountId:account.id,amount:bill.balance}).expect(200);
  await post(owner,`/stays/${stay.id}/checkout`,{}).expect(200);
  // Reproduce the old live failure on an isolated fixture: an invoice dated by a lagged
  // replay cursor, with its genuine issue timestamp on today's calendar.
  await sql(`UPDATE properties SET data_origin='live'`);
  client=new Client({connectionString:MIGRATOR_URL.replace(/\/[^/]+$/,'/resortos_invoice_date_repair_test')});
  await client.connect(); plan=await planInvoiceDateRepair(client);
},120_000);
afterAll(async()=>{await client?.end();await app?.close();});

it('plans only dates backed by the recorded local issue timestamp without writing',async()=>{
  expect(plan).toHaveLength(1);expect(plan[0]!.old_date).toBe('2026-09-16');
  expect(plan[0]!.new_date).not.toBe(plan[0]!.old_date);
  const [row]=await sql(`SELECT invoice_date FROM invoices WHERE id=$1`,[plan[0]!.id]);
  expect(row.invoice_date).toBe(plan[0]!.old_date);
});
it('rejects a tampered date or stale non-date fingerprint',async()=>{
  await expect(applyInvoiceDateRepair(client,plan.map(r=>({...r,new_date:'2027-04-01'})))).rejects.toThrow(/manifest/);
  await expect(applyInvoiceDateRepair(client,plan.map(r=>({...r,preserved_hash:'changed'})))).rejects.toThrow(/manifest/);
});
it('yields to an active invoice writer or audit append before changing anything',async()=>{
  const other=new Client({connectionString:MIGRATOR_URL.replace(/\/[^/]+$/,'/resortos_invoice_date_repair_test')});
  await other.connect();
  try {
    await other.query('BEGIN');await other.query('LOCK TABLE invoices IN ROW EXCLUSIVE MODE');
    await expect(applyInvoiceDateRepair(client,plan)).rejects.toMatchObject({code:'55P03'});
    await other.query('ROLLBACK');await other.query('BEGIN');
    await other.query("SELECT pg_advisory_xact_lock(hashtextextended('audit_chain:' || $1::text,0))",[plan[0]!.property_id]);
    await expect(applyInvoiceDateRepair(client,plan)).rejects.toThrow(/live transaction/);
  } finally {await other.query('ROLLBACK');await other.end();}
  expect((await planInvoiceDateRepair(client))[0]!.old_date).toBe(plan[0]!.old_date);
});
it('rolls back the date and restores immutable protection if auditing fails',async()=>{
  await sql(`CREATE FUNCTION reject_date_repair_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='invoice.calendar_date_corrected' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`);
  await sql(`CREATE TRIGGER reject_date_repair BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_date_repair_audit()`);
  try { await expect(applyInvoiceDateRepair(client,plan)).rejects.toThrow(/test audit failure/); }
  finally { await sql('DROP TRIGGER reject_date_repair ON audit_logs'); }
  expect((await planInvoiceDateRepair(client))[0]!.old_date).toBe(plan[0]!.old_date);
  const [trigger]=await sql(`SELECT tgenabled FROM pg_trigger WHERE tgname='invoices_immutable'`);
  expect(trigger.tgenabled).toBe('O');
});
it('corrects only the date, preserves every other header field and all invoice parts, and is repeat-safe',async()=>{
  const before=(await sql(`SELECT to_jsonb(i)-'invoice_date' AS record FROM invoices i WHERE id=$1`,[plan[0]!.id]))[0]!.record;
  const parts=await sql(`SELECT to_jsonb(l) AS record FROM invoice_lines l ORDER BY id`);
  expect(await applyInvoiceDateRepair(client,plan)).toBe(1);
  expect(await applyInvoiceDateRepair(client,plan)).toBe(0);
  const [after]=await sql(`SELECT to_jsonb(i)-'invoice_date' AS record,invoice_date FROM invoices i WHERE id=$1`,[plan[0]!.id]);
  expect(after.record).toEqual(before);expect(after.invoice_date).toBe(plan[0]!.new_date);
  expect(await sql(`SELECT to_jsonb(l) AS record FROM invoice_lines l ORDER BY id`)).toEqual(parts);
  const [audit]=await sql(`SELECT count(*)::int AS n FROM audit_logs WHERE action='invoice.calendar_date_corrected'`);
  expect(audit.n).toBe(1);
  expect(await planInvoiceDateRepair(client)).toHaveLength(0);
  const register=await owner.get('/api/v1/invoices').query({from:plan[0]!.new_date,to:plan[0]!.new_date}).expect(200);
  expect(register.body.find((r: {id:string})=>r.id===plan[0]!.id)?.invoiceDate).toBe(plan[0]!.new_date);
});
it('leaves ordinary invoice writes protected after the operator repair',async()=>{
  await expect(sql(`UPDATE invoices SET invoice_date=invoice_date WHERE id=$1`,[plan[0]!.id])).rejects.toThrow(/finalized invoice/);
});
