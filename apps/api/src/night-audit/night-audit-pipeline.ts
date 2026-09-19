import type { Queryable } from '../db/db.service';
import type { Actor } from '../common/request-context';

export interface NightAuditContext {
  q: Queryable;
  actor: Actor;
  propertyId: string;
  /** The business date being closed — not today's date. */
  businessDate: string;
}

/** One row the desk has to deal with before the audit can complete. */
export interface NightAuditItem {
  id: string;
  /** Staff words: 'BK-000007 · Room 104 · Kavya Reddy'. */
  label: string;
  /** Where the desk goes to fix it. */
  href: string | null;
  /** Which resolutions this row offers, e.g. ['no_show', 'extend_arrival', 'cancel']. */
  actions: string[];
}

export interface StepReport {
  /** Non-empty on a blocking step means the audit cannot complete. */
  items: NightAuditItem[];
  /** Worth seeing, never a reason to stop. */
  warnings: string[];
  /** What `run()` will do, in staff words, or null if it does nothing. */
  willDo: string | null;
  /** Merged into the run's stored summary. Later milestones add revenue and payments this way. */
  facts: Record<string, unknown>;
}

export interface StepResult {
  posted: number;
  skipped: number;
  details?: Record<string, unknown>;
}

/**
 * Night audit is a sequence of named steps (spec §35.1), contributed the way checkout steps and
 * outbox handlers are, so that later milestones extend the audit without editing it: **2.2 registers
 * room-night posting, 2.4 registers the open-shift check**, and the screen renders whatever is
 * registered rather than showing steps that quietly do nothing.
 *
 * Two rules for anything registered here:
 *
 * 1. **`inspect()` must not write.** It runs on every poll of the night audit screen.
 * 2. **`run()` must be idempotent.** It runs inside the completion transaction, and the suite
 *    replays every step against an already-closed date to prove nothing posts twice. A step that
 *    inserts rows must be protected by a database constraint, not by checking first.
 */
export interface NightAuditStep {
  name: string;
  /** Staff-facing, shown on the screen. */
  title: string;
  order: number;
  /** A blocking step with items refuses completion; a non-blocking one only reports. */
  blocking: boolean;
  inspect(ctx: NightAuditContext): Promise<StepReport>;
  run?(ctx: NightAuditContext): Promise<StepResult>;
}

export const NIGHT_AUDIT_STEPS = Symbol('NIGHT_AUDIT_STEPS');

export const emptyReport = (): StepReport => ({ items: [], warnings: [], willDo: null, facts: {} });

export const inOrder = (steps: readonly NightAuditStep[]): NightAuditStep[] =>
  [...steps].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
