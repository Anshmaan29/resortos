import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, formatDate, formatINR, money, nightsBetween, PAYMENT_METHOD_LABELS, toMoneyString, type PaymentMethod, type EmailSettingsInput } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { OutboxService } from '../common/outbox.service';
import { IdempotencyService } from '../common/idempotency.service';
import { PrintingService } from '../printing/printing.service';
import { MESSAGE_PROVIDERS, ProviderError, type MessageProvider, type OutgoingMessage } from './providers';
import {
  DEFAULT_TEMPLATES, emailHtml, NON_URGENT, renderTemplate, TEMPLATE_KEYS, TEMPLATE_LABELS, TEMPLATE_VARIABLES, unknownVariables,
  type Channel, type Language, type TemplateKey, type TemplateVars,
} from './templates';

/** After this many attempts a message is marked failed and left for a person to resend. */
export const MAX_SEND_ATTEMPTS = 6;
/** How long a claimed message is leased to one sender before another may pick it up. */
const LEASE_SECONDS = 300;
const retryDelaySeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));

interface PropertySettings {
  id: string; name: string; timezone: string; check_in_time: string; check_out_time: string;
  email_enabled: boolean; email_from_name: string | null; email_from_address: string | null; email_reply_to: string | null;
  reception_phone: string | null; phone: string; wifi_details: string | null; location_link: string | null;
}

interface MessageRow {
  id: string; property_id: string; template_key: TemplateKey; channel: Channel; language: Language; recipient: string;
  guest_id: string | null; reservation_id: string | null; stay_id: string | null; invoice_id: string | null; payment_id: string | null;
  trigger: string; source_key: string; subject: string | null; body: string; status: string; skip_reason: string | null;
  last_error: string | null; attempts: number; send_after: Date; provider: string | null; provider_message_id: string | null;
  outgoing_payload: StoredOutgoing | null;
  queued_at: Date; sent_at: Date | null; delivered_at: Date | null; failed_at: Date | null; resend_of: string | null;
}

type StoredOutgoing = Omit<OutgoingMessage, 'attachments'> & { attachments: { filename: string; content: string; contentType: string }[] };

export interface QueueRequest {
  propertyId: string;
  templateKey: TemplateKey;
  trigger: 'event' | 'schedule' | 'resend' | 'test';
  /** What caused it. The same cause queues the same message once (`messages_once_per_cause`). */
  sourceKey: string;
  reservationId?: string | null;
  stayId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  createdBy?: string | null;
  resendOf?: string | null;
  /** A test send goes to the owner, not a guest. */
  recipient?: string;
  /** Recorded, never sent (e.g. a one-night stay that skips its reminder). */
  skipReason?: string;
}

const mapMessage = (r: MessageRow) => ({
  id: r.id, templateKey: r.template_key, templateLabel: TEMPLATE_LABELS[r.template_key as keyof typeof TEMPLATE_LABELS] ?? (r.template_key as string === 'daily_summary' ? 'Owner daily summary' : r.template_key), channel: r.channel, language: r.language,
  recipient: r.recipient, trigger: r.trigger, subject: r.subject, body: r.body, status: r.status,
  skipReason: r.skip_reason, lastError: r.last_error, attempts: r.attempts, sendAfter: r.send_after,
  queuedAt: r.queued_at, sentAt: r.sent_at, deliveredAt: r.delivered_at, failedAt: r.failed_at, resendOf: r.resend_of,
  reservationId: r.reservation_id, stayId: r.stay_id, invoiceId: r.invoice_id, paymentId: r.payment_id,
});

/**
 * Guest messages (spec §40). Two halves, deliberately apart:
 *
 *   queue()    writes the message row — rendered, addressed, or marked skipped with the reason —
 *              idempotently per cause. Runs inside a transaction; touches no network.
 *   sendDue()  delivers queued rows through the channel's provider, with a lease, retries with
 *              backoff, and a final "failed" that a person can resend.
 *
 * A failure anywhere here reaches only the message row: never a booking, a stay or a bill.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly printing: PrintingService,
    @Inject(MESSAGE_PROVIDERS) private readonly providers: MessageProvider[],
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async emailSettings(propertyId: string) {
    const settings = await this.settings(this.db, propertyId);
    const { rows } = await this.db.query<{ version: number; recipients: string[] | {recipients?:string[]} | null }>(
      `SELECT p.version, (SELECT value FROM settings WHERE property_id=p.id AND key='daily_summary_recipients') AS recipients FROM properties p WHERE p.id=$1`, [propertyId],
    );
    const raw=rows[0]!.recipients;
    const owners=await this.db.query<{email:string}>(`SELECT email FROM users WHERE property_id=$1 AND role='owner' AND is_active AND email IS NOT NULL`,[propertyId]);
    const recipients=Array.isArray(raw)?raw:raw?.recipients??owners.rows.map((r)=>r.email);
    return {
      enabled: settings.email_enabled, fromName: settings.email_from_name ?? '', fromAddress: settings.email_from_address ?? '', replyTo: settings.email_reply_to ?? '',
      dailySummaryRecipients: recipients, version: rows[0]!.version,
      provider: this.config.MESSAGING_PROVIDER, jobsEnabled: this.config.JOBS_ENABLED,
      webhookConfigured: Boolean(this.config.RESEND_WEBHOOK_SECRET),
      readyToSend: this.config.MESSAGING_PROVIDER === 'resend' && this.config.JOBS_ENABLED && Boolean(settings.email_from_address),
    };
  }

  async saveEmailSettings(actor: Actor, input: EmailSettingsInput, key: string | undefined) {
    return this.db.tx({ userId: actor.user.id }, async (q) => (await this.idempotency.run(q, actor, key,
      { method: 'PUT', path: '/email-settings', body: input }, async () => {
        const { rows } = await q.query<{ id: string }>(
          `UPDATE properties SET email_enabled=$3, email_from_name=$4, email_from_address=$5, email_reply_to=$6
            WHERE id=$1 AND version=$2 RETURNING id`,
          [actor.user.propertyId, input.version, input.enabled, input.fromName ?? null, input.fromAddress ?? null, input.replyTo ?? null],
        );
        if (!rows[0]) throw staleVersion();
        await q.query(`INSERT INTO settings (property_id,key,value) VALUES ($1,'daily_summary_recipients',$2::jsonb)
          ON CONFLICT (property_id,key) DO UPDATE SET value=EXCLUDED.value`, [actor.user.propertyId, JSON.stringify({ recipients: input.dailySummaryRecipients })]);
        await this.audit.record(q, actor, { action: 'email.settings_saved', entityType: 'property', entityId: actor.user.propertyId, after: input });
        await this.outbox.emit(q, actor.user.propertyId, 'property.email_settings_changed', { type: 'property', id: actor.user.propertyId });
        return { ok: true };
      })).body);
  }

  private async mutate<T>(actor: Actor, key: string | undefined, path: string, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db.tx({ userId: actor.user.id }, async (q) => (await this.idempotency.run(q,actor,key,{method:'POST',path,body},()=>fn(q))).body);
  }

  private provider(channel: Channel): MessageProvider | null {
    return this.providers.find((p) => p.channel === channel) ?? null;
  }

  private async settings(q: Queryable, propertyId: string): Promise<PropertySettings> {
    const { rows } = await q.query<PropertySettings>(
      `SELECT id, name, timezone, to_char(check_in_time, 'HH24:MI') AS check_in_time, to_char(check_out_time, 'HH24:MI') AS check_out_time,
              email_enabled, email_from_name, email_from_address, email_reply_to, reception_phone, phone, wifi_details, location_link
         FROM properties WHERE id = $1`,
      [propertyId],
    );
    return rows[0]!;
  }

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------

  private async template(q: Queryable, propertyId: string, key: TemplateKey, channel: Channel, language: Language) {
    const { rows } = await q.query<{ subject: string | null; body: string; is_active: boolean }>(
      `SELECT subject, body, is_active FROM message_templates
        WHERE property_id = $1 AND template_key = $2 AND channel = $3 AND language = $4`,
      [propertyId, key, channel, language],
    );
    if (rows[0]) return { ...rows[0], source: 'custom' as const };
    const d = DEFAULT_TEMPLATES[key][language];
    return { subject: d.subject, body: d.body, is_active: true, source: 'default' as const };
  }

  async listTemplates(propertyId: string) {
    const { rows } = await this.db.query<{ template_key: TemplateKey; language: Language; subject: string | null; body: string; is_active: boolean; version: number; updated_at: Date }>(
      `SELECT template_key, language, subject, body, is_active, version, updated_at FROM message_templates WHERE property_id = $1 AND channel = 'email'`,
      [propertyId],
    );
    return {
      variables: TEMPLATE_VARIABLES,
      templates: TEMPLATE_KEYS.flatMap((key) => (['en', 'hi'] as const).map((language) => {
        const custom = rows.find((r) => r.template_key === key && r.language === language);
        const d = DEFAULT_TEMPLATES[key][language];
        return {
          key, label: TEMPLATE_LABELS[key], channel: 'email' as const, language,
          subject: custom?.subject ?? d.subject, body: custom?.body ?? d.body, isActive: custom?.is_active ?? true,
          isCustom: Boolean(custom), version: custom?.version ?? 0, defaultSubject: d.subject, defaultBody: d.body,
        };
      })),
    };
  }

  async saveTemplate(actor: Actor, key: TemplateKey, language: Language, input: { subject: string; body: string; isActive: boolean }) {
    const unknown = unknownVariables(`${input.subject}\n${input.body}`);
    if (unknown.length) {
      throw new AppError(ERROR_CODES.VALIDATION, `These are not variables a message can use: ${unknown.map((u) => `{{${u}}}`).join(', ')}.`, {
        fields: [{ path: 'body', message: 'Unknown variable' }],
      });
    }
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO message_templates (property_id, template_key, channel, language, subject, body, is_active, updated_by)
         VALUES ($1,$2,'email',$3,$4,$5,$6,$7)
         ON CONFLICT (property_id, template_key, channel, language)
         DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, is_active = EXCLUDED.is_active, updated_by = EXCLUDED.updated_by
         RETURNING id`,
        [actor.user.propertyId, key, language, input.subject, input.body, input.isActive, actor.user.id],
      );
      await this.audit.record(q, actor, {
        action: 'message_template.saved', entityType: 'message_template', entityId: rows[0]!.id,
        after: { key, language, isActive: input.isActive },
      });
      return { id: rows[0]!.id };
    });
  }

  /** Sample values for the template editor's preview and for a test send. */
  async sampleVars(propertyId: string): Promise<TemplateVars> {
    const s = await this.settings(this.db, propertyId);
    return {
      ...this.propertyVars(s),
      guest_name: 'Rahul Sharma', booking_number: 'BK-000183', room_number: '204', check_in_date: formatDate('2026-10-02'),
      check_out_date: formatDate('2026-10-04'), nights: '2', advance_received: formatINR('5000'), balance: formatINR('0'),
      invoice_number: 'INV/26-27/00152', invoice_total: formatINR('12882'), receipt_number: 'PAY-000923', amount: formatINR('5000'),
      payment_method: 'UPI',
    };
  }

  // ---------------------------------------------------------------------------
  // Variables — only from the whitelist, and never a guest's phone, address or ID (§41)
  // ---------------------------------------------------------------------------

  private propertyVars(s: PropertySettings): TemplateVars {
    return {
      resort_name: s.name, checkout_time: s.check_out_time, check_in_time: s.check_in_time,
      reception_phone: s.reception_phone ?? s.phone, location_link: s.location_link ?? '', wifi: s.wifi_details ?? 'ask at the reception',
    };
  }

  private async context(q: Queryable, propertyId: string, req: QueueRequest) {
    let reservationId = req.reservationId ?? null;
    let stayId = req.stayId ?? null;
    const vars: TemplateVars = {};

    if (req.invoiceId) {
      const { rows } = await q.query<{ number: string; grand_total: string; paid_at_issue: string; reservation_id: string; stay_id: string | null }>(
        `SELECT i.number, i.grand_total, i.paid_at_issue, f.reservation_id, f.stay_id
           FROM invoices i JOIN folios f ON f.id = i.folio_id WHERE i.id = $1 AND i.property_id = $2`,
        [req.invoiceId, propertyId],
      );
      if (!rows[0]) throw notFound('Invoice');
      reservationId = rows[0].reservation_id;
      stayId = stayId ?? rows[0].stay_id;
      const balance = money(rows[0].grand_total).minus(rows[0].paid_at_issue);
      Object.assign(vars, {
        invoice_number: rows[0].number, invoice_total: formatINR(rows[0].grand_total),
        balance: formatINR(toMoneyString(balance.isNegative() ? money(0) : balance)),
      });
    }
    if (req.paymentId) {
      const { rows } = await q.query<{ number: string; amount: string; method: PaymentMethod; reservation_id: string }>(
        `SELECT number, amount, method, reservation_id FROM payments WHERE id = $1 AND property_id = $2`, [req.paymentId, propertyId],
      );
      if (!rows[0]) throw notFound('Payment');
      reservationId = rows[0].reservation_id;
      Object.assign(vars, {
        receipt_number: rows[0].number, amount: formatINR(rows[0].amount),
        payment_method: PAYMENT_METHOD_LABELS[rows[0].method].replace(/ \(.*\)$/, ''),
      });
    }
    if (stayId && !reservationId) {
      const { rows } = await q.query<{ reservation_id: string }>(`SELECT reservation_id FROM stays WHERE id = $1`, [stayId]);
      reservationId = rows[0]?.reservation_id ?? null;
    }
    if (!reservationId) throw new AppError(ERROR_CODES.VALIDATION, 'A message needs a booking to be about.');

    const { rows } = await q.query<{
      number: string; arrival: string; departure: string; guest_id: string; first_name: string; last_name: string;
      email: string | null; preferred_language: Language; advance: string; rooms: string | null;
    }>(
      `SELECT r.number, r.arrival, r.departure, g.id AS guest_id, g.first_name, g.last_name, g.email, g.preferred_language,
              COALESCE((SELECT sum(bill_effect) FROM payments p WHERE p.reservation_id = r.id), 0)::numeric(14,2) AS advance,
              (SELECT string_agg(rm.number, ', ' ORDER BY rm.number) FROM stays s JOIN rooms rm ON rm.id = s.room_id
                WHERE s.reservation_id = r.id AND ($3::uuid IS NULL OR s.id = $3)) AS rooms
         FROM reservations r JOIN guests g ON g.id = r.primary_guest_id
        WHERE r.id = $1 AND r.property_id = $2`,
      [reservationId, propertyId, stayId],
    );
    const r = rows[0];
    if (!r) throw notFound('Booking');
    const { rows: stay } = stayId
      ? await q.query<{ expected_departure: string }>(`SELECT expected_departure FROM stays WHERE id = $1`, [stayId])
      : { rows: [] as { expected_departure: string }[] };
    const departure = stay[0]?.expected_departure ?? r.departure;
    Object.assign(vars, {
      guest_name: `${r.first_name} ${r.last_name}`.trim(), booking_number: r.number,
      check_in_date: formatDate(r.arrival), check_out_date: formatDate(departure), nights: String(nightsBetween(r.arrival, departure)),
      advance_received: formatINR(r.advance), room_number: r.rooms ?? '',
    } satisfies TemplateVars);
    return { vars, reservationId, stayId, guestId: r.guest_id, email: r.email, language: r.preferred_language };
  }

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  /**
   * Write one message row, or none if this cause already produced it. Everything that can be decided
   * now is decided now — and written down: a guest with no email, email switched off, no provider —
   * so the owner sees a "skipped, because…" row instead of silence.
   */
  async queue(q: Queryable, req: QueueRequest): Promise<string | null> {
    const s = await this.settings(q, req.propertyId);
    const ctx = await this.context(q, req.propertyId, req);
    const channel: Channel = 'email';
    const t = await this.template(q, req.propertyId, req.templateKey, channel, ctx.language);
    const vars = { ...this.propertyVars(s), ...ctx.vars };
    const recipient = req.recipient ?? ctx.email ?? '';

    const skip = req.skipReason
      ?? (!t.is_active ? 'This message is switched off in settings.'
        : !recipient ? 'The guest has no email address on file.'
          : !s.email_enabled && req.trigger !== 'test' ? 'Email is switched off in message settings.'
            : !this.provider(channel) ? 'No email provider is set up for this system.'
              : !s.email_from_address && this.provider(channel)?.name === 'resend' ? 'No sender address is set in message settings.'
                : null);

    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO messages (property_id, template_key, channel, language, recipient, guest_id, reservation_id, stay_id, invoice_id,
                             payment_id, trigger, source_key, subject, body, status, skip_reason, send_after, created_by, resend_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               CASE WHEN $17 THEN quiet_hours_release($1) ELSE now() END, $18, $19)
       ON CONFLICT ON CONSTRAINT messages_once_per_cause DO NOTHING
       RETURNING id`,
      [req.propertyId, req.templateKey, channel, ctx.language, recipient, ctx.guestId, ctx.reservationId, ctx.stayId,
        req.invoiceId ?? null, req.paymentId ?? null, req.trigger, req.sourceKey,
        t.subject ? renderTemplate(t.subject, vars) : null, renderTemplate(t.body, vars),
        skip ? 'skipped' : 'queued', skip, NON_URGENT.has(req.templateKey), req.createdBy ?? null, req.resendOf ?? null],
    );
    return rows[0]?.id ?? null;
  }

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  /**
   * Deliver what is due. Rows are leased (`sending`, `send_after` pushed out) under SKIP LOCKED, so
   * two senders never take the same message, and a sender that dies leaves it to be picked up again
   * when the lease runs out. The provider's idempotency key is the message id, so that second pick-up
   * cannot reach the guest twice.
   */
  async sendDue(limit = 10): Promise<{ claimed: number; sent: number; retrying: number; failed: number; skipped: number }> {
    const result = { claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 };
    // Resend retains idempotency keys for 24 hours. A send interrupted beyond that window
    // needs manual delivery reconciliation; automatically repeating it could duplicate an email.
    await this.db.query(`UPDATE messages SET status='failed', failed_at=now(), last_error='Delivery is uncertain after 24 hours. Check Resend before sending again.'
      WHERE status IN ('queued','sending') AND first_attempt_at < now() - interval '23 hours'`);
    for (let i = 0; i < limit; i += 1) {
      // Claim only the next message, so later rows never wait for a batch's lease to expire.
      const { rows } = await this.db.query<MessageRow>(
        `UPDATE messages m SET status='sending', attempts=m.attempts+1, first_attempt_at=COALESCE(m.first_attempt_at,now()), send_after=now()+make_interval(secs=>$1)
          WHERE m.id IN (SELECT id FROM messages WHERE status IN ('queued','sending') AND send_after <= now()
            ORDER BY send_after FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING m.*`, [LEASE_SECONDS],
      );
      const m = rows[0];
      if (!m) break;
      result.claimed += 1;
      const provider = this.provider(m.channel);
      if (!provider) {
        await this.db.query(`UPDATE messages SET status = 'skipped', skip_reason = 'No provider is set up for this channel.' WHERE id = $1 AND status='sending' AND attempts=$2`, [m.id, m.attempts]);
        result.skipped += 1;
        continue;
      }
      try {
        const s = await this.settings(this.db, m.property_id);
        if (!s.email_enabled && m.trigger !== 'test') {
          await this.db.query(`UPDATE messages SET status='skipped', skip_reason='Email is switched off in message settings.' WHERE id=$1 AND status='sending' AND attempts=$2`, [m.id, m.attempts]);
          result.skipped += 1;
          continue;
        }
        const payload: StoredOutgoing = m.outgoing_payload ?? {
          id: m.id, channel: m.channel, to: m.recipient,
          from: s.email_from_address ? { name: s.email_from_name ?? s.name, address: s.email_from_address } : null,
          replyTo: s.email_reply_to, subject: m.subject, text: m.body, html: emailHtml(m.body, s.name),
          attachments: (await this.attachments(m)).map((a) => ({ ...a, content: a.content.toString('base64') })),
          tags: [{ name: 'template', value: m.template_key }],
        };
        const saved = await this.db.query(`UPDATE messages SET outgoing_payload=COALESCE(outgoing_payload,$3::jsonb), send_after=now()+make_interval(secs=>$4)
          WHERE id=$1 AND status='sending' AND attempts=$2`, [m.id,m.attempts,JSON.stringify(payload),LEASE_SECONDS]);
        if (!saved.rowCount) continue; // A newer sender owns this attempt.
        const out: OutgoingMessage = { ...payload, attachments: payload.attachments.map((a) => ({ ...a, content: Buffer.from(a.content,'base64') })) };
        const { providerMessageId } = await provider.send(out);
        await this.db.query(
          `UPDATE messages SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, last_error = NULL
            WHERE id = $1 AND status = 'sending' AND attempts=$4`,
          [m.id, provider.name, providerMessageId, m.attempts],
        );
        result.sent += 1;
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        const retryable = !(err instanceof ProviderError) || err.retryable;
        if (retryable && m.attempts < MAX_SEND_ATTEMPTS) {
          await this.db.query(
            `UPDATE messages SET status = 'queued', last_error = $2, send_after = now() + make_interval(secs => $3) WHERE id = $1 AND status='sending' AND attempts=$4`,
            [m.id, message, retryDelaySeconds(m.attempts), m.attempts],
          );
          result.retrying += 1;
        } else {
          await this.db.query(`UPDATE messages SET status = 'failed', last_error = $2, failed_at = now() WHERE id = $1 AND status='sending' AND attempts=$3`, [m.id, message, m.attempts]);
          result.failed += 1;
          this.logger.warn(`Message ${m.id} (${m.template_key}) failed: ${message}`);
        }
      }
    }
    return result;
  }

  /** The invoice or receipt, rendered from the stored rows at send time — the emailed copy (§40). */
  private async attachments(m: MessageRow): Promise<OutgoingMessage['attachments']> {
    if (m.template_key === 'invoice' && m.invoice_id) {
      const { pdf, filename } = await this.printing.invoicePdfFor(m.property_id, m.invoice_id, { forEmail: true });
      return [{ filename, content: pdf, contentType: 'application/pdf' }];
    }
    if (m.template_key === 'receipt' && m.payment_id) {
      const { pdf, filename } = await this.printing.receiptPdfFor(m.property_id, m.payment_id, { forEmail: true });
      return [{ filename, content: pdf, contentType: 'application/pdf' }];
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Delivery reports (Resend webhook)
  // ---------------------------------------------------------------------------

  /**
   * A delivery report from the provider. Every report is kept in `message_events`; the message's
   * status only ever moves forward (sent → delivered → opened), and a bounce or complaint is final.
   */
  async recordDelivery(provider: string, report: { providerMessageId: string; type: string; occurredAt: Date; detail?: string }) {
    const status = ({
      'email.sent': 'sent', 'email.delivered': 'delivered', 'email.opened': 'opened', 'email.clicked': 'opened',
      'email.bounced': 'bounced', 'email.complained': 'complained', 'email.delivery_delayed': null, 'email.failed': 'failed',
    } as Record<string, string | null>)[report.type];
    return this.db.tx({}, async (q) => {
      const { rows } = await q.query<{ id: string; status: string }>(
        `SELECT id, status FROM messages WHERE provider = $1 AND provider_message_id = $2 FOR UPDATE`, [provider, report.providerMessageId],
      );
      const m = rows[0];
      if (!m) return { matched: false };
      await q.query(
        `INSERT INTO message_events (message_id, status, detail, occurred_at) VALUES ($1,$2,$3,$4)`,
        [m.id, report.type, report.detail?.slice(0, 500) ?? null, report.occurredAt],
      );
      const rank: Record<string, number> = { sending: 0, sent: 1, delivered: 2, opened: 3, bounced: 4, complained: 4, failed: 4 };
      if (status && (rank[status] ?? 0) > (rank[m.status] ?? 99)) {
        await q.query(
          `UPDATE messages SET status = $2,
                  delivered_at = CASE WHEN $2 IN ('delivered', 'opened') THEN COALESCE(delivered_at, $3) ELSE delivered_at END,
                  failed_at = CASE WHEN $2 IN ('bounced', 'complained', 'failed') THEN $3 ELSE failed_at END,
                  last_error = CASE WHEN $2 IN ('bounced', 'complained', 'failed') THEN COALESCE($4, $2) ELSE last_error END
            WHERE id = $1`,
          [m.id, status, report.occurredAt, report.detail ?? null],
        );
      }
      return { matched: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Resend, list, test
  // ---------------------------------------------------------------------------

  /** "Resend" on the stay (§40): a new message with the same subject matter, never an edit of the old one. */
  async resend(actor: Actor, messageId: string, requestKey?: string) {
    return this.mutate(actor,requestKey,`/messages/${messageId}/resend`,{},async(q)=>{
      const { rows } = await q.query<MessageRow>(`SELECT * FROM messages WHERE id = $1 AND property_id = $2`, [messageId, actor.user.propertyId]);
      const m = rows[0];
      if (!m) throw notFound('Message');
      if (m.trigger === 'test') throw new AppError(ERROR_CODES.VALIDATION, 'A test message is not sent again.');
      const id = await this.queue(q, {
        propertyId: actor.user.propertyId, templateKey: m.template_key, trigger: 'resend', sourceKey: `resend:${randomUUID()}`,
        reservationId: m.reservation_id, stayId: m.stay_id, invoiceId: m.invoice_id, paymentId: m.payment_id,
        createdBy: actor.user.id, resendOf: m.id,
      });
      await this.audit.record(q, actor, { action: 'message.resent', entityType: 'message', entityId: messageId, after: { newMessageId: id } });
      if (id) await this.outbox.emit(q,actor.user.propertyId,'message.queued',{type:'message',id});
      const { rows: created } = await q.query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [id]);
      return mapMessage(created[0]!);
    });
  }

  /** Send a template to a key the desk chooses, for a booking (e.g. the confirmation again after an edit). */
  async sendNow(actor: Actor, key: TemplateKey, target: { reservationId?: string; stayId?: string }, requestKey?: string) {
    return this.mutate(actor,requestKey,'/messages/send',{key,...target},async(q)=>{
      const id = await this.queue(q, {
        propertyId: actor.user.propertyId, templateKey: key, trigger: 'resend', sourceKey: `manual:${randomUUID()}`,
        reservationId: target.reservationId, stayId: target.stayId, createdBy: actor.user.id,
      });
      const { rows } = await q.query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [id]);
      await this.audit.record(q,actor,{action:'message.sent_manually',entityType:'message',entityId:id});
      if (id) await this.outbox.emit(q,actor.user.propertyId,'message.queued',{type:'message',id});
      return mapMessage(rows[0]!);
    });
  }

  async list(propertyId: string, filter: { reservationId?: string; stayId?: string; status?: string; limit?: number }) {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM messages
        WHERE property_id = $1
          AND ($2::uuid IS NULL OR reservation_id = $2)
          AND ($3::uuid IS NULL OR stay_id = $3 OR (stay_id IS NULL AND reservation_id = (SELECT reservation_id FROM stays WHERE id = $3)))
          AND ($4::text IS NULL OR status = $4)
        ORDER BY queued_at DESC LIMIT $5`,
      [propertyId, filter.reservationId ?? null, filter.stayId ?? null, filter.status ?? null, filter.limit ?? 100],
    );
    return rows.map(mapMessage);
  }

  /**
   * A test email to the owner, with sample values, so the wording and the sending domain can be checked
   * before any guest sees them. Goes through the same queue and sender as a real message.
   */
  async sendTest(actor: Actor, key: TemplateKey, language: Language, to: string) {
    const provider = this.provider('email');
    if (!provider) throw new AppError(ERROR_CODES.VALIDATION, 'Set up Resend on the server before sending a test.');
    const settings = await this.settings(this.db, actor.user.propertyId);
    if (provider.name === 'resend' && !settings.email_from_address) throw new AppError(ERROR_CODES.VALIDATION, 'Save a sender address on your verified domain first.');
    const vars = await this.sampleVars(actor.user.propertyId);
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const t = await this.template(q, actor.user.propertyId, key, 'email', language);
      const { rows } = await q.query<MessageRow>(
        `INSERT INTO messages (property_id, template_key, channel, language, recipient, trigger, source_key, subject, body, status, skip_reason, created_by)
         VALUES ($1,$2,'email',$3,$4,'test',$5,$6,$7,$8,$9,$10) RETURNING *`,
        [actor.user.propertyId, key, language, to, `test:${randomUUID()}`, `[Test] ${renderTemplate(t.subject ?? '', vars)}`,
          renderTemplate(t.body, vars), this.provider('email') ? 'queued' : 'skipped',
          this.provider('email') ? null : 'No email provider is set up for this system.', actor.user.id],
      );
      return mapMessage(rows[0]!);
    });
  }

  // ---------------------------------------------------------------------------
  // Owner daily summary (§42) — sent after the night audit closes a day
  // ---------------------------------------------------------------------------

  /**
   * One row per date and recipient (`messages_once_per_cause`), body already rendered by the handler
   * — the summary is computed numbers, not a template with variables. It goes out immediately: the
   * audit has just closed the day, and quiet hours are for guest-facing messages.
   */
  async queueDailySummary(q: Queryable, req: { propertyId: string; recipient: string; businessDate: string; subject: string; body: string }): Promise<string | null> {
    const settings = await this.settings(q, req.propertyId);
    const skip = !settings.email_enabled ? 'Email is switched off in message settings.'
      : !this.provider('email') ? 'No email provider is set up for this system.'
      : this.provider('email')?.name === 'resend' && !settings.email_from_address ? 'No sender address is set in message settings.' : null;
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO messages (property_id, template_key, channel, language, recipient, trigger, source_key, subject, body, status, skip_reason, send_after)
       VALUES ($1, 'daily_summary', 'email', 'en', $2, 'schedule', $3, $4, $5, $6, $7, now())
       ON CONFLICT ON CONSTRAINT messages_once_per_cause DO NOTHING
       RETURNING id`,
      [req.propertyId, req.recipient, `daily_summary:${req.businessDate}`, req.subject, req.body, skip ? 'skipped' : 'queued', skip],
    );
    return rows[0]?.id ?? null;
  }

  // ---------------------------------------------------------------------------
  // Checkout reminders (§40) — the evening before departure
  // ---------------------------------------------------------------------------

  /**
   * For every property whose reminder time has passed today, queue a reminder for each guest leaving
   * tomorrow. Safe to run every few minutes: the cause key is the stay, so each stay gets one reminder.
   * A one-night stay checked in that afternoon is recorded as skipped (§40, configurable).
   */
  async queueCheckoutReminders(): Promise<number> {
    const { rows } = await this.db.query<{ property_id: string; stay_id: string; skip: boolean }>(
      `SELECT p.id AS property_id, s.id AS stay_id,
              (p.reminder_skip_same_day AND s.expected_departure - s.business_date_in = 1
               AND (s.checked_in_at AT TIME ZONE p.timezone)::time >= '12:00') AS skip
         FROM properties p
         JOIN stays s ON s.property_id = p.id AND s.status = 'in_house'
        WHERE (now() AT TIME ZONE p.timezone)::time >= p.checkout_reminder_time
          AND s.expected_departure = (now() AT TIME ZONE p.timezone)::date + 1
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.property_id = p.id AND m.source_key = 'stay:' || s.id || ':checkout_reminder')`,
    );
    let queued = 0;
    for (const r of rows) {
      await this.db.tx({}, async (q) => {
        const id = await this.queue(q, {
          propertyId: r.property_id, templateKey: 'checkout_reminder', trigger: 'schedule',
          sourceKey: `stay:${r.stay_id}:checkout_reminder`, stayId: r.stay_id,
          ...(r.skip ? { skipReason: 'One-night stay checked in this afternoon.' } : {}),
        });
        if (id) queued += 1;
      }).catch((err: Error) => this.logger.warn(`Checkout reminder for stay ${r.stay_id}: ${err.message}`));
    }
    return queued;
  }
}
