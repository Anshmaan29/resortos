import { Injectable } from '@nestjs/common';
import { ERROR_CODES, type OwnerPinAction } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { canonicalJson, sha256 } from '../common/canonical';
import { AppError, notFound } from '../common/errors';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { IdRow, OwnerAuthorisationRow } from '../db/rows';
import { verifySecret } from './password';

const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MINUTES = 30;
const PIN_ENTRY_MINUTES = 10;
const APPROVAL_VALID_SECONDS = 120;

export interface AuthorisationReason {
  action: OwnerPinAction;
  /** Plain language shown on the PIN pad and on the record, e.g. "Rate ₹2,000 is below the minimum ₹2,600" */
  description: string;
}

export interface AuthorisationRequirement {
  /** e.g. "reservation.create" */
  operation: string;
  /** The exact values the owner is approving. Recomputed by the server on use. */
  scope: unknown;
  reasons: AuthorisationReason[];
}

export interface Authorisation {
  authorisedBy: string;
  authorisationId: string | null;
  reasons: AuthorisationReason[];
}

/**
 * Owner authorisation on the same screen (spec §4.5), with no approval queue:
 *
 *   request needs owner ──► 403 OWNER_PIN_REQUIRED + pending authorisation (scope stored server-side)
 *   owner types PIN    ──► approved, valid for 2 minutes
 *   request retried    ──► consumed only if the recomputed scope hash matches exactly (single use)
 *
 * Pending rows and PIN failure counters are written on their own connection, because the
 * business transaction that discovered the need is about to roll back.
 */
@Injectable()
export class OwnerAuthorisationService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private hash(operation: string, scope: unknown): Buffer {
    return sha256(`${operation}\n${canonicalJson(scope)}`);
  }

  /** Returns null when nothing needs authorising. Throws when authorisation is missing or does not match. */
  async require(q: Queryable, actor: Actor, req: AuthorisationRequirement, authorisationId: string | undefined, entity: { type: string; id: string }): Promise<Authorisation | null> {
    if (req.reasons.length === 0) return null;
    if (actor.user.role === 'owner') return { authorisedBy: actor.user.id, authorisationId: null, reasons: req.reasons };

    const scopeHash = this.hash(req.operation, req.scope);
    if (authorisationId) {
      // Single use: the row lock makes a concurrent second use see used_at already set.
      const { rows } = await q.query<{ approved_by: string }>(
        `UPDATE owner_authorisations SET used_at = now(), used_entity_type = $6, used_entity_id = $7
          WHERE id = $1 AND property_id = $2 AND requested_by = $3 AND operation = $4 AND scope_hash = $5
            AND approved_at IS NOT NULL AND expires_at > now() AND used_at IS NULL
          RETURNING approved_by`,
        [authorisationId, actor.user.propertyId, actor.user.id, req.operation, scopeHash, entity.type, entity.id],
      );
      if (rows[0]) return { authorisedBy: rows[0].approved_by, authorisationId, reasons: req.reasons };

      const problem = await this.whyUnusable(actor, authorisationId, req.operation, scopeHash);
      const pending = await this.createPending(actor, req, scopeHash);
      throw new AppError(ERROR_CODES.OWNER_AUTHORISATION_INVALID, `${problem} Owner authorisation is needed again.`, {
        authorisationId: pending.id, description: pending.description, reasons: req.reasons, problem,
      });
    }

    const pending = await this.createPending(actor, req, scopeHash);
    throw new AppError(ERROR_CODES.OWNER_PIN_REQUIRED, `This needs owner authorisation: ${pending.description}`, {
      authorisationId: pending.id, description: pending.description, reasons: req.reasons,
    });
  }

  private async whyUnusable(actor: Actor, id: string, operation: string, scopeHash: Buffer): Promise<string> {
    const { rows } = await this.db.query<OwnerAuthorisationRow>(`SELECT * FROM owner_authorisations WHERE id = $1 AND property_id = $2`, [id, actor.user.propertyId]);
    const a = rows[0];
    if (!a || a.requested_by !== actor.user.id) return 'That owner approval was not found.';
    if (a.used_at) return 'That owner approval was already used.';
    if (!a.approved_at) return 'The owner has not approved this yet.';
    if (a.expires_at && a.expires_at <= new Date()) return 'The owner approval expired (approvals last 2 minutes).';
    if (a.operation !== operation || !a.scope_hash.equals(scopeHash)) return 'The details changed after the owner approved them.';
    return 'That owner approval cannot be used.';
  }

  private async createPending(actor: Actor, req: AuthorisationRequirement, scopeHash: Buffer) {
    const description = req.reasons.map((r) => r.description).join('; ');
    const { rows } = await this.db.query<IdRow>(
      `INSERT INTO owner_authorisations (property_id, requested_by, session_id, operation, scope, scope_hash, reasons, description, request_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' minutes')::interval) RETURNING id`,
      [actor.user.propertyId, actor.user.id, actor.sessionId, req.operation, canonicalJson(req.scope), scopeHash,
        JSON.stringify(req.reasons), description, String(PIN_ENTRY_MINUTES)],
    );
    return { id: rows[0]!.id, description };
  }

  /** Owner enters their PIN on the requesting user's screen. */
  async approve(actor: Actor, authorisationId: string, ownerUserId: string, pin: string) {
    const { rows } = await this.db.query<OwnerAuthorisationRow>(
      `SELECT * FROM owner_authorisations WHERE id = $1 AND property_id = $2 AND requested_by = $3`,
      [authorisationId, actor.user.propertyId, actor.user.id],
    );
    const a = rows[0];
    if (!a) throw notFound('Authorisation request');
    if (a.approved_at) throw new AppError(ERROR_CODES.OWNER_AUTHORISATION_INVALID, 'This request was already approved. Try the action again.');
    if (a.request_expires_at <= new Date()) throw new AppError(ERROR_CODES.OWNER_AUTHORISATION_INVALID, 'This authorisation request expired. Try the action again.');

    const ownerId = await this.verifyPin(actor, ownerUserId, pin);
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows: upd } = await q.query<{ expires_at: Date }>(
        `UPDATE owner_authorisations SET approved_by = $2, approved_at = now(), expires_at = now() + ($3 || ' seconds')::interval
          WHERE id = $1 AND approved_at IS NULL RETURNING expires_at`,
        [authorisationId, ownerId, String(APPROVAL_VALID_SECONDS)],
      );
      if (!upd[0]) throw new AppError(ERROR_CODES.OWNER_AUTHORISATION_INVALID, 'This request was already approved. Try the action again.');
      await this.audit.record(q, actor, {
        action: 'owner_authorisation.approved', entityType: 'owner_authorisation', entityId: authorisationId,
        authorisedBy: ownerId, reason: a.description,
      });
      return { authorisationId, expiresAt: upd[0].expires_at };
    });
  }

  /** Writes the permanent record of what was authorised (shown on the booking, and later the owner review list). */
  async recordOverrides(q: Queryable, actor: Actor, auth: Authorisation, entity: { type: string; id: string }) {
    for (const r of auth.reasons) {
      await q.query(
        `INSERT INTO owner_overrides (property_id, entity_type, entity_id, action, description, performed_by, authorised_by, authorisation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [actor.user.propertyId, entity.type, entity.id, r.action, r.description, actor.user.id, auth.authorisedBy, auth.authorisationId],
      );
    }
  }

  /** PIN check with 5-strike lock that survives rollbacks. */
  private async verifyPin(actor: Actor, ownerUserId: string, pin: string): Promise<string> {
    const { rows } = await this.db.query<{ id: string; owner_pin_hash: string | null; owner_pin_locked_until: Date | null }>(
      `SELECT id, owner_pin_hash, owner_pin_locked_until FROM users WHERE id = $1 AND property_id = $2 AND role = 'owner' AND is_active`,
      [ownerUserId, actor.user.propertyId],
    );
    const owner = rows[0];
    const invalid = () => new AppError(ERROR_CODES.OWNER_PIN_INVALID, 'Owner PIN is incorrect.');

    if (!owner || !owner.owner_pin_hash) {
      await this.db.query(`INSERT INTO auth_attempts (kind, user_id, ip, succeeded) VALUES ('owner_pin', NULL, $1, false)`, [actor.ip]);
      throw invalid();
    }
    if (owner.owner_pin_locked_until && owner.owner_pin_locked_until > new Date()) {
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED,
        'Owner PIN is locked after too many wrong attempts. It unlocks automatically in 30 minutes, or the owner can unlock it from their own login.');
    }
    const ok = await verifySecret(owner.owner_pin_hash, pin);
    await this.db.query(`INSERT INTO auth_attempts (kind, user_id, ip, succeeded) VALUES ('owner_pin', $1, $2, $3)`, [owner.id, actor.ip, ok]);
    if (!ok) {
      await this.db.query(
        `UPDATE users SET
           owner_pin_failed_count = CASE WHEN owner_pin_failed_count + 1 >= $2 THEN 0 ELSE owner_pin_failed_count + 1 END,
           owner_pin_locked_until = CASE WHEN owner_pin_failed_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE owner_pin_locked_until END
         WHERE id = $1`,
        [owner.id, MAX_PIN_FAILURES, String(PIN_LOCK_MINUTES)],
      );
      throw invalid();
    }
    await this.db.query(`UPDATE users SET owner_pin_failed_count = 0 WHERE id = $1 AND owner_pin_failed_count <> 0`, [owner.id]);
    return owner.id;
  }

  async listOwners(propertyId: string) {
    const { rows } = await this.db.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE property_id = $1 AND role = 'owner' AND is_active AND owner_pin_hash IS NOT NULL ORDER BY full_name`,
      [propertyId],
    );
    return rows.map((r) => ({ id: r.id, fullName: r.full_name }));
  }
}
