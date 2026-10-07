import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevProvider, MESSAGE_PROVIDERS, type MessageProvider } from '../src/messaging/providers';
import { MessagingService } from '../src/messaging/messaging.service';
import { OutboxDispatcher } from '../src/jobs/outbox.dispatcher';
import { bootAppOnOwnDatabase, login, post, type Agent } from './helpers';

/**
 * The owner's daily summary (spec §42): after the night audit closes a day, one email with the day
 * in numbers — computed by the backend, plain text, no AI. The audit is what causes it; replaying
 * or re-reading the event must not send it twice.
 */
const TEST_BUSINESS_DATE = '2026-09-16';

let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let desk: Agent;
let owner: Agent;
let dev: DevProvider;
let outbox: OutboxDispatcher;
let messaging: MessagingService;

/** The outbox drains in the background; this waits for it and then for the sender. */
async function settle() {
  await sql(`UPDATE outbox_events SET available_at = now() WHERE dispatched_at IS NULL AND failed_at IS NULL`);
  for (let i = 0; i < 5; i += 1) if ((await outbox.drainOnce(50)).claimed === 0) break;
  await messaging.sendDue(50);
}

beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('dailysummary', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  desk = await login(app, 'receptionist');
  owner = await login(app, 'owner');
  dev = app.get<MessageProvider[]>(MESSAGE_PROVIDERS)[0] as DevProvider;
  outbox = app.get(OutboxDispatcher);
  messaging = app.get(MessagingService);
  await sql(`UPDATE properties SET email_enabled=true, email_from_address='stay@aravali.example'`);
  // The demo owner has no email; the summary goes to whoever the property configured.
  await sql(`INSERT INTO settings (property_id, key, value)
             SELECT id, 'daily_summary_recipients', '["accounts@aravali.example"]'::jsonb FROM properties LIMIT 1`);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('the daily summary email', () => {
  it('goes out when the audit closes the day, with the day in numbers', async () => {
    // The demo booking arriving today blocks the audit; mark it a no-show first.
    const arrivals = await sql<{ id: string }>(`SELECT id FROM reservations WHERE arrival = $1 AND status = 'confirmed'`, [TEST_BUSINESS_DATE]);
    for (const a of arrivals) await post(desk, `/reservations/${a.id}/no-show`, { reason: 'did_not_arrive' }).expect(200);
    await post(desk, '/night-audit/complete', { businessDate: TEST_BUSINESS_DATE }).expect(200);
    await settle();

    expect(dev.sent.map((s) => s.to)).toEqual(['accounts@aravali.example']);
    const m = (await sql<{ subject: string; body: string; status: string }>(
      `SELECT subject, body, status FROM messages WHERE template_key = 'daily_summary'`,
    ))[0]!;
    expect(m.status).toBe('sent');
    expect(m.subject).toContain('16 Sep');
    // The example lines of §42, filled from real rows.
    expect(m.body).toMatch(/Room revenue\s+₹[\d,]+/);
    expect(m.body).toMatch(/Collected\s+₹/);
    expect(m.body).toMatch(/Needs a look\s+\d+ item/);
    expect(m.body).toMatch(/Tomorrow\s+\d+ arrivals? · \d+ departures?/);
    // This suite has no occupied stays; the summary must not invent revenue.
    expect(m.body).toMatch(/Room revenue\s+₹0(\.00)?/);
  });

  it('is sent once, however often the event is delivered', async () => {
    const { DailySummaryHandler } = await import('../src/messaging/daily-summary.handler');
    const events = await sql<{ id: string; property_id: string; payload: any }>(
      `SELECT id, property_id, payload FROM outbox_events WHERE topic = 'night_audit.completed'`,
    );
    const handler = app.get(DailySummaryHandler);
    const asEvent = (row: { id: string; property_id: string; payload: any }) =>
      ({ id: row.id, topic: 'night_audit.completed', aggregateId: row.id, propertyId: row.property_id, payload: row.payload, createdAt: new Date() }) as never;
    await handler.handle(asEvent(events[0]!));
    await handler.handle(asEvent(events[0]!));
    const messages = await sql<{ n: string }>(`SELECT count(*) AS n FROM messages WHERE template_key = 'daily_summary'`);
    expect(Number(messages[0]!.n)).toBe(1);
    expect(dev.sent.filter((s) => s.to === 'accounts@aravali.example')).toHaveLength(1);
  });
});
