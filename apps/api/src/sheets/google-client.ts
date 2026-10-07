import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';

const accountSchema = z.object({ client_email: z.string().email(), private_key: z.string().min(100) });
export class SheetsError extends Error {}
export interface MirrorSheet { name: string; columns: string[]; rows: unknown[][] }

/** Only our reserved tabs are replaced. Other tabs, formatting, and formulas are untouched. */
export function mirrorRequests(sheets: MirrorSheet[], existing: { sheetId: number; title: string; gridProperties?: { rowCount: number; columnCount: number } }[]) {
  const requests: unknown[] = [];
  let nextId = Math.max(0, ...existing.map((s) => s.sheetId)) + 1;
  for (const sheet of sheets) {
    if (!sheet.name.startsWith('ResortOS ')) throw new SheetsError('Invalid mirror tab');
    const values = [sheet.columns, ...sheet.rows];
    if (values.length > 25_000) throw new SheetsError('The Sheets mirror has reached its row limit. Download all records from ResortOS.');
    const found = existing.find((s) => s.title === sheet.name);
    const sheetId = found?.sheetId ?? nextId++;
    const rowCount = Math.max(found?.gridProperties?.rowCount ?? 1000, values.length);
    const columnCount = Math.max(found?.gridProperties?.columnCount ?? 26, sheet.columns.length);
    if (!found) requests.push({ addSheet: { properties: { sheetId, title: sheet.name, gridProperties: { rowCount, columnCount } } } });
    else if (rowCount !== found.gridProperties?.rowCount || columnCount !== found.gridProperties?.columnCount)
      requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount, columnCount } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } });
    requests.push({ updateCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount },
      // Explicit strings preserve exact money, dates, mobile numbers and leading zeros. A guest
      // name beginning with '=' is data, never a Google Sheets formula.
      rows: values.map((row) => ({ values: row.map((v) => ({ userEnteredValue: { stringValue: v === null || v === undefined ? '' : String(typeof v === 'object' && 'number' in v ? (v as { number: unknown }).number : v) } })) })),
      fields: 'userEnteredValue',
    } });
  }
  return requests;
}

export class GoogleSheetsClient {
  readonly email: string;
  private readonly key: ReturnType<typeof createPrivateKey>;
  constructor(json: string, private readonly request: typeof fetch = fetch) {
    try {
      const account = accountSchema.parse(JSON.parse(json));
      this.email = account.client_email;
      this.key = createPrivateKey(account.private_key);
    } catch { throw new SheetsError('Google Sheets credentials need attention in Railway.'); }
  }

  private async call(url: string, init: RequestInit) {
    const res = await this.request(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      // Never echo Google's response: it can contain credentials or guest values.
      if (res.status === 403 || res.status === 404) throw new SheetsError('Share the sheet with the service account as Editor and enable the Google Sheets API.');
      if (res.status === 429 || res.status >= 500) throw new SheetsError('Google Sheets is temporarily busy. The next sync will retry.');
      throw new SheetsError('Google Sheets could not connect. Check the credentials and sheet ID in Railway.');
    }
    return res.json();
  }

  async replace(spreadsheetId: string, sheets: MirrorSheet[]) {
    const now = Math.floor(Date.now() / 1000);
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: this.email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), this.key).toString('base64url')}`;
    const token = await this.call('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() }) as { access_token?: string };
    if (typeof token.access_token !== 'string') throw new SheetsError('Google Sheets authentication failed.');
    const headers = { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' };
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
    const metadata = await this.call(`${base}?fields=sheets.properties`, { headers }) as { sheets?: { properties: Parameters<typeof mirrorRequests>[1][number] }[] };
    const requests = mirrorRequests(sheets, (metadata.sheets ?? []).map((s: { properties: Parameters<typeof mirrorRequests>[1][number] }) => s.properties));
    await this.call(`${base}:batchUpdate`, { method: 'POST', headers, body: JSON.stringify({ requests }) });
  }
}
