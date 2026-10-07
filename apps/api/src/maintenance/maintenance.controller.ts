import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { zId, maintenanceTicketCreateSchema, maintenanceTicketPatchSchema, maintenanceScheduleCreateSchema, maintenanceSchedulePatchSchema } from '@resortos/shared';
import { CurrentActor, IdempotencyKey, Roles } from '../common/decorators';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { MaintenanceService } from './maintenance.service';
import { IdempotencyService } from '../common/idempotency.service';
import type { Queryable } from '../db/db.service';

const ticketStatus = z.enum(['open', 'in_progress', 'resolved', 'closed']);
const listQuery = z.object({ status: ticketStatus.optional() });

/** Maintenance tickets and preventive schedules (spec §38). */
@Controller()
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private mutate<T>(actor: Actor, req: AppRequest, key: string | undefined, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db.tx({ userId: actor.user.id }, (q) => this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => fn(q))).then((r) => r.body);
  }

  @Get('maintenance/tickets')
  tickets(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const { status } = parse(listQuery, query);
    return this.maintenance.listTickets(actor.user.propertyId, status);
  }

  @Post('maintenance/tickets')
  create(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const input = parse(maintenanceTicketCreateSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.maintenance.createTicket(q, actor, input));
  }

  @Patch('maintenance/tickets/:id')
  patch(@CurrentActor() actor: Actor, @Req() req: AppRequest, @Param('id') id: string, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const ticketId = parse(zId, id);
    const input = parse(maintenanceTicketPatchSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.maintenance.patchTicket(q, actor, ticketId, input));
  }

  @Get('maintenance/schedules')
  @Roles('owner')
  schedules(@CurrentActor() actor: Actor) {
    return this.maintenance.listSchedules(actor.user.propertyId);
  }

  @Post('maintenance/schedules')
  @Roles('owner')
  createSchedule(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const input = parse(maintenanceScheduleCreateSchema, body);
    return this.mutate(actor, req, key, body, async (q) => {
      const bd = await this.businessDate(q, actor.user.propertyId);
      return this.maintenance.createSchedule(q, actor, input, bd);
    });
  }

  @Patch('maintenance/schedules/:id')
  @Roles('owner')
  patchSchedule(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const scheduleId = parse(zId, id);
    const input = parse(maintenanceSchedulePatchSchema, body);
    return this.mutate(actor, req, key, body, async (q) => {
      const bd = await this.businessDate(q, actor.user.propertyId);
      return this.maintenance.patchSchedule(q, actor, scheduleId, input, bd);
    });
  }

  private async businessDate(q: import('../db/db.service').Queryable, propertyId: string) {
    const { rows } = await q.query<{ current_business_date: string }>(`SELECT current_business_date FROM properties WHERE id = $1`, [propertyId]);
    return rows[0]!.current_business_date;
  }
}
