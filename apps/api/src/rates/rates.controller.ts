import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { MEAL_PLAN_CODES, ratePlanUpdateSchema, rateQuoteQuerySchema, taxRuleSchema, zId, zIsoDate, zNonNegativeMoney } from '@resortos/shared';
import { CurrentActor, Roles } from '../common/decorators';
import type { Actor } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { RatesService } from './rates.service';

@Controller()
export class RatesController {
  constructor(private readonly rates: RatesService, private readonly db: DbService) {}

  @Get('rates/quote')
  quote(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const input = parse(rateQuoteQuerySchema, query);
    return this.rates.quote(this.db, actor.user.propertyId, input);
  }

  @Get('meal-plans')
  mealPlans(@CurrentActor() actor: Actor) {
    return this.rates.listMealPlans(actor.user.propertyId);
  }

  @Post('meal-plans')
  @Roles('owner')
  saveMealPlan(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.rates.upsertMealPlan(actor, parse(z.object({
      code: z.enum(MEAL_PLAN_CODES), name: z.string().trim().min(2).max(60), adultRate: zNonNegativeMoney,
      childRate: zNonNegativeMoney, postSeparately: z.boolean().default(false), isActive: z.boolean().default(true),
    }), body));
  }

  @Get('rate-plans')
  ratePlans(@CurrentActor() actor: Actor) {
    return this.rates.listRatePlans(actor.user.propertyId);
  }

  @Post('rate-plans')
  @Roles('owner')
  createRatePlan(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.rates.createRatePlan(actor, parse(z.object({
      code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,16}$/), name: z.string().trim().min(2).max(60),
      kind: z.enum(['standard', 'corporate', 'travel_agent', 'package']).default('standard'),
    }), body));
  }

  @Get('rate-calendar')
  @Roles('owner')
  calendar(@CurrentActor() actor: Actor, @Query() query: unknown) {
    const { from, to } = parse(z.object({ from: zIsoDate, to: zIsoDate }), query);
    return this.rates.listCalendar(actor.user.propertyId, from, to);
  }

  @Post('rate-calendar')
  @Roles('owner')
  addCalendar(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.rates.addCalendarEntry(actor, parse(z.object({
      ratePlanId: zId, roomTypeIds: z.array(zId).min(1), label: z.string().trim().min(2).max(60),
      startDate: zIsoDate, endDate: zIsoDate, daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
      rate: zNonNegativeMoney, minStay: z.number().int().min(1).max(30).optional(), priority: z.number().int().min(0).max(100).default(10),
    }).refine((v) => v.endDate > v.startDate, { message: 'End date must be after start date', path: ['endDate'] }), body));
  }

  @Get('tax-rules')
  @Roles('owner')
  taxRules(@CurrentActor() actor: Actor) {
    return this.rates.listTaxRules(actor.user.propertyId);
  }

  @Patch('rate-plans/:id')
  @Roles('owner')
  updateRatePlan(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.rates.updateRatePlan(actor, parse(zId, id), parse(ratePlanUpdateSchema, body));
  }

  @Post('rate-calendar/:id/deactivate')
  @Roles('owner')
  @HttpCode(200)
  deactivateCalendar(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.rates.deactivateCalendarEntry(actor, parse(zId, id));
  }

  @Post('tax-rules')
  @Roles('owner')
  createTaxRule(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.rates.createTaxRule(actor, parse(taxRuleSchema, body));
  }

  @Post('tax-rules/:id/close')
  @Roles('owner')
  @HttpCode(200)
  closeTaxRule(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const { effectiveTo } = parse(z.object({ effectiveTo: zIsoDate }), body);
    return this.rates.closeTaxRule(actor, parse(zId, id), effectiveTo);
  }
}
