import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { zId } from '@resortos/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentActor } from '../common/decorators';
import type { Actor } from '../common/request-context';
import { parse } from '../common/zod';
import { PrintingService } from './printing.service';

const paperSchema = z.object({ paper: z.enum(['a4', 'thermal_80']).optional() });

/**
 * Printable PDFs (spec §36), opened by the browser in a new tab. Rendered on request from the stored
 * rows; nothing here writes. Never cached: an invoice's PDF must not outlive the session that asked.
 */
@Controller()
export class PrintingController {
  constructor(private readonly printing: PrintingService) {}

  private send(res: Response, file: { pdf: Buffer; filename: string }) {
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${file.filename}"`,
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(file.pdf);
  }

  @Get('invoices/:id/pdf')
  async invoice(@CurrentActor() actor: Actor, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.printing.invoicePdf(actor, parse(zId, id)));
  }

  @Get('payments/:id/receipt.pdf')
  async receipt(@CurrentActor() actor: Actor, @Param('id') id: string, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.printing.receiptPdf(actor, parse(zId, id), parse(paperSchema, query).paper));
  }

  @Get('shifts/:id/report.pdf')
  async shift(@CurrentActor() actor: Actor, @Param('id') id: string, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.printing.shiftReportPdf(actor, parse(zId, id), parse(paperSchema, query).paper));
  }
}
