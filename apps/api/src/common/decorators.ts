import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@resortos/shared';
import type { Actor, AppRequest } from './request-context';

export const ROLES_KEY = 'resortos:roles';
export const PUBLIC_KEY = 'resortos:public';

/** Restricts an endpoint to roles. Without it, any logged-in owner or receptionist may call. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.actor) throw new Error('CurrentActor used on a public route');
  return req.actor;
});

export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  const v = req.header('idempotency-key');
  return v ?? undefined;
});
