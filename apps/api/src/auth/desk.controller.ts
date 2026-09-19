import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { zId } from '@resortos/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config';
import { CurrentActor, Public, Roles } from '../common/decorators';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { SESSION_COOKIE } from './tokens';
import { DESK_COOKIE, DeskService } from './desk.service';

/** Shared front-desk computers and quick PIN switching (spec §5.3). */
@Controller()
export class DeskController {
  constructor(private readonly desk: DeskService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private cookieToken(req: AppRequest, name: string): string | null {
    const v: unknown = req.cookies?.[name];
    return typeof v === 'string' ? v : null;
  }

  /** The owner marks this computer as a shared desk. The device cookie never leaves the API path. */
  @Post('desk/trust')
  @Roles('owner')
  @HttpCode(200)
  async trust(@CurrentActor() actor: Actor, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { name } = parse(z.object({ name: z.string().trim().min(1, 'Name this computer').max(60) }), body);
    const { id, token } = await this.desk.trust(actor, name);
    res.cookie(DESK_COOKIE, token, {
      httpOnly: true, secure: this.config.SESSION_COOKIE_SECURE, sameSite: 'strict', path: '/api/v1', maxAge: 365 * 24 * 3_600_000,
    });
    return { id, name };
  }

  /** Is this a shared desk, and who can switch in. Works with no session — that is the lock screen. */
  @Public()
  @Get('desk')
  async status(@Req() req: AppRequest) {
    const token = this.cookieToken(req, DESK_COOKIE);
    if (!(await this.desk.device(token))) return { trusted: false };
    return { trusted: true, ...(await this.desk.candidates(token)) };
  }

  @Public()
  @Post('desk/switch')
  @HttpCode(200)
  async switchTo(@Req() req: AppRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(z.object({ userId: zId, pin: z.string().regex(/^\d{4,6}$/, 'Enter your 4 to 6 digit PIN') }), body);
    const result = await this.desk.switchTo(
      this.cookieToken(req, DESK_COOKIE), this.cookieToken(req, SESSION_COOKIE), input.userId, input.pin,
      { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null, requestId: req.requestId },
    );
    res.cookie(SESSION_COOKIE, result.token, { httpOnly: true, secure: this.config.SESSION_COOKIE_SECURE, sameSite: 'lax', path: '/', expires: result.expiresAt });
    return { user: result.user };
  }

  @Post('desk/lock')
  @Roles('owner', 'receptionist', 'cleaner')
  @HttpCode(200)
  async lock(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    await this.desk.lock(actor);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Post('auth/staff-pin')
  @Roles('owner', 'receptionist', 'cleaner')
  @HttpCode(200)
  async setPin(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(z.object({ password: z.string().min(1), pin: z.string() }), body);
    await this.desk.setPin(actor, input.password, input.pin);
    return { ok: true };
  }

  @Get('desk/devices')
  @Roles('owner')
  devices(@CurrentActor() actor: Actor) {
    return this.desk.list(actor);
  }

  @Post('desk/devices/:id/revoke')
  @Roles('owner')
  @HttpCode(200)
  async revoke(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.desk.revoke(actor, parse(zId, id));
    return { ok: true };
  }
}
