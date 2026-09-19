import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { completeNightAuditSchema } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, IdempotencyKey } from '../common/decorators';
import { AppError } from '../common/errors';
import { IdempotencyService } from '../common/idempotency.service';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { NightAuditService } from './night-audit.service';

@Controller()
export class NightAuditController {
  constructor(
    private readonly nightAudit: NightAuditService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** The night audit screen. A read: safe to poll while staff clear the blockers. */
  @Get('night-audit')
  preview(@CurrentActor() actor: Actor) {
    return this.nightAudit.preview(actor);
  }

  /** The Day Audit Log — every business date that has been closed. */
  @Get('night-audit/log')
  log(@CurrentActor() actor: Actor, @Query('limit') limit?: string) {
    return this.nightAudit.log(actor.user.propertyId, parse(z.coerce.number().int().min(1).max(365).default(60), limit ?? 60));
  }

  @Post('night-audit/complete')
  @HttpCode(200)
  async complete(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const input = parse(completeNightAuditSchema, body);
    try {
      const result = await this.db
        .tx({ userId: actor.user.id, reason: 'Night audit' }, (q) =>
          this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => this.nightAudit.complete(q, actor, input)))
        .then((r) => r.body);
      return result;
    } catch (error) {
      // A refused attempt belongs in the day audit log, and the transaction that refused it has
      // already rolled back — so it is written here, in its own transaction, before rethrowing.
      if (error instanceof AppError) {
        await this.nightAudit.recordRefusal(actor, { businessDate: input.businessDate, code: error.code, message: error.message, details: error.details ?? null });
      }
      throw error;
    }
  }
}
