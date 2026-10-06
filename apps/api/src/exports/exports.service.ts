import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { formatDate } from '@resortos/shared';
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

/** The GST slabs a GSTR-1 summary groups by, in the order the accountant reads them. */
const GSTR_RATE_ORDER = ['0.00', '5.00', '12.00', '18.00', '28.00'];

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
        case 'bookings': return this.bookings(q, propertyId);
        case 'guests': return this.guests(q, propertyId);
        case 'in-house': return this.inHouse(q, propertyId);
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

  private async bookings(q: Queryable, propertyId: string) {
    const { rows } = await q.query<Record<string, string | null>>(
      `SELECT r.number, g.first_name || ' ' || g.last_name AS guest, g.mobile, r.source, r.ota_reference,
              to_char(r.arrival, 'YYYY-MM-DD') AS arrival, to_char(r.departure, 'YYYY-MM-DD') AS departure,
              r.status, r.group_name, r.purpose,
              (SELECT sum(rr.adults) FROM reservation_rooms rr WHERE rr.reservation_id = r.id)::text AS guests_count,
              (SELECT count(*) FROM reservation_rooms rr WHERE rr.reservation_id = r.id)::text AS rooms_count,
              u.full_name AS created_by_name, to_char(r.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
         FROM reservations r
         JOIN guests g ON g.id = r.primary_guest_id
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.property_id = $1
        ORDER BY r.arrival, r.number`,
      [propertyId],
    );
    return {
      title: 'Bookings',
      columns: ['Booking', 'Guest', 'Mobile', 'Source', 'OTA reference', 'Arrival', 'Departure', 'Status', 'Group', 'Purpose', 'Guests', 'Rooms', 'Booked by', 'Booked at'],
      rows: rows.map((r) => [r.number, r.guest, r.mobile, r.source, r.ota_reference, r.arrival, r.departure, r.status, r.group_name, r.purpose, num(r.guests_count), num(r.rooms_count), r.created_by_name, r.created_at]),
    };
  }

  private async guests(q: Queryable, propertyId: string) {
    const { rows } = await q.query<Record<string, string | null>>(
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
      rows: rows.map((r) => [r.guest, r.mobile, r.email, r.city, r.state, r.address_line, r.nationality, r.company_name, r.company_gstin, r.is_vip === 'true' ? 'Yes' : '', r.special_note, num(r.bookings_count), r.last_arrival, r.created_at]),
    };
  }

  private async inHouse(q: Queryable, propertyId: string) {
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
        WHERE s.property_id = $1
        ORDER BY s.business_date_in, rm.number`,
      [propertyId],
    );
    return {
      title: 'Stays',
      columns: ['Room', 'Room type', 'Status', 'Checked in', 'Expected out', 'Checked out', 'Occupants', 'Persons', 'Booking guest', 'Mobile', 'Source'],
      rows: rows.map((r) => [r.room, r.room_type, r.status, r.checked_in, r.expected_out, r.checked_out, r.occupants, num(r.persons), r.guest, r.mobile, r.source]),
    };
  }

  private async payments(q: Queryable, propertyId: string, from: string, to: string) {
    const { rows } = await q.query<Record<string, string | null>>(
      `SELECT p.business_date, p.number, g.first_name || ' ' || g.last_name AS guest, r.number AS booking,
              p.entry_type, p.method, a.name AS account, p.amount, p.reverses_payment_id IS NOT NULL AS is_reversal,
              p.reference, u.full_name AS received_by_name, p.received_at
         FROM payments p
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
      columns: ['Date', 'Number', 'Guest', 'Booking', 'Entry', 'Method', 'Account', 'Amount', 'Reference', 'Received by'],
      rows: rows.map((r) => [r.business_date, r.number, r.guest, r.booking, r.entry_type + (r.is_reversal === 'true' ? ' (reversed)' : ''), r.method, r.account, num(r.amount), r.reference, r.received_by_name]),
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
              e.amount, e.note, u.full_name AS paid_by_name,
              EXISTS (SELECT 1 FROM expenses x WHERE x.reverses_expense_id = e.id) AS reversed
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
        num(r.reversed === 'true' ? null : r.amount), r.note, r.paid_by_name]),
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
      `SELECT to_char(f.arrived_at, 'YYYY-MM-DD HH24:MI') AS arrived, o.full_name, o.nationality, rm.number AS room,
              f.status, f.passport_number, f.passport_place_of_issue, f.passport_expiry_date, f.visa_number, f.visa_type,
              f.visa_expiry_date, f.arrival_in_india_date, f.arrival_port, f.next_destination,
              f.submitted_reference, to_char(f.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at,
              to_char(s.expected_departure, 'YYYY-MM-DD') AS expected_out
         FROM form_c_records f
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
   * GSTR-1-ready CSV (§46): B2B invoices line by line, B2C aggregated per rate, credit/debit notes,
   * and the documents-issued summary — the four blocks the accountant keys into the portal tool.
   */
  async gstr1(actor: Actor, from: string, to: string): Promise<{ csv: string; rows: number }> {
    const { rows } = await this.db.tx({}, async (q) => q.query<Record<string, string | null>>(
      `SELECT i.number, i.invoice_date, i.document_type, i.buyer_name, i.buyer_gstin, i.place_of_supply,
              i.supply_type, gl.gst_rate::text AS gst_rate, gl.taxable_value::text AS taxable_value,
              CASE WHEN i.supply_type = 'intra_state' THEN round(gl.taxable_value * gl.gst_rate / 200.0, 2)::text ELSE '0.00' END AS cgst,
              CASE WHEN i.supply_type = 'intra_state' THEN round(gl.taxable_value * gl.gst_rate / 200.0, 2)::text ELSE '0.00' END AS sgst,
              CASE WHEN i.supply_type = 'inter_state' THEN round(gl.taxable_value * gl.gst_rate / 100.0, 2)::text ELSE '0.00' END AS igst
         FROM invoices i
         JOIN invoice_lines gl ON gl.invoice_id = i.id
        WHERE i.property_id = $1 AND i.invoice_date BETWEEN $2::date AND $3::date
        ORDER BY i.invoice_date, gl.line_no`,
      [actor.user.propertyId, from, to],
    ));
    const cell = (v: string | null | undefined) => (v ?? '').replace(/,/g, ' ');
    const out: string[] = [];
    out.push('section,gstin,party,invoice number,invoice date,document type,place of supply,supply type,rate %,taxable value,CGST,SGST,IGST');
    let count = 0;
    for (const r of rows) {
      if (r.buyer_gstin || r.document_type === 'credit_note' || r.document_type === 'debit_note') {
        // B2B and the notes are reported document by document, line by line.
        out.push([r.buyer_gstin ? 'B2B' : 'CDN', cell(r.buyer_gstin), cell(r.buyer_name), r.number!, r.invoice_date!, r.document_type!, r.place_of_supply!, r.supply_type!, r.gst_rate!, r.taxable_value!, r.cgst ?? '', r.sgst ?? '', r.igst ?? ''].join(','));
        count += 1;
      }
    }
    // B2C: aggregated per rate for the period, the way the portal's B2C tab wants it.
    const b2c = new Map<string, { taxable: number; cgst: number; sgst: number; igst: number }>();
    for (const r of rows) {
      if (r.buyer_gstin || (r.document_type !== 'tax_invoice' && r.document_type !== 'bill_of_supply')) continue;
      const key = r.gst_rate!;
      const acc = b2c.get(key) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      acc.taxable += Number(r.taxable_value);
      acc.cgst += Number(r.cgst ?? 0);
      acc.sgst += Number(r.sgst ?? 0);
      acc.igst += Number(r.igst ?? 0);
      b2c.set(key, acc);
    }
    for (const rate of [...b2c.keys()].sort((a, b) => GSTR_RATE_ORDER.indexOf(a) - GSTR_RATE_ORDER.indexOf(b))) {
      const acc = b2c.get(rate)!;
      out.push(['B2C', '', '—', '', from, 'aggregated', '', '', rate, acc.taxable.toFixed(2), acc.cgst.toFixed(2), acc.sgst.toFixed(2), acc.igst.toFixed(2)].join(','));
      count += 1;
    }
    return { csv: out.join('\r\n'), rows: count };
  }

  /**
   * Tally vouchers (§46): sales (invoices) and receipts (payments) in Tally's XML import format.
   * The ledger names are defaults; the resort's accountant maps them once in Tally (spec: "a
   * Tally-importable format agreed with the resort's accountant").
   */
  async tallyXml(actor: Actor, from: string, to: string): Promise<{ xml: string; count: number }> {
    const data = await this.db.tx({}, async (q) => {
      const invoices = await q.query<Record<string, string | null>>(
        `SELECT i.number, i.invoice_date, i.buyer_name, i.buyer_gstin, i.grand_total, i.seller_state_code,
                (SELECT string_agg(distinct gl.gst_rate::text, ',') FROM invoice_lines gl WHERE gl.invoice_id = i.id) AS rates
           FROM invoices i
          WHERE i.property_id = $1 AND i.invoice_date BETWEEN $2::date AND $3::date
            AND i.document_type IN ('tax_invoice', 'bill_of_supply')
          ORDER BY i.invoice_date, i.seq`,
        [actor.user.propertyId, from, to],
      );
      const receipts = await q.query<Record<string, string | null>>(
        `SELECT p.number, p.business_date, p.amount, p.method, a.name AS account, g.first_name || ' ' || g.last_name AS guest
           FROM payments p
           LEFT JOIN payment_accounts a ON a.id = p.payment_account_id
           LEFT JOIN guests g ON g.id = p.guest_id
          WHERE p.property_id = $1 AND p.business_date BETWEEN $2::date AND $3::date
            AND p.entry_type IN ('payment', 'advance') AND p.reverses_payment_id IS NULL
          ORDER BY p.business_date`,
        [actor.user.propertyId, from, to],
      );
      return { invoices: invoices.rows, receipts: receipts.rows };
    });
    const esc = (v: string | null | undefined) => (v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
    const voucherDate = (d: string) => d.split('-').reverse().join('-');
    const vouchers: string[] = [];
    for (const inv of data.invoices) {
      vouchers.push(`
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${voucherDate(inv.invoice_date!)}</DATE>
      <NARRATION>Invoice ${esc(inv.number)}</NARRATION>
      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <PARTYLEDGERNAME>${esc(inv.buyer_name)}</PARTYLEDGERNAME>
      <ALLINVENTORYENTRIES.LIST></ALLINVENTORYENTRIES.LIST>
      <LEDGERENTRIES.LIST>
       <LEDGERNAME>${esc(inv.buyer_name)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <AMOUNT>-${inv.grand_total}</AMOUNT>
      </LEDGERENTRIES.LIST>
      <LEDGERENTRIES.LIST>
       <LEDGERNAME>Sales - GST ${esc(inv.rates ?? '')}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <AMOUNT>${inv.grand_total}</AMOUNT>
      </LEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>`);
    }
    for (const rec of data.receipts) {
      vouchers.push(`
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${voucherDate(rec.business_date!)}</DATE>
      <NARRATION>${esc(rec.method)} from ${esc(rec.guest)} (${esc(rec.number)})</NARRATION>
      <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
      <PARTYLEDGERNAME>${esc(rec.guest)}</PARTYLEDGERNAME>
      <LEDGERENTRIES.LIST>
       <LEDGERNAME>${esc(rec.account ?? rec.method)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <AMOUNT>${rec.amount}</AMOUNT>
      </LEDGERENTRIES.LIST>
      <LEDGERENTRIES.LIST>
       <LEDGERNAME>${esc(rec.guest)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <AMOUNT>-${rec.amount}</AMOUNT>
      </LEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>`);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
   </REQUESTDESC>
   <REQUESTDATA>${vouchers.join('')}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
    return { xml, count: vouchers.length };
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
      const rowTop = doc.y;
      const heights = cells.map((c, i) => doc.heightOfString(String(c ?? ''), { width: colWidth - 6 }));
      const rowHeight = Math.max(size + 2, ...heights) + 4;
      if (rowTop + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
        doc.font('body').fontSize(size);
      }
      cells.forEach((c, i) => {
        doc.text(String(c ?? ''), left + i * colWidth, doc.page.height - doc.page.margins.bottom <= doc.y ? doc.y : rowTop, { width: colWidth - 6, height: rowHeight, ellipsis: true });
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
