import type { Request } from 'express';
import type { Role } from '@resortos/shared';

export interface SessionUser {
  id: string;
  propertyId: string;
  fullName: string;
  username: string;
  role: Role;
  discountLimitPercent: string;
  mustChangePassword: boolean;
  canRunNightAudit: boolean;
}

export interface Actor {
  user: SessionUser;
  sessionId: string;
  ip: string | null;
  device: string | null;
  requestId: string;
}

export interface AppRequest extends Request {
  requestId: string;
  actor?: Actor;
}
