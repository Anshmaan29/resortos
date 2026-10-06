import type { ExportKind } from '../exports/exports.service';
import type { MirrorSheet } from './google-client';

// Fail closed: new fields in an owner download never become Google fields automatically.
const COLUMNS: Partial<Record<ExportKind, readonly string[]>> = {
  bookings: ['Booking', 'Guest', 'Mobile', 'Source', 'Arrival', 'Departure', 'Status', 'Guests', 'Rooms', 'Booked at'],
  guests: ['Guest', 'Mobile', 'Bookings', 'Last arrival', 'Added on'],
  payments: ['Date', 'Number', 'Guest', 'Booking', 'Entry', 'Method', 'Amount', 'Cash movement', 'Bill settlement'],
  invoices: ['Date', 'Number', 'Type', 'Taxable', 'CGST', 'SGST', 'IGST', 'Round off', 'Total'],
  expenses: ['Date', 'Number', 'Method', 'Amount'],
  'daily-summaries': ['Business date', 'Rooms active', 'Rooms occupied', 'Occupancy %', 'Arrivals checked in', 'Departures completed', 'No-shows'],
};
export function safeProjection(kind: ExportKind, data: { title: string; columns: string[]; rows: MirrorSheet['rows'] }): MirrorSheet {
  const columns = COLUMNS[kind];
  if (!columns) throw new Error('This report cannot be sent to Google Sheets.');
  const indices = columns.map((c) => {
    const index = data.columns.indexOf(c);
    if (index < 0) throw new Error('Sheets report format has changed; review the safe fields.');
    return index;
  });
  return { name: `ResortOS ${data.title}`, columns: [...columns], rows: data.rows.map((row) => indices.map((index, i) => {
    const cell = row[index];
    if (columns[i] !== 'Mobile') return cell ?? null;
    const digits = String(cell ?? '').replace(/\D/g, '');
    return digits.length >= 4 ? `••••${digits.slice(-4)}` : null;
  })) };
}
