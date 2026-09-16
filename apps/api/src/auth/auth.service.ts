import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, normalizeIndianMobile, type CreateUserInput, type Role } from '@resortos/shared';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuditService } from '../common/audit.service';
import { AppError, forbidden, notFound } from '../common/errors';
import type { Actor, SessionUser } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import type { CountRow, IdRow, UserRow } from '../db/rows';
import { burnVerifyTime, hashSecret, passwordProblem, pinProblem, verifySecret } from './password';
import { newToken, tokenHash } from './tokens';

/**
 * Login throttling (spec §5.1) designed so a stranger cannot lock the owner out:
 *
 * - Per network (IP): more than 20 failed logins in 15 minutes blocks that IP for all accounts.
 * - Per account + network, or account + known device: after 5 failures, increasing delays
 *   (30 s, 1 min, 2 min … max 15 min). An attacker only slows down their own network.
 * - Per account overall: more than 30 failures in an hour slows down unknown devices only.
 *   Devices that have logged in successfully before (known-device cookie) are unaffected.
 * - Owner recovery codes reset the password and clear every throttle and PIN lock.
 */
export const THROTTLE = {
  ipWindowMinutes: 15,
  ipFailureLimit: 20,
  freeFailures: 5,
  baseDelaySeconds: 30,
  maxDelaySeconds: 900,
  accountWindowMinutes: 60,
  accountFailureLimit: 30,
  recoveryIpLimit: 5,
} as const;

export const DEVICE_COOKIE = 'rsos_device';

export function delayForFailures(failures: number): number {
  if (failures < THROTTLE.freeFailures) return 0;
  return Math.min(THROTTLE.maxDelaySeconds, THROTTLE.baseDelaySeconds * 2 ** (failures - THROTTLE.freeFailures));
}

export function toSessionUser(r: UserRow): SessionUser {
  return {
    id: r.id,
    propertyId: r.property_id,
    fullName: r.full_name,
    username: r.username,
    role: r.role,
    discountLimitPercent: r.discount_limit_percent,
    mustChangePassword: r.must_change_password,
    canRunNightAudit: r.role === 'owner' || r.can_run_night_audit,
  };
}

export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  deviceToken: string | null;
}

export interface LoginResult {
  token: string;
  user: SessionUser;
  expiresAt: Date;
  /** Set when a new known-device cookie should be issued. */
  newDeviceToken: string | null;
}

function waitMessage(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  return seconds < 60 ? `${Math.max(1, Math.ceil(seconds))} seconds` : `${minutes} minute${minutes > 1 ? 's' : ''}`;
}

function recoveryCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => alphabet[b % 32]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async recordAttempt(q: Queryable, a: { kind: string; login: string | null; userId: string | null; ip: string | null; succeeded: boolean; deviceId?: string | null; throttled?: boolean }) {
    await q.query(
      `INSERT INTO auth_attempts (kind, login, user_id, ip, succeeded, known_device_id, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [a.kind, a.login, a.userId, a.ip, a.succeeded, a.deviceId ?? null, a.throttled ? 'throttled' : 'checked'],
    );
  }

  private rateLimited(message: string, retryAfterSeconds: number) {
    return new AppError(ERROR_CODES.RATE_LIMITED, message, { retryAfterSeconds: Math.ceil(retryAfterSeconds) });
  }

  private async knownDevice(userId: string, token: string | null): Promise<string | null> {
    if (!token) return null;
    const { rows } = await this.db.query<IdRow>(
      `SELECT id FROM known_devices WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL`, [userId, tokenHash(token)],
    );
    return rows[0]?.id ?? null;
  }

  /** Seconds until this login may be attempted again, or 0. */
  private async throttleSeconds(user: UserRow, ip: string | null, deviceId: string | null): Promise<number> {
    // Scope: this known device, or this network for unknown devices. Only failures after the last
    // success in the same scope, after the owner's reset, and inside the window count.
    const { rows } = await this.db.query<{ failures: string; last_failure: Date | null }>(
      `WITH scoped AS (
         SELECT * FROM auth_attempts
          WHERE kind = 'password' AND user_id = $1
            AND (($2::uuid IS NOT NULL AND known_device_id = $2) OR ($2::uuid IS NULL AND known_device_id IS NULL AND ip IS NOT DISTINCT FROM $3::inet))
       ), floor AS (
         SELECT GREATEST(
           now() - ($4 || ' minutes')::interval,
           COALESCE($5::timestamptz, '-infinity'),
           COALESCE((SELECT max(created_at) FROM scoped WHERE succeeded), '-infinity')
         ) AS since
       )
       SELECT count(*) AS failures, max(created_at) AS last_failure
         FROM scoped, floor
        WHERE NOT succeeded AND outcome = 'checked' AND created_at > floor.since`,
      [user.id, deviceId, ip, String(THROTTLE.ipWindowMinutes), user.login_throttle_reset_at],
    );
    const failures = Number(rows[0]!.failures);
    const delay = delayForFailures(failures);
    let wait = 0;
    if (delay > 0 && rows[0]!.last_failure) {
      wait = Math.max(wait, (rows[0]!.last_failure.getTime() + delay * 1000 - Date.now()) / 1000);
    }

    if (!deviceId) {
      const { rows: acct } = await this.db.query<{ failures: string; last_failure: Date | null }>(
        `SELECT count(*) AS failures, max(created_at) AS last_failure FROM auth_attempts
          WHERE kind = 'password' AND user_id = $1 AND NOT succeeded AND outcome = 'checked'
            AND created_at > GREATEST(now() - ($2 || ' minutes')::interval, COALESCE($3::timestamptz, '-infinity'))`,
        [user.id, String(THROTTLE.accountWindowMinutes), user.login_throttle_reset_at],
      );
      if (Number(acct[0]!.failures) >= THROTTLE.accountFailureLimit && acct[0]!.last_failure) {
        wait = Math.max(wait, (acct[0]!.last_failure.getTime() + THROTTLE.maxDelaySeconds * 1000 - Date.now()) / 1000);
      }
    }
    return wait;
  }

  /** Network-wide limit. Known devices are exempt so a busy shared network cannot block the front desk. */
  private async assertNetworkAllowed(ctx: LoginContext) {
    if (ctx.ip) {
      const { rows } = await this.db.query<{ n: string; oldest: Date | null }>(
        `SELECT count(*) AS n, min(created_at) AS oldest FROM auth_attempts
          WHERE ip = $1 AND kind = 'password' AND NOT succeeded AND outcome = 'checked' AND created_at > now() - ($2 || ' minutes')::interval`,
        [ctx.ip, String(THROTTLE.ipWindowMinutes)],
      );
      if (Number(rows[0]!.n) >= THROTTLE.ipFailureLimit) {
        const wait = rows[0]!.oldest ? (rows[0]!.oldest.getTime() + THROTTLE.ipWindowMinutes * 60_000 - Date.now()) / 1000 : THROTTLE.ipWindowMinutes * 60;
        throw this.rateLimited(`Too many failed logins from this network. Please wait ${waitMessage(wait)}.`, wait);
      }
    }
  }

  async login(login: string, password: string, ctx: LoginContext): Promise<LoginResult> {
    const invalid = () => new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Username or password is incorrect.');

    const mobile = normalizeIndianMobile(login);
    const { rows } = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE (username = $1 OR ($2::text IS NOT NULL AND mobile = $2)) LIMIT 1`,
      [login.trim().toLowerCase(), mobile],
    );
    const user = rows[0];

    if (!user || !user.is_active) {
      await this.assertNetworkAllowed(ctx);
      await burnVerifyTime(password);
      await this.recordAttempt(this.db, { kind: 'password', login, userId: user?.id ?? null, ip: ctx.ip, succeeded: false });
      throw invalid();
    }

    const deviceId = await this.knownDevice(user.id, ctx.deviceToken);
    if (!deviceId) await this.assertNetworkAllowed(ctx);
    const wait = await this.throttleSeconds(user, ctx.ip, deviceId);
    if (wait > 0) {
      await this.recordAttempt(this.db, { kind: 'password', login, userId: user.id, ip: ctx.ip, succeeded: false, deviceId, throttled: true });
      throw this.rateLimited(`Too many wrong passwords. Please wait ${waitMessage(wait)} and try again.`, wait);
    }

    const ok = await verifySecret(user.password_hash, password);
    if (!ok) {
      await this.db.tx({}, async (q) => {
        await this.recordAttempt(q, { kind: 'password', login, userId: user.id, ip: ctx.ip, succeeded: false, deviceId });
      });
      const next = await this.throttleSeconds(user, ctx.ip, deviceId);
      if (next > 0) {
        await this.db.tx({}, (q) => this.audit.recordSystem(q, user.property_id, {
          userId: user.id, ip: ctx.ip, requestId: ctx.requestId, action: 'auth.login_throttled', entityType: 'user', entityId: user.id,
          reason: deviceId ? 'repeated wrong passwords from a known device' : 'repeated wrong passwords from one network',
        }));
      }
      throw invalid();
    }

    const token = newToken();
    const expiresAt = new Date(Date.now() + this.config.SESSION_HOURS_DEFAULT * 3_600_000);
    const newDeviceToken = deviceId ? null : newToken();

    await this.db.tx({ userId: user.id }, async (q) => {
      let knownDeviceId = deviceId;
      if (newDeviceToken) {
        const { rows: d } = await q.query<IdRow>(
          `INSERT INTO known_devices (user_id, token_hash, user_agent) VALUES ($1,$2,$3) RETURNING id`,
          [user.id, tokenHash(newDeviceToken), ctx.userAgent?.slice(0, 300) ?? null],
        );
        knownDeviceId = d[0]!.id;
      } else {
        await q.query(`UPDATE known_devices SET last_used_at = now() WHERE id = $1`, [deviceId]);
      }
      const { rows: s } = await q.query<IdRow>(
        `INSERT INTO sessions (user_id, property_id, token_hash, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [user.id, user.property_id, tokenHash(token), ctx.ip, ctx.userAgent?.slice(0, 300) ?? null, expiresAt],
      );
      await this.recordAttempt(q, { kind: 'password', login, userId: user.id, ip: ctx.ip, succeeded: true, deviceId: knownDeviceId });
      await this.audit.recordSystem(q, user.property_id, {
        userId: user.id, ip: ctx.ip, requestId: ctx.requestId, action: 'auth.login', entityType: 'session', entityId: s[0]!.id,
      });
    });

    return { token, user: toSessionUser(user), expiresAt, newDeviceToken };
  }

  /** Resolves a cookie token to an actor. Returns null for missing/expired/revoked sessions. */
  async authenticate(token: string): Promise<{ user: SessionUser; sessionId: string } | null> {
    const { rows } = await this.db.query<UserRow & { session_id: string; last_seen_at: Date }>(
      `SELECT u.*, s.id AS session_id, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
      [tokenHash(token)],
    );
    const row = rows[0];
    if (!row) return null;
    if (Date.now() - row.last_seen_at.getTime() > 60_000) {
      await this.db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [row.session_id]);
    }
    return { user: toSessionUser(row), sessionId: row.session_id };
  }

  async logout(actor: Actor) {
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      await q.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`, [actor.sessionId]);
      await this.audit.record(q, actor, { action: 'auth.logout', entityType: 'session', entityId: actor.sessionId });
    });
  }

  private async loadUser(id: string): Promise<UserRow> {
    const { rows } = await this.db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound('Account');
    return rows[0];
  }

  async changePassword(actor: Actor, currentPassword: string, newPassword: string) {
    const user = await this.loadUser(actor.user.id);
    if (!(await verifySecret(user.password_hash, currentPassword))) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Your current password is incorrect.');
    }
    const problem = passwordProblem(newPassword, { username: user.username, fullName: user.full_name, mobile: user.mobile });
    if (problem) throw new AppError(ERROR_CODES.VALIDATION, problem, { fields: [{ path: 'newPassword', message: problem }] });
    if (await verifySecret(user.password_hash, newPassword)) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Choose a password different from the current one.');
    }
    const hash = await hashSecret(newPassword);
    await this.db.tx({ userId: user.id }, async (q) => {
      await q.query(`UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE id = $1`, [user.id, hash]);
      // Password change logs out every other session (spec §5.4).
      await q.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [user.id, actor.sessionId],
      );
      await this.audit.record(q, actor, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
    });
  }

  // ---------------- owner recovery (spec §5.2) ----------------

  /** Generates 10 single-use recovery codes to print and keep safe. Old unused codes stop working. */
  async generateRecoveryCodes(actor: Actor, password: string): Promise<string[]> {
    if (actor.user.role !== 'owner') throw forbidden();
    const user = await this.loadUser(actor.user.id);
    if (!(await verifySecret(user.password_hash, password))) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Your password is incorrect.');
    const codes = Array.from({ length: 10 }, recoveryCode);
    const hashes = await Promise.all(codes.map((c) => hashSecret(c.replace(/-/g, ''))));
    await this.db.tx({ userId: user.id }, async (q) => {
      await q.query(`UPDATE recovery_codes SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [user.id]);
      for (const h of hashes) await q.query(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [user.id, h]);
      await this.audit.record(q, actor, { action: 'auth.recovery_codes_generated', entityType: 'user', entityId: user.id });
    });
    return codes;
  }

  /** Owner forgot password or is being throttled: a printed recovery code resets everything. */
  async recoverWithCode(input: { login: string; recoveryCode: string; newPassword: string }, ctx: LoginContext) {
    const invalid = () => new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'That username and recovery code do not match.');
    if (ctx.ip) {
      const { rows } = await this.db.query<CountRow>(
        `SELECT count(*) AS n FROM auth_attempts WHERE ip = $1 AND kind = 'recovery' AND NOT succeeded AND created_at > now() - interval '15 minutes'`,
        [ctx.ip],
      );
      if (Number(rows[0]!.n) >= THROTTLE.recoveryIpLimit) throw this.rateLimited('Too many recovery attempts from this network. Please wait 15 minutes.', 900);
    }
    const mobile = normalizeIndianMobile(input.login);
    const { rows } = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE (username = $1 OR ($2::text IS NOT NULL AND mobile = $2)) AND role = 'owner' AND is_active LIMIT 1`,
      [input.login.trim().toLowerCase(), mobile],
    );
    const user = rows[0];
    const code = input.recoveryCode.replace(/-/g, '').toUpperCase();
    let matchedId: string | null = null;
    if (user) {
      const { rows: codes } = await this.db.query<{ id: string; code_hash: string }>(
        `SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [user.id],
      );
      for (const c of codes) if (await verifySecret(c.code_hash, code)) { matchedId = c.id; break; }
    } else {
      await burnVerifyTime(code);
    }
    if (!user || !matchedId) {
      await this.recordAttempt(this.db, { kind: 'recovery', login: input.login, userId: user?.id ?? null, ip: ctx.ip, succeeded: false });
      throw invalid();
    }
    const problem = passwordProblem(input.newPassword, { username: user.username, mobile: user.mobile });
    if (problem) throw new AppError(ERROR_CODES.VALIDATION, problem, { fields: [{ path: 'newPassword', message: problem }] });
    const hash = await hashSecret(input.newPassword);

    await this.db.tx({ userId: user.id }, async (q) => {
      const { rowCount } = await q.query(`UPDATE recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [matchedId]);
      if (!rowCount) throw invalid();
      await q.query(
        `UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now(), login_throttle_reset_at = now(),
                owner_pin_failed_count = 0, owner_pin_locked_until = NULL
          WHERE id = $1`,
        [user.id, hash],
      );
      await q.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'account_recovered' WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
      await this.recordAttempt(q, { kind: 'recovery', login: input.login, userId: user.id, ip: ctx.ip, succeeded: true });
      await this.audit.recordSystem(q, user.property_id, {
        userId: user.id, ip: ctx.ip, requestId: ctx.requestId, action: 'auth.account_recovered', entityType: 'user', entityId: user.id,
        reason: 'recovery code used; password reset, login throttles and Owner PIN lock cleared, all sessions logged out',
      });
    });
    const { rows: left } = await this.db.query<CountRow>(`SELECT count(*) AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [user.id]);
    return { remainingCodes: Number(left[0]!.n) };
  }

  // ---------------- owner-only user management ----------------

  async listUsers(actor: Actor) {
    const { rows } = await this.db.query<UserRow & { has_owner_pin: boolean }>(
      `SELECT *, owner_pin_hash IS NOT NULL AS has_owner_pin FROM users WHERE property_id = $1 ORDER BY role, full_name`,
      [actor.user.propertyId],
    );
    return rows.map((r) => ({
      id: r.id, fullName: r.full_name, username: r.username, mobile: r.mobile, role: r.role, isActive: r.is_active,
      mustChangePassword: r.must_change_password, discountLimitPercent: r.discount_limit_percent, canRunNightAudit: r.can_run_night_audit,
      ownerPinLocked: !!r.owner_pin_locked_until && r.owner_pin_locked_until > new Date(), hasOwnerPin: r.has_owner_pin, createdAt: r.created_at,
    }));
  }

  async createUser(actor: Actor, input: CreateUserInput) {
    const problem = passwordProblem(input.temporaryPassword, { username: input.username, mobile: input.mobile });
    if (problem) throw new AppError(ERROR_CODES.VALIDATION, problem, { fields: [{ path: 'temporaryPassword', message: problem }] });
    const hash = await hashSecret(input.temporaryPassword);
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<IdRow>(
        `INSERT INTO users (property_id, full_name, username, mobile, role, password_hash, must_change_password, discount_limit_percent, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,true,COALESCE($7::numeric, 10.00),$8) RETURNING id`,
        [actor.user.propertyId, input.fullName, input.username, input.mobile ?? null, input.role, hash, input.discountLimitPercent ?? null, actor.user.id],
      );
      const id = rows[0]!.id;
      await this.audit.record(q, actor, {
        action: 'user.created', entityType: 'user', entityId: id,
        after: { fullName: input.fullName, username: input.username, role: input.role as Role, discountLimitPercent: input.discountLimitPercent },
      });
      return { id };
    });
  }

  async resetPassword(actor: Actor, userId: string, temporaryPassword: string) {
    const { rows } = await this.db.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND property_id = $2`, [userId, actor.user.propertyId]);
    const user = rows[0];
    if (!user) throw notFound('User');
    if (user.role === 'owner' && user.id !== actor.user.id) throw forbidden('Owner passwords are reset with the owner recovery codes.');
    const problem = passwordProblem(temporaryPassword, { username: user.username, mobile: user.mobile });
    if (problem) throw new AppError(ERROR_CODES.VALIDATION, problem);
    const hash = await hashSecret(temporaryPassword);
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      await q.query(`UPDATE users SET password_hash = $2, must_change_password = true, login_throttle_reset_at = now() WHERE id = $1`, [userId, hash]);
      await q.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await this.audit.record(q, actor, { action: 'user.password_reset', entityType: 'user', entityId: userId });
    });
  }

  /** Clears login throttles and the Owner PIN lock (owner may unlock their own PIN). */
  async unlockUser(actor: Actor, userId: string) {
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rowCount } = await q.query(
        `UPDATE users SET login_throttle_reset_at = now(), owner_pin_failed_count = 0, owner_pin_locked_until = NULL
          WHERE id = $1 AND property_id = $2`,
        [userId, actor.user.propertyId],
      );
      if (!rowCount) throw notFound('User');
      await this.audit.record(q, actor, { action: 'user.unlocked', entityType: 'user', entityId: userId });
    });
  }

  async setUserActive(actor: Actor, userId: string, isActive: boolean) {
    if (userId === actor.user.id && !isActive) throw forbidden('You cannot deactivate your own account.');
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rowCount } = await q.query(`UPDATE users SET is_active = $3 WHERE id = $1 AND property_id = $2`, [userId, actor.user.propertyId, isActive]);
      if (!rowCount) throw notFound('User');
      if (!isActive) {
        await q.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'deactivated' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
        await q.query(`UPDATE known_devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      }
      await this.audit.record(q, actor, { action: isActive ? 'user.activated' : 'user.deactivated', entityType: 'user', entityId: userId });
    });
  }

  async setOwnerPin(actor: Actor, password: string, pin: string) {
    if (actor.user.role !== 'owner') throw forbidden();
    const problem = pinProblem(pin);
    if (problem) throw new AppError(ERROR_CODES.VALIDATION, problem);
    const user = await this.loadUser(actor.user.id);
    if (!(await verifySecret(user.password_hash, password))) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Your password is incorrect.');
    const hash = await hashSecret(pin);
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      await q.query(`UPDATE users SET owner_pin_hash = $2, owner_pin_failed_count = 0, owner_pin_locked_until = NULL WHERE id = $1`, [actor.user.id, hash]);
      await this.audit.record(q, actor, { action: 'auth.owner_pin_set', entityType: 'user', entityId: actor.user.id });
    });
  }

  async listSessions(actor: Actor) {
    const { rows } = await this.db.query<{ id: string; user_id: string; full_name: string; ip: string | null; user_agent: string | null; created_at: Date; last_seen_at: Date; expires_at: Date }>(
      `SELECT s.id, s.user_id, u.full_name, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.property_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND ($2 = 'owner' OR s.user_id = $3)
        ORDER BY s.last_seen_at DESC`,
      [actor.user.propertyId, actor.user.role, actor.user.id],
    );
    return rows.map((r) => ({
      id: r.id, userId: r.user_id, fullName: r.full_name, ip: r.ip, userAgent: r.user_agent,
      createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, isCurrent: r.id === actor.sessionId,
    }));
  }

  async revokeSession(actor: Actor, sessionId: string) {
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rowCount } = await q.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_user'
          WHERE id = $1 AND property_id = $2 AND revoked_at IS NULL AND ($3 = 'owner' OR user_id = $4)`,
        [sessionId, actor.user.propertyId, actor.user.role, actor.user.id],
      );
      if (!rowCount) throw notFound('Session');
      await this.audit.record(q, actor, { action: 'auth.session_revoked', entityType: 'session', entityId: sessionId });
    });
  }
}
