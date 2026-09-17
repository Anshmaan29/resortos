import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { formatDate, formatDateTime, formatINR, formatTime, ID_TYPE_LABELS, MEAL_PLAN_LABELS, type IdType, type MealPlanCode } from '@resortos/shared';

/**
 * Guest registration card (spec §20), rendered server-side with pdfkit.
 *
 * **The render is a pure function of its input.** It reads no clock, generates no random id and
 * pins its font to a file in this repository, so the same `GrcPdfInput` always produces the same
 * bytes — and therefore the same SHA-256 that `grc_documents` stores. Regenerating a card from its
 * stored row reproduces the archived PDF exactly, which is what makes the recorded hash a real
 * check rather than decoration.
 *
 * Two rules protect that property; break either and the reproducibility test fails:
 *   1. never call `new Date()`, `Date.now()`, `randomUUID()` or anything else time- or
 *      machine-dependent in this file — every timestamp arrives through `GrcPdfInput`
 *   2. the PDF info dates come from `generatedAt`, not from the clock
 */

/** Bundled with the API (`dist/stays/assets`, see `assets/README.md`). One Noto family covers Latin, ₹ and shaped Devanagari. */
const FONT_PATH = join(__dirname, 'assets', 'NotoSansDevanagari-VF.ttf');
export const GRC_FONT_PATH = FONT_PATH;

/** pdfkit can embed PNG and JPEG only — a WebP signature must be re-captured. */
export const SIGNATURE_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const;

export type SignatureMethod = 'touchscreen' | 'phone' | 'paper_scan';

export const SIGNATURE_METHOD_LABELS: Record<SignatureMethod, string> = {
  touchscreen: 'Signed on the reception touchscreen',
  phone: 'Signed on a phone through the scanner session',
  paper_scan: 'Signed on paper and scanned back in',
};

export interface GrcOccupant {
  fullName: string;
  isChild: boolean;
  age: number | null;
  relation: string | null;
  nationality: string;
  idType: IdType;
  /** Last 4 characters only — a full ID number never reaches this document (spec §58.3). */
  idLast4: string | null;
}

export interface GrcPdfInput {
  number: string;
  version: number;
  property: {
    name: string;
    legalName: string;
    addressLines: string[];
    gstin: string | null;
    phone: string;
    email: string | null;
    checkOutTime: string;
    timezone: string;
  };
  stay: {
    reservationNumber: string;
    roomNumber: string;
    roomTypeName: string;
    mealPlan: MealPlanCode;
    nightlyRate: string;
    arrival: string;
    departure: string;
    nights: number;
    checkedInAt: Date;
  };
  guest: { name: string; mobile: string; addressLines: string[] };
  occupants: GrcOccupant[];
  vehicles: { registration: string; vehicleType: string; parkingSlot: string | null }[];
  consents: { stayAndCompliance: boolean; marketing: boolean };
  houseRules: { en: string[]; hi: string[] };
  notice: { version: string; en: string; hi: string };
  signature: { image: Buffer; contentType: string; method: SignatureMethod; signedAt: Date; signedBy: string };
  generatedAt: Date;
  generatedBy: string;
}

const PAGE = { size: 'A4' as const, margin: 36 };
const WIDTH = 595.28 - PAGE.margin * 2;
const PAGE_BOTTOM = 841.89 - PAGE.margin;
/** Signature box plus its heading and the footer line. */
const CLOSING_HEIGHT = 128;
const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';

type Doc = PDFKit.PDFDocument;

/** The single font has one weight; emphasis is a hairline stroke in the same colour. */
function strong(doc: Doc, text: string, size: number, opts: PDFKit.Mixins.TextOptions = {}, at?: { x: number; y: number }): void {
  doc.fontSize(size).lineWidth(size / 28).strokeColor(INK).fillColor(INK);
  const options = { ...opts, fill: true, stroke: true };
  if (at) doc.text(text, at.x, at.y, options);
  else doc.text(text, options);
}

function rule(doc: Doc, gap = 6): void {
  doc.moveDown(gap / doc.currentLineHeight());
  const y = doc.y;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + WIDTH, y).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.y = y + gap;
}

function sectionTitle(doc: Doc, title: string): void {
  doc.moveDown(0.6);
  doc.fontSize(7.5).fillColor(MUTED).text(title.toUpperCase(), { characterSpacing: 1.2 });
  doc.moveDown(0.25);
}

/**
 * Two columns of label/value pairs. Row height is measured rather than assumed, so a long address
 * or a wrapped date pushes the next row down instead of printing on top of it.
 */
function facts(doc: Doc, pairs: [string, string][]): void {
  const colWidth = WIDTH / 2;
  const labelWidth = 84;
  const valueWidth = colWidth - labelWidth - 12;
  const startY = doc.y;
  const perColumn = Math.ceil(pairs.length / 2);
  let bottom = startY;

  for (const [column, columnPairs] of [pairs.slice(0, perColumn), pairs.slice(perColumn)].entries()) {
    const x = PAGE.margin + column * colWidth;
    let y = startY;
    for (const [label, value] of columnPairs) {
      const shown = value || '—';
      doc.fontSize(7.5).fillColor(MUTED).text(label, x, y, { width: labelWidth });
      doc.fontSize(9).fillColor(INK).text(shown, x + labelWidth + 8, y - 1, { width: valueWidth });
      y += Math.max(14, doc.fontSize(9).heightOfString(shown, { width: valueWidth }) + 3);
    }
    bottom = Math.max(bottom, y);
  }
  doc.y = bottom;
  doc.x = PAGE.margin;
}

const OCCUPANT_COLUMNS: { head: string; width: number }[] = [
  { head: '#', width: 18 },
  { head: 'Name', width: 150 },
  { head: 'Adult / child', width: 70 },
  { head: 'Relation', width: 75 },
  { head: 'Nationality', width: 60 },
  { head: 'ID type', width: 85 },
  { head: 'ID last 4', width: 65 },
];

function occupantTable(doc: Doc, occupants: GrcOccupant[]): void {
  const x0 = PAGE.margin;
  let y = doc.y;
  doc.fontSize(7.5).fillColor(MUTED);
  OCCUPANT_COLUMNS.reduce((x, c) => {
    doc.text(c.head.toUpperCase(), x, y, { width: c.width, characterSpacing: 0.6 });
    return x + c.width;
  }, x0);
  y += 12;

  occupants.forEach((o, i) => {
    if (y > 700) { doc.addPage(); y = PAGE.margin; }
    const cells = [
      String(i + 1),
      o.fullName,
      o.isChild ? `Child${o.age === null ? '' : ` · ${o.age}y`}` : 'Adult',
      o.relation ?? '—',
      o.nationality,
      ID_TYPE_LABELS[o.idType],
      o.idLast4 ? `•••• ${o.idLast4}` : '—',
    ];
    doc.fontSize(8.5).fillColor(INK);
    OCCUPANT_COLUMNS.reduce((x, c, j) => {
      doc.text(cells[j] ?? '', x, y, { width: c.width - 6, ellipsis: true, lineBreak: false });
      return x + c.width;
    }, x0);
    y += 13;
    doc.moveTo(x0, y - 3).lineTo(x0 + WIDTH, y - 3).lineWidth(0.25).strokeColor(RULE).stroke();
  });
  doc.y = y;
  doc.x = x0;
}

function bilingualBlock(doc: Doc, en: string[], hi: string[]): void {
  doc.fontSize(8).fillColor(INK);
  for (const line of en) doc.text(line, { width: WIDTH, lineGap: 1 });
  if (hi.length) {
    doc.moveDown(0.3);
    doc.fillColor(MUTED);
    for (const line of hi) doc.text(line, { width: WIDTH, lineGap: 1.5 });
  }
}

function signatureBlock(doc: Doc, input: GrcPdfInput): void {
  const { signature, property } = input;
  if (doc.y + CLOSING_HEIGHT > PAGE_BOTTOM) doc.addPage();
  sectionTitle(doc, 'Guest signature');
  const top = doc.y;
  const boxWidth = 250;
  const boxHeight = 70;
  doc.rect(PAGE.margin, top, boxWidth, boxHeight).lineWidth(0.5).strokeColor(RULE).stroke();
  // fit keeps the aspect ratio; a signature is never stretched.
  doc.image(signature.image, PAGE.margin + 6, top + 6, { fit: [boxWidth - 12, boxHeight - 12], align: 'center', valign: 'center' });

  const x = PAGE.margin + boxWidth + 18;
  doc.fontSize(9).fillColor(INK).text(signature.signedBy, x, top + 6, { width: WIDTH - boxWidth - 18 });
  doc.fontSize(8).fillColor(MUTED)
    .text(SIGNATURE_METHOD_LABELS[signature.method], x, doc.y + 1, { width: WIDTH - boxWidth - 18 })
    .text(`Signed ${formatDateTime(signature.signedAt, property.timezone)}`, x, doc.y + 1)
    .text(`Checkout time ${property.checkOutTime.slice(0, 5)}`, x, doc.y + 1);
  doc.y = top + boxHeight + 6;
  doc.x = PAGE.margin;
}

function footer(doc: Doc, input: GrcPdfInput): void {
  rule(doc, 8);
  doc.fontSize(7.5).fillColor(MUTED).text(
    `${input.number} · version ${input.version} · prepared by ${input.generatedBy} on `
    + `${formatDateTime(input.generatedAt, input.property.timezone)} · privacy notice ${input.notice.version} · computer generated document`,
    { width: WIDTH },
  );
}

/** Renders the card. Deterministic: same input in, same bytes out. */
export function renderGrcPdf(input: GrcPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!(SIGNATURE_CONTENT_TYPES as readonly string[]).includes(input.signature.contentType)) {
      reject(new Error(`Signature image must be PNG or JPEG, got ${input.signature.contentType}`));
      return;
    }
    const doc = new PDFDocument({
      ...PAGE,
      autoFirstPage: true,
      info: {
        Title: `Guest registration card ${input.number}`,
        Author: input.property.legalName,
        Subject: `Stay ${input.stay.arrival} to ${input.stay.departure}, room ${input.stay.roomNumber}`,
        Creator: 'ResortOS',
        // Taken from the stored row, never from the clock — see the note at the top of this file.
        CreationDate: input.generatedAt,
        ModDate: input.generatedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('body', FONT_PATH);
    doc.font('body');

    const { property, stay, guest } = input;

    // --- header -------------------------------------------------------------
    const headerTop = doc.y;
    strong(doc, property.name, 15, { width: WIDTH - 170 });
    doc.fontSize(8).fillColor(MUTED)
      .text(property.legalName, { width: WIDTH - 170 })
      .text(property.addressLines.join(', '), { width: WIDTH - 170 })
      .text([property.gstin ? `GSTIN ${property.gstin}` : null, property.phone, property.email].filter(Boolean).join(' · '), { width: WIDTH - 170 });

    const leftBottom = doc.y;
    const rightX = PAGE.margin + WIDTH - 165;
    strong(doc, 'GUEST REGISTRATION CARD', 9, { width: 165, align: 'right' }, { x: rightX, y: headerTop + 2 });
    doc.fontSize(8).fillColor(MUTED)
      .text('अतिथि पंजीकरण पत्र', rightX, doc.y + 2, { width: 165, align: 'right' })
      .text(`${input.number} · version ${input.version}`, rightX, doc.y + 1, { width: 165, align: 'right' });
    doc.y = Math.max(leftBottom, doc.y);
    doc.x = PAGE.margin;
    rule(doc, 10);

    // --- stay ---------------------------------------------------------------
    sectionTitle(doc, 'Stay');
    facts(doc, [
      ['Booking', stay.reservationNumber],
      ['Primary guest', guest.name],
      ['Mobile', guest.mobile],
      ['Address', guest.addressLines.join(', ')],
      ['Room', `${stay.roomNumber} · ${stay.roomTypeName}`],
      ['Meal plan', MEAL_PLAN_LABELS[stay.mealPlan]],
      ['Arrival', `${formatDate(stay.arrival)} · in at ${formatTime(stay.checkedInAt, property.timezone)}`],
      ['Departure', `${formatDate(stay.departure)} · by ${property.checkOutTime.slice(0, 5)}`],
      ['Nights', String(stay.nights)],
      ['Room rate', `${formatINR(stay.nightlyRate)} per night`],
    ]);

    // --- occupants ----------------------------------------------------------
    sectionTitle(doc, `Occupants (${input.occupants.length})`);
    occupantTable(doc, input.occupants);

    if (input.vehicles.length) {
      sectionTitle(doc, 'Vehicles');
      doc.fontSize(8.5).fillColor(INK).text(
        input.vehicles.map((v) => `${v.registration} (${v.vehicleType}${v.parkingSlot ? `, slot ${v.parkingSlot}` : ''})`).join(' · '),
        { width: WIDTH },
      );
    }

    // --- house rules --------------------------------------------------------
    sectionTitle(doc, 'House rules');
    bilingualBlock(doc, input.houseRules.en, input.houseRules.hi);

    // --- privacy notice and consent ----------------------------------------
    sectionTitle(doc, 'Privacy notice and consent');
    bilingualBlock(doc, [input.notice.en], [input.notice.hi]);
    doc.moveDown(0.4);
    doc.fontSize(8.5).fillColor(INK)
      .text(`Stay and legal compliance: ${input.consents.stayAndCompliance ? 'Accepted' : 'Not accepted'}`, { width: WIDTH })
      .text(`Marketing messages: ${input.consents.marketing ? 'Accepted' : 'Not accepted'}`, { width: WIDTH });

    // --- signature and footer ----------------------------------------------
    signatureBlock(doc, input);
    footer(doc, input);

    doc.end();
  });
}
