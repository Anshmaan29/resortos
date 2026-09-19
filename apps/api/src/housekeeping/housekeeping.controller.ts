import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { housekeepingTaskUpdateSchema, zId, zIsoDate } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, IdempotencyKey, Roles } from '../common/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';
import { HousekeepingService } from './housekeeping.service';

const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });

/** Housekeeping board, cleaner task list and the actions on a cleaning task (spec §37, §4.3). */
@Controller('housekeeping')
export class HousekeepingController {
  constructor(
    private readonly housekeeping: HousekeepingService,
    private readonly property: PropertyService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private mutate<T>(actor: Actor, req: AppRequest, key: string | undefined, body: unknown, reason: string | undefined, fn: (q: Queryable) => Promise<T>) {
    return this.db
      .tx({ userId: actor.user.id, reason }, (q) => this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => fn(q)))
      .then((r) => r.body);
  }

  @Get('board')
  board(@CurrentActor() actor: Actor) {
    return this.housekeeping.board(actor.user.propertyId);
  }

  @Get('my-tasks')
  @Roles('owner', 'receptionist', 'cleaner')
  mine(@CurrentActor() actor: Actor) {
    return this.housekeeping.myTasks(actor);
  }

  @Get('history')
  async history(@CurrentActor() actor: Actor, @Query('from') from?: string, @Query('to') to?: string) {
    const businessDate = (await this.property.getProperty(actor.user.propertyId)).businessDate;
    return this.housekeeping.history(actor.user.propertyId, from ? parse(zIsoDate, from) : businessDate, to ? parse(zIsoDate, to) : businessDate);
  }

  @Post('tasks/:id/start')
  @Roles('owner', 'receptionist', 'cleaner')
  @HttpCode(200)
  start(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string) {
    const taskId = parse(zId, id);
    return this.mutate(actor, req, key, {}, 'Cleaning started', (q) => this.housekeeping.start(q, actor, taskId));
  }

  @Post('tasks/:id/complete')
  @Roles('owner', 'receptionist', 'cleaner')
  @HttpCode(200)
  complete(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string) {
    const taskId = parse(zId, id);
    return this.mutate(actor, req, key, {}, 'Room cleaned', (q) => this.housekeeping.complete(q, actor, taskId));
  }

  @Post('tasks/:id/stop')
  @Roles('owner', 'receptionist', 'cleaner')
  @HttpCode(200)
  stop(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string) {
    const taskId = parse(zId, id);
    return this.mutate(actor, req, key, {}, 'Cleaning stopped', (q) => this.housekeeping.stop(q, actor, taskId));
  }

  // Assigning is guarded by the task's version rather than an idempotency key: sending it twice
  // lands on the same state, and the second attempt with a stale version is refused.
  @Patch('tasks/:id')
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const taskId = parse(zId, id);
    const input = parse(housekeepingTaskUpdateSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.housekeeping.update(q, actor, taskId, input));
  }

  @Post('tasks/:id/skip')
  @HttpCode(200)
  skip(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const taskId = parse(zId, id);
    const { reason } = parse(reasonSchema, body);
    return this.mutate(actor, req, key, body, reason, (q) => this.housekeeping.skipStayover(q, actor, taskId, reason));
  }
}
