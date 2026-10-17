import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ERROR_CODES, whatsappConsentSchema, whatsappSettingsSchema, zId } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, IdempotencyKey, Public, Roles } from '../common/decorators';
import { AppError } from '../common/errors';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { APP_CONFIG, type AppConfig } from '../config';
import { MessagingService } from './messaging.service';
import { WhatsAppService } from './whatsapp.service';
import { verifyMetaSignature, verifyMetaToken, whatsappPropertyIds } from './whatsapp';

const targetSchema = z.object({ reservationId: zId.optional(), stayId: zId.optional() })
  .refine(v => Boolean(v.reservationId || v.stayId), 'Choose a booking or a stay');
const callbackSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.object({
      field: z.string(),
      value: z.object({
        metadata: z.object({ phone_number_id: z.string() }).optional(),
        statuses: z.array(z.object({
          id: z.string().max(500),
          status: z.enum(['sent', 'delivered', 'read', 'failed']),
          timestamp: z.string().regex(/^\d{1,12}$/),
          biz_opaque_callback_data: z.string().uuid().optional(),
          errors: z.array(z.object({ code: z.number().int() })).optional(),
        })).max(1000).optional(),
      }),
    })).max(1000),
  })).max(1000),
});

@Controller()
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService, private readonly messaging: MessagingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('whatsapp-settings') @Roles('owner')
  setup(@CurrentActor() actor: Actor) { return this.whatsapp.setup(actor.user.propertyId); }
  @Get('whatsapp-availability')
  available(@CurrentActor() actor: Actor) { return this.whatsapp.availability(actor.user.propertyId); }
  @Post('whatsapp-settings') @Roles('owner') @HttpCode(200)
  save(@CurrentActor() actor: Actor, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    return this.whatsapp.save(actor, parse(whatsappSettingsSchema, body), key);
  }
  @Post('whatsapp-settings/check-templates') @Roles('owner') @HttpCode(200)
  check(@CurrentActor() actor: Actor) { return this.whatsapp.sync(actor); }
  @Get('whatsapp-consent')
  consent(@CurrentActor() actor: Actor, @Query() query: unknown) {
    return this.whatsapp.consent(actor.user.propertyId, parse(targetSchema, query));
  }
  @Post('whatsapp-consent') @HttpCode(200)
  saveConsent(@CurrentActor() actor: Actor, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const input = parse(whatsappConsentSchema.and(targetSchema), body);
    return this.whatsapp.saveConsent(actor, input, input, key);
  }

  @Public() @Get('webhooks/whatsapp')
  verify(@Query() query: Record<string, unknown>, @Res() res: Response) {
    const token = this.config.WHATSAPP_VERIFY_TOKEN;
    if (!token || query['hub.mode'] !== 'subscribe' || typeof query['hub.verify_token'] !== 'string'
      || !verifyMetaToken(token, query['hub.verify_token']) || typeof query['hub.challenge'] !== 'string'
      || query['hub.challenge'].length > 1000) throw new AppError(ERROR_CODES.UNAUTHENTICATED, 'Webhook verification is not valid.');
    res.status(200).type('text/plain').send(query['hub.challenge']);
  }
  @Public() @Post('webhooks/whatsapp') @HttpCode(200)
  async receive(@Req() req: AppRequest & { rawBody?: Buffer }, @Headers('x-hub-signature-256') signature?: string) {
    const secret = this.config.WHATSAPP_APP_SECRET;
    if (!secret || !req.rawBody || !verifyMetaSignature(secret, signature, req.rawBody)) throw new AppError(ERROR_CODES.UNAUTHENTICATED, 'Webhook signature is not valid.');
    // Incoming chat bodies, contacts, phones and IDs are deliberately discarded, never logged.
    const parsed = callbackSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(ERROR_CODES.VALIDATION, 'Webhook payload is not valid.');
    let matched = 0;
    for (const entry of parsed.data.entry) {
      if (entry.id !== this.config.WHATSAPP_BUSINESS_ACCOUNT_ID) continue;
      for (const change of entry.changes) {
        if (change.field !== 'messages' || change.value.metadata?.phone_number_id !== this.config.WHATSAPP_PHONE_NUMBER_ID) continue;
        for (const status of change.value.statuses ?? []) {
          const occurredAt = new Date(Number(status.timestamp) * 1000);
          if (!Number.isFinite(occurredAt.getTime())) continue;
          const report = await this.messaging.recordDelivery('meta_whatsapp', {
            providerMessageId: status.id, type: 'whatsapp.' + status.status, occurredAt,
            messageId: status.biz_opaque_callback_data, propertyIds: whatsappPropertyIds(this.config),
            detail: status.errors?.length ? 'Meta error code ' + status.errors.map(e => e.code).join(', ') : undefined,
          });
          if (report.matched) matched += 1;
        }
      }
    }
    return { ok: true, matched };
  }
}
