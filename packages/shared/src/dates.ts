/**
 * Business dates are plain calendar dates ("YYYY-MM-DD"), never timestamps.
 * All arithmetic is done in UTC to avoid DST/timezone drift.
 */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toUtc(date: IsoDate): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(dt: Date): IsoDate {
  return dt.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const dt = toUtc(date);
  dt.setUTCDate(dt.getUTCDate() + days);
  return fromUtc(dt);
}

/** Nights between arrival and departure (departure exclusive). */
export function nightsBetween(arrival: IsoDate, departure: IsoDate): number {
  return Math.round((toUtc(departure).getTime() - toUtc(arrival).getTime()) / 86_400_000);
}

/** Every night of a stay: [arrival, departure) */
export function eachNight(arrival: IsoDate, departure: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = arrival; d < departure; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dayOfWeek(date: IsoDate): number {
  return toUtc(date).getUTCDay();
}

/** Today's calendar date in a timezone (default IST). */
export function todayIn(timeZone = 'Asia/Kolkata', now = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Indian financial year (April–March) label used in document numbers: "26-27". */
export function financialYearLabel(date: IsoDate): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  const two = (n: number) => String(n % 100).padStart(2, '0');
  return `${two(start)}-${two(start + 1)}`;
}
