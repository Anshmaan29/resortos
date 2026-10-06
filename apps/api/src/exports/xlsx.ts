import { deflateRawSync } from 'node:zlib';

/**
 * A very small .xlsx writer.
 *
 * An Excel workbook is a ZIP of XML parts, and everything the owner's exports need — a header row,
 * text, numbers, dates as text, several sheets — is a few hundred bytes of XML each. That is worth
 * writing here rather than taking a spreadsheet dependency: this file has no supply chain, produces
 * the same bytes for the same rows (there is no timestamp anywhere in it), and cannot be told to
 * evaluate a formula. Numbers are written as numbers so the accountant can sum a column; everything
 * else is an inline string, so nothing the guest typed is ever interpreted as a formula (§46).
 */

export interface Sheet {
  name: string;
  columns: string[];
  /** A cell is text unless it is `{ number }`. Nulls are written as an empty cell. */
  rows: (string | number | null | { number: string | number })[][];
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!))
  // Excel refuses control characters; keep tab, newline and carriage return.
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** Excel sheet names: at most 31 characters and none of \ / ? * [ ] : */
const sheetName = (name: string, index: number) => (name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${index + 1}`);

const columnLetter = (index: number): string => {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
};

const isNumberCell = (v: unknown): v is { number: string | number } => typeof v === 'object' && v !== null && 'number' in v;

function sheetXml(sheet: Sheet): string {
  const cells = (values: Sheet['rows'][number], rowIndex: number, style: string) =>
    values.map((value, i) => {
      const ref = `${columnLetter(i)}${rowIndex}`;
      if (value === null || value === undefined || value === '') return `<c r="${ref}"${style}/>`;
      if (isNumberCell(value)) {
        const n = typeof value.number === 'string' ? Number(value.number) : value.number;
        if (!Number.isFinite(n)) return `<c r="${ref}"${style} t="inlineStr"><is><t>${xml(String(value.number))}</t></is></c>`;
        return `<c r="${ref}"${style}><v>${n}</v></c>`;
      }
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`;
    }).join('');

  const header = `<row r="1">${cells(sheet.columns, 1, ' s="1"')}</row>`;
  const body = sheet.rows.map((row, i) => `<row r="${i + 2}">${cells(row, i + 2, '')}</row>`).join('');
  const widths = sheet.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(46, Math.max(10, c.length + 4))}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${header}${body}</sheetData></worksheet>`;
}

const CONTENT_TYPES = (count: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
  Array.from({ length: count }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
}</Types>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs></styleSheet>`;

// ---------------------------------------------------------------------------
// The ZIP container
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zips the parts with no timestamps, so the same rows always produce the same file (spec §36). */
function zip(files: { path: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const data = Buffer.from(file.content, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1 January 1980, the zero of the ZIP epoch
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0, 42); // offset of the local header
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);

    offset += local.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** One workbook, one sheet per dataset. */
export function workbook(sheets: Sheet[]): Buffer {
  const named = sheets.map((s, i) => ({ ...s, name: sheetName(s.name, i) }));
  const files = [
    { path: '[Content_Types].xml', content: CONTENT_TYPES(named.length) },
    {
      path: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      path: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
        named.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      }</sheets></workbook>`,
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
        named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      }<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { path: 'xl/styles.xml', content: STYLES },
    ...named.map((s, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s) })),
  ];
  return zip(files);
}

/**
 * CSV for the same data.
 *
 * A leading =, +, - or @ is prefixed with an apostrophe: a spreadsheet would otherwise treat a
 * guest's name or note as a formula, which is how CSV exports become an attack on the accountant.
 */
export function csv(sheet: Sheet): string {
  const cell = (value: (typeof sheet.rows)[number][number]): string => {
    if (value === null || value === undefined) return '';
    const text = isNumberCell(value) ? String(value.number) : String(value);
    const safe = /^[=+\-@\t\r]/.test(text) && !isNumberCell(value) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [sheet.columns.map((c) => cell(c)).join(','), ...sheet.rows.map((r) => r.map(cell).join(','))].join('\r\n');
}
