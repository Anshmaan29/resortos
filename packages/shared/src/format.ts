/** Indian display formatting (spec §68). Display only — never parse these back. */
import { money, type MoneyInput } from './money';

/** 112000 → "1,12,000" (Indian digit grouping) */
export function groupIndian(integerDigits: string): string {
  if (integerDigits.length <= 3) return integerDigits;
  const last3 = integerDigits.slice(-3);
  const rest = integerDigits.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

export interface InrOptions {
  /** show paise even when zero (invoices: true, dashboards: false) */
  paise?: boolean;
  symbol?: boolean;
}

/** "₹1,12,000" / "₹12,882.00" / "−₹5,000" */
export function formatINR(value: MoneyInput, opts: InrOptions = {}): string {
  const { paise = false, symbol = true } = opts;
  const d = money(value).toDecimalPlaces(2);
  const negative = d.isNegative() && !d.isZero();
  const abs = d.abs();
  const [intPart, fracPart = '00'] = abs.toFixed(2).split('.');
  const showPaise = paise || fracPart !== '00';
  const body = groupIndian(intPart!) + (showPaise ? '.' + fracPart : '');
  return (negative ? '−' : '') + (symbol ? '₹' : '') + body;
}

/** Compact: ₹14.6L, ₹2.3Cr (revenue KPIs) */
export function formatINRCompact(value: MoneyInput): string {
  const n = money(value);
  const abs = n.abs();
  const sign = n.isNegative() ? '−' : '';
  if (abs.gte(10_000_000)) return `${sign}₹${abs.dividedBy(10_000_000).toDecimalPlaces(1).toString()}Cr`;
  if (abs.gte(100_000)) return `${sign}₹${abs.dividedBy(100_000).toDecimalPlaces(1).toString()}L`;
  return formatINR(n);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-09-16" → "16 Sep 2026" */
export function formatDate(isoDate: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const { weekday = false, year = true } = opts;
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  const parts = [
    weekday ? DAYS[dt.getUTCDay()] : null,
    String(d),
    MONTHS[m - 1],
    year ? String(y) : null,
  ].filter(Boolean);
  return parts.join(' ');
}

/** Date → "2:14 PM" in Asia/Kolkata */
export function formatTime(value: Date | string, timeZone = 'Asia/Kolkata'): string {
  const dt = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone })
    .format(dt)
    .toUpperCase();
}

/** "+919876543210" → "+91 ••••• •3210" (printouts, sheets) */
export function maskMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return '••••••' + digits.slice(-4);
}

/** Common country calling codes, longest first, for display grouping. */
const CALLING_CODES = ['971', '977', '880', '91', '44', '61', '49', '33', '86', '65', '94', '60', '66', '81', '1', '7'];

/** "+919849012345" → "+91 98490 12345"; foreign numbers get a space after the country code. */
export function formatMobile(e164: string | null | undefined): string {
  if (!e164) return '';
  const digits = e164.replace(/\D/g, '');
  if (e164.startsWith('+91') && digits.length === 12) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  const cc = CALLING_CODES.find((c) => digits.startsWith(c));
  if (!cc) return e164;
  const rest = digits.slice(cc.length);
  const mid = Math.ceil(rest.length / 2);
  return `+${cc} ${rest.slice(0, mid)} ${rest.slice(mid)}`.trim();
}

/** "2026-09-16" → "16/09/2026" (Indian numeric date for inputs). */
export function formatDateInput(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** "16/09/2026", "16-9-2026", "16.09.26" → "2026-09-16"; null if not a real date. Day first, always. */
export function parseIndianDate(input: string): string | null {
  const m = /^\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\s*$/.exec(input);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt.toISOString().slice(0, 10);
}

/** Timestamp → "16 Sep, 5:42 PM" in IST. */
export function formatDateTime(value: Date | string, timeZone = 'Asia/Kolkata'): string {
  const dt = typeof value === 'string' ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).formatToParts(dt);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${MONTHS[Number(get('month')) - 1]}, ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}
