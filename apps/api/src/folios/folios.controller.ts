import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { addChargeSchema, chargeItemSchema, voidLineSchema, zId } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, IdempotencyKey, Roles } from '../common/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService, type Queryable } from '../db/db.service';
import { FolioService } from './folio.service';

@Controller()
export class FoliosController {
  constructor(
    private readonly folios: FolioService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private mutate<T>(actor: Actor, req: AppRequest, key: string | undefined, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db
      .tx({ userId: actor.user.id }, (q) => this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => fn(q)))
      .then((r) => r.body);
  }

  /** The bill for a stay, opened on first look. */
  @Get('stays/:id/bill')
  forStay(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.folios.forStay(actor, parse(zId, id));
  }

  @Post('folios/:id/charges')
  @HttpCode(200)
  addCharge(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const folioId = parse(zId, id);
    const input = parse(addChargeSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.folios.addCharge(q, actor, folioId, input));
  }

  @Post('folio-lines/:id/void')
  @HttpCode(200)
  voidLine(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const lineId = parse(zId, id);
    const input = parse(voidLineSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.folios.voidLine(q, actor, lineId, input));
  }

  // ---------------- saved charge items (spec §24.2) ----------------

  @Get('charge-items')
  listItems(@CurrentActor() actor: Actor, @Query('includeInactive') includeInactive?: string) {
    return this.folios.listChargeItems(actor.user.propertyId, includeInactive === 'true');
  }

  // Owner settings (spec §24.2), so they follow the same shape as the other settings endpoints:
  // owner-only, guarded by an optimistic version rather than an idempotency key.
  @Post('charge-items')
  @Roles('owner')
  createItem(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(chargeItemSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.folios.createChargeItem(q, actor, input));
  }

  @Patch('charge-items/:id')
  @Roles('owner')
  updateItem(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const itemId = parse(zId, id);
    const { version, ...rest } = parse(chargeItemSchema.extend({ version: z.coerce.number().int().min(1) }), body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.folios.updateChargeItem(q, actor, itemId, rest, version));
  }
}
