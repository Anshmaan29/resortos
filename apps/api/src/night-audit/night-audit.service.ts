import { Inject, Injectable } from '@nestjs/common';
import { addDays, ERROR_CODES, formatDate, type CompleteNightAuditInput } from '@resortos/shared';
import { AuditService } from '../common/audit.service';
import { AppError, forbidden } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import type { Actor } from '../common/request-context';
import { DbService, type Queryable } from '../db/db.service';
import { PropertyService } from '../property/property.service';
import {
  inOrder, NIGHT_AUDIT_STEPS,
  type NightAuditContext, type NightAuditItem, type NightAuditStep, type StepResult,
} from './night-audit-pipeline';

interface RunRow {
  id: string;
  business_date: string;
  started_at: Date;
  completed_at: Date;
  completed_by: string;
  steps: StoredStep[];
  summary: Record<string, unknown>;
}

export interface StoredStep {
  name: string;
  title: string;
  posted: number;
  skipped: number;
  details?: Record<string, unknown>;
}

const mapRun = (r: RunRow & { completed_by_name?: string }) => ({
  id: r.id,
  businessDate: r.business_date,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  completedBy: r.completed_by_name ?? r.completed_by,
  steps: r.steps,
  summary: r.summary,
});

@Injectable()
export class NightAuditService {
  constructor(
    private readonly db: DbService,
    private readonly property: PropertyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(NIGHT_AUDIT_STEPS) private readonly steps: NightAuditStep[],
  ) {}

  /** Who may complete an audit: the owner always, a receptionist only if the owner allows it (§35.2). */
  private async assertMayRun(q: Queryable, actor: Actor): Promise<void> {
    if (actor.user.role === 'owner') return;
    const { rows } = await q.query<{ allowed: boolean }>(
      `SELECT receptionist_can_run_night_audit AS allowed FROM properties WHERE id = $1`, [actor.user.propertyId],
    );
    if (!rows[0]?.allowed) throw forbidden('Only the owner can run night audit. Ask the owner to run it, or to allow it in settings.');
  }

  /**
   * The night audit screen: every step's read-only report for the current business date. Safe to
   * poll, and it never writes — which is why resolving a blocker and re-reading gives an honest
   * answer rather than a cached one.
   */
  async preview(actor: Actor) {
    const propertyId = actor.user.propertyId;
    const businessDate = await this.property.businessDate(this.db, propertyId);
    const existing = await this.runFor(this.db, propertyId, businessDate);
    const ctx: NightAuditContext = { q: this.db, actor, propertyId, businessDate };

    const steps = [];
    let blocked = false;
    let facts: Record<string, unknown> = {};
    for (const step of inOrder(this.steps)) {
      const report = await step.inspect(ctx);
      if (step.blocking && report.items.length) blocked = true;
      facts = { ...facts, ...report.facts };
      steps.push({
        name: step.name, title: step.title, blocking: step.blocking,
        items: report.items, warnings: report.warnings, willDo: report.willDo,
      });
    }

    return {
      businessDate,
      nextBusinessDate: addDays(businessDate, 1),
      // A closed date can never be re-audited; the screen says so rather than offering a button
      // that would fail on the unique constraint.
      alreadyCompleted: existing ? mapRun(existing) : null,
      canComplete: !existing && !blocked,
      blocked,
      steps,
      summary: facts,
      mayRun: actor.user.role === 'owner' || (await this.receptionistAllowed(propertyId)),
    };
  }

  private async receptionistAllowed(propertyId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ allowed: boolean }>(
      `SELECT receptionist_can_run_night_audit AS allowed FROM properties WHERE id = $1`, [propertyId],
    );
    return !!rows[0]?.allowed;
  }

  private async runFor(q: Queryable, propertyId: string, businessDate: string): Promise<RunRow | undefined> {
    const { rows } = await q.query<RunRow & { completed_by_name: string }>(
      `SELECT na.*, u.full_name AS completed_by_name FROM night_audits na
         JOIN users u ON u.id = na.completed_by
        WHERE na.property_id = $1 AND na.business_date = $2::date`,
      [propertyId, businessDate],
    );
    return rows[0];
  }

  /**
   * Complete the audit for the current business date: everything or nothing, in one transaction.
   *
   * Four independent defences stop a date being closed twice, because the business date is what the
   * whole of Phase 2 attributes money to (docs/night-audit.md):
   *
   *   1. `FOR UPDATE` on the property row, so two people pressing Complete serialise.
   *   2. `UNIQUE (property_id, business_date)` on `night_audits` — the database, not this code.
   *   3. A compare-and-swap on the date itself, so it cannot advance twice.
   *   4. The `guard_business_date` trigger, which refuses any backwards move.
   *
   * Plus the idempotency key every mutation carries, which returns the first result to a retry.
   */
  async complete(q: Queryable, actor: Actor, input: CompleteNightAuditInput) {
    const propertyId = actor.user.propertyId;
    await this.assertMayRun(q, actor);

    // (1) Serialise concurrent audits. Everything below reads the date under this lock.
    //
    // FOR NO KEY UPDATE, not FOR UPDATE: every table in the schema has a foreign key to
    // `properties`, so every insert anywhere takes a KEY SHARE lock on this row. FOR UPDATE blocks
    // those, and that is enough to deadlock — an audit holding this row waits for the audit-chain
    // advisory lock, while the transaction holding that lock waits to insert a row whose foreign
    // key needs this one. FOR NO KEY UPDATE still conflicts with itself, so two audits serialise
    // exactly as intended, but it lets unrelated inserts through. We never change the key here.
    const { rows: locked } = await q.query<{ current_business_date: string }>(
      `SELECT current_business_date FROM properties WHERE id = $1 FOR NO KEY UPDATE`, [propertyId],
    );
    if (!locked[0]) throw new AppError(ERROR_CODES.NOT_FOUND, 'Property was not found.');
    const businessDate = input.businessDate;

    // The caller names the date it was looking at. Whoever gets the lock second finds the date has
    // already moved and is told so, instead of closing tomorrow as well — which is what would
    // happen if this simply closed "whatever date is current now".
    if (locked[0].current_business_date !== businessDate) {
      const closed = await this.runFor(q, propertyId, businessDate);
      if (closed) return { alreadyCompleted: true, run: mapRun(closed) };
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `The business date is now ${formatDate(locked[0].current_business_date)}, not ${formatDate(businessDate)}. Reload the night audit screen.`,
        { businessDate: locked[0].current_business_date, attempted: businessDate },
      );
    }

    // Belt and braces: the date is current and not yet closed.
    const existing = await this.runFor(q, propertyId, businessDate);
    if (existing) return { alreadyCompleted: true, run: mapRun(existing) };

    const ctx: NightAuditContext = { q, actor, propertyId, businessDate };

    const blockers: { step: string; title: string; items: NightAuditItem[] }[] = [];
    let facts: Record<string, unknown> = {};
    const reports = [];
    for (const step of inOrder(this.steps)) {
      const report = await step.inspect(ctx);
      facts = { ...facts, ...report.facts };
      reports.push({ step, report });
      if (step.blocking && report.items.length) blockers.push({ step: step.name, title: step.title, items: report.items });
    }

    if (blockers.length) {
      const total = blockers.reduce((n, b) => n + b.items.length, 0);
      throw new AppError(
        ERROR_CODES.VALIDATION,
        `${total} thing${total === 1 ? '' : 's'} still need attention before ${formatDate(businessDate)} can be closed: ${blockers.map((b) => b.title.toLowerCase()).join(', ')}.`,
        { businessDate, blockers },
      );
    }

    const stored: StoredStep[] = [];
    for (const { step, report } of reports) {
      const result: StepResult = step.run ? await step.run(ctx) : { posted: 0, skipped: 0 };
      stored.push({ name: step.name, title: step.title, posted: result.posted, skipped: result.skipped, details: result.details ?? undefined });
      void report;
    }

    // (3) Compare-and-swap. Zero rows means the date moved under us despite the lock — refuse
    // rather than record a run against a date we did not actually close.
    const next = addDays(businessDate, 1);
    const { rowCount } = await q.query(
      `UPDATE properties SET current_business_date = $3::date
        WHERE id = $1 AND current_business_date = $2::date`,
      [propertyId, businessDate, next],
    );
    if (!rowCount) throw new AppError(ERROR_CODES.CONFLICT, 'The business date changed while the audit was running. Reload and check the day audit log.');

    // (2) The unique constraint is the real guarantee; this insert is where it bites.
    const { rows: runRows } = await q.query<RunRow>(
      // Both times come from the database, never from this process's clock: mixing the two is how
      // a machine whose clock drifts writes a run that finished before it started (the same reason
      // login throttling does all its time arithmetic in SQL). transaction_timestamp() is when the
      // request began; clock_timestamp() is now, so the two together give a real duration.
      `INSERT INTO night_audits (property_id, business_date, started_at, completed_at, completed_by, steps, summary)
       VALUES ($1, $2::date, transaction_timestamp(), clock_timestamp(), $3, $4::jsonb, $5::jsonb) RETURNING *`,
      [propertyId, businessDate, actor.user.id, JSON.stringify(stored), JSON.stringify(facts)],
    );
    const run = runRows[0]!;

    await this.audit.record(q, actor, {
      action: 'night_audit.completed', entityType: 'night_audit', entityId: run.id,
      after: { businessDate, nextBusinessDate: next, steps: stored, summary: facts },
    });
    // Completion is what triggers the owner daily summary, the Sheets mirror, the metric refresh
    // and the backup check (§35.2) — all after commit, none able to break the audit.
    await this.outbox.emit(q, propertyId, 'night_audit.completed', { type: 'night_audit', id: run.id }, { businessDate, nextBusinessDate: next, summary: facts });

    return { alreadyCompleted: false, run: mapRun({ ...run, completed_by_name: actor.user.fullName }) };
  }

  /**
   * A refused attempt is recorded too, in its own transaction: "tried at 11 PM, blocked by two
   * departures" is exactly what the owner wants to see the next morning, and it would be rolled
   * back if it were written inside the attempt that failed.
   */
  async recordRefusal(actor: Actor, details: Record<string, unknown>): Promise<void> {
    await this.db.tx({ userId: actor.user.id, reason: 'Night audit refused' }, async (q) => {
      await this.audit.record(q, actor, {
        action: 'night_audit.refused', entityType: 'night_audit', entityId: actor.user.propertyId, after: details,
      });
    });
  }

  /** The Day Audit Log: every closed business date, newest first. */
  async log(propertyId: string, limit = 60) {
    const { rows } = await this.db.query<RunRow & { completed_by_name: string }>(
      `SELECT na.*, u.full_name AS completed_by_name FROM night_audits na
         JOIN users u ON u.id = na.completed_by
        WHERE na.property_id = $1 ORDER BY na.business_date DESC LIMIT $2`,
      [propertyId, limit],
    );
    return rows.map(mapRun);
  }
}
