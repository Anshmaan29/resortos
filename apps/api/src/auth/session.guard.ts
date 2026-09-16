import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, type Role } from '@resortos/shared';
import { PUBLIC_KEY, ROLES_KEY } from '../common/decorators';
import { AppError, forbidden } from '../common/errors';
import type { AppRequest } from '../common/request-context';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './tokens';

/** Paths a user with a temporary password may still call. */
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/password/change', '/api/v1/auth/logout']);

/**
 * Global guard: every endpoint requires a valid session unless marked @Public().
 * Default access: owner + receptionist. Cleaners only reach endpoints that name them. (spec §4, §57)
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handlers = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, handlers)) return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length < 20) {
      throw new AppError(ERROR_CODES.UNAUTHENTICATED, 'Please log in.');
    }
    const session = await this.auth.authenticate(token);
    if (!session) throw new AppError(ERROR_CODES.UNAUTHENTICATED, 'Your session has ended. Please log in again.');

    req.actor = {
      user: session.user,
      sessionId: session.sessionId,
      ip: req.ip ?? null,
      device: req.header('user-agent')?.slice(0, 120) ?? null,
      requestId: req.requestId,
    };

    if (session.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.path)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Please set a new password before continuing.', { mustChangePassword: true });
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, handlers) ?? ['owner', 'receptionist'];
    if (!roles.includes(session.user.role)) throw forbidden();
    return true;
  }
}
