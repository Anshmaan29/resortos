import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { closeShiftSchema, openShiftSchema, zId, zIsoDate } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, IdempotencyKey, Roles } from '../common/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService, type Queryable } from '../db/db.service';
import { ShiftsService } from './shifts.service';

const rangeSchema = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  status: z.enum(['open', 'closed']).optional(),
});

@Controller()
export class ShiftsController {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private mutate<T>(actor: Actor, req: AppRequest, key: string | undefined, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db
      .tx({ userId: actor.user.id }, (q) => this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => fn(q)))
      .then((r) => r.body);
  }

  /** My open shift, if any. */
  @Get('shifts/current')
  current(@CurrentActor() actor: Actor) {
    return this.shifts.current(actor);
  }

  @Get('shifts')
  list(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const range = parse(rangeSchema, query);
    // A receptionist sees their own shifts through `current`; the full list is the owner's.
    return this.shifts.list(actor.user.propertyId, actor.user.role === 'owner' ? range : { ...range, status: 'open' });
  }

  @Get('shifts/:id')
  detail(@CurrentActor() actor: Actor, @Param('id') id: string) {
    const shiftId = parse(zId, id);
    return this.db.tx({ userId: actor.user.id }, (q) => this.shifts.detail(q, actor.user.propertyId, shiftId));
  }

  @Post('shifts/open')
  @HttpCode(200)
  open(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const input = parse(openShiftSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.shifts.open(q, actor, input));
  }

  @Post('shifts/:id/close')
  @HttpCode(200)
  close(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const shiftId = parse(zId, id);
    const input = parse(closeShiftSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.shifts.close(q, actor, shiftId, input));
  }

  /** Account-wise ledger — "Ledger Entries" in the old software. Owner only: it is the whole till. */
  @Get('payment-accounts/:id/ledger')
  @Roles('owner')
  ledger(@CurrentActor() actor: Actor, @Param('id') id: string, @Query() query: unknown) {
    const accountId = parse(zId, id);
    const range = parse(rangeSchema, query);
    return this.shifts.ledger(actor.user.propertyId, accountId, range);
  }
}
