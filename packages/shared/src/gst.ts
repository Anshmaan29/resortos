/**
 * GST tax engine (spec §30).
 *
 * - Rates are NEVER hard-coded here; they come from dated tax rules.
 * - The rule used is the one valid on each line's date of supply.
 * - Accommodation slabs are evaluated per room, per night, on the value
 *   actually charged after discount (`unitValue`).
 * - Tax is computed per tax-rate group and rounded to 2 decimals.
 * - Invoice total is rounded to the nearest rupee; round-off is its own line.
 */
import type Decimal from 'decimal.js';
import { money, round2, roundRupee, sum, toMoneyString, type MoneyString } from './money';
import type { IsoDate } from './dates';

export type TaxCategory = 'accommodation' | 'food' | 'activity' | 'laundry' | 'transport' | 'other';

export interface TaxRule {
  id: string;
  taxCategory: TaxCategory;
  /** Applies when unitValue > unitValueAbove (exclusive). null = no lower bound. */
  unitValueAbove: MoneyString | null;
  /** Applies when unitValue <= unitValueUpTo (inclusive). null = no upper bound. */
  unitValueUpTo: MoneyString | null;
  ratePercent: MoneyString;
  sac: string;
  effectiveFrom: IsoDate;
  /** Inclusive last day; null = open-ended. */
  effectiveTo: IsoDate | null;
}

export interface TaxableLine {
  key: string;
  taxCategory: TaxCategory;
  dateOfSupply: IsoDate;
  /** Taxable value of the whole line after discount. */
  taxableValue: MoneyString;
  /** Per-room-per-night value used for slab rules (accommodation). Defaults to taxableValue. */
  unitValue?: MoneyString;
}

export type SupplyType = 'intra_state' | 'inter_state';

export interface TaxedLine extends TaxableLine {
  ruleId: string;
  ratePercent: MoneyString;
  sac: string;
}

export interface TaxGroup {
  ratePercent: MoneyString;
  taxableValue: MoneyString;
  cgst: MoneyString;
  sgst: MoneyString;
  igst: MoneyString;
}

export interface TaxComputation {
  lines: TaxedLine[];
  groups: TaxGroup[];
  taxableTotal: MoneyString;
  taxTotal: MoneyString;
  grossTotal: MoneyString;
  roundOff: MoneyString;
  grandTotal: MoneyString;
}

export class TaxRuleError extends Error {
  constructor(message: string, readonly lineKey: string) {
    super(message);
    this.name = 'TaxRuleError';
  }
}

function ruleMatches(rule: TaxRule, line: TaxableLine, unit: Decimal): boolean {
  if (rule.taxCategory !== line.taxCategory) return false;
  if (line.dateOfSupply < rule.effectiveFrom) return false;
  if (rule.effectiveTo !== null && line.dateOfSupply > rule.effectiveTo) return false;
  if (rule.unitValueAbove !== null && !unit.gt(money(rule.unitValueAbove))) return false;
  if (rule.unitValueUpTo !== null && !unit.lte(money(rule.unitValueUpTo))) return false;
  return true;
}

/** Finds exactly one applicable rule. Zero or several matches is a configuration error. */
export function resolveTaxRule(rules: TaxRule[], line: TaxableLine): TaxRule {
  const unit = money(line.unitValue ?? line.taxableValue);
  const matches = rules.filter((r) => ruleMatches(r, line, unit));
  if (matches.length === 0) {
    throw new TaxRuleError(
      `No tax rule for ${line.taxCategory} on ${line.dateOfSupply} at unit value ${unit.toFixed(2)}`,
      line.key,
    );
  }
  if (matches.length > 1) {
    throw new TaxRuleError(
      `Overlapping tax rules (${matches.map((m) => m.id).join(', ')}) for ${line.taxCategory} on ${line.dateOfSupply}`,
      line.key,
    );
  }
  return matches[0]!;
}

export function computeTax(
  rules: TaxRule[],
  lines: TaxableLine[],
  supplyType: SupplyType = 'intra_state',
): TaxComputation {
  const taxed: TaxedLine[] = lines.map((line) => {
    const rule = resolveTaxRule(rules, line);
    return { ...line, ruleId: rule.id, ratePercent: toMoneyString(rule.ratePercent), sac: rule.sac };
  });

  const byRate = new Map<string, TaxedLine[]>();
  for (const l of taxed) {
    const list = byRate.get(l.ratePercent) ?? [];
    list.push(l);
    byRate.set(l.ratePercent, list);
  }

  const groups: TaxGroup[] = [...byRate.entries()]
    .sort(([a], [b]) => money(a).comparedTo(money(b)))
    .map(([rate, groupLines]) => {
      const taxable = round2(sum(groupLines.map((l) => l.taxableValue)));
      const r = money(rate);
      if (supplyType === 'intra_state') {
        const half = round2(taxable.times(r).dividedBy(200));
        return {
          ratePercent: rate,
          taxableValue: toMoneyString(taxable),
          cgst: toMoneyString(half),
          sgst: toMoneyString(half),
          igst: '0.00',
        };
      }
      return {
        ratePercent: rate,
        taxableValue: toMoneyString(taxable),
        cgst: '0.00',
        sgst: '0.00',
        igst: toMoneyString(round2(taxable.times(r).dividedBy(100))),
      };
    });

  const taxableTotal = sum(groups.map((g) => g.taxableValue));
  const taxTotal = sum(groups.flatMap((g) => [g.cgst, g.sgst, g.igst]));
  const gross = taxableTotal.plus(taxTotal);
  const grand = roundRupee(gross);

  return {
    lines: taxed,
    groups,
    taxableTotal: toMoneyString(taxableTotal),
    taxTotal: toMoneyString(taxTotal),
    grossTotal: toMoneyString(gross),
    roundOff: toMoneyString(grand.minus(gross)),
    grandTotal: toMoneyString(grand),
  };
}
