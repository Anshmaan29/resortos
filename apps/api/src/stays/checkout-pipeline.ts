import type { Queryable } from '../db/db.service';
import type { StayRow } from '../db/rows';
import type { Actor } from '../common/request-context';

export interface CheckoutContext {
  q: Queryable;
  actor: Actor;
  stay: StayRow;
  businessDate: string;
  /** Step-specific input from the checkout screen, keyed by step name. */
  input: Record<string, unknown>;
}

export interface CheckoutBlocker {
  step: string;
  message: string;
}

/**
 * Checkout is a stay/room status change with named extension points (spec §22).
 *
 * Phase 2 registers its steps here — e.g. `bill-review`, `settlement` (balance zero or moved to
 * a company account), `security-deposit`, `invoice-finalize` — without rewriting checkout:
 *
 *   check()  runs first for every step and returns blockers shown on the checkout screen
 *   apply()  runs in `order`, inside the same transaction, before the stay is closed
 */
export interface CheckoutStep {
  name: string;
  order: number;
  check(ctx: CheckoutContext): Promise<CheckoutBlocker[]>;
  apply?(ctx: CheckoutContext): Promise<void>;
}

export const CHECKOUT_STEPS = Symbol('CHECKOUT_STEPS');

export async function collectBlockers(steps: CheckoutStep[], ctx: CheckoutContext): Promise<CheckoutBlocker[]> {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const blockers: CheckoutBlocker[] = [];
  for (const step of sorted) blockers.push(...(await step.check(ctx)));
  return blockers;
}

export async function applySteps(steps: CheckoutStep[], ctx: CheckoutContext): Promise<string[]> {
  const applied: string[] = [];
  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    if (step.apply) {
      await step.apply(ctx);
      applied.push(step.name);
    }
  }
  return applied;
}
