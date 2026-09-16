import { Injectable } from '@nestjs/common';
import {
  computeTax, Decimal, eachNight, ERROR_CODES, money, nightsBetween, TaxRuleError, toMoneyString,
  type IsoDate, type MealPlanCode, type MoneyString, type TaxableLine, type TaxGroup, type TaxRule,
} from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, notFound } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { IdRow, MealPlanRow, NightRow, RateCalendarRow, RatePlanRow, RoomTypeRow, TaxRuleRow } from '../db/rows';

export interface ChildPolicy {
  /** Children younger than this stay free (e.g. 6 → ages 0–5 free). */
  freeBelowAge: number;
  /** Children older than this are charged as adults (e.g. 12 → 13+ are adults). */
  childMaxAge: number;
}
export const DEFAULT_CHILD_POLICY: ChildPolicy = { freeBelowAge: 6, childMaxAge: 12 };

export interface QuoteInput {
  roomTypeId: string;
  arrival: IsoDate;
  departure: IsoDate;
  adults: number;
  childAges: number[];
  ratePlanId?: string;
  mealPlan: MealPlanCode;
  manualRate?: MoneyString;
}

export interface NightQuote {
  date: IsoDate;
  roomRate: MoneyString;
  extraPersonAmount: MoneyString;
  mealAmount: MoneyString;
  total: MoneyString;
  rateSource: 'base' | 'calendar' | 'manual';
  label: string | null;
  belowFloor: boolean;
}

export interface TaxEstimate {
  roomTotal: MoneyString;
  extrasTotal: MoneyString;
  mealTotal: MoneyString;
  taxableTotal: MoneyString;
  available: boolean;
  message: string | null;
  taxTotal: MoneyString | null;
  roundOff: MoneyString | null;
  grandTotal: MoneyString | null;
  groups: TaxGroup[];
  /** True while the property still uses demo tax rules that a CA has not confirmed. */
  usesPlaceholderRates: boolean;
}

export interface Quote {
  roomTypeId: string;
  ratePlanId: string | null;
  nights: NightQuote[];
  nightCount: number;
  roomTotal: MoneyString;
  extrasTotal: MoneyString;
  mealTotal: MoneyString;
  total: MoneyString;
  averageRoomRate: MoneyString;
  minRate: MoneyString;
  belowFloor: boolean;
  minStay: number;
  minStayViolated: boolean;
  occupancy: { chargeableAdults: number; freeChildren: number; payingChildren: number; extraAdults: number; extraChildren: number };
}

/**
 * Pricing (spec §11). Deterministic and pure given the database state, so the same quote
 * is used for the booking screen and inside the booking transaction.
 */
@Injectable()
export class RatesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async childPolicy(q: Queryable, propertyId: string): Promise<ChildPolicy> {
    const { rows } = await q.query<{ value: ChildPolicy }>(`SELECT value FROM settings WHERE property_id = $1 AND key = 'child_policy'`, [propertyId]);
    return rows[0]?.value ?? DEFAULT_CHILD_POLICY;
  }

  async roomType(q: Queryable, propertyId: string, roomTypeId: string): Promise<RoomTypeRow> {
    const { rows } = await q.query<RoomTypeRow>(`SELECT * FROM room_types WHERE id = $1 AND property_id = $2 AND is_active`, [roomTypeId, propertyId]);
    if (!rows[0]) throw notFound('Room type');
    return rows[0];
  }

  /** Quote rebuilt from nightly rates already agreed on a booking (used when an edit leaves a room unchanged). */
  async quoteFromStoredNights(q: Queryable, propertyId: string, roomTypeId: string, ratePlanId: string | null, nights: NightRow[]): Promise<Quote> {
    const rt = await this.roomType(q, propertyId, roomTypeId);
    const minRate = money(rt.min_rate);
    const nightQuotes: NightQuote[] = [...nights].sort((a, b) => a.night_date.localeCompare(b.night_date)).map((n) => ({
      date: n.night_date,
      roomRate: toMoneyString(n.room_rate),
      extraPersonAmount: toMoneyString(n.extra_person_amount),
      mealAmount: toMoneyString(n.meal_amount),
      total: toMoneyString(money(n.room_rate).plus(n.extra_person_amount).plus(n.meal_amount)),
      rateSource: n.rate_source,
      label: null,
      belowFloor: money(n.room_rate).lt(minRate),
    }));
    return this.summarise(roomTypeId, ratePlanId, nightQuotes, minRate, 1, { chargeableAdults: 0, freeChildren: 0, payingChildren: 0, extraAdults: 0, extraChildren: 0 });
  }

  private summarise(roomTypeId: string, ratePlanId: string | null, nights: NightQuote[], minRate: Decimal, minStay: number, occupancy: Quote['occupancy']): Quote {
    const count = nights.length;
    const roomTotal = nights.reduce((acc, n) => acc.plus(n.roomRate), new Decimal(0));
    return {
      roomTypeId, ratePlanId, nights, nightCount: count,
      roomTotal: toMoneyString(roomTotal),
      extrasTotal: toMoneyString(nights.reduce((acc, n) => acc.plus(n.extraPersonAmount), new Decimal(0))),
      mealTotal: toMoneyString(nights.reduce((acc, n) => acc.plus(n.mealAmount), new Decimal(0))),
      total: toMoneyString(nights.reduce((acc, n) => acc.plus(n.total), new Decimal(0))),
      averageRoomRate: toMoneyString(count ? roomTotal.dividedBy(count) : 0),
      minRate: toMoneyString(minRate),
      belowFloor: nights.some((n) => n.belowFloor),
      minStay,
      minStayViolated: count < minStay,
      occupancy,
    };
  }

  async taxRules(q: Queryable, propertyId: string): Promise<{ rules: TaxRule[]; placeholderIds: Set<string> }> {
    const { rows } = await q.query<TaxRuleRow>(`SELECT * FROM tax_rules WHERE property_id = $1`, [propertyId]);
    return {
      rules: rows.map((r) => ({
        id: r.id, taxCategory: r.tax_category, unitValueAbove: r.unit_value_above, unitValueUpTo: r.unit_value_up_to,
        ratePercent: r.rate_percent, sac: r.sac, effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
      })),
      placeholderIds: new Set(rows.filter((r) => r.origin === 'demo_placeholder').map((r) => r.id)),
    };
  }

  /**
   * GST estimate for a booking (spec §30). Accommodation is taxed per room per night on room + extra-person
   * value; meal plan components are treated as food. Final tax is decided on the invoice (Phase 2).
   */
  async estimateTax(q: Queryable, propertyId: string, rooms: Quote[]): Promise<TaxEstimate> {
    const lines: TaxableLine[] = [];
    rooms.forEach((room, i) => room.nights.forEach((n) => {
      const accommodation = money(n.roomRate).plus(n.extraPersonAmount);
      lines.push({ key: `${i}:${n.date}:room`, taxCategory: 'accommodation', dateOfSupply: n.date, taxableValue: toMoneyString(accommodation), unitValue: toMoneyString(accommodation) });
      if (money(n.mealAmount).gt(0)) lines.push({ key: `${i}:${n.date}:meal`, taxCategory: 'food', dateOfSupply: n.date, taxableValue: n.mealAmount });
    }));
    const sum = (pick: (quote: Quote) => string) => toMoneyString(rooms.reduce((acc, r) => acc.plus(pick(r)), new Decimal(0)));
    const base = { roomTotal: sum((r) => r.roomTotal), extrasTotal: sum((r) => r.extrasTotal), mealTotal: sum((r) => r.mealTotal), taxableTotal: sum((r) => r.total) };
    const { rules, placeholderIds } = await this.taxRules(q, propertyId);
    try {
      const tax = computeTax(rules, lines);
      return {
        ...base, available: true, message: null, taxTotal: tax.taxTotal, roundOff: tax.roundOff, grandTotal: tax.grandTotal, groups: tax.groups,
        usesPlaceholderRates: tax.lines.some((l) => placeholderIds.has(l.ruleId)),
      };
    } catch (err) {
      if (!(err instanceof TaxRuleError)) throw err;
      return { ...base, available: false, message: 'GST cannot be estimated: tax rates are not set up for these dates.', taxTotal: null, roundOff: null, grandTotal: null, groups: [], usesPlaceholderRates: false };
    }
  }

  async quote(q: Queryable, propertyId: string, input: QuoteInput): Promise<Quote> {
    const rt = await this.roomType(q, propertyId, input.roomTypeId);

    const totalGuests = input.adults + input.childAges.length;
    if (totalGuests > rt.max_occupancy) {
      throw new AppError(ERROR_CODES.VALIDATION, `${rt.name} allows at most ${rt.max_occupancy} guests.`, {
        fields: [{ path: 'adults', message: `Maximum ${rt.max_occupancy} guests` }],
      });
    }

    let ratePlanId = input.ratePlanId ?? null;
    if (!ratePlanId) {
      const { rows } = await q.query<{ id: string }>(`SELECT id FROM rate_plans WHERE property_id = $1 AND is_default AND is_active`, [propertyId]);
      ratePlanId = rows[0]?.id ?? null;
    }

    const policy = await this.childPolicy(q, propertyId);
    const teens = input.childAges.filter((a) => a > policy.childMaxAge).length;
    const freeChildren = input.childAges.filter((a) => a < policy.freeBelowAge).length;
    const payingChildren = input.childAges.length - teens - freeChildren;
    const chargeableAdults = input.adults + teens;
    const extraAdults = Math.max(0, chargeableAdults - rt.base_occupancy);
    const slotsLeft = Math.max(0, rt.base_occupancy - chargeableAdults);
    const extraChildren = Math.max(0, payingChildren - slotsLeft);

    const { rows: mealRows } = await q.query<Pick<MealPlanRow, 'adult_rate' | 'child_rate'>>(
      `SELECT adult_rate, child_rate FROM meal_plans WHERE property_id = $1 AND code = $2 AND is_active`, [propertyId, input.mealPlan],
    );
    if (input.mealPlan !== 'EP' && !mealRows[0]) {
      throw new AppError(ERROR_CODES.VALIDATION, `Meal plan ${input.mealPlan} is not set up for this property.`);
    }
    const meal = mealRows[0];
    const mealPerNight = meal
      ? money(meal.adult_rate).times(chargeableAdults).plus(money(meal.child_rate).times(payingChildren))
      : new Decimal(0);
    const extraPerNight = money(rt.extra_adult_rate).times(extraAdults).plus(money(rt.extra_child_rate).times(extraChildren));

    const nights = eachNight(input.arrival, input.departure);
    const calendar = ratePlanId
      ? (await q.query<RateCalendarRow>(
          `SELECT id, rate_plan_id, room_type_id, start_date, end_date, days_of_week, rate, min_stay, priority, label, created_at FROM rate_calendar
            WHERE rate_plan_id = $1 AND room_type_id = $2 AND is_active AND start_date < $4::date AND end_date > $3::date
            ORDER BY priority DESC, created_at DESC`,
          [ratePlanId, input.roomTypeId, input.arrival, input.departure],
        )).rows
      : [];

    let minStay = 1;
    const minRate = money(rt.min_rate);
    const nightQuotes: NightQuote[] = nights.map((date) => {
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      const entry = calendar.find(
        (c) => c.start_date <= date && c.end_date > date && (c.days_of_week.length === 0 || c.days_of_week.map(Number).includes(dow)),
      );
      if (entry?.min_stay) minStay = Math.max(minStay, entry.min_stay);
      const source: NightQuote['rateSource'] = input.manualRate !== undefined ? 'manual' : entry ? 'calendar' : 'base';
      const roomRate = money(input.manualRate ?? entry?.rate ?? rt.base_rate);
      return {
        date,
        roomRate: toMoneyString(roomRate),
        extraPersonAmount: toMoneyString(extraPerNight),
        mealAmount: toMoneyString(mealPerNight),
        total: toMoneyString(roomRate.plus(extraPerNight).plus(mealPerNight)),
        rateSource: source,
        label: entry?.label ?? null,
        belowFloor: roomRate.lt(minRate),
      };
    });

    return this.summarise(input.roomTypeId, ratePlanId, nightQuotes, minRate, minStay,
      { chargeableAdults, freeChildren, payingChildren, extraAdults, extraChildren });
  }

  // ---------------- configuration (owner) ----------------

  async listMealPlans(propertyId: string) {
    const { rows } = await this.db.query<MealPlanRow>(`SELECT * FROM meal_plans WHERE property_id = $1 ORDER BY array_position(ARRAY['EP','CP','MAP','AP'], code)`, [propertyId]);
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, adultRate: r.adult_rate, childRate: r.child_rate, postSeparately: r.post_separately, isActive: r.is_active }));
  }

  async upsertMealPlan(actor: Actor, input: { code: MealPlanCode; name: string; adultRate: string; childRate: string; postSeparately: boolean; isActive: boolean }) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<IdRow>(
        `INSERT INTO meal_plans (property_id, code, name, adult_rate, child_rate, post_separately, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (property_id, code) DO UPDATE SET name = EXCLUDED.name, adult_rate = EXCLUDED.adult_rate,
           child_rate = EXCLUDED.child_rate, post_separately = EXCLUDED.post_separately, is_active = EXCLUDED.is_active
         RETURNING id`,
        [actor.user.propertyId, input.code, input.name, input.adultRate, input.childRate, input.postSeparately, input.isActive],
      );
      await this.audit.record(q, actor, { action: 'meal_plan.saved', entityType: 'meal_plan', entityId: rows[0]!.id, after: input });
      return { id: rows[0]!.id };
    });
  }

  async listRatePlans(propertyId: string) {
    const { rows } = await this.db.query<RatePlanRow>(`SELECT * FROM rate_plans WHERE property_id = $1 ORDER BY is_default DESC, name`, [propertyId]);
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind, isDefault: r.is_default, isActive: r.is_active }));
  }

  async createRatePlan(actor: Actor, input: { code: string; name: string; kind: string }) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<IdRow>(
        `INSERT INTO rate_plans (property_id, code, name, kind) VALUES ($1,$2,$3,$4) RETURNING id`,
        [actor.user.propertyId, input.code, input.name, input.kind],
      );
      await this.audit.record(q, actor, { action: 'rate_plan.created', entityType: 'rate_plan', entityId: rows[0]!.id, after: input });
      return { id: rows[0]!.id };
    });
  }

  async listCalendar(propertyId: string, from: IsoDate, to: IsoDate) {
    const { rows } = await this.db.query<RateCalendarRow & { room_type_name: string; rate_plan_name: string }>(
      `SELECT c.*, rt.name AS room_type_name, rp.name AS rate_plan_name FROM rate_calendar c
         JOIN room_types rt ON rt.id = c.room_type_id JOIN rate_plans rp ON rp.id = c.rate_plan_id
        WHERE c.property_id = $1 AND c.is_active AND c.start_date < $3::date AND c.end_date > $2::date
        ORDER BY c.start_date, c.priority DESC`,
      [propertyId, from, to],
    );
    return rows.map((r) => ({
      id: r.id, ratePlanId: r.rate_plan_id, ratePlanName: r.rate_plan_name, roomTypeId: r.room_type_id, roomTypeName: r.room_type_name,
      label: r.label, startDate: r.start_date, endDate: r.end_date, daysOfWeek: r.days_of_week.map(Number), rate: r.rate,
      minStay: r.min_stay, priority: r.priority,
    }));
  }

  async addCalendarEntry(actor: Actor, input: {
    ratePlanId: string; roomTypeIds: string[]; label: string; startDate: IsoDate; endDate: IsoDate;
    daysOfWeek: number[]; rate: MoneyString; minStay?: number; priority: number;
  }) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const ids: string[] = [];
      for (const roomTypeId of input.roomTypeIds) {
        const { rows } = await q.query<IdRow>(
          `INSERT INTO rate_calendar (property_id, rate_plan_id, room_type_id, label, start_date, end_date, days_of_week, rate, min_stay, priority, created_by)
           SELECT $1, rp.id, rt.id, $4, $5, $6, $7, $8, $9, $10, $11
             FROM rate_plans rp, room_types rt
            WHERE rp.id = $2 AND rp.property_id = $1 AND rt.id = $3 AND rt.property_id = $1
           RETURNING id`,
          [actor.user.propertyId, input.ratePlanId, roomTypeId, input.label, input.startDate, input.endDate, input.daysOfWeek,
            input.rate, input.minStay ?? null, input.priority, actor.user.id],
        );
        if (!rows[0]) throw notFound('Rate plan or room type');
        ids.push(rows[0].id);
      }
      await this.audit.record(q, actor, { action: 'rate_calendar.added', entityType: 'rate_plan', entityId: input.ratePlanId, after: input });
      return { ids };
    });
  }

  async listTaxRules(propertyId: string) {
    const { rows } = await this.db.query<TaxRuleRow>(
      `SELECT * FROM tax_rules WHERE property_id = $1 ORDER BY tax_category, effective_from DESC, unit_value_above NULLS FIRST`, [propertyId],
    );
    return rows.map((r) => ({
      id: r.id, taxCategory: r.tax_category, unitValueAbove: r.unit_value_above, unitValueUpTo: r.unit_value_up_to,
      ratePercent: r.rate_percent, sac: r.sac, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, note: r.note,
      isDemoPlaceholder: r.origin === 'demo_placeholder',
    }));
  }
}
