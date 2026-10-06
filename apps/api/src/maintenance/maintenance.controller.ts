import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { zId, zIsoDate, zNonNegativeMoney } from '@resortos/shared';
import { CurrentActor, IdempotencyKey, Roles } from '../common/decorators';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { MaintenanceService } from './maintenance.service';

const ticketStatus = z.enum(['open', 'in_progress', 'resolved', 'closed']);
const listQuery = z.object({ status: ticketStatus.optional() });

const createTicketSchema = z.object({
  roomId: zId.optional(),
  area: z.string().trim().min(2).max(120).optional(),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  assignedTo: zId.nullable().optional(),
}).refine((v) => (v.roomId != null) !== (v.area != null), { message: 'A ticket is about a room or an area, not both', path: ['area'] });

const patchTicketSchema = z.object({
  version: z.coerce.number().int().min(1),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  assignedTo: zId.nullable().optional(),
  cost: zNonNegativeMoney.nullable().optional(),
  resolutionNote: z.string().trim().min(3).max(1000).optional(),
  status: ticketStatus.optional(),
});

const createScheduleSchema = z.object({
  name: z.string().trim().min(2).max(120),
  area: z.string().trim().max(120).optional(),
  roomId: zId.optional(),
  everyDays: z.coerce.number().int().min(1).max(3650),
  nextDue: zIsoDate.optional(),
});

const patchScheduleSchema = createScheduleSchema.partial().extend({ isActive: z.boolean().optional(), version: z.coerce.number().int().min(1) });

/** Maintenance tickets and preventive schedules (spec §38). */
@Controller()
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly db: DbService,
  ) {}

  @Get('maintenance/tickets')
  tickets(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const { status } = parse(listQuery, query);
    return this.maintenance.listTickets(actor.user.propertyId, status);
  }

  @Post('maintenance/tickets')
  create(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const input = parse(createTicketSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.maintenance.createTicket(q, actor, input));
  }

  @Patch('maintenance/tickets/:id')
  patch(@CurrentActor() actor: Actor, @Req() req: AppRequest, @Param('id') id: string, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const ticketId = parse(zId, id);
    const input = parse(patchTicketSchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.maintenance.patchTicket(q, actor, ticketId, input));
  }

  @Get('maintenance/schedules')
  @Roles('owner')
  schedules(@CurrentActor() actor: Actor) {
    return this.maintenance.listSchedules(actor.user.propertyId);
  }

  @Post('maintenance/schedules')
  @Roles('owner')
  createSchedule(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(createScheduleSchema, body);
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const bd = await this.businessDate(q, actor.user.propertyId);
      return this.maintenance.createSchedule(q, actor, input, bd);
    });
  }

  @Patch('maintenance/schedules/:id')
  @Roles('owner')
  patchSchedule(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const scheduleId = parse(zId, id);
    const input = parse(patchScheduleSchema, body);
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const bd = await this.businessDate(q, actor.user.propertyId);
      return this.maintenance.patchSchedule(q, actor, scheduleId, input, bd);
    });
  }

  private async businessDate(q: import('../db/db.service').Queryable, propertyId: string) {
    const { rows } = await q.query<{ current_business_date: string }>(`SELECT current_business_date FROM properties WHERE id = $1`, [propertyId]);
    return rows[0]!.current_business_date;
  }
}
