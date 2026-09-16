import { Injectable } from '@nestjs/common';
import type { Queryable } from '../db/db.service';
import type { Actor } from './request-context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  authorisedBy?: string | null;
}

/** Writes to the append-only, hash-chained audit log inside the caller's transaction (spec §50). */
@Injectable()
export class AuditService {
  async record(q: Queryable, actor: Actor, entry: AuditEntry): Promise<void> {
    await q.query(
      `INSERT INTO audit_logs
         (property_id, user_id, authorised_by, session_id, device, ip, action, entity_type, entity_id,
          before_values, after_values, reason, request_id, chain_position, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, 0, '\\x')`,
      [
        actor.user.propertyId,
        actor.user.id,
        entry.authorisedBy ?? null,
        actor.sessionId,
        actor.device,
        actor.ip,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.reason ?? null,
        actor.requestId,
      ],
    );
  }

  /** For events without a logged-in user (e.g. failed logins, system jobs). */
  async recordSystem(q: Queryable, propertyId: string, entry: AuditEntry & { userId?: string | null; ip?: string | null; requestId?: string }) {
    await q.query(
      `INSERT INTO audit_logs
         (property_id, user_id, ip, action, entity_type, entity_id, before_values, after_values, reason, request_id, chain_position, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, 0, '\\x')`,
      [
        propertyId,
        entry.userId ?? null,
        entry.ip ?? null,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.reason ?? null,
        entry.requestId ?? null,
      ],
    );
  }
}
