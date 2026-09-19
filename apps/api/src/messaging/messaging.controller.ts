import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { zId } from '@resortos/shared';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config';
import { CurrentActor, Public, Roles } from '../common/decorators';
import { AppError, forbidden } from '../common/errors';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { ERROR_CODES } from '@resortos/shared';
import { MessagingService } from './messaging.service';
import { verifySvixSignature } from './providers';
import { TEMPLATE_KEYS } from './templates';

const keySchema = z.enum(TEMPLATE_KEYS);
const languageSchema = z.enum(['en', 'hi']);

@Controller()
export class MessagingController {
  constructor(private readonly messaging: MessagingService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Messages for a booking or a stay, newest first — the "Messages" panel. */
  @Get('messages')
  list(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const f = parse(z.object({ reservationId: zId.optional(), stayId: zId.optional(), status: z.string().max(20).optional() }), query);
    if (!f.reservationId && !f.stayId && actor.user.role !== 'owner') throw forbidden('Choose a booking or a stay.');
    return this.messaging.list(actor.user.propertyId, f);
  }

  @Post('messages/:id/resend')
  @HttpCode(200)
  resend(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.messaging.resend(actor, parse(zId, id));
  }

  /** Send a message for a booking now, e.g. the confirmation again after the guest added an email. */
  @Post('messages/send')
  @HttpCode(200)
  sendNow(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(z.object({ templateKey: keySchema, reservationId: zId.optional(), stayId: zId.optional() })
      .refine((v) => v.reservationId || v.stayId, 'Choose a booking or a stay'), body);
    return this.messaging.sendNow(actor, input.templateKey, input);
  }

  // ---------------- templates (owner settings) ----------------

  @Get('message-templates')
  @Roles('owner')
  templates(@CurrentActor() actor: Actor) {
    return this.messaging.listTemplates(actor.user.propertyId);
  }

  @Put('message-templates/:key/:language')
  @Roles('owner')
  saveTemplate(@CurrentActor() actor: Actor, @Param('key') key: string, @Param('language') language: string, @Body() body: unknown) {
    const input = parse(z.object({
      subject: z.string().trim().min(3, 'Enter a subject').max(200),
      body: z.string().trim().min(10, 'Write the message').max(4000),
      isActive: z.boolean().default(true),
    }), body);
    return this.messaging.saveTemplate(actor, parse(keySchema, key), parse(languageSchema, language), input);
  }

  @Get('message-templates/sample')
  @Roles('owner')
  sample(@CurrentActor() actor: Actor) {
    return this.messaging.sampleVars(actor.user.propertyId);
  }

  @Post('message-templates/:key/:language/test')
  @Roles('owner')
  @HttpCode(200)
  test(@CurrentActor() actor: Actor, @Param('key') key: string, @Param('language') language: string, @Body() body: unknown) {
    const { to } = parse(z.object({ to: z.string().trim().email('Enter an email address') }), body);
    return this.messaging.sendTest(actor, parse(keySchema, key), parse(languageSchema, language), to);
  }

  // ---------------- delivery reports ----------------

  /**
   * Resend delivery webhook. Public — Resend's servers call it — so it proves itself instead: a Svix
   * signature over the exact bytes, less than five minutes old. Anything else is refused and changes
   * nothing. Returns 200 for a report about a message we do not know, so Resend stops retrying it.
   */
  @Public()
  @Post('webhooks/resend')
  @HttpCode(200)
  async resendWebhook(
    @Req() req: AppRequest & { rawBody?: Buffer },
    @Headers('svix-id') id?: string, @Headers('svix-timestamp') timestamp?: string, @Headers('svix-signature') signature?: string,
  ) {
    const secret = this.config.RESEND_WEBHOOK_SECRET;
    if (!secret || !req.rawBody || !verifySvixSignature(secret, { id, timestamp, signature }, req.rawBody)) {
      throw new AppError(ERROR_CODES.UNAUTHENTICATED, 'Webhook signature is not valid.');
    }
    const event = JSON.parse(req.rawBody.toString('utf8')) as { type?: string; created_at?: string; data?: { email_id?: string; bounce?: { message?: string } } };
    if (!event.type || !event.data?.email_id) return { ok: true, matched: false };
    const result = await this.messaging.recordDelivery('resend', {
      providerMessageId: event.data.email_id, type: event.type,
      occurredAt: event.created_at ? new Date(event.created_at) : new Date(),
      detail: event.data.bounce?.message,
    });
    return { ok: true, ...result };
  }
}
