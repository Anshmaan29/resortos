import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { companyReceiptSchema, companySchema, otaBookingSchema, otaPayoutSchema, zId, zIsoDate } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, IdempotencyKey, Roles } from '../common/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService, type Queryable } from '../db/db.service';
import { CompaniesService } from './companies.service';
import { OtaService } from './ota.service';

const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });
const rangeSchema = z.object({ from: zIsoDate.optional(), to: zIsoDate.optional() });

/** Company accounts (spec §32) and OTA bookings (§33): money the resort is owed by someone other than the guest. */
@Controller()
export class ReceivablesController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly ota: OtaService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private mutate<T>(actor: Actor, req: AppRequest, key: string | undefined, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db
      .tx({ userId: actor.user.id }, (q) => this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => fn(q)))
      .then((r) => r.body);
  }

  // ---------------- companies ----------------

  @Get('companies')
  list(@CurrentActor() actor: Actor, @Query('includeInactive') includeInactive?: string) {
    return this.companies.list(actor.user.propertyId, includeInactive === 'true');
  }

  @Post('companies')
  @Roles('owner')
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(companySchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.companies.create(q, actor, input));
  }

  @Patch('companies/:id')
  @Roles('owner')
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const companyId = parse(zId, id);
    const { version, ...input } = parse(companySchema.extend({ version: z.coerce.number().int().min(1) }), body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.companies.update(q, actor, companyId, input, version));
  }

  @Get('companies/:id/statement')
  @Roles('owner')
  statement(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.companies.statement(actor.user.propertyId, parse(zId, id));
  }

  @Post('companies/:id/receipts')
  @HttpCode(200)
  receipt(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const companyId = parse(zId, id);
    const input = parse(companyReceiptSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.companies.recordReceipt(q, actor, companyId, input));
  }

  @Post('company-receipts/:id/reverse')
  @Roles('owner')
  @HttpCode(200)
  reverseReceipt(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const receiptId = parse(zId, id);
    const { reason } = parse(reasonSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.companies.reverseReceipt(q, actor, receiptId, reason));
  }

  // ---------------- OTA ----------------

  @Get('reservations/:id/ota')
  terms(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.ota.terms(actor.user.propertyId, parse(zId, id));
  }

  @Put('reservations/:id/ota')
  saveTerms(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const reservationId = parse(zId, id);
    const input = parse(otaBookingSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.ota.saveTerms(q, actor, reservationId, input));
  }

  @Post('reservations/:id/ota/payouts')
  @Roles('owner')
  @HttpCode(200)
  payout(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const reservationId = parse(zId, id);
    const input = parse(otaPayoutSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.ota.recordPayout(q, actor, reservationId, input));
  }

  @Post('ota-payouts/:id/reverse')
  @Roles('owner')
  @HttpCode(200)
  reversePayout(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const payoutId = parse(zId, id);
    const { reason } = parse(reasonSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.ota.reversePayout(q, actor, payoutId, reason));
  }

  @Get('ota/receivables')
  @Roles('owner')
  receivables(@CurrentActor() actor: Actor, @Query() query: unknown) {
    return this.ota.receivables(actor.user.propertyId, parse(rangeSchema, query));
  }

  /** The dashboard's "Availability changed today" list (§33). */
  @Get('availability-changes/today')
  availabilityChanges(@CurrentActor() actor: Actor) {
    return this.ota.availabilityChangedToday(actor.user.propertyId);
  }
}
