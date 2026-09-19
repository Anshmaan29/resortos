import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@resortos/shared';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuditService } from '../common/audit.service';
import { AppError, forbidden, notFound } from '../common/errors';
import type { Actor, SessionUser } from '../common/request-context';
import { DbService } from '../db/db.service';
import type { UserRow } from '../db/rows';
import { toSessionUser } from './auth.service';
import { burnVerifyTime, hashSecret, staffPinProblem, verifySecret } from './password';
import { newToken, tokenHash } from './tokens';

export const DESK_COOKIE = 'rsos_desk';
/** Wrong PINs for one person before their PIN stops working for a while. */
const PIN_FAILURES = 5;
const PIN_LOCK_MINUTES = 15;

/**
 * Shared front-desk computers (spec §5.3).
 *
 * The owner marks a computer as trusted; it then carries a device cookie. On a trusted computer,
 * someone who has **logged in with their password earlier that day** can start a session with their
 * personal 4–6 digit PIN instead. Everyone else still needs the password. The PIN is never enough on
 * its own: it only resumes a day that began with the full login, on a computer the owner chose.
 *
 * Locking the screen ends the session outright, so a locked desk holds nobody's access.
 */
@Injectable()
export class DeskService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The trusted device this browser is, if any. */
  async device(token: string | undefined | null): Promise<{ id: string; property_id: string; name: string } | null> {
    if (!token || token.length < 20) return null;
    const { rows } = await this.db.query<{ id: string; property_id: string; name: string }>(
      `SELECT id, property_id, name FROM trusted_devices WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash(token)],
    );
    if (rows[0]) await this.db.query(`UPDATE trusted_devices SET last_seen_at = now() WHERE id = $1`, [rows[0].id]);
    return rows[0] ?? null;
  }

  /** The owner marks the computer they are using as a shared desk. Returns the cookie token once. */
  async trust(actor: Actor, name: string): Promise<{ id: string; token: string }> {
    if (actor.user.role !== 'owner') throw forbidden('Only the owner can mark a computer as a shared desk.');
    const token = newToken();
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO trusted_devices (property_id, name, token_hash, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [actor.user.propertyId, name, tokenHash(token), actor.user.id],
      );
      await this.audit.record(q, actor, { action: 'desk.trusted', entityType: 'trusted_device', entityId: rows[0]!.id, after: { name } });
      return { id: rows[0]!.id, token };
    });
  }

  async list(actor: Actor) {
    const { rows } = await this.db.query<{ id: string; name: string; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null; created_by_name: string }>(
      `SELECT d.id, d.name, d.created_at, d.last_seen_at, d.revoked_at, u.full_name AS created_by_name
         FROM trusted_devices d JOIN users u ON u.id = d.created_by
        WHERE d.property_id = $1 ORDER BY d.revoked_at NULLS FIRST, d.created_at DESC`,
      [actor.user.propertyId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at, createdBy: r.created_by_name }));
  }

  /** No longer a shared desk: its PIN sessions end now, and it takes no more PINs. */
  async revoke(actor: Actor, deviceId: string) {
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `UPDATE trusted_devices SET revoked_at = now(), revoked_by = $3 WHERE id = $1 AND property_id = $2 AND revoked_at IS NULL RETURNING id`,
        [deviceId, actor.user.propertyId, actor.user.id],
      );
      if (!rows[0]) throw notFound('Desk computer');
      await q.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'device_revoked' WHERE trusted_device_id = $1 AND revoked_at IS NULL`, [deviceId]);
      await this.audit.record(q, actor, { action: 'desk.revoked', entityType: 'trusted_device', entityId: deviceId });
    });
  }

  /** Set your own PIN, after proving it is you with your password. */
  async setPin(actor: Actor, password: string, pin: string) {
    const problem = staffPinProblem(pin);
    if (problem) throw new AppError(ERROR_CODES.VALIDATION, problem, { fields: [{ path: 'pin', message: problem }] });
    const { rows } = await this.db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [actor.user.id]);
    if (!(await verifySecret(rows[0]!.password_hash, password))) throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Your password is incorrect.');
    const hash = await hashSecret(pin);
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      await q.query(`UPDATE users SET staff_pin_hash = $2, staff_pin_set_at = now() WHERE id = $1`, [actor.user.id, hash]);
      await this.audit.record(q, actor, { action: 'auth.staff_pin_set', entityType: 'user', entityId: actor.user.id });
    });
  }

  /**
   * Who may switch in on this desk right now: active staff of this property with a PIN who logged
   * in with their password today (in the property's timezone). Names only.
   */
  async candidates(deviceToken: string | undefined | null) {
    const device = await this.device(deviceToken);
    if (!device) throw forbidden('This computer is not a shared desk. Log in with your password.');
    const { rows } = await this.db.query<{ id: string; full_name: string; role: string }>(
      `SELECT u.id, u.full_name, u.role
         FROM users u JOIN properties p ON p.id = u.property_id
        WHERE u.property_id = $1 AND u.is_active AND u.staff_pin_hash IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM auth_attempts a
             WHERE a.user_id = u.id AND a.kind = 'password' AND a.succeeded
               AND a.created_at >= (date_trunc('day', now() AT TIME ZONE p.timezone) AT TIME ZONE p.timezone))
        ORDER BY u.full_name`,
      [device.property_id],
    );
    const { rows: prop } = await this.db.query<{ desk_lock_minutes: number; name: string }>(`SELECT desk_lock_minutes, name FROM properties WHERE id = $1`, [device.property_id]);
    return { device: { name: device.name }, property: prop[0]!.name, lockMinutes: prop[0]!.desk_lock_minutes, people: rows.map((r) => ({ id: r.id, fullName: r.full_name, role: r.role })) };
  }

  /**
   * Switch to someone by PIN on a trusted desk. The session this browser had (if any) ends first,
   * so there is never more than one person's access on the desk at a time.
   */
  async switchTo(
    deviceToken: string | undefined | null, currentSessionToken: string | undefined | null, userId: string, pin: string,
    ctx: { ip: string | null; userAgent: string | null; requestId: string },
  ): Promise<{ token: string; user: SessionUser; expiresAt: Date }> {
    const device = await this.device(deviceToken);
    if (!device) throw forbidden('This computer is not a shared desk. Log in with your password.');
    const wrong = () => new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'That PIN is not right.');

    const { rows } = await this.db.query<UserRow & { password_today: boolean; recent_failures: number }>(
      `SELECT u.*,
              EXISTS (SELECT 1 FROM auth_attempts a WHERE a.user_id = u.id AND a.kind = 'password' AND a.succeeded
                        AND a.created_at >= (date_trunc('day', now() AT TIME ZONE p.timezone) AT TIME ZONE p.timezone)) AS password_today,
              (SELECT count(*)::int FROM auth_attempts a WHERE a.user_id = u.id AND a.kind = 'staff_pin' AND NOT a.succeeded
                 AND a.created_at > now() - make_interval(mins => $3)
                 AND a.created_at > COALESCE((SELECT max(created_at) FROM auth_attempts s WHERE s.user_id = u.id AND s.kind IN ('staff_pin', 'password') AND s.succeeded), '-infinity')) AS recent_failures
         FROM users u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1 AND u.property_id = $2`,
      [userId, device.property_id, PIN_LOCK_MINUTES],
    );
    const user = rows[0];
    if (!user || !user.is_active || !user.staff_pin_hash) { await burnVerifyTime(pin); throw wrong(); }
    if (!user.password_today) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Log in with your password first today. The PIN works for the rest of the day on this desk.');
    }
    if (user.recent_failures >= PIN_FAILURES) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, `Too many wrong PINs. Log in with your password, or wait ${PIN_LOCK_MINUTES} minutes.`, { retryAfterSeconds: PIN_LOCK_MINUTES * 60 });
    }
    const ok = await verifySecret(user.staff_pin_hash, pin);
    await this.db.query(
      `INSERT INTO auth_attempts (kind, login, user_id, ip, succeeded) VALUES ('staff_pin', $1, $2, $3, $4)`,
      [user.username, user.id, ctx.ip, ok],
    );
    if (!ok) throw wrong();

    const token = newToken();
    const expiresAt = new Date(Date.now() + this.config.SESSION_HOURS_TRUSTED * 3_600_000);
    await this.db.tx({ userId: user.id }, async (q) => {
      if (currentSessionToken) {
        await q.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'desk_switch' WHERE token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash(currentSessionToken)],
        );
      }
      const { rows: s } = await q.query<{ id: string }>(
        `INSERT INTO sessions (user_id, property_id, token_hash, trusted_device_id, ip, user_agent, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [user.id, user.property_id, tokenHash(token), device.id, ctx.ip, ctx.userAgent?.slice(0, 300) ?? null, expiresAt],
      );
      await this.audit.recordSystem(q, user.property_id, {
        userId: user.id, ip: ctx.ip, requestId: ctx.requestId, action: 'auth.desk_switch', entityType: 'session', entityId: s[0]!.id,
        reason: `PIN on shared desk "${device.name}"`,
      });
    });
    return { token, user: toSessionUser(user), expiresAt };
  }

  /** Lock the desk: this session ends now. Unlocking is a PIN switch. */
  async lock(actor: Actor) {
    await this.db.tx({ userId: actor.user.id }, async (q) => {
      await q.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'desk_locked' WHERE id = $1 AND revoked_at IS NULL`, [actor.sessionId]);
      await this.audit.record(q, actor, { action: 'auth.desk_locked', entityType: 'session', entityId: actor.sessionId });
    });
  }
}
