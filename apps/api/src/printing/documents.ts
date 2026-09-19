import PDFDocument from 'pdfkit';
import {
  formatDate, formatINR, GST_STATE_CODES, maskMobile, money, PAYMENT_ENTRY_TYPE_LABELS, PAYMENT_METHOD_LABELS,
  toMoneyString, type PaymentEntryType, type PaymentMethod,
} from '@resortos/shared';
import { GRC_FONT_PATH } from '../stays/grc-pdf';

/**
 * Printed documents (spec §36): the A4 invoice, the payment receipt (A4 or an 80 mm thermal roll)
 * and the cashier shift report.
 *
 * Like the registration card, **every render is a pure function of its input**: no clock, no random
 * ids, one pinned font. The same invoice always prints the same bytes, so a copy archived to Drive
 * in Sprint D can be checked against a fresh render.
 */

export type Paper = 'a4' | 'thermal_80';

const A4 = { width: 595.28, height: 841.89, margin: 36 };
/** 80 mm roll: 226.77 pt wide. Height is worked out from the content so the roll is cut once. */
const THERMAL = { width: 226.77, margin: 10 };
const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';

type Doc = PDFKit.PDFDocument;

export interface Seller {
  legalName: string; name: string; address: string; gstin: string | null; stateCode: string; phone: string; email: string | null;
}

function start(opts: { title: string; author: string; at: Date; size: [number, number]; margin: number }): { doc: Doc; done: Promise<Buffer> } {
  const doc = new PDFDocument({
    size: opts.size, margin: opts.margin, autoFirstPage: true,
    info: { Title: opts.title, Author: opts.author, Creator: 'ResortOS', CreationDate: opts.at, ModDate: opts.at },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('body', GRC_FONT_PATH);
  doc.font('body').fillColor(INK);
  return { doc, done };
}

/** The single font has one weight; emphasis is a hairline stroke in the same colour, as on the GRC. */
function bold(doc: Doc, text: string, size: number, opts: PDFKit.Mixins.TextOptions = {}, at?: { x: number; y: number }) {
  doc.fontSize(size).lineWidth(size / 28).strokeColor(INK).fillColor(INK);
  if (at) doc.text(text, at.x, at.y, { ...opts, fill: true, stroke: true });
  else doc.text(text, { ...opts, fill: true, stroke: true });
}

function hr(doc: Doc, x: number, width: number, gap = 5) {
  const y = doc.y + gap / 2;
  doc.moveTo(x, y).lineTo(x + width, y).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.y = y + gap / 2;
}

const inr = (v: string) => formatINR(v, { paise: true });
const qty = (v: string) => (Number(v) % 1 === 0 ? String(Number(v)) : Number(v).toFixed(2));
const state = (code: string | null) => (code ? `${GST_STATE_CODES[code] ?? 'State'} (${code})` : '—');

// ---------------------------------------------------------------------------
// Invoice, credit note, debit note — A4 (spec §29.2)
// ---------------------------------------------------------------------------

export interface InvoicePrint {
  seller: Seller;
  documentType: 'tax_invoice' | 'bill_of_supply' | 'credit_note' | 'debit_note';
  number: string; invoiceDate: string; original: { number: string } | null; reason: string | null;
  buyer: { name: string; gstin: string | null; address: string | null; stateCode: string | null; mobile: string | null };
  placeOfSupply: string;
  stay: { from: string | null; to: string | null; rooms: string | null; reservationNumber: string | null };
  lines: { businessDate: string; description: string; sac: string; quantity: string; rate: string; gross: string; discount: string; taxable: string; gstRate: string }[];
  groups: { ratePercent: string; taxableValue: string; cgst: string; sgst: string; igst: string }[];
  taxableTotal: string; cgstTotal: string; sgstTotal: string; igstTotal: string; roundOff: string; grandTotal: string;
  paid: { method: string; amount: string }[]; paidAtIssue: string;
  terms: string | null; bankDetails: string | null; maskMobile: boolean;
  finalizedAt: Date; finalizedBy: string;
}

const TITLES: Record<InvoicePrint['documentType'], string> = {
  tax_invoice: 'TAX INVOICE', bill_of_supply: 'BILL OF SUPPLY', credit_note: 'CREDIT NOTE', debit_note: 'DEBIT NOTE',
};

const COLS = [
  { head: 'Date', w: 44, align: 'left' as const },
  { head: 'Description', w: 150, align: 'left' as const },
  { head: 'SAC', w: 44, align: 'left' as const },
  { head: 'Qty', w: 30, align: 'right' as const },
  { head: 'Rate', w: 56, align: 'right' as const },
  { head: 'Discount', w: 52, align: 'right' as const },
  { head: 'Taxable', w: 62, align: 'right' as const },
  { head: 'GST', w: 35, align: 'right' as const },
];

export function renderInvoicePdf(input: InvoicePrint): Promise<Buffer> {
  const { doc, done } = start({ title: `${TITLES[input.documentType]} ${input.number}`, author: input.seller.legalName, at: input.finalizedAt, size: [A4.width, A4.height], margin: A4.margin });
  const x0 = A4.margin;
  const width = A4.width - A4.margin * 2;

  // Seller, left; the title block takes the right 200 pt, so the seller never runs under it.
  const sellerW = width - 210;
  bold(doc, input.seller.legalName, 15, { width: sellerW });
  doc.fontSize(8.5).fillColor(MUTED).text(input.seller.address, { width: sellerW });
  doc.text([input.seller.phone, input.seller.email].filter(Boolean).join(' · '), { width: sellerW });
  if (input.seller.gstin) { doc.fillColor(INK).fontSize(9).text(`GSTIN ${input.seller.gstin} · State ${state(input.seller.stateCode)}`, { width: sellerW }); }

  // Title block, right
  const titleY = A4.margin;
  bold(doc, TITLES[input.documentType], 13, { width: 200, align: 'right' }, { x: x0 + width - 200, y: titleY });
  doc.fontSize(9).fillColor(INK).text(`No. ${input.number}`, x0 + width - 200, titleY + 20, { width: 200, align: 'right' });
  doc.text(`Date ${formatDate(input.invoiceDate)}`, x0 + width - 200, titleY + 33, { width: 200, align: 'right' });
  if (input.original) doc.fillColor(MUTED).text(`Against ${input.original.number}`, x0 + width - 200, titleY + 46, { width: 200, align: 'right' });
  doc.x = x0;
  doc.y = Math.max(doc.y, titleY + 70);
  hr(doc, x0, width, 10);

  // Buyer and stay
  const colW = width / 2 - 8;
  const top = doc.y;
  doc.fontSize(7.5).fillColor(MUTED).text('BILLED TO', x0, top, { characterSpacing: 1 });
  bold(doc, input.buyer.name, 10, { width: colW }, { x: x0, y: top + 11 });
  doc.fontSize(8.5).fillColor(INK);
  if (input.buyer.gstin) doc.text(`GSTIN ${input.buyer.gstin} · ${state(input.buyer.stateCode)}`, { width: colW });
  if (input.buyer.address) doc.fillColor(MUTED).text(input.buyer.address, { width: colW });
  if (input.buyer.mobile) doc.fillColor(MUTED).text(`Mobile ${input.maskMobile ? maskMobile(input.buyer.mobile) : input.buyer.mobile}`, { width: colW });
  const leftBottom = doc.y;

  const rx = x0 + width / 2 + 8;
  doc.fontSize(7.5).fillColor(MUTED).text('STAY', rx, top, { characterSpacing: 1 });
  doc.fontSize(8.5).fillColor(INK);
  const stayLines = [
    input.stay.from && input.stay.to ? `${formatDate(input.stay.from)} to ${formatDate(input.stay.to)}` : null,
    input.stay.rooms ? `Room ${input.stay.rooms}` : null,
    input.stay.reservationNumber ? `Booking ${input.stay.reservationNumber}` : null,
    `Place of supply ${state(input.placeOfSupply)}`,
  ].filter((l): l is string => Boolean(l));
  doc.text(stayLines.join('\n'), rx, top + 11, { width: colW });
  doc.y = Math.max(leftBottom, doc.y) + 4;
  doc.x = x0;
  if (input.reason) doc.fontSize(8.5).fillColor(INK).text(`Reason: ${input.reason}`, x0, doc.y, { width });
  hr(doc, x0, width, 10);

  // Lines
  let y = doc.y;
  doc.fontSize(7).fillColor(MUTED);
  COLS.reduce((x, c) => { doc.text(c.head.toUpperCase(), x, y, { width: c.w - 4, align: c.align }); return x + c.w; }, x0);
  y += 12;
  for (const l of input.lines) {
    const cells = [
      formatDate(l.businessDate, { year: false }), l.description, l.sac, qty(l.quantity), inr(l.rate),
      Number(l.discount) ? inr(l.discount) : '—', inr(l.taxable), `${Number(l.gstRate)}%`,
    ];
    const h = Math.max(12, doc.fontSize(8).heightOfString(l.description, { width: COLS[1]!.w - 4 }) + 3);
    if (y + h > A4.height - A4.margin - 170) { doc.addPage(); y = A4.margin; }
    doc.fontSize(8).fillColor(INK);
    COLS.reduce((x, c, i) => { doc.text(cells[i]!, x, y, { width: c.w - 4, align: c.align }); return x + c.w; }, x0);
    y += h;
    doc.moveTo(x0, y - 2).lineTo(x0 + width, y - 2).lineWidth(0.25).strokeColor(RULE).stroke();
  }
  doc.y = y + 6;
  doc.x = x0;

  // Tax summary by rate
  const sumX = x0 + width - 260;
  // Row height is measured, not assumed: a long label wraps and pushes the next row down.
  const row = (label: string, value: string, strong = false) => {
    const ry = doc.y;
    const h = doc.fontSize(strong ? 10 : 8.5).heightOfString(label, { width: 170 });
    if (strong) { bold(doc, label, 10, { width: 170 }, { x: sumX, y: ry }); bold(doc, value, 10, { width: 90, align: 'right' }, { x: sumX + 170, y: ry }); }
    else { doc.fontSize(8.5).fillColor(INK).text(label, sumX, ry, { width: 170 }); doc.text(value, sumX + 170, ry, { width: 90, align: 'right' }); }
    doc.y = ry + Math.max(strong ? 15 : 12, h + 3);
  };
  row('Taxable value', inr(input.taxableTotal));
  for (const g of input.groups) {
    if (Number(g.ratePercent) === 0) continue;
    row(`CGST ${Number(g.ratePercent) / 2}% on ${inr(g.taxableValue)}`, inr(g.cgst));
    row(`SGST ${Number(g.ratePercent) / 2}% on ${inr(g.taxableValue)}`, inr(g.sgst));
    if (Number(g.igst)) row(`IGST ${Number(g.ratePercent)}% on ${inr(g.taxableValue)}`, inr(g.igst));
  }
  if (Number(input.roundOff) !== 0) row('Round off', inr(input.roundOff));
  hr(doc, sumX, 260, 4);
  row(input.documentType === 'credit_note' ? 'Total credited' : 'Total', inr(input.grandTotal), true);

  if (input.documentType === 'tax_invoice' || input.documentType === 'bill_of_supply') {
    for (const p of input.paid) row(`Paid · ${(PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method).replace(/ \(.*\)$/, '')}`, inr(p.amount));
    const balance = money(input.grandTotal).minus(input.paidAtIssue);
    row('Balance', inr(toMoneyString(balance.isNegative() ? money(0) : balance)), true);
  }

  // Footer
  doc.x = x0;
  doc.y += 10;
  if (input.documentType === 'bill_of_supply') {
    doc.fontSize(8).fillColor(MUTED).text('Bill of supply: issued by a supplier not registered under GST. No tax is charged.', x0, doc.y, { width });
  }
  if (input.bankDetails) { doc.fontSize(8).fillColor(INK).text(`Pay to: ${input.bankDetails}`, x0, doc.y + 4, { width }); }
  if (input.terms) { doc.fontSize(8).fillColor(MUTED).text(input.terms, x0, doc.y + 4, { width }); }
  const sigY = Math.max(doc.y + 24, A4.height - A4.margin - 60);
  doc.fontSize(8.5).fillColor(INK).text(`For ${input.seller.legalName}`, x0 + width - 200, sigY, { width: 200, align: 'right' });
  doc.fillColor(MUTED).text('Authorised signatory', x0 + width - 200, sigY + 30, { width: 200, align: 'right' });
  doc.fontSize(7).fillColor(MUTED).text(
    `Computer generated ${TITLES[input.documentType].toLowerCase()} · issued ${formatDate(input.invoiceDate)} by ${input.finalizedBy}`,
    x0, sigY + 30, { width: width - 210 },
  );
  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Receipt — A4 or 80 mm (spec §25.5)
// ---------------------------------------------------------------------------

export interface ReceiptPrint {
  seller: Seller;
  number: string; entryType: PaymentEntryType; method: PaymentMethod; amount: string; reference: string | null;
  businessDate: string; receivedAt: Date; receivedBy: string; accountName: string | null;
  guestName: string; guestMobile: string | null; reservationNumber: string; roomNumber: string | null; billNumber: string | null;
  isReversal: boolean; reverses: string | null; reason: string | null; maskMobile: boolean;
}

const RECEIPT_TITLE: Record<PaymentEntryType, string> = {
  payment: 'PAYMENT RECEIPT', advance: 'ADVANCE RECEIPT', deposit: 'SECURITY DEPOSIT RECEIPT', refund: 'REFUND VOUCHER',
  deposit_refund: 'DEPOSIT RETURNED', deposit_adjustment: 'DEPOSIT APPLIED TO BILL',
};

export function renderReceiptPdf(input: ReceiptPrint, paper: Paper): Promise<Buffer> {
  const thermal = paper === 'thermal_80';
  const width = thermal ? THERMAL.width - THERMAL.margin * 2 : A4.width - A4.margin * 2;
  const margin = thermal ? THERMAL.margin : A4.margin;
  // A roll is cut once: the page is as long as the receipt, worked out from how many rows it has.
  const rows = 9 + [input.guestMobile, input.roomNumber, input.billNumber, input.accountName, input.reference, input.reason].filter(Boolean).length;
  const size: [number, number] = thermal ? [THERMAL.width, 170 + rows * 11 + (input.reason ? 20 : 0)] : [A4.width, A4.height];
  const title = input.isReversal ? `REVERSAL OF ${input.reverses}` : RECEIPT_TITLE[input.entryType];
  const { doc, done } = start({ title: `${title} ${input.number}`, author: input.seller.legalName, at: input.receivedAt, size, margin });
  const s = thermal ? 0.82 : 1;

  bold(doc, input.seller.name, 13 * s, { width, align: thermal ? 'center' : 'left' });
  doc.fontSize(7.5 * s).fillColor(MUTED).text(input.seller.address, { width, align: thermal ? 'center' : 'left' });
  if (input.seller.gstin) doc.text(`GSTIN ${input.seller.gstin}`, { width, align: thermal ? 'center' : 'left' });
  hr(doc, margin, width, 10);
  bold(doc, title, 11 * s, { width, align: 'center' });
  doc.moveDown(0.4);

  const pairs: [string, string][] = [
    ['Receipt no.', input.number],
    ['Date', `${formatDate(input.businessDate)} · ${input.receivedAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}`],
    ['Guest', input.guestName],
    ...(input.guestMobile ? [['Mobile', input.maskMobile ? maskMobile(input.guestMobile) : input.guestMobile] as [string, string]] : []),
    ['Booking', input.reservationNumber],
    ...(input.roomNumber ? [['Room', input.roomNumber] as [string, string]] : []),
    ...(input.billNumber ? [['Bill', input.billNumber] as [string, string]] : []),
    ['Method', PAYMENT_METHOD_LABELS[input.method]],
    ...(input.accountName ? [['Into', input.accountName] as [string, string]] : []),
    ...(input.reference ? [['Reference', input.reference] as [string, string]] : []),
    ...(input.reason ? [['Reason', input.reason] as [string, string]] : []),
    ['Received by', input.receivedBy],
  ];
  const labelW = thermal ? 62 : 110;
  for (const [label, value] of pairs) {
    const y = doc.y;
    doc.fontSize(8 * s).fillColor(MUTED).text(label, margin, y, { width: labelW });
    doc.fillColor(INK).text(value, margin + labelW, y, { width: width - labelW });
    doc.y = Math.max(doc.y, y + 12 * s);
  }
  hr(doc, margin, width, 10);
  const y = doc.y;
  bold(doc, 'Amount', 12 * s, { width: width / 2 }, { x: margin, y });
  bold(doc, inr(input.amount), 12 * s, { width: width / 2, align: 'right' }, { x: margin + width / 2, y });
  doc.y = y + 20;
  doc.x = margin;
  doc.fontSize(7 * s).fillColor(MUTED).text(
    input.entryType === 'deposit'
      ? 'A security deposit is held for the guest and returned or applied to the bill at checkout. It is not a payment for the stay.'
      : 'Computer generated receipt. ResortOS records payments made at the resort; it does not process card or UPI payments.',
    margin, doc.y, { width, align: thermal ? 'center' : 'left' },
  );
  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Cashier shift report — A4 or 80 mm (spec §34.3)
// ---------------------------------------------------------------------------

export interface ShiftReportPrint {
  seller: Seller;
  openedBy: string; openedAt: Date; closedAt: Date | null; closedBy: string | null; businessDate: string;
  openingCash: string; expectedCash: string; countedCash: string | null; cashDifference: string | null;
  expectedCard: string; posBatchTotal: string | null; cardDifference: string | null;
  accounts: { name: string; amount: string; entries: number }[];
  payments: { number: string; entryType: string; method: string; cashEffect: string; at: Date; isReversal: boolean }[];
  differenceReason: string | null; handoverNote: string | null;
}

export function renderShiftReportPdf(input: ShiftReportPrint, paper: Paper): Promise<Buffer> {
  const thermal = paper === 'thermal_80';
  const width = thermal ? THERMAL.width - THERMAL.margin * 2 : A4.width - A4.margin * 2;
  const margin = thermal ? THERMAL.margin : A4.margin;
  const size: [number, number] = thermal ? [THERMAL.width, 300 + input.payments.length * 12 + input.accounts.length * 12] : [A4.width, A4.height];
  const at = input.closedAt ?? input.openedAt;
  const { doc, done } = start({ title: `Shift report ${input.openedBy} ${input.businessDate}`, author: input.seller.legalName, at, size, margin });
  const s = thermal ? 0.82 : 1;
  const time = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  bold(doc, input.seller.name, 13 * s, { width });
  bold(doc, 'CASHIER SHIFT REPORT', 10 * s, { width });
  doc.fontSize(8 * s).fillColor(MUTED).text(
    `${input.openedBy} · business date ${formatDate(input.businessDate)}\n${time(input.openedAt)} – ${input.closedAt ? time(input.closedAt) : 'still open'}${input.closedBy ? ` · closed by ${input.closedBy}` : ''}`,
    { width },
  );
  hr(doc, margin, width, 10);

  const line = (label: string, value: string, strong = false) => {
    const y = doc.y;
    if (strong) { bold(doc, label, 9 * s, { width: width * 0.6 }, { x: margin, y }); bold(doc, value, 9 * s, { width: width * 0.4, align: 'right' }, { x: margin + width * 0.6, y }); }
    else { doc.fontSize(8.5 * s).fillColor(INK).text(label, margin, y, { width: width * 0.6 }); doc.text(value, margin + width * 0.6, y, { width: width * 0.4, align: 'right' }); }
    doc.y = y + 12 * s;
  };
  line('Opening cash', inr(input.openingCash));
  line('Expected cash', inr(input.expectedCash));
  line('Counted cash', input.countedCash ? inr(input.countedCash) : '—');
  if (input.cashDifference) line('Cash difference', inr(input.cashDifference), true);
  line('Card expected', inr(input.expectedCard));
  line('Card machine slip', input.posBatchTotal ? inr(input.posBatchTotal) : '—');
  if (input.cardDifference) line('Card difference', inr(input.cardDifference), true);
  hr(doc, margin, width, 8);
  for (const a of input.accounts) line(`${a.name} (${a.entries})`, inr(a.amount));
  if (input.differenceReason) { doc.moveDown(0.3); doc.fontSize(8 * s).fillColor(INK).text(`Reason for difference: ${input.differenceReason}`, margin, doc.y, { width }); }
  if (input.handoverNote) { doc.moveDown(0.3); doc.fontSize(8 * s).fillColor(INK).text(`Handover: ${input.handoverNote}`, margin, doc.y, { width }); }
  hr(doc, margin, width, 10);
  for (const p of input.payments) {
    line(`${p.number} · ${p.isReversal ? 'reversal · ' : ''}${(PAYMENT_ENTRY_TYPE_LABELS as Record<string, string>)[p.entryType] ?? p.entryType} · ${(PAYMENT_METHOD_LABELS as Record<string, string>)[p.method] ?? p.method}`, inr(p.cashEffect));
  }
  doc.end();
  return done;
}
