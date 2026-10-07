import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GoogleSheetsClient, mirrorRequests } from './google-client';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = JSON.stringify({ client_email: 'mirror@example.iam.gserviceaccount.com', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const sheet = { name: 'ResortOS Bookings', columns: ['Guest', 'Amount'], rows: [['=IMPORTXML("bad")', { number: '0123.40' }]] };

describe('Google Sheets mirror', () => {
  it('writes exact literal values, clears stale rows and leaves unrelated tabs alone', () => {
    const requests = mirrorRequests([sheet], [{ sheetId: 4, title: 'ResortOS Bookings', gridProperties: { rowCount: 1000, columnCount: 26 } }, { sheetId: 9, title: 'Owner notes' }]);
    expect(requests).toEqual([{ updateCells: { range: { sheetId: 4, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 26 }, fields: 'userEnteredValue', rows: [
      { values: [{ userEnteredValue: { stringValue: 'Guest' } }, { userEnteredValue: { stringValue: 'Amount' } }] },
      { values: [{ userEnteredValue: { stringValue: '=IMPORTXML("bad")' } }, { userEnteredValue: { stringValue: '0123.40' } }] },
    ] } }]);
  });
  it('creates missing tabs and grows grids instead of silently dropping records', () => {
    const large = { ...sheet, rows: Array.from({ length: 1100 }, () => ['Guest']) };
    const requests = mirrorRequests([large], []) as any[];
    expect(requests[0].addSheet.properties.gridProperties.rowCount).toBe(1101);
    expect(() => mirrorRequests([{ ...large, rows: Array.from({ length: 25_000 }, () => []) }], [])).toThrow('row limit');
    expect(() => mirrorRequests([{ ...sheet, name: 'Owner notes' }], [])).toThrow('Invalid mirror tab');
  });
  it('authenticates with a signed server JWT and commits the mirror in one batch', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: 'private-access-token' }))
      .mockResolvedValueOnce(Response.json({ sheets: [] }))
      .mockResolvedValueOnce(Response.json({}));
    await new GoogleSheetsClient(credentials, request).replace('sheet-id', [sheet]);
    const body = new URLSearchParams(request.mock.calls[0]![1]!.body as string);
    const jwt = body.get('assertion')!.split('.');
    expect(verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), keys.publicKey, Buffer.from(jwt[2]!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString()).scope).toBe('https://www.googleapis.com/auth/spreadsheets');
    expect(request.mock.calls[2]![0]).toContain(':batchUpdate');
    expect(JSON.parse(request.mock.calls[2]![1]!.body as string).requests).toHaveLength(2);
  });
  it('redacts provider errors and gives a useful permission message', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'secret' })).mockResolvedValueOnce(Response.json({ error: 'PRIVATE GUEST DATA' }, { status: 403 }));
    await expect(new GoogleSheetsClient(credentials, request).replace('sheet-id', [sheet])).rejects.toThrow('Share the sheet');
    expect(() => new GoogleSheetsClient('secret-invalid-json')).toThrow('credentials need attention');
  });
});
