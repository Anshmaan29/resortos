import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type WhatsAppSettingsInput } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound, staleVersion } from '../common/errors';
import { IdempotencyService } from '../common/idempotency.service';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Queryable } from '../db/db.service';
import { MessagingService, type QueueRequest } from './messaging.service';
import type { OutgoingMessage } from './providers';
import { NON_URGENT, TEMPLATE_LABELS, type TemplateKey } from './templates';
import { defaultBindings, WHATSAPP_WORDING, whatsappBody, whatsappConfigured, whatsappNumber, whatsappParameters, whatsappWording, WhatsAppProvider, type TemplateBinding } from './whatsapp';

interface Binding extends TemplateBinding { ready?: boolean; approval?: string; matching?: boolean }
interface Settings { enabled: boolean; templates: Binding[]; checkedAt?: string }
const defaults = (): Settings => ({ enabled: false, templates: defaultBindings() });

@Injectable()
export class WhatsAppService {
  constructor(
    private readonly db: DbService, private readonly messaging: MessagingService,
    private readonly audit: AuditService, private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService, @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  private available(propertyId: string) {
    return whatsappConfigured(this.config) && this.config.WHATSAPP_PROPERTY_ID === propertyId;
  }
  private async settings(q: Queryable, propertyId: string): Promise<Settings> {
    const { rows } = await q.query<{ value: Settings }>("SELECT value FROM settings WHERE property_id=$1 AND key='whatsapp'", [propertyId]);
    return rows[0]?.value ?? defaults();
  }
  async setup(propertyId: string) {
    const settings = await this.settings(this.db, propertyId);
    const { rows } = await this.db.query<{ version: number }>('SELECT version FROM properties WHERE id=$1', [propertyId]);
    return {
      ...settings, propertyId, version: rows[0]!.version, configured: this.available(propertyId), jobsEnabled: this.config.JOBS_ENABLED,
      webhookConfigured: Boolean(this.config.WHATSAPP_APP_SECRET && this.config.WHATSAPP_VERIFY_TOKEN),
      phoneNumberId: this.config.WHATSAPP_PROPERTY_ID === propertyId ? this.config.WHATSAPP_PHONE_NUMBER_ID ?? null : null,
      templates: settings.templates.map(t => ({ ...t, label: TEMPLATE_LABELS[t.key],
        body: whatsappWording(t.key,t.language,t.name).body, variables: WHATSAPP_WORDING[t.key].variables,
        documentHeader: WHATSAPP_WORDING[t.key].documentHeader })),
    };
  }
  async availability(propertyId: string) {
    const settings = await this.settings(this.db, propertyId);
    return { enabled: settings.enabled, configured: this.available(propertyId), jobsEnabled: this.config.JOBS_ENABLED };
  }
  private async mutate<T>(actor: Actor, key: string | undefined, path: string, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db.tx({ userId: actor.user.id }, async q =>
      (await this.idempotency.run(q, actor, key, { method: 'POST', path, body }, () => fn(q))).body);
  }
  async save(actor: Actor, input: WhatsAppSettingsInput, key: string | undefined) {
    if (input.enabled && !this.available(actor.user.propertyId)) throw new AppError(ERROR_CODES.VALIDATION, 'Set up the WhatsApp server credentials first.');
    if (input.enabled && !this.config.JOBS_ENABLED) throw new AppError(ERROR_CODES.VALIDATION, 'The message sender must be enabled on the server.');
    return this.mutate(actor, key, '/whatsapp-settings', input, async q => {
      const changed = await q.query('UPDATE properties SET version=version+1 WHERE id=$1 AND version=$2', [actor.user.propertyId, input.version]);
      if (!changed.rowCount) throw staleVersion();
      const previous = await this.settings(q, actor.user.propertyId);
      const templates = input.templates.map(t => {
        const old = previous.templates.find(p => p.key === t.key && p.language === t.language && p.name === t.name && p.languageCode === t.languageCode);
        return { ...t, ready: old?.ready ?? false, approval: old?.approval ?? 'NOT_CHECKED', matching: old?.matching ?? false };
      });
      if (input.enabled && !templates.some(t => t.active && t.ready)) throw new AppError(ERROR_CODES.VALIDATION, 'Check Meta approval for at least one active template before switching WhatsApp on.');
      const value: Settings = { enabled: input.enabled, templates, checkedAt: previous.checkedAt };
      await q.query("INSERT INTO settings(property_id,key,value) VALUES($1,'whatsapp',$2::jsonb) ON CONFLICT(property_id,key) DO UPDATE SET value=EXCLUDED.value", [actor.user.propertyId, JSON.stringify(value)]);
      await this.audit.record(q, actor, { action: 'whatsapp.settings_saved', entityType: 'property', entityId: actor.user.propertyId, after: { enabled: value.enabled, templates: templates.map(t => ({ key: t.key, name: t.name, active: t.active })) } });
      await this.outbox.emit(q, actor.user.propertyId, 'property.whatsapp_settings_changed', { type: 'property', id: actor.user.propertyId });
      return { ok: true };
    });
  }
  async sync(actor: Actor) {
    if (!this.available(actor.user.propertyId)) throw new AppError(ERROR_CODES.VALIDATION, 'Set up the WhatsApp server credentials first.');
    const settings = await this.settings(this.db, actor.user.propertyId);
    // Network is deliberately outside the database transaction.
    const checked = await new WhatsAppProvider(this.config).approval(settings.templates);
    await this.db.tx({ userId: actor.user.id }, async q => {
      await q.query('SELECT id FROM properties WHERE id=$1 FOR UPDATE', [actor.user.propertyId]);
      const current = await this.settings(q, actor.user.propertyId);
      const templates = current.templates.map(t => {
        const match = checked.find(p => p.key === t.key && p.language === t.language && p.name === t.name && p.languageCode === t.languageCode);
        return match ? { ...match, active: t.active } : t;
      });
      await q.query("INSERT INTO settings(property_id,key,value) VALUES($1,'whatsapp',$2::jsonb) ON CONFLICT(property_id,key) DO UPDATE SET value=EXCLUDED.value", [actor.user.propertyId, JSON.stringify({ ...current, templates, checkedAt: new Date().toISOString() })]);
      await this.audit.record(q, actor, { action: 'whatsapp.templates_checked', entityType: 'property', entityId: actor.user.propertyId, after: { approvedCount: checked.filter(t => t.ready).length } });
    });
    return this.setup(actor.user.propertyId);
  }
  private async guest(q: Queryable, propertyId: string, target: { reservationId?: string; stayId?: string }) {
    const { rows } = await q.query<{ id: string; version: number; whatsapp_opted_in: boolean }>(
      'SELECT g.id,g.version,g.whatsapp_opted_in FROM reservations r JOIN guests g ON g.id=r.primary_guest_id AND g.property_id=r.property_id WHERE r.property_id=$1 AND (($2::uuid IS NOT NULL AND r.id=$2) OR ($2::uuid IS NULL AND r.id=(SELECT reservation_id FROM stays WHERE id=$3 AND property_id=$1)))',
      [propertyId, target.reservationId ?? null, target.stayId ?? null]);
    if (!rows[0]) throw notFound('Guest');
    return rows[0];
  }
  async consent(propertyId: string, target: { reservationId?: string; stayId?: string }) {
    const g = await this.guest(this.db, propertyId, target);
    return { optedIn: g.whatsapp_opted_in, version: g.version };
  }
  async saveConsent(actor: Actor, target: { reservationId?: string; stayId?: string }, input: { optedIn: boolean; version: number }, key: string | undefined) {
    return this.mutate(actor, key, '/whatsapp-consent', { ...target, ...input }, async q => {
      const g = await this.guest(q, actor.user.propertyId, target);
      const changed = await q.query('UPDATE guests SET whatsapp_opted_in=$3, whatsapp_consent_at=now(), whatsapp_consent_by=$4 WHERE id=$1 AND property_id=$2 AND version=$5',
        [g.id, actor.user.propertyId, input.optedIn, actor.user.id, input.version]);
      if (!changed.rowCount) throw staleVersion();
      await this.audit.record(q, actor, { action: 'guest.whatsapp_consent_recorded', entityType: 'guest', entityId: g.id, after: { optedIn: input.optedIn } });
      return { ok: true };
    });
  }

  async queue(q: Queryable, req: QueueRequest): Promise<string | null> {
    const settings = await this.settings(q, req.propertyId);
    if (!settings.enabled) return null; // No new skipped rows for installations not using WhatsApp.
    const ctx = await this.messaging.context(q, req.propertyId, req);
    const property = await this.messaging.settings(q, req.propertyId);
    const binding = settings.templates.find(t => t.key === req.templateKey && t.language === ctx.language)
      ?? settings.templates.find(t => t.key === req.templateKey && t.language === 'en');
    const parameters = whatsappParameters(req.templateKey, { ...this.messaging.propertyVars(property), ...ctx.vars }, binding?.name, binding?.language ?? 'en');
    const recipient = whatsappNumber(ctx.mobile ?? '') ?? '';
    const skip = req.skipReason ?? (!ctx.whatsappOptedIn ? 'The guest has not agreed to WhatsApp messages.'
      : !recipient ? 'The guest has no valid WhatsApp phone number on file.'
      : !this.available(req.propertyId) ? 'WhatsApp server credentials are incomplete.'
      : !binding?.active ? 'This WhatsApp message is switched off.'
      : !binding.ready ? 'The WhatsApp template is not approved or its wording does not match.'
      : null);
    const id = randomUUID();
    const payload: OutgoingMessage = {
      id, channel: 'whatsapp', to: recipient, from: null, replyTo: null, subject: null,
      text: whatsappBody(req.templateKey, parameters, binding?.language ?? 'en', binding?.name), html: null, attachments: [], tags: [],
      ...(binding ? { whatsapp: { name: binding.name, languageCode: binding.languageCode, parameters, documentHeader: WHATSAPP_WORDING[req.templateKey].documentHeader } } : {}),
    };
    const { rows } = await q.query<{ id: string }>(
      "INSERT INTO messages(id,property_id,template_key,channel,language,recipient,guest_id,reservation_id,stay_id,invoice_id,payment_id,trigger,source_key,body,status,skip_reason,send_after,created_by,resend_of,outgoing_payload) VALUES($1,$2,$3,'whatsapp',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $16 THEN quiet_hours_release($2) ELSE now() END,$17,$18,$19::jsonb) ON CONFLICT ON CONSTRAINT messages_once_per_cause DO NOTHING RETURNING id",
      [id, req.propertyId, req.templateKey, binding?.language ?? 'en', recipient, ctx.guestId, ctx.reservationId, ctx.stayId, req.invoiceId ?? null,
        req.paymentId ?? null, req.trigger, req.sourceKey, payload.text, skip ? 'skipped' : 'queued', skip, NON_URGENT.has(req.templateKey), req.createdBy ?? null, req.resendOf ?? null, JSON.stringify(payload)]);
    return rows[0]?.id ?? null;
  }
  async send(actor: Actor, templateKey: TemplateKey, target: { reservationId?: string; stayId?: string }, key: string | undefined) {
    return this.mutate(actor, key, '/whatsapp/send', { templateKey, ...target }, async q => {
      const id = await this.queue(q, { propertyId: actor.user.propertyId, templateKey, ...target, trigger: 'resend', sourceKey: 'manual:' + randomUUID(), createdBy: actor.user.id });
      if (!id) throw new AppError(ERROR_CODES.VALIDATION, 'WhatsApp is switched off in settings.');
      await this.audit.record(q, actor, { action: 'whatsapp.sent_manually', entityType: 'message', entityId: id });
      await this.outbox.emit(q, actor.user.propertyId, 'message.queued', { type: 'message', id });
      return this.message(q, id);
    });
  }
  private async message(q: Queryable, id: string) {
    const { rows } = await q.query<{ id: string; status: string; skip_reason: string | null }>('SELECT id,status,skip_reason FROM messages WHERE id=$1', [id]);
    return { id: rows[0]!.id, status: rows[0]!.status, skipReason: rows[0]!.skip_reason };
  }
  async resend(actor: Actor, id: string, key: string | undefined) {
    return this.mutate(actor, key, '/whatsapp/' + id + '/resend', {}, async q => {
      const { rows } = await q.query<{ template_key: TemplateKey; reservation_id: string | null; stay_id: string | null; invoice_id: string | null; payment_id: string | null }>(
        "SELECT template_key,reservation_id,stay_id,invoice_id,payment_id FROM messages WHERE id=$1 AND property_id=$2 AND channel='whatsapp'", [id, actor.user.propertyId]);
      const m = rows[0]; if (!m) throw notFound('Message');
      const created = await this.queue(q, { propertyId: actor.user.propertyId, templateKey: m.template_key, reservationId: m.reservation_id, stayId: m.stay_id, invoiceId: m.invoice_id, paymentId: m.payment_id, trigger: 'resend', sourceKey: 'resend:' + randomUUID(), createdBy: actor.user.id, resendOf: id });
      if (!created) throw new AppError(ERROR_CODES.VALIDATION, 'WhatsApp is switched off in settings.');
      await this.audit.record(q, actor, { action: 'whatsapp.resent', entityType: 'message', entityId: id, after: { newMessageId: created } });
      await this.outbox.emit(q, actor.user.propertyId, 'message.queued', { type: 'message', id: created });
      return this.message(q, created);
    });
  }
  async queueCheckoutReminders() {
    const { rows } = await this.db.query<{ property_id: string; stay_id: string; skip: boolean }>(
      "SELECT p.id AS property_id,s.id AS stay_id,(p.reminder_skip_same_day AND s.expected_departure-(s.checked_in_at AT TIME ZONE p.timezone)::date=1 AND (s.checked_in_at AT TIME ZONE p.timezone)::time >= '12:00') AS skip FROM properties p JOIN stays s ON s.property_id=p.id AND s.status='in_house' WHERE p.id=$1 AND (now() AT TIME ZONE p.timezone)::time>=p.checkout_reminder_time AND s.expected_departure=(now() AT TIME ZONE p.timezone)::date+1 AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.property_id=p.id AND m.channel='whatsapp' AND m.source_key='stay:' || s.id || ':checkout_reminder')", [this.config.WHATSAPP_PROPERTY_ID ?? null]);
    for (const r of rows) await this.db.tx({}, q => this.queue(q, { propertyId: r.property_id, templateKey: 'checkout_reminder', trigger: 'schedule', sourceKey: 'stay:' + r.stay_id + ':checkout_reminder', stayId: r.stay_id, ...(r.skip ? { skipReason: 'One-night stay checked in this afternoon.' } : {}) }));
  }
}
