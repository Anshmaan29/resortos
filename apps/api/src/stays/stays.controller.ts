import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Sse } from '@nestjs/common';
import {
  checkoutSchema, createCheckInDraftSchema, documentUploadRequestSchema, regenerateGrcSchema, roomShiftSchema,
  stayListQuerySchema, updateCheckInDraftSchema, zId, zIsoDate,
} from '@resortos/shared';
import { z } from 'zod';
import { CurrentActor, IdempotencyKey, Public } from '../common/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { DbService, type Queryable } from '../db/db.service';
import { CaptureService } from './capture.service';
import { CheckInService } from './check-in.service';
import { GrcService } from './grc.service';
import { StaysService } from './stays.service';

const zToken = z.string().regex(/^[A-Za-z0-9_-]{40,60}$/);

@Controller()
export class StaysController {
  constructor(
    private readonly checkIn: CheckInService,
    private readonly capture: CaptureService,
    private readonly grc: GrcService,
    private readonly stays: StaysService,
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private mutate<T>(actor: Actor, req: AppRequest, key: string | undefined, body: unknown, fn: (q: Queryable) => Promise<T>) {
    return this.db
      .tx({ userId: actor.user.id }, (q) => this.idempotency.run(q, actor, key, { method: req.method, path: req.path, body }, () => fn(q)))
      .then((r) => r.body);
  }

  // ---------------- check-in drafts ----------------

  @Post('check-in-drafts')
  @HttpCode(200)
  start(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(createCheckInDraftSchema, body);
    return this.checkIn.start(actor, input.reservationId, input.reservationRoomIds);
  }

  @Get('check-in-drafts/:id')
  getDraft(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.checkIn.get(actor, parse(zId, id));
  }

  @Patch('check-in-drafts/:id')
  saveDraft(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.checkIn.save(actor, parse(zId, id), parse(updateCheckInDraftSchema, body));
  }

  @Post('check-in-drafts/:id/abandon')
  @HttpCode(200)
  abandon(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.checkIn.abandon(actor, parse(zId, id));
  }

  @Post('check-in-drafts/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string) {
    const draftId = parse(zId, id);
    return this.mutate(actor, req, key, {}, (q) => this.checkIn.confirm(q, actor, draftId));
  }

  // ---------------- documents from the desk ----------------

  @Post('check-in-drafts/:id/documents')
  deskUpload(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const { source, ...rest } = parse(z.object({ source: z.enum(['desk_camera', 'file_upload', 'signature_pad']) }).passthrough(), body);
    return this.capture.deskUploadRequest(actor, parse(zId, id), parse(documentUploadRequestSchema, rest), source);
  }

  @Post('check-in-drafts/:draftId/documents/:id/confirm')
  @HttpCode(200)
  deskConfirm(@CurrentActor() actor: Actor, @Param('draftId') draftId: string, @Param('id') id: string) {
    return this.capture.verifyDocument(actor.user.propertyId, parse(zId, id), { draftId: parse(zId, draftId) });
  }

  @Post('check-in-drafts/:draftId/documents/:id/grant')
  @HttpCode(200)
  deskGrant(@CurrentActor() actor: Actor, @Param('draftId') draftId: string, @Param('id') id: string) {
    return this.capture.deskRefreshGrant(actor, parse(zId, draftId), parse(zId, id));
  }

  @Get('documents/:id/view-url')
  viewUrl(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.capture.viewUrl(actor, parse(zId, id));
  }

  // ---------------- phone scanner: desk side ----------------

  @Post('check-in-drafts/:id/capture-sessions')
  createCapture(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.capture.createSession(actor, parse(zId, id));
  }

  @Get('capture-sessions/:id')
  captureStatus(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.capture.sessionStatus(actor, parse(zId, id));
  }

  /** Live updates for the desk while the QR session is open; the browser falls back to polling. */
  @Sse('capture-sessions/:id/events')
  captureEvents(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.capture.sessionEvents(actor, parse(zId, id));
  }

  @Post('capture-sessions/:id/close')
  @HttpCode(200)
  closeCapture(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.capture.closeSession(actor, parse(zId, id));
  }

  // ---------------- phone scanner: phone side (token + device secret, no login) ----------------

  @Public()
  @Post('capture/:token/claim')
  @HttpCode(200)
  claim(@Param('token') token: string, @Req() req: AppRequest) {
    return this.capture.claim(parse(zToken, token), req.header('user-agent') ?? null);
  }

  @Public()
  @Post('capture/:token/uploads')
  phoneUpload(@Param('token') token: string, @Headers('x-capture-device') device: string | undefined, @Body() body: unknown, @Req() req: AppRequest) {
    return this.capture.phoneUploadRequest(parse(zToken, token), device, parse(documentUploadRequestSchema, body), req.header('user-agent') ?? null);
  }

  @Public()
  @Post('capture/:token/status')
  @HttpCode(200)
  phoneStatus(@Param('token') token: string, @Headers('x-capture-device') device: string | undefined) {
    return this.capture.phoneStatus(parse(zToken, token), device);
  }

  @Public()
  @Post('capture/:token/uploads/:id/grant')
  @HttpCode(200)
  phoneGrant(@Param('token') token: string, @Param('id') id: string, @Headers('x-capture-device') device: string | undefined) {
    return this.capture.phoneRefreshGrant(parse(zToken, token), device, parse(zId, id));
  }

  @Public()
  @Post('capture/:token/uploads/:id/confirm')
  @HttpCode(200)
  phoneConfirm(@Param('token') token: string, @Param('id') id: string, @Headers('x-capture-device') device: string | undefined) {
    return this.capture.phoneConfirm(parse(zToken, token), device, parse(zId, id));
  }

  // ---------------- stays ----------------

  /** The in-house list ("Check In List"), with date-range and status filters. */
  @Get('stays')
  list(@CurrentActor() actor: Actor, @Query() query: Record<string, string>) {
    return this.stays.list(actor.user.propertyId, parse(stayListQuerySchema, query));
  }

  /** Room changes across the property ("Room Shift Log"). */
  @Get('room-shifts')
  roomShifts(@CurrentActor() actor: Actor, @Query() query: Record<string, string>) {
    const range = parse(z.object({ from: zIsoDate.optional(), to: zIsoDate.optional() }), query);
    return this.stays.roomShiftLog(actor.user.propertyId, range);
  }

  @Get('stays/:id')
  stay(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.stays.detail(this.db, actor.user.propertyId, parse(zId, id));
  }

  @Post('stays/:id/shift-room')
  @HttpCode(200)
  shift(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const stayId = parse(zId, id);
    const input = parse(roomShiftSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.stays.shiftRoom(q, actor, stayId, input));
  }

  // ---------------- registration card (spec §20) ----------------

  @Get('stays/:id/grc')
  grcVersions(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.grc.list(actor, parse(zId, id));
  }

  /** Prints or reprints: returns the stored card, generating version 1 the first time. */
  @Post('stays/:id/grc')
  @HttpCode(200)
  generateGrc(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string) {
    const stayId = parse(zId, id);
    return this.mutate(actor, req, key, {}, (q) => this.grc.ensure(q, actor, stayId));
  }

  @Post('stays/:id/grc/regenerate')
  @HttpCode(200)
  regenerateGrc(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const stayId = parse(zId, id);
    const input = parse(regenerateGrcSchema, body);
    return this.mutate(actor, req, key, body, (q) => this.grc.regenerate(q, actor, stayId, input.reason));
  }

  @Get('grc-documents/:id/view-url')
  grcViewUrl(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.grc.viewUrl(actor, parse(zId, id));
  }

  @Get('stays/:id/checkout-preview')
  checkoutPreview(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.stays.checkoutPreview(actor, parse(zId, id));
  }

  @Post('stays/:id/checkout')
  @HttpCode(200)
  checkout(@CurrentActor() actor: Actor, @Req() req: AppRequest, @IdempotencyKey() key: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const stayId = parse(zId, id);
    const input = parse(checkoutSchema, body ?? {});
    return this.mutate(actor, req, key, body ?? {}, (q) => this.stays.checkout(q, actor, stayId, input.steps));
  }
}
