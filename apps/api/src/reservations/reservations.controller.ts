import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  ERROR_CODES, nightsBetween, availabilityQuerySchema, BOOKING_SOURCES, cancelReservationSchema, createReservationSchema, noShowSchema, RESERVATION_STATUSES,
  reservationEstimateSchema, updateReservationSchema, zId, zIsoDate,
} from '@resortos/shared';
import { CurrentActor, IdempotencyKey } from '../common/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { AppError } from '../common/errors';
import { DbService, type Queryable } from '../db/db.service';
import { ReservationsService } from './reservations.service';

@Controller()
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** Wraps a mutation in one transaction with idempotency (spec §8.2, §51). */
  private mutate<T>(actor: Actor, req: AppRequest, key: string | undefined, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db
      .tx({ userId: actor.user.id }, (q) => this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => fn(q)))
      .then((r) => r.body);
  }

  @Get('availability')
  availability(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const input = parse(availabilityQuerySchema, query);
    return this.reservations.availability(actor.user.propertyId, input.arrival, input.departure, input.roomTypeId);
  }

  @Get('front-desk')
  frontDesk(@CurrentActor() actor: Actor) {
    return this.reservations.frontDesk(actor.user.propertyId);
  }

  @Get('calendar')
  calendar(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const input = parse(z.object({ from: zIsoDate, to: zIsoDate.optional(), days: z.coerce.number().int().min(1).max(62).optional() })
      .refine((v) => !v.to || !v.days, { message: 'Use either an end date or a number of days', path: ['to'] }), query);
    // End is exclusive, as in the returned calendar range. Never silently ignore it.
    const days = input.to ? nightsBetween(input.from, input.to) : input.days ?? 14;
    if (days < 1 || days > 62) throw new AppError(ERROR_CODES.VALIDATION, 'Choose a calendar range from 1 to 62 days.');
    return this.reservations.calendar(actor.user.propertyId, input.from, days);
  }

  @Get('reservations')
  list(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const input = parse(z.object({
      from: zIsoDate.optional(), to: zIsoDate.optional(), status: z.enum(RESERVATION_STATUSES).optional(),
      source: z.enum(BOOKING_SOURCES).optional(), q: z.string().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }), query);
    return this.reservations.list(actor.user.propertyId, input);
  }

  @Get('reservations/:id')
  get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.reservations.detail(this.db, actor.user.propertyId, parse(zId, id));
  }

  @Post('reservations')
  create(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const input = parse(createReservationSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.reservations.create(q, actor, input));
  }

  /** Price + GST estimate for the booking form; same pricing code as saving, no side effects. */
  @Post('reservations/estimate')
  @HttpCode(200)
  estimate(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.reservations.estimate(this.db, actor.user.propertyId, parse(reservationEstimateSchema, body));
  }

  @Patch('reservations/:id')
  update(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const reservationId = parse(zId, id);
    const input = parse(updateReservationSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.reservations.update(q, actor, reservationId, input));
  }

  @Post('reservations/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string) {
    const reservationId = parse(zId, id);
    return this.mutate(actor, req, key, {}, (q) => this.reservations.confirm(q, actor, reservationId));
  }

  @Post('reservations/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const reservationId = parse(zId, id);
    const input = parse(cancelReservationSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.reservations.cancel(q, actor, reservationId, input));
  }

  @Post('reservations/:id/no-show')
  @HttpCode(200)
  noShow(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const reservationId = parse(zId, id);
    const input = parse(noShowSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.reservations.noShow(q, actor, reservationId, input));
  }

  @Post('reservation-rooms/:id/assign')
  @HttpCode(200)
  assign(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const rrId = parse(zId, id);
    const { roomId } = parse(z.object({ roomId: zId.nullable() }), body);
    return this.mutate(actor, req, key, body, (q) => this.reservations.assignRoom(q, actor, rrId, roomId));
  }
}
