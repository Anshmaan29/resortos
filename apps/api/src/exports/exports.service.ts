import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { formatDate, money, toMoneyString } from '@resortos/shared';
import { ERROR_CODES } from '@resortos/shared';
import { AppError } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import { GRC_FONT_PATH } from '../stays/grc-pdf';
import { PoliceRegisterService } from '../compliance/police-register.service';
import { csv, workbook, type Sheet } from './xlsx';

/**
 * The owner's exports (spec §43 records area, §46): every table as Excel and CSV, the police
 * register also as PDF, a GSTR-1-ready summary and Tally vouchers. Owner-only; every download is
 * audit-logged with the report, the filters and the row count (§46).
 *
 * Nothing here writes business rows: each export reads the records live, so a file can never
 * disagree with the ledger it came from.
 */

export const EXPORT_KINDS = [
  'bookings', 'guests', 'in-house', 'payments', 'invoices', 'expenses', 'daily-summaries', 'form-c', 'police-register',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : { number: v });

@Injectable()
export class ExportsService {
  constructor(
    private readonly db: DbService,
    private readonly police: PoliceRegisterService,
  ) {}

  private sheetRows(kind: ExportKind, propertyId: string, from: string, to: string): Promise<{ title: string; columns: string[]; rows: (string | number | null | undefined | { number: string | number })[][] }> {
    return this.db.tx({}, async (q) => {
      switch (kind) {
        case 'bookings': return this.bookings(q, propertyId, from, to);
        case 'guests': return this.guests(q, propertyId);
        case 'in-house': return this.inHouse(q, propertyId, from, to);
        case 'payments': return this.payments(q, propertyId, from, to);
        case 'invoices': return this.invoices(q, propertyId, from, to);
        case 'expenses': return this.expenses(q, propertyId, from, to);
        case 'daily-summaries': return this.dailySummaries(q, propertyId, from, to);
        case 'form-c': return this.formC(q, propertyId);
        case 'police-register': return this.policeRegister(propertyId, from, to);
      }
    });
  }

  /** The one entry point every file format goes through, so the audit row is written exactly once. */
  async download(actor: Actor, kind: ExportKind, format: 'xlsx' | 'csv' | 'pdf', from: string, to: string): Promise<{ body: Buffer; filename: string; contentType: string; rows: number }> {
    const raw = await this.sheetRows(kind, actor.user.propertyId, from, to);
    const sheet = { name: raw.title, title: raw.title, columns: raw.columns, rows: raw.rows.map((r) => r.map((c) => c ?? null)) };
    const rows = sheet.rows.length;
    let body: Buffer;
    let contentType: string;
    if (format === 'xlsx') {
      body = workbook([{ name: sheet.title, columns: sheet.columns, rows: sheet.rows }]);
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else if (format === 'csv') {
      body = Buffer.from(csv(sheet), 'utf8');
      contentType = 'text/csv; charset=utf-8';
    } else {
      if (kind !== 'police-register') throw new AppError(ERROR_CODES.VALIDATION, 'A PDF is available for the police register; the other records download as Excel or CSV.');
      body = await this.registerPdf({ title: sheet.title, columns: sheet.columns, rows: sheet.rows as string[][] }, from, to);
      contentType = 'application/pdf';
    }
    const stamp = format === 'pdf' && from === to ? `-${from}` : `-${from}-to-${to}`;
    return {
      body, contentType, rows,
      filename: `${kind}${kind === 'bookings' || kind === 'guests' || kind === 'form-c' ? '' : stamp}.${format}`,
    };
  }

  // ---------------- datasets ----------------

  private async bookings(q: Queryable, propertyId: string, from: string, to: string) {
    const { rows } = await q.query<Record<string, string | null>>(
      `SELECT r.number, g.first_name || ' ' || g.last_name AS guest, g.mobile, r.source, r.ota_reference,
              to_char(r.arrival, 'YYYY-MM-DD') AS arrival, to_char(r.departure, 'YYYY-MM-DD') AS departure,
              r.status, r.group_name, r.purpose,
              (SELECT sum(rr.adults) FROM reservation_rooms rr WHERE rr.reservation_id = r.id)::text AS guests_count,
              (SELECT count(*) FROM reservation_rooms rr WHERE rr.reservation_id = r.id)::text AS rooms_count,
              u.full_name AS created_by_name, to_char(r.created_at AT TIME ZONE prop.timezone, 'YYYY-MM-DD HH24:MI') AS created_at
         FROM reservations r
         JOIN properties prop ON prop.id=r.property_id
         JOIN guests g ON g.id = r.primary_guest_id
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.property_id = $1 AND r.arrival BETWEEN $2::date AND $3::date
        ORDER BY r.arrival, r.number`,
      [propertyId, from, to],
    );
    return {
      title: 'Bookings',
      columns: ['Booking', 'Guest', 'Mobile', 'Source', 'OTA reference', 'Arrival', 'Departure', 'Status', 'Group', 'Purpose', 'Guests', 'Rooms', 'Booked by', 'Booked at'],
      rows: rows.map((r) => [r.number, r.guest, r.mobile, r.source, r.ota_reference, r.arrival, r.departure, r.status, r.group_name, r.purpose, num(r.guests_count), num(r.rooms_count), r.created_by_name, r.created_at]),
    };
  }

  private async guests(q: Queryable, propertyId: string) {
    const { rows } = await q.query<Record<'guest' | 'mobile' | 'email' | 'city' | 'state' | 'address_line' | 'nationality' | 'company_name' | 'company_gstin' | 'special_note' | 'bookings_count' | 'last_arrival' | 'created_at', string | null> & { is_vip: boolean }>(
      `SELECT g.first_name || ' ' || g.last_name AS guest, g.mobile, g.email, g.city, g.state,
              g.address_line, g.nationality, g.company_name, g.company_gstin, g.is_vip, g.special_note,
              (SELECT count(*) FROM reservations r WHERE r.primary_guest_id = g.id)::text AS bookings_count,
              (SELECT max(r.arrival)::text FROM reservations r WHERE r.primary_guest_id = g.id) AS last_arrival,
              to_char(g.created_at, 'YYYY-MM-DD') AS created_at
         FROM guests g
        WHERE g.property_id = $1
        ORDER BY g.created_at, g.id`,
      [propertyId],
    );
    return {
      title: 'Guests',
      columns: ['Guest', 'Mobile', 'Email', 'City', 'State', 'Address', 'Nationality', 'Company', 'Company GSTIN', 'VIP', 'Note', 'Bookings', 'Last arrival', 'Added on'],
      rows: rows.map((r) => [r.guest, r.mobile, r.email, r.city, r.state, r.address_line, r.nationality, r.company_name, r.company_gstin, r.is_vip ? 'Yes' : '', r.special_note, num(r.bookings_count), r.last_arrival, r.created_at]),
    };
  }

  private async inHouse(q: Queryable, propertyId: string, from: string, to: string) {
    const { rows } = await q.query<Record<string, string | null>>(
      `SELECT rm.number AS room, s.status, to_char(s.business_date_in, 'YYYY-MM-DD') AS checked_in,
              to_char(s.expected_departure, 'YYYY-MM-DD') AS expected_out, to_char(s.business_date_out, 'YYYY-MM-DD') AS checked_out,
              (SELECT string_agg(o.full_name, ', ' ORDER BY o.is_primary DESC, o.created_at) FROM stay_occupants o WHERE o.stay_id = s.id) AS occupants,
              g.first_name || ' ' || g.last_name AS guest, g.mobile,
              rt.name AS room_type, res.source,
              (SELECT count(*) FROM stay_occupants o WHERE o.stay_id = s.id)::text AS persons
         FROM stays s
         JOIN rooms rm ON rm.id = s.room_id
         JOIN room_types rt ON rt.id = rm.room_type_id
         JOIN reservations res ON res.id = s.reservation_id
         JOIN guests g ON g.id = res.primary_guest_id
        WHERE s.property_id = $1 AND s.business_date_in BETWEEN $2::date AND $3::date
        ORDER BY s.business_date_in, rm.number`,
      [propertyId, from, to],
    );
    return {
      title: 'Stays',
      columns: ['Room', 'Room type', 'Status', 'Checked in', 'Expected out', 'Checked out', 'Occupants', 'Persons', 'Booking guest', 'Mobile', 'Source'],
      rows: rows.map((r) => [r.room, r.room_type, r.status, r.checked_in, r.expected_out, r.checked_out, r.occupants, num(r.persons), r.guest, r.mobile, r.source]),
    };
  }

  private async payments(q: Queryable, propertyId: string, from: string, to: string) {
    const { rows } = await q.query<Record<'business_date' | 'number' | 'guest' | 'booking' | 'entry_type' | 'method' | 'account' | 'amount' | 'cash_effect' | 'bill_effect' | 'reference' | 'received_by_name' | 'received_at', string | null> & { is_reversal: boolean }>(
      `SELECT p.business_date, p.number, g.first_name || ' ' || g.last_name AS guest, r.number AS booking,
              p.entry_type, p.method, a.name AS account, p.amount, p.cash_effect, p.bill_effect, p.reverses_payment_id IS NOT NULL AS is_reversal,
              p.reference, u.full_name AS received_by_name, to_char(p.received_at AT TIME ZONE prop.timezone,'YYYY-MM-DD HH24:MI') AS received_at
         FROM payments p
         JOIN properties prop ON prop.id=p.property_id
         JOIN guests g ON g.id = p.guest_id
         JOIN reservations r ON r.id = p.reservation_id
         LEFT JOIN payment_accounts a ON a.id = p.payment_account_id
         LEFT JOIN users u ON u.id = p.received_by
        WHERE p.property_id = $1 AND p.business_date BETWEEN $2::date AND $3::date
        ORDER BY p.business_date, p.received_at`,
      [propertyId, from, to],
    );
    return {
      title: 'Payments',
      columns: ['Date', 'Number', 'Guest', 'Booking', 'Entry', 'Method', 'Account', 'Amount', 'Reference', 'Received by', 'Cash movement', 'Bill settlement'],
      rows: rows.map((r) => [r.business_date, r.number, r.guest, r.booking, r.entry_type + (r.is_reversal ? ' (reversed)' : ''), r.method, r.account, num(r.amount), r.reference, r.received_by_name, num(r.cash_effect), num(r.bill_effect)]),
    };
  }

  private async invoices(q: Queryable, propertyId: string, from: string, to: string) {
    const { rows } = await q.query<Record<string, string | null>>(
      `SELECT i.invoice_date, i.number, i.document_type, i.buyer_name, i.buyer_gstin, i.place_of_supply,
              i.taxable_total, i.cgst_total, i.sgst_total, i.igst_total, i.round_off, i.grand_total, i.reason
         FROM invoices i
        WHERE i.property_id = $1 AND i.invoice_date BETWEEN $2::date AND $3::date
        ORDER BY i.invoice_date, i.seq`,
      [propertyId, from, to],
    );
    return {
      title: 'Invoices',
      columns: ['Date', 'Number', 'Type', 'Party', 'GSTIN', 'Place of supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Round off', 'Total', 'Reason'],
      rows: rows.map((r) => [r.invoice_date, r.number, r.document_type, r.buyer_name, r.buyer_gstin, r.place_of_supply,
        num(r.taxable_total), num(r.cgst_total), num(r.sgst_total), num(r.igst_total), num(r.round_off), num(r.grand_total), r.reason]),
    };
  }

  private async expenses(q: Queryable, propertyId: string, from: string, to: string) {
    const { rows } = await q.query<Record<string, string | null>>(
      `SELECT e.expense_date, e.number, c.name AS category, e.paid_to, e.method, a.name AS account,
              CASE WHEN e.reverses_expense_id IS NULL THEN e.amount ELSE -e.amount END AS amount,
              e.note, u.full_name AS paid_by_name
         FROM expenses e
         JOIN expense_categories c ON c.id = e.category_id
         JOIN payment_accounts a ON a.id = e.payment_account_id
         JOIN users u ON u.id = e.paid_by
        WHERE e.property_id = $1 AND e.expense_date BETWEEN $2::date AND $3::date
        ORDER BY e.expense_date, e.number`,
      [propertyId, from, to],
    );
    return {
      title: 'Expenses',
      columns: ['Date', 'Number', 'Category', 'Paid to', 'Method', 'Account', 'Amount', 'Note', 'Recorded by'],
      rows: rows.map((r) => [r.expense_date, r.number, r.category, r.paid_to, r.method, r.account,
        num(r.amount), r.note, r.paid_by_name]),
    };
  }

  private async dailySummaries(q: Queryable, propertyId: string, from: string, to: string) {
    const { rows } = await q.query<{ business_date: string; completed_at: Date; completed_by_name: string | null; summary: Record<string, unknown> }>(
      `SELECT to_char(n.business_date, 'YYYY-MM-DD') AS business_date, n.completed_at, u.full_name AS completed_by_name, n.summary
         FROM night_audits n
         LEFT JOIN users u ON u.id = n.completed_by
        WHERE n.property_id = $1 AND n.business_date BETWEEN $2::date AND $3::date
        ORDER BY n.business_date`,
      [propertyId, from, to],
    );
    const pick = (s: Record<string, unknown>, key: string) => (s[key] === undefined || s[key] === null ? null : String(s[key]));
    return {
      title: 'Daily summaries',
      columns: ['Business date', 'Rooms active', 'Rooms occupied', 'Occupancy %', 'Arrivals checked in', 'Departures completed', 'No-shows', 'Closed by'],
      rows: rows.map((r) => [r.business_date, num(pick(r.summary, 'roomsActive')), num(pick(r.summary, 'roomsOccupied')), pick(r.summary, 'occupancyPercent'),
        num(pick(r.summary, 'arrivalsCheckedIn')), num(pick(r.summary, 'departuresCompleted')), num(pick(r.summary, 'noShows')), r.completed_by_name]),
    };
  }

  private async formC(q: Queryable, propertyId: string) {
    const { rows } = await q.query<Record<string, string | null>>(
      `SELECT to_char(f.arrived_at AT TIME ZONE prop.timezone, 'YYYY-MM-DD HH24:MI') AS arrived, o.full_name, o.nationality, rm.number AS room,
              f.status, f.passport_number, f.passport_place_of_issue, f.passport_expiry_date, f.visa_number, f.visa_type,
              f.visa_expiry_date, f.arrival_in_india_date, f.arrival_port, f.next_destination,
              f.submitted_reference, to_char(f.submitted_at AT TIME ZONE prop.timezone, 'YYYY-MM-DD HH24:MI') AS submitted_at,
              to_char(s.expected_departure, 'YYYY-MM-DD') AS expected_out
         FROM form_c_records f
         JOIN properties prop ON prop.id=f.property_id
         JOIN stay_occupants o ON o.id = f.occupant_id
         JOIN stays s ON s.id = f.stay_id
         JOIN rooms rm ON rm.id = s.room_id
        WHERE f.property_id = $1
        ORDER BY f.arrived_at`,
      [propertyId],
    );
    return {
      title: 'Form C',
      columns: ['Arrived', 'Guest', 'Nationality', 'Room', 'Status', 'Passport number', 'Passport issued at', 'Passport expiry', 'Visa number', 'Visa type', 'Visa expiry', 'Arrived in India', 'Port of arrival', 'Next destination', 'Portal reference', 'Submitted at', 'Expected departure'],
      rows: rows.map((r) => [r.arrived, r.full_name, r.nationality, r.room, r.status, r.passport_number, r.passport_place_of_issue, r.passport_expiry_date,
        r.visa_number, r.visa_type, r.visa_expiry_date, r.arrival_in_india_date, r.arrival_port, r.next_destination, r.submitted_reference, r.submitted_at, r.expected_out]),
    };
  }

  private async policeRegister(propertyId: string, from: string, to: string) {
    const register = await this.police.rows(propertyId, from, to);
    return {
      title: 'Police register',
      columns: register.columns.map((c) => c.label),
      rows: register.rows as string[][],
    };
  }

  // ---------------- accountant formats ----------------

  /**
   * Accountant GST summary (§46): immutable invoice tax groups, B2B documents,
   * B2C totals and credit/debit notes. This is not a GST portal upload file.
   */
  async gstr1(actor: Actor, from: string, to: string): Promise<{ csv: string; rows: number }> {
    const { rows } = await this.db.tx({}, async (q) => q.query<Record<string, string | null>>(
      `SELECT i.number, i.invoice_date, i.document_type, i.buyer_name, i.buyer_gstin, i.place_of_supply,
              i.supply_type, gl.rate_percent::text AS gst_rate, gl.taxable_value::text AS taxable_value,
              gl.cgst::text AS cgst, gl.sgst::text AS sgst, gl.igst::text AS igst
         FROM invoices i
         JOIN invoice_tax_groups gl ON gl.invoice_id = i.id
        WHERE i.property_id = $1 AND i.invoice_date BETWEEN $2::date AND $3::date
        ORDER BY i.invoice_date, i.seq, gl.rate_percent`,
      [actor.user.propertyId, from, to],
    ));
    const cell = (v: string | null | undefined) => (v ?? '').replace(/,/g, ' ');
    const out: string[] = [];
    out.push('section,gstin,party,invoice number,invoice date,document type,place of supply,supply type,rate %,taxable value,CGST,SGST,IGST');
    let count = 0;
    for (const r of rows) {
      if (r.buyer_gstin || r.document_type === 'credit_note' || r.document_type === 'debit_note') {
        // B2B and the notes are reported document by document, line by line.
        out.push([r.document_type === 'credit_note' || r.document_type === 'debit_note' ? 'CDN' : 'B2B', cell(r.buyer_gstin), cell(r.buyer_name), r.number!, r.invoice_date!, r.document_type!, r.place_of_supply!, r.supply_type!, r.gst_rate!, r.taxable_value!, r.cgst ?? '', r.sgst ?? '', r.igst ?? ''].join(','));
        count += 1;
      }
    }
    // B2C: aggregated per rate for the period, the way the portal's B2C tab wants it.
    const b2c = new Map<string, { rate: string; place: string; supply: string; taxable: ReturnType<typeof money>; cgst: ReturnType<typeof money>; sgst: ReturnType<typeof money>; igst: ReturnType<typeof money> }>();
    for (const r of rows) {
      if (r.buyer_gstin || (r.document_type !== 'tax_invoice' && r.document_type !== 'bill_of_supply')) continue;
      const key = `${r.gst_rate}:${r.place_of_supply}:${r.supply_type}`;
      const acc = b2c.get(key) ?? { rate: r.gst_rate!, place: r.place_of_supply!, supply: r.supply_type!, taxable: money(0), cgst: money(0), sgst: money(0), igst: money(0) };
      acc.taxable = acc.taxable.plus(r.taxable_value ?? 0);
      acc.cgst = acc.cgst.plus(r.cgst ?? 0);
      acc.sgst = acc.sgst.plus(r.sgst ?? 0);
      acc.igst = acc.igst.plus(r.igst ?? 0);
      b2c.set(key, acc);
    }
    for (const acc of [...b2c.values()].sort((a, b) => money(a.rate).comparedTo(b.rate) || a.place.localeCompare(b.place))) {
      out.push(['B2C', '', '—', '', from, 'aggregated', acc.place, acc.supply, acc.rate, toMoneyString(acc.taxable), toMoneyString(acc.cgst), toMoneyString(acc.sgst), toMoneyString(acc.igst)].join(','));
      count += 1;
    }
    return { csv: out.join('\r\n'), rows: count };
  }

  /** Accounting vouchers use signed ledger amounts and the immutable invoice tax snapshot.
   * Ledger masters must be mapped and a sample imported by the accountant before live use. */
  async tallyXml(actor: Actor, from: string, to: string): Promise<{ xml: string; count: number }> {
    const data = await this.db.tx({}, async (q) => {
      const invoices = await q.query<Record<'id'|'number'|'invoice_date'|'buyer_name'|'series'|'taxable_total'|'cgst_total'|'sgst_total'|'igst_total'|'round_off'|'grand_total', string>>(
        `SELECT id,number,invoice_date,buyer_name,series,taxable_total,cgst_total,sgst_total,igst_total,round_off,grand_total
           FROM invoices WHERE property_id=$1 AND invoice_date BETWEEN $2::date AND $3::date ORDER BY invoice_date,series,seq`,
        [actor.user.propertyId,from,to],
      );
      const receipts = await q.query<Record<'id'|'number'|'business_date'|'cash_effect'|'entry_type'|'method'|'account'|'guest', string>>(
        `SELECT p.id,p.number,p.business_date,p.cash_effect,p.entry_type,p.method,a.name AS account,g.first_name||' '||g.last_name AS guest
           FROM payments p JOIN payment_accounts a ON a.id=p.payment_account_id JOIN guests g ON g.id=p.guest_id
          WHERE p.property_id=$1 AND p.business_date BETWEEN $2::date AND $3::date AND p.cash_effect<>0
            AND NOT EXISTS (SELECT 1 FROM payments reversal WHERE reversal.reverses_payment_id=p.id AND reversal.business_date BETWEEN $2::date AND $3::date)
            AND NOT EXISTS (SELECT 1 FROM payments original WHERE original.id=p.reverses_payment_id AND original.business_date BETWEEN $2::date AND $3::date)
          ORDER BY p.business_date,p.received_at,p.id`, [actor.user.propertyId,from,to],
      );
      return { invoices: invoices.rows, receipts: receipts.rows };
    });
    const esc = (v: string) => v.replace(/[<>&"']/g, (c) => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]!));
    const vouchers: string[] = [];
    const voucher = (id: string, type: string, date: string, number: string, party: string, narration: string, lines: { name: string; amount: string }[]) => {
      const nonzero = lines.filter((l) => !money(l.amount).isZero());
      if (!nonzero.reduce((sum,l) => sum.plus(l.amount),money(0)).isZero()) throw new AppError(ERROR_CODES.CONFLICT,'The accounting voucher does not balance.');
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(id)}" VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View">
        <GUID>${esc(id)}</GUID><DATE>${date.replaceAll('-','')}</DATE><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER>
        <VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME><NARRATION>${esc(narration)}</NARRATION>
        ${nonzero.map((l) => `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(l.name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${money(l.amount).isNegative()?'Yes':'No'}</ISDEEMEDPOSITIVE><AMOUNT>${l.amount}</AMOUNT></LEDGERENTRIES.LIST>`).join('')}
      </VOUCHER></TALLYMESSAGE>`;
    };
    for (const inv of data.invoices) {
      const sign = inv.series==='CN' ? -1 : 1;
      vouchers.push(voucher(`resortos-invoice-${inv.id}`, inv.series==='CN'?'Credit Note':inv.series==='DN'?'Debit Note':'Sales', inv.invoice_date, inv.number, inv.buyer_name, `Invoice ${inv.number}`, [
        { name:inv.buyer_name, amount:toMoneyString(money(inv.grand_total).times(-sign)) },
        ...([['Sales',inv.taxable_total],['Output CGST',inv.cgst_total],['Output SGST',inv.sgst_total],['Output IGST',inv.igst_total],['Round off',inv.round_off]] as const)
          .map(([name,amount])=>({name,amount:toMoneyString(money(amount).times(sign))})),
      ]));
    }
    for (const rec of data.receipts) {
      const party = rec.entry_type==='deposit'||rec.entry_type==='deposit_refund'?'Guest deposits':rec.guest;
      vouchers.push(voucher(`resortos-payment-${rec.id}`, money(rec.cash_effect).gt(0)?'Receipt':'Payment', rec.business_date, rec.number,party,`${rec.method} ${rec.entry_type} (${rec.number})`,[
        { name:rec.account,amount:toMoneyString(money(rec.cash_effect).negated()) },{ name:party,amount:rec.cash_effect },
      ]));
    }
    return { count:vouchers.length,xml:`<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>${vouchers.join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>` };
  }

  // ---------------- police register PDF ----------------

  /** Landscape A4, one page wide if it fits; the station signs the last column on paper. */
  private async registerPdf(sheet: { title: string; columns: string[]; rows: string[][] }, from: string, to: string): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: `${sheet.title} ${from} to ${to}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    doc.registerFont('body', GRC_FONT_PATH);
    doc.registerFont('body-bold', GRC_FONT_PATH);
    doc.font('body').fillColor('#111111');
    doc.fontSize(13).text(sheet.title);
    doc.fontSize(9).fillColor('#555555').text(from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`);
    doc.moveDown(0.5);

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = width / Math.max(1, sheet.columns.length);
    const drawRow = (cells: string[], bold = false) => {
      const size = bold ? 8.5 : 8;
      doc.font('body').fontSize(size).fillColor(bold ? '#111111' : '#333333');
      let rowTop = doc.y;
      const heights = cells.map((c, i) => doc.heightOfString(String(c ?? ''), { width: colWidth - 6 }));
      const rowHeight = Math.max(size + 2, ...heights) + 4;
      if (rowTop + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
        if (!bold) drawRow(sheet.columns, true);
        doc.font('body').fontSize(size);
        rowTop = doc.y;
      }
      cells.forEach((c, i) => {
        doc.text(String(c ?? ''), left + i * colWidth, rowTop, { width: colWidth - 6, height: rowHeight, ellipsis: true });
      });
      doc.y = rowTop + rowHeight;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke();
      doc.y += 2;
    };
    drawRow(sheet.columns, true);
    for (const row of sheet.rows) drawRow(row);
    doc.end();
    return done;
  }
}
