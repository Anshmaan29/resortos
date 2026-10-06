import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { ERROR_CODES, zIsoDate } from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, Roles } from '../common/decorators';
import type { Actor } from '../common/request-context';
import { AppError } from '../common/errors';
import { AuditService } from '../common/audit.service';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { ExportsService, EXPORT_KINDS, type ExportKind } from './exports.service';

const querySchema = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
});

/**
 * The owner's downloads (spec §43, §46): /exports/bookings.xlsx, /exports/police-register.pdf,
 * /exports/gstr-1.csv, /exports/tally.xml — every one audit-logged with the report, the filters and
 * the row count. Owner-only; the receptionist's exports are the operational ones (a printed invoice,
 * a receipt), not the owner's records.
 */
@Controller()
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('exports/gstr-1.csv')
  @Roles('owner')
  async gstr1(@CurrentActor() actor: Actor, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const { from, to } = this.range(query);
    const { csv, rows } = await this.exports.gstr1(actor, from, to);
    await this.log(actor, 'gstr-1', 'csv', from, to, rows);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="gstr-1-${from}-to-${to}.csv"`,
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }

  @Get('exports/tally.xml')
  @Roles('owner')
  async tally(@CurrentActor() actor: Actor, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const { from, to } = this.range(query);
    const { xml, count } = await this.exports.tallyXml(actor, from, to);
    await this.log(actor, 'tally', 'xml', from, to, count);
    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="tally-vouchers-${from}-to-${to}.xml"`,
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(Buffer.from(xml, 'utf8'));
  }

  @Get('exports/:file')
  @Roles('owner')
  async file(@CurrentActor() actor: Actor, @Param('file') file: string, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const dot = file.lastIndexOf('.');
    const kind = dot === -1 ? file : file.slice(0, dot);
    const ext = dot === -1 ? 'xlsx' : file.slice(dot + 1);
    if (dot <= 0 || !(EXPORT_KINDS as readonly string[]).includes(kind) || !['xlsx', 'csv', 'pdf'].includes(ext)) {
      throw new AppError(ERROR_CODES.VALIDATION, `Unknown export "${file}". Available: ${EXPORT_KINDS.join(', ')} as xlsx or csv (police register also pdf), gstr-1.csv, tally.xml.`);
    }
    const { from, to } = this.range(query);
    const out = await this.exports.download(actor, kind as ExportKind, ext as 'xlsx' | 'csv' | 'pdf', from, to);
    await this.log(actor, kind, ext, from, to, out.rows);
    res.set({
      'Content-Type': out.contentType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(out.body);
  }

  /** §46: every export logs who, when (audit row), which report, the filters and the row count. */
  private log(actor: Actor, report: string, format: string, from: string, to: string, rows: number) {
    return this.db.tx({ userId: actor.user.id }, (q) => this.audit.record(q, actor, {
      action: 'export.downloaded', entityType: 'property', entityId: actor.user.propertyId,
      after: { report, format, from, to, rows },
    }));
  }

  /** Every export is a range; with none picked, the financial year so far. */
  private range(query: unknown): { from: string; to: string } {
    const { from, to } = parse(querySchema, query);
    const today = new Date();
    const fyStart = today.getMonth() >= 3 ? `${today.getFullYear()}-04-01` : `${today.getFullYear() - 1}-04-01`;
    return { from: from ?? fyStart, to: to ?? today.toISOString().slice(0, 10) };
  }
}
