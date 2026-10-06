import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@resortos/shared';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuditService } from '../common/audit.service';
import { AppError } from '../common/errors';
import { DbService } from '../db/db.service';
import { ExportsService, type ExportKind } from '../exports/exports.service';
import { GoogleSheetsClient, SheetsError, type MirrorSheet } from './google-client';

const KINDS: ExportKind[] = ['bookings', 'guests', 'payments', 'invoices', 'expenses', 'daily-summaries'];
@Injectable()
export class SheetsService {
  constructor(private readonly db: DbService, private readonly exports: ExportsService,
    private readonly audit: AuditService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async status(propertyId: string) {
    const configured = !!(this.config.GOOGLE_SHEETS_ID && this.config.GOOGLE_SERVICE_ACCOUNT_JSON);
    const { rows } = await this.db.query<{ occurred_at: Date; after_values: { ok: boolean; message?: string } }>(
      `SELECT occurred_at, after_values FROM audit_logs WHERE property_id=$1 AND action='sheets.synced' ORDER BY chain_position DESC LIMIT 1`, [propertyId]);
    let email: string | null = null;
    try { if (configured) email = new GoogleSheetsClient(this.config.GOOGLE_SERVICE_ACCOUNT_JSON!).email; } catch { /* sync reports invalid credentials */ }
    return { configured, serviceAccountEmail: email, lastAttemptAt: rows[0]?.occurred_at ?? null,
      lastAttemptOk: rows[0]?.after_values.ok ?? null, message: rows[0]?.after_values.message ?? null,
      url: configured ? `https://docs.google.com/spreadsheets/d/${this.config.GOOGLE_SHEETS_ID}/edit` : null };
  }

  async scheduled() {
    if (!this.config.GOOGLE_SHEETS_ID || !this.config.GOOGLE_SERVICE_ACCOUNT_JSON) return;
    const { rows } = await this.db.query<{ id: string }>(`SELECT id FROM properties ORDER BY id LIMIT 2`);
    // A single configured spreadsheet must never mix properties.
    if (rows.length !== 1) return;
    await this.sync(rows[0]!.id);
  }

  async sync(propertyId: string) {
    if (!this.config.GOOGLE_SHEETS_ID || !this.config.GOOGLE_SERVICE_ACCOUNT_JSON)
      throw new AppError(ERROR_CODES.VALIDATION, 'Google Sheets is not connected yet. Create the hotel sheet, then complete the Railway setup.');
    const { rows: properties } = await this.db.query<{ id: string }>(`SELECT id FROM properties ORDER BY id LIMIT 2`);
    if (properties.length !== 1 || properties[0]!.id !== propertyId)
      throw new AppError(ERROR_CODES.VALIDATION, 'This Sheets connection supports one hotel per deployment.');
    // Keep a session lock across network calls so a manual sync and a worker cannot overwrite
    // each other with an older snapshot. Release on every path, including timeouts.
    const client = await this.db.pool.connect();
    let locked = false;
    try {
      const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(76422891) AS locked`);
      locked = lock.rows[0]!.locked;
      if (!locked) throw new AppError(ERROR_CODES.SERVICE_BUSY, 'A Sheets sync is already running. Try again shortly.');
      try {
        const sheets: MirrorSheet[] = [];
        for (const kind of KINDS) {
          const data = await this.exports.sheetRows(kind, propertyId, '0001-01-01', '9999-12-31');
          sheets.push({ name: `ResortOS ${data.title}`, columns: data.columns, rows: data.rows });
        }
        await new GoogleSheetsClient(this.config.GOOGLE_SERVICE_ACCOUNT_JSON!).replace(this.config.GOOGLE_SHEETS_ID!, sheets);
        await this.db.tx({}, (q) => this.audit.recordSystem(q, propertyId, { action: 'sheets.synced', entityType: 'property', entityId: propertyId, after: { ok: true, rows: sheets.reduce((n, s) => n + s.rows.length, 0) } }));
        return { ok: true };
      } catch (err) {
        const message = err instanceof SheetsError ? err.message : 'Sheets sync did not finish. Check the connection; Railway records are safe. The next sync will retry.';
        await this.db.tx({}, (q) => this.audit.recordSystem(q, propertyId, { action: 'sheets.synced', entityType: 'property', entityId: propertyId, after: { ok: false, message } }));
        throw new AppError(ERROR_CODES.SERVICE_BUSY, message);
      }
    } finally {
      try { if (locked) await client.query(`SELECT pg_advisory_unlock(76422891)`); }
      finally { client.release(); }
    }
  }
}
