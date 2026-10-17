import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  villaBookingSchema,
  VILLA_USES,
  recordPaymentSchema,
  zId,
  zIsoDate,
} from '@resortos/shared';
import { CurrentActor, IdempotencyKey } from '../common/decorators';
import { parse } from '../common/zod';
import type { Actor, AppRequest } from '../common/request-context';
import { DbService } from '../db/db.service';
import { IdempotencyService } from '../common/idempotency.service';
import { VillaService } from './villa.service';
@Controller('villa')
export class VillaController {
  constructor(
    private readonly db: DbService,
    private readonly villa: VillaService,
    private readonly idem: IdempotencyService,
  ) {}
  @Get('bookings') list(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const f = parse(z.object({ from: zIsoDate.optional(), to: zIsoDate.optional() }), query);
    return this.villa.list(actor.user.propertyId, f.from, f.to);
  }
  @Get('availability') async available(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const f = parse(
      z
        .object({
          startsAt: z.iso.datetime({ offset: true }),
          endsAt: z.iso.datetime({ offset: true }),
          excludeId: zId.optional(),
          roomId: zId.optional(),
          useKind: z.enum(VILLA_USES).optional(),
        })
        .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), 'End must be after start'),
      query,
    );
    const rooms = await this.villa.roomOptions(
      this.db,
      actor.user.propertyId,
      f.startsAt,
      f.endsAt,
      f.excludeId,
    );
    const selected = rooms.find((r) => r.id === f.roomId);
    const result =
      f.useKind === 'one_bedroom'
        ? (selected ?? { available: false, message: 'Choose Room 1 or Room 2.' })
        : await this.villa.available(
            this.db,
            actor.user.propertyId,
            f.startsAt,
            f.endsAt,
            f.excludeId,
          );
    return { ...result, rooms };
  }
  @Get('bookings/:id') detail(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.villa.detail(this.db, actor.user.propertyId, parse(zId, id));
  }
  @Post('bookings') create(
    @CurrentActor() actor: Actor,
    @Req() req: AppRequest,
    @IdempotencyKey() key: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(villaBookingSchema, body);
    return this.db
      .tx({ userId: actor.user.id }, (q) =>
        this.idem.run(q, actor, key, { method: req.method, path: req.path, body }, () =>
          this.villa.create(q, actor, input),
        ),
      )
      .then((r) => r.body);
  }
  @Patch('bookings/:id') update(
    @CurrentActor() actor: Actor,
    @Req() req: AppRequest,
    @IdempotencyKey() key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(villaBookingSchema, body);
    return this.db
      .tx({ userId: actor.user.id }, (q) =>
        this.idem.run(q, actor, key, { method: req.method, path: req.path, body }, () =>
          this.villa.update(q, actor, parse(zId, id), input),
        ),
      )
      .then((r) => r.body);
  }
  @Post('bookings/:id/refund')
  @HttpCode(200)
  refund(
    @CurrentActor() actor: Actor,
    @Req() req: AppRequest,
    @IdempotencyKey() key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(recordPaymentSchema, body);
    return this.db
      .tx({ userId: actor.user.id }, (q) =>
        this.idem.run(q, actor, key, { method: req.method, path: req.path, body }, () =>
          this.villa.refund(q, actor, parse(zId, id), input),
        ),
      )
      .then((r) => r.body);
  }
  @Post('bookings/:id/:action')
  @HttpCode(200)
  action(
    @CurrentActor() actor: Actor,
    @Req() req: AppRequest,
    @IdempotencyKey() key: string | undefined,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: unknown,
  ) {
    const bookingId = parse(zId, id);
    const op = parse(z.enum(['arrive', 'depart', 'cancel']), action);
    const { version } = parse(z.object({ version: z.number().int().min(1) }), body);
    return this.db
      .tx({ userId: actor.user.id }, (q) =>
        this.idem.run(q, actor, key, { method: req.method, path: req.path, body }, () =>
          this.villa[op](q, actor, bookingId, version),
        ),
      )
      .then((r) => r.body);
  }
}
