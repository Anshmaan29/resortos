import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { expenseCategorySchema, expenseCorrectionSchema, expenseSchema, zId, zIsoDate } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, IdempotencyKey, Roles } from '../common/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';
import { ExpensesService } from './expenses.service';

const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-09');

/** Expenses and their categories (spec §39). */
@Controller()
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly property: PropertyService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private mutate<T>(actor: Actor, req: AppRequest, key: string | undefined, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db
      .tx({ userId: actor.user.id }, (q) => this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => fn(q)))
      .then((r) => r.body);
  }

  @Get('expense-categories')
  categories(@CurrentActor() actor: Actor, @Query('includeInactive') includeInactive?: string) {
    return this.expenses.listCategories(actor.user.propertyId, includeInactive === 'true' && actor.user.role === 'owner');
  }

  @Post('expense-categories')
  @Roles('owner')
  createCategory(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(expenseCategorySchema, body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.expenses.createCategory(q, actor, input));
  }

  @Patch('expense-categories/:id')
  @Roles('owner')
  updateCategory(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const categoryId = parse(zId, id);
    const { version, ...input } = parse(expenseCategorySchema.extend({ version: z.coerce.number().int().min(1) }), body);
    return this.db.tx({ userId: actor.user.id }, (q) => this.expenses.updateCategory(q, actor, categoryId, input, version));
  }

  @Get('expenses')
  async list(@CurrentActor() actor: Actor, @Query('from') from?: string, @Query('to') to?: string, @Query('categoryId') categoryId?: string) {
    const businessDate = (await this.property.getProperty(actor.user.propertyId)).businessDate;
    return this.expenses.list(actor.user.propertyId, {
      from: from ? parse(zIsoDate, from) : businessDate,
      to: to ? parse(zIsoDate, to) : businessDate,
      categoryId: categoryId ? parse(zId, categoryId) : undefined,
    });
  }

  @Get('expenses/monthly')
  @Roles('owner')
  monthly(@CurrentActor() actor: Actor, @Query('month') month: string) {
    return this.expenses.monthly(actor.user.propertyId, parse(monthSchema, month));
  }

  @Post('expenses')
  record(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Body() body: unknown) {
    const input = parse(expenseSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.expenses.record(q, actor, input));
  }

  @Post('expenses/:id/correct')
  @HttpCode(200)
  correct(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const expenseId = parse(zId, id);
    const input = parse(expenseCorrectionSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.expenses.correct(q, actor, expenseId, input));
  }

  @Post('expenses/:id/reverse')
  @HttpCode(200)
  reverse(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const expenseId = parse(zId, id);
    const { reason } = parse(reasonSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.expenses.reverse(q, actor, expenseId, reason));
  }
}
