import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  approveOwnerAuthorisationSchema, changePasswordSchema, createUserSchema, updateUserSchema, loginSchema, passwordSchema, pinSchema, recoverAccountSchema, zId,
} from '@resortos/shared';
import { APP_CONFIG, type AppConfig } from '../config';
import { CurrentActor, Public, Roles } from '../common/decorators';
import type { Actor, AppRequest } from '../common/request-context';
import { parse } from '../common/zod';
import { AuthService, DEVICE_COOKIE } from './auth.service';
import { OwnerAuthorisationService } from './owner-authorisation.service';
import { SESSION_COOKIE } from './tokens';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly ownerAuth: OwnerAuthorisationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private context(req: AppRequest) {
    const device: unknown = req.cookies?.[DEVICE_COOKIE];
    return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null, requestId: req.requestId, deviceToken: typeof device === 'string' ? device : null };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginSchema, body);
    const result = await this.auth.login(input.login, input.password, this.context(req));
    const secure = this.config.SESSION_COOKIE_SECURE;
    res.cookie(SESSION_COOKIE, result.token, { httpOnly: true, secure, sameSite: 'lax', path: '/', expires: result.expiresAt });
    if (result.newDeviceToken) {
      // Remembers this device so login throttling aimed at the account does not affect it.
      res.cookie(DEVICE_COOKIE, result.newDeviceToken, { httpOnly: true, secure, sameSite: 'lax', path: '/api/v1/auth', maxAge: 365 * 24 * 3_600_000 });
    }
    return { user: result.user };
  }

  @Public()
  @Post('recover')
  @HttpCode(200)
  recover(@Body() body: unknown, @Req() req: AppRequest) {
    return this.auth.recoverWithCode(parse(recoverAccountSchema, body), this.context(req));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(actor);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @Roles('owner', 'receptionist', 'cleaner')
  me(@CurrentActor() actor: Actor) {
    return { user: actor.user };
  }

  @Post('password/change')
  @Roles('owner', 'receptionist', 'cleaner')
  @HttpCode(200)
  async changePassword(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(changePasswordSchema, body);
    await this.auth.changePassword(actor, input.currentPassword, input.newPassword);
    return { ok: true };
  }

  @Post('owner-pin')
  @Roles('owner')
  @HttpCode(200)
  async setOwnerPin(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(z.object({ password: z.string().min(1), pin: pinSchema }), body);
    await this.auth.setOwnerPin(actor, input.password, input.pin);
    return { ok: true };
  }

  @Post('recovery-codes')
  @Roles('owner')
  @HttpCode(200)
  async recoveryCodes(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(z.object({ password: z.string().min(1) }), body);
    return { codes: await this.auth.generateRecoveryCodes(actor, input.password) };
  }

  /** Owners available for the on-screen PIN pad. */
  @Get('owners')
  owners(@CurrentActor() actor: Actor) {
    return this.ownerAuth.listOwners(actor.user.propertyId);
  }

  @Get('sessions')
  sessions(@CurrentActor() actor: Actor) {
    return this.auth.listSessions(actor);
  }

  @Delete('sessions/:id')
  async revokeSession(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.auth.revokeSession(actor, parse(zId, id));
    return { ok: true };
  }
}

@Controller('owner-authorisations')
export class OwnerAuthorisationsController {
  constructor(private readonly ownerAuth: OwnerAuthorisationService) {}

  /** The owner enters their PIN on this screen to approve one pending request. */
  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(approveOwnerAuthorisationSchema, body);
    return this.ownerAuth.approve(actor, parse(zId, id), input.ownerUserId, input.pin);
  }
}

@Controller('users')
@Roles('owner')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  list(@CurrentActor() actor: Actor) {
    return this.auth.listUsers(actor);
  }

  @Post()
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.auth.createUser(actor, parse(createUserSchema, body));
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  async resetPassword(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ temporaryPassword: passwordSchema }), body);
    await this.auth.resetPassword(actor, parse(zId, id), input.temporaryPassword);
    return { ok: true };
  }

  @Post(':id/unlock')
  @HttpCode(200)
  async unlock(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.auth.unlockUser(actor, parse(zId, id));
    return { ok: true };
  }

  @Patch(':id')
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.auth.updateUser(actor, parse(zId, id), parse(updateUserSchema, body));
  }

  @Patch(':id/active')
  async setActive(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ isActive: z.boolean() }), body);
    await this.auth.setUserActive(actor, parse(zId, id), input.isActive);
    return { ok: true };
  }
}
