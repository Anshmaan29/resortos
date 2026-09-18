/** A recorded outbox event, exactly as it was written inside the business transaction. */
export interface OutboxEvent {
  id: string;
  propertyId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

/**
 * Work that happens *after* a business change has committed — WhatsApp, email, the Google Sheets
 * mirror, PDF generation (spec §8.2, §13). A handler can fail, and take the whole external service
 * with it, without any of that reaching a booking or a bill.
 *
 * Two rules for anything registered here:
 *
 * 1. **Be idempotent.** Delivery is at-least-once. If the process dies between doing the work and
 *    recording success, the event is delivered again. Upsert by a stable key; never "send and hope".
 * 2. **Throw to retry.** A thrown error is recorded and retried with backoff. Returning normally
 *    means the work is done, so never swallow a failure to look tidy.
 */
export interface OutboxHandler {
  /** Shown in job status and logs. */
  name: string;
  /** Topics this handler wants, or '*' for every topic. */
  topics: readonly string[] | '*';
  handle(event: OutboxEvent): Promise<void>;
}

export const OUTBOX_HANDLERS = Symbol('OUTBOX_HANDLERS');

export function handlersFor(handlers: readonly OutboxHandler[], topic: string): OutboxHandler[] {
  return handlers.filter((h) => h.topics === '*' || h.topics.includes(topic));
}

/** Retry schedule: ~15 s, 30 s, 1 min, 2 min … capped at 30 min, with jitter so retries spread out. */
export function backoffSeconds(attempts: number): number {
  const base = Math.min(1800, 15 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/** After this many attempts an event is dead-lettered: kept, visible, no longer retried. */
export const MAX_ATTEMPTS = 10;
