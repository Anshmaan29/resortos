import { createHmac, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../src/jobs/outbox.dispatcher';
import { MessagingService } from '../src/messaging/messaging.service';
import { DevProvider, MESSAGE_PROVIDERS, type MessageProvider } from '../src/messaging/providers';
import { renderTemplate } from '../src/messaging/templates';
import { bootAppOnOwnDatabase, booking, fixtures, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

/**
 * Guest messages (spec §40, §41): queued from business events, delivered by the provider, every
 * outcome recorded, and a failure never reaching a booking or a bill.
 */
const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString('base64')}`;
let app: INestApplication;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let owner: Agent;
let desk: Agent;
let f: Awaited<ReturnType<typeof fixtures>>;
let dev: DevProvider;
let outbox: OutboxDispatcher;
let messaging: MessagingService;
let mobile = 9820088000;

/** Everything after commit: drain the outbox, then send what it queued. */
async function settle() {
  await sql(`UPDATE outbox_events SET available_at = now() WHERE dispatched_at IS NULL AND failed_at IS NULL`);
  for (let i = 0; i < 5; i += 1) if ((await outbox.drainOnce(50)).claimed === 0) break;
  await messaging.sendDue(50);
}

const messagesFor = (reservationId: string) =>
  sql<{ id: string; template_key: string; status: string; skip_reason: string | null; recipient: string; body: string; subject: string; language: string; attempts: number; last_error: string | null; send_after: Date }>(
    `SELECT * FROM messages WHERE reservation_id = $1 ORDER BY queued_at`, [reservationId],
  );

/** One night each, on a different night, so the cottages never run out. */
let night = 0;
async function book(extra: object = {}, guest: object = {}) {
  mobile += 1;
  night += 1;
  const arrival = new Date(Date.UTC(2026, 9, 1 + night)).toISOString().slice(0, 10);
  const departure = new Date(Date.UTC(2026, 9, 2 + night)).toISOString().slice(0, 10);
  const created = await post(owner, '/reservations', {
    ...booking({ roomTypeId: f.type('PRE'), arrival, departure, extra }),
    guest: { firstName: 'Mala', lastName: 'Rao', mobile: String(mobile), email: `mala${mobile}@example.com`, ...guest },
  }).expect(201);
  return created.body.id as string;
}

beforeAll(async () => {
  process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const booted = await bootAppOnOwnDatabase('messaging', TEST_BUSINESS_DATE);
  app = booted.app;
  sql = booted.sql;
  owner = await login(app, 'owner');
  desk = await login(app, 'receptionist');
  f = await fixtures(sql);
  dev = app.get<MessageProvider[]>(MESSAGE_PROVIDERS)[0] as DevProvider;
  outbox = app.get(OutboxDispatcher);
  messaging = app.get(MessagingService);
  await sql(`UPDATE properties SET email_enabled = true, email_from_address = 'stay@aravali.example', reception_phone = '+91 141 000 0000'`);
}, 120_000);
afterAll(async () => { delete process.env.RESEND_WEBHOOK_SECRET; await app.close(); });
beforeEach(() => { dev.sent.length = 0; dev.failNext = null; });

describe('booking confirmation', () => {
  it('is queued from the booking event and sent once, however often the event is delivered', async () => {
    const id = await book();
    await settle();
    const [m, ...rest] = await messagesFor(id);
    expect(rest).toHaveLength(0);
    expect(m).toMatchObject({ template_key: 'booking_confirmation', status: 'sent' });
    expect(m!.subject).toMatch(/is confirmed/);
    expect(dev.sent.map((s) => s.to)).toEqual([m!.recipient]);

    // The outbox is at-least-once: deliver the same event again.
    await sql(`UPDATE outbox_events SET dispatched_at = NULL, available_at = now() WHERE aggregate_id = $1 AND topic = 'reservation.created'`, [id]);
    await settle();
    expect(await messagesFor(id)).toHaveLength(1);
  });

  it('never carries the guest mobile, address or anything not on the variable list (§41)', async () => {
    const id = await book({}, { addressLine: '12 Secret Lane' });
    await settle();
    const [m] = await messagesFor(id);
    const guestMobile = String(mobile);
    expect(m!.body).not.toContain(guestMobile);
    expect(m!.body).not.toContain('Secret Lane');
    expect(dev.sent[0]!.html).not.toContain(guestMobile);
    expect(renderTemplate('{{guest_name}} {{mobile}} {{id_number}} {{address}}', { guest_name: 'A' })).toBe('A   ');
  });

  it('is recorded as skipped, with the reason, when it cannot go', async () => {
    const noEmail = await book({}, { email: '' });
    await settle();
    await sql(`UPDATE properties SET email_enabled = false`);
    const disabled = await book();
    await settle();
    await sql(`UPDATE properties SET email_enabled = true`);
    expect((await messagesFor(noEmail))[0]).toMatchObject({ status: 'skipped', skip_reason: 'The guest has no email address on file.' });
    expect((await messagesFor(disabled))[0]).toMatchObject({ status: 'skipped', skip_reason: 'Email is switched off in message settings.' });
    expect(dev.sent).toHaveLength(0);
  });

  it('is not sent to a walk-in being checked in today, nor for a tentative booking', async () => {
    const walkIn = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type('DLX'), arrival: TEST_BUSINESS_DATE, departure: '2026-09-17' }),
      guest: { firstName: 'Walk', lastName: 'In', mobile: String((mobile += 1)), email: 'walk@example.com' },
    }).expect(201);
    const tentative = await book({ status: 'tentative' });
    await settle();
    expect(await messagesFor(walkIn.body.id)).toHaveLength(0);
    const t = await sql<{ status: string }>(`SELECT status FROM reservations WHERE id = $1`, [tentative]);
    if (t[0]!.status === 'tentative') expect(await messagesFor(tentative)).toHaveLength(0);
  });

  it('is in Hindi for a guest who reads Hindi, and uses the owner’s wording once saved', async () => {
    await owner.put('/api/v1/message-templates/booking_confirmation/hi').set('x-resortos', '1')
      .send({ subject: '{{resort_name}}: बुकिंग {{booking_number}}', body: 'नमस्ते {{guest_name}}, आपकी बुकिंग पक्की है।' }).expect(200);
    const id = await book();
    await sql(`UPDATE guests SET preferred_language = 'hi' WHERE id = (SELECT primary_guest_id FROM reservations WHERE id = $1)`, [id]);
    await settle();
    const [m] = await messagesFor(id);
    expect(m!.language).toBe('hi');
    expect(m!.body).toMatch(/^नमस्ते Mala/);
  });

  it('refuses a template that uses a variable that does not exist', async () => {
    const refused = await owner.put('/api/v1/message-templates/receipt/en').set('x-resortos', '1')
      .send({ subject: 'Receipt', body: 'Your mobile {{guest_mobile}} is on file.' }).expect(400);
    expect(refused.body.message).toMatch(/\{\{guest_mobile\}\}/);
    await desk.put('/api/v1/message-templates/receipt/en').set('x-resortos', '1').send({ subject: 'x', body: 'xxxxxxxxxxxx' }).expect(403);
  });
});

describe('delivery', () => {
  it('retries a provider hiccup with backoff and then sends', async () => {
    dev.failNext = { message: 'Resend 503: temporarily unavailable', retryable: true, times: 1 };
    const id = await book();
    await settle();
    let [m] = await messagesFor(id);
    expect(m).toMatchObject({ status: 'queued', attempts: 1, last_error: 'Resend 503: temporarily unavailable' });
    expect(new Date(m!.send_after).getTime()).toBeGreaterThan(Date.now());
    await sql(`UPDATE messages SET send_after = now() WHERE id = $1`, [m!.id]);
    await messaging.sendDue();
    [m] = await messagesFor(id);
    expect(m!.status).toBe('sent');
  });

  it('marks a rejected message failed with the reason, and Resend is a new message pointing at it', async () => {
    dev.failNext = { message: 'Resend 422: invalid recipient', retryable: false, times: 1 };
    const id = await book();
    await settle();
    const [failed] = await messagesFor(id);
    expect(failed).toMatchObject({ status: 'failed', last_error: 'Resend 422: invalid recipient' });

    const again = await post(desk, `/messages/${failed!.id}/resend`, {}, null).expect(200);
    expect(again.body.resendOf).toBe(failed!.id);
    await messaging.sendDue();
    const all = await messagesFor(id);
    expect(all.map((m) => m.status)).toEqual(['failed', 'sent']);
  });

  it('a message is never rewritten or deleted, and a failed one stays failed', async () => {
    const [m] = await sql<{ id: string }>(`SELECT id FROM messages WHERE status = 'failed' LIMIT 1`);
    await expect(sql(`UPDATE messages SET body = 'changed' WHERE id = $1`, [m!.id])).rejects.toThrow(/never rewritten/);
    await expect(sql(`UPDATE messages SET status = 'sent', sent_at = now() WHERE id = $1`, [m!.id])).rejects.toThrow(/stays that way/);
    await expect(sql(`DELETE FROM messages WHERE id = $1`, [m!.id])).rejects.toThrow(/history is kept/);
  });

  it('a failing provider never touches the booking', async () => {
    dev.failNext = { message: 'Resend 500', retryable: true, times: 99 };
    const id = await book();
    await settle();
    const [r] = await sql<{ status: string }>(`SELECT status FROM reservations WHERE id = $1`, [id]);
    expect(r!.status).toBe('confirmed');
    dev.failNext = null;
  });
});

describe('the Resend delivery webhook', () => {
  const sign = (body: string, id = `msg_${randomBytes(6).toString('hex')}`, ts = Math.floor(Date.now() / 1000)) => {
    const key = Buffer.from(WEBHOOK_SECRET.replace('whsec_', ''), 'base64');
    const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
    return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
  };

  it('moves a sent message to delivered on a signed report, and keeps the report', async () => {
    const [m] = await sql<{ id: string; provider_message_id: string }>(
      `SELECT id, provider_message_id FROM messages WHERE status = 'sent' AND provider = 'dev' LIMIT 1`,
    );
    // Stand in for a Resend-sent message: same row, Resend's id.
    await sql(`ALTER TABLE messages DISABLE TRIGGER messages_guard`);
    await sql(`UPDATE messages SET provider = 'resend', provider_message_id = 're_test_1' WHERE id = $1`, [m!.id]);
    await sql(`ALTER TABLE messages ENABLE TRIGGER messages_guard`);
    const body = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 're_test_1' } });
    await request(app.getHttpServer()).post('/api/v1/webhooks/resend').set(sign(body)).set('content-type', 'application/json').send(body).expect(200);
    const [after] = await sql<{ status: string; delivered_at: Date | null }>(`SELECT status, delivered_at FROM messages WHERE id = $1`, [m!.id]);
    expect(after!.status).toBe('delivered');
    expect(after!.delivered_at).toBeTruthy();
    expect(await sql(`SELECT 1 FROM message_events WHERE message_id = $1`, [m!.id])).toHaveLength(1);

    // Status never moves backwards: a late "sent" report after "delivered" changes nothing.
    const late = JSON.stringify({ type: 'email.sent', created_at: new Date().toISOString(), data: { email_id: 're_test_1' } });
    await request(app.getHttpServer()).post('/api/v1/webhooks/resend').set(sign(late)).set('content-type', 'application/json').send(late).expect(200);
    expect((await sql<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [m!.id]))[0]!.status).toBe('delivered');
  });

  it('refuses a report without a valid, fresh signature, and needs no CSRF header', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_test_1' } });
    await request(app.getHttpServer()).post('/api/v1/webhooks/resend').set('content-type', 'application/json').send(body).expect(401);
    const forged = { ...sign(body), 'svix-signature': 'v1,AAAA' };
    await request(app.getHttpServer()).post('/api/v1/webhooks/resend').set(forged).set('content-type', 'application/json').send(body).expect(401);
    const stale = sign(body, 'msg_old', Math.floor(Date.now() / 1000) - 3600);
    await request(app.getHttpServer()).post('/api/v1/webhooks/resend').set(stale).set('content-type', 'application/json').send(body).expect(401);
    expect((await sql<{ status: string }>(`SELECT status FROM messages WHERE provider_message_id = 're_test_1'`))[0]!.status).toBe('delivered');
  });
});

describe('checkout reminders (§40)', () => {
  async function stayLeavingTomorrow(room: string, type: string, nights: number, checkedInAfternoon: boolean) {
    const [{ tomorrow, today }] = await sql<{ tomorrow: string; today: string }>(
      `SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::text AS tomorrow, (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`,
    ) as [{ tomorrow: string; today: string }];
    const arrival = new Date(`${tomorrow}T00:00:00Z`);
    arrival.setUTCDate(arrival.getUTCDate() - nights);
    const arrivalIso = arrival.toISOString().slice(0, 10);
    const id = await post(owner, '/reservations', {
      ...booking({ roomTypeId: f.type(type), roomId: f.room(room), arrival: arrivalIso, departure: tomorrow }),
      guest: { firstName: 'Rem', lastName: 'Joshi', mobile: String((mobile += 1)), email: `rem${mobile}@example.com` },
    }).expect(201).then((r) => r.body.id as string);
    const [draft] = await sql<{ id: string }>(
      `INSERT INTO check_in_drafts (property_id, reservation_id, reservation_room_ids, status, confirmed_at, created_by)
       SELECT r.property_id, r.id, array_agg(rr.id), 'confirmed', now(), r.created_by FROM reservations r JOIN reservation_rooms rr ON rr.reservation_id = r.id
        WHERE r.id = $1 GROUP BY r.property_id, r.id, r.created_by RETURNING id`, [id],
    );
    const [stay] = await sql<{ id: string }>(
      `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id, business_date_in,
                          expected_departure, checked_in_by, checked_in_at)
       SELECT rr.property_id, rr.reservation_id, rr.id, rr.room_id, r.primary_guest_id, $2, rr.arrival, rr.departure, r.created_by,
              (($3::date + $4::time) AT TIME ZONE 'Asia/Kolkata')
         FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id WHERE rr.reservation_id = $1 RETURNING id`,
      [id, draft!.id, today, checkedInAfternoon ? '15:00' : '10:00'],
    );
    return { reservationId: id, stayId: stay!.id };
  }

  it('goes once to each guest leaving tomorrow after the reminder time, and skips a same-afternoon one-nighter', async () => {
    await sql(`UPDATE properties SET checkout_reminder_time = '00:00', quiet_hours_start = '00:00', quiet_hours_end = '00:00'`);
    const two = await stayLeavingTomorrow('202', 'DLX', 2, false);
    const one = await stayLeavingTomorrow('203', 'DLX', 1, true);
    expect(await messaging.queueCheckoutReminders()).toBe(2);
    expect(await messaging.queueCheckoutReminders()).toBe(0);
    await messaging.sendDue();
    expect((await messagesFor(two.reservationId)).find((m) => m.template_key === 'checkout_reminder')?.status).toBe('sent');
    expect((await messagesFor(one.reservationId)).find((m) => m.template_key === 'checkout_reminder'))
      .toMatchObject({ status: 'skipped', skip_reason: 'One-night stay checked in this afternoon.' });
  });

  it('waits out quiet hours, worked out by the database clock in the property timezone', async () => {
    // Quiet hours from an hour ago to an hour from now, local time.
    await sql(`UPDATE properties SET quiet_hours_start = ((now() AT TIME ZONE timezone) - interval '1 hour')::time,
                                     quiet_hours_end   = ((now() AT TIME ZONE timezone) + interval '1 hour')::time`);
    const [{ release }] = await sql<{ release: Date }>(`SELECT quiet_hours_release(id) AS release FROM properties`) as [{ release: Date }];
    const minutes = (new Date(release).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(55);
    expect(minutes).toBeLessThan(65);
    await sql(`UPDATE properties SET quiet_hours_start = '21:30', quiet_hours_end = '08:00'`);
  });
});

describe('receipts and the invoice', () => {
  it('a cash payment gets a receipt with the PDF attached; a refund and a company settlement do not', async () => {
    const [{ id: cash }] = await sql<{ id: string }>(`SELECT id FROM payment_accounts WHERE kind = 'cash' LIMIT 1`) as [{ id: string }];
    await post(desk, '/shifts/open', { openingCash: '0' }).expect(200);
    const id = await book();
    await post(desk, `/reservations/${id}/advance`, { method: 'cash', paymentAccountId: cash, amount: '1500' }).expect(200);
    await settle();
    const receipt = (await messagesFor(id)).find((m) => m.template_key === 'receipt');
    expect(receipt).toMatchObject({ status: 'sent' });
    expect(receipt!.body).toMatch(/₹1,500/);
    const sent = dev.sent.find((s) => s.id === receipt!.id)!;
    expect(sent.attachments[0]!.filename).toMatch(/^PAY-\d{6}\.pdf$/);
    expect(sent.attachments[0]!.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('owners see and test templates; the desk cannot', async () => {
    const list = await owner.get('/api/v1/message-templates').expect(200);
    expect(list.body.templates).toHaveLength(10);
    await desk.get('/api/v1/message-templates').expect(403);
    const test = await post(owner, '/message-templates/check_in_welcome/en/test', { to: 'owner@example.com' }, null).expect(200);
    expect(test.body.subject).toMatch(/^\[Test\] Welcome to/);
    await messaging.sendDue();
    expect(dev.sent.some((s) => s.to === 'owner@example.com')).toBe(true);
  });
});
