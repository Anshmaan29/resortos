import { Controller, Get, HttpCode, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import type { AppRequest } from '../common/request-context';
import { StorageService } from './storage.service';

/**
 * Signed-URL endpoints. Authorisation is the HMAC signature itself (issued only after
 * session or capture-session checks), so these routes do not need a login cookie.
 */
@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Put('upload')
  @HttpCode(201)
  upload(@Query() query: Record<string, unknown>, @Req() req: AppRequest) {
    return this.storage.receiveUpload(query, req.header('content-type'), req);
  }

  @Public()
  @Get('object')
  view(@Query() query: Record<string, unknown>, @Res() res: Response) {
    const { stream, contentType } = this.storage.openForView(query);
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('content-disposition', 'inline');
    stream.on('error', () => res.status(404).end());
    stream.pipe(res);
  }
}
