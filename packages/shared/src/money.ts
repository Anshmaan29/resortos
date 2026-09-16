/**
 * Money rules (spec §49):
 * - NUMERIC(14,2) in PostgreSQL
 * - decimal arithmetic in code — never JavaScript floats
 * - amounts cross the API as strings, e.g. "4000.00"
 */
import DecimalJs from 'decimal.js';

const D = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP });

export type MoneyInput = string | number | DecimalJs;
export type MoneyString = string;

const MONEY_PATTERN = /^-?\d{1,12}(\.\d{1,2})?$/;
export const MAX_MONEY = new D('999999999999.99');

export function isMoneyString(value: unknown): value is MoneyString {
  return typeof value === 'string' && MONEY_PATTERN.test(value);
}

export function money(value: MoneyInput): DecimalJs {
  if (value instanceof DecimalJs) return new D(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid money value');
    // Only safe for literal integers/test constants; convert through string.
    return new D(value.toString());
  }
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid money value: "${value}"`);
  return new D(trimmed);
}

/** Round to 2 decimals, half-up (₹0.005 → ₹0.01). */
export function round2(value: MoneyInput): DecimalJs {
  return money(value).toDecimalPlaces(2, DecimalJs.ROUND_HALF_UP);
}

/** Round to whole rupees, half-up (₹12,882.50 → ₹12,883). */
export function roundRupee(value: MoneyInput): DecimalJs {
  return money(value).toDecimalPlaces(0, DecimalJs.ROUND_HALF_UP);
}

/** Canonical API/DB string with exactly two decimals. */
export function toMoneyString(value: MoneyInput): MoneyString {
  return round2(value).toFixed(2);
}

export function sum(values: MoneyInput[]): DecimalJs {
  return values.reduce<DecimalJs>((acc, v) => acc.plus(money(v)), new D(0));
}

export function percentOf(amount: MoneyInput, percent: MoneyInput): DecimalJs {
  return money(amount).times(money(percent)).dividedBy(100);
}

/** Decimal constructor (half-up rounding) and instance type. */
const Decimal = D;
type Decimal = DecimalJs;
export { Decimal };
