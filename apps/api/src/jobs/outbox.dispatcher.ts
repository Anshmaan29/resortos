import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { backoffSeconds, handlersFor, MAX_ATTEMPTS, OUTBOX_HANDLERS, type OutboxEvent, type OutboxHandler } from './outbox-handlers';

interface OutboxRow {
  id: string;
  property_id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
}

export interface DrainResult {
  claimed: number;
  dispatched: number;
  retrying: number;
  deadLettered: number;
  /** True when the batch was full, so there is probably more waiting. */
  more: boolean;
}

const BATCH = 20;

/**
 * Drains `outbox_events` (spec §8.2).
 *
 * The event row *is* the job: it was written inside the business transaction, so it cannot exist
 * for work that rolled back, and it cannot go missing for work that committed. Nothing here ever
 * deletes a row — an event ends up dispatched or dead-lettered, and both are kept.
 *
 * Delivery is **at-least-once**. A claim defers the event before the handler runs, so a process
 * that dies mid-handler leaves the event to be retried rather than spinning on it; the cost is that
 * a handler may see the same event twice, which is why handlers must be idempotent.
 *
 * Every deadline is computed by PostgreSQL (`now() + interval`), never from this process's clock.
 * Workers run on more than one machine, and an app clock that drifts must not be able to make an
 * event retry early, late, or never.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly db: DbService,
    @Inject(OUTBOX_HANDLERS) private readonly handlers: OutboxHandler[],
  ) {}

  /** Claims a batch of due events and runs them. Safe to run concurrently: rows are claimed with SKIP LOCKED. */
  async drainOnce(limit = BATCH): Promise<DrainResult> {
    const { rows } = await this.db.query<OutboxRow>(
      `UPDATE outbox_events o
          SET attempts = o.attempts + 1,
              available_at = now() + make_interval(secs => $2)
        WHERE o.id IN (
          SELECT id FROM outbox_events
           WHERE dispatched_at IS NULL AND failed_at IS NULL AND available_at <= now()
           ORDER BY available_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
      RETURNING o.id, o.property_id, o.topic, o.aggregate_type, o.aggregate_id, o.payload, o.attempts, o.created_at`,
      [limit, backoffSeconds(1)],
    );

    const result: DrainResult = { claimed: rows.length, dispatched: 0, retrying: 0, deadLettered: 0, more: rows.length === limit };

    for (const row of rows) {
      const event: OutboxEvent = {
        id: row.id,
        propertyId: row.property_id,
        topic: row.topic,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload ?? {},
        attempts: row.attempts,
        createdAt: row.created_at,
      };
      const matched = handlersFor(this.handlers, event.topic);
      try {
        // No handler is a real outcome, not a failure: the topic exists, nothing wants it yet.
        // Messaging and the Sheets mirror register handlers in Phase 3.
        for (const handler of matched) await handler.handle(event);
        await this.db.query(
          `UPDATE outbox_events SET dispatched_at = now(), last_error = NULL WHERE id = $1`, [event.id],
        );
        result.dispatched += 1;
      } catch (err) {
        const message = (err as Error).message?.slice(0, 500) ?? 'unknown error';
        const dead = event.attempts >= MAX_ATTEMPTS;
        await this.db.query(
          dead
            ? `UPDATE outbox_events SET failed_at = now(), last_error = $2 WHERE id = $1`
            : `UPDATE outbox_events SET available_at = now() + make_interval(secs => $3), last_error = $2 WHERE id = $1`,
          dead ? [event.id, message] : [event.id, message, backoffSeconds(event.attempts)],
        );
        if (dead) {
          result.deadLettered += 1;
          this.logger.error(`Outbox event ${event.topic} gave up after ${event.attempts} attempts: ${message}`);
        } else {
          result.retrying += 1;
          this.logger.warn(`Outbox event ${event.topic} failed (attempt ${event.attempts}), will retry: ${message}`);
        }
      }
    }
    return result;
  }

  /** What the operator and, later, the owner's Data Safety panel need to know. */
  async status() {
    const { rows } = await this.db.query<{
      pending: string; due: string; retrying: string; dead: string; dispatched: string; oldest_pending_seconds: string | null;
    }>(
      `SELECT count(*) FILTER (WHERE dispatched_at IS NULL AND failed_at IS NULL)                        AS pending,
              count(*) FILTER (WHERE dispatched_at IS NULL AND failed_at IS NULL AND available_at <= now()) AS due,
              count(*) FILTER (WHERE dispatched_at IS NULL AND failed_at IS NULL AND attempts > 0)       AS retrying,
              count(*) FILTER (WHERE failed_at IS NOT NULL)                                             AS dead,
              count(*) FILTER (WHERE dispatched_at IS NOT NULL)                                          AS dispatched,
              EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE dispatched_at IS NULL AND failed_at IS NULL))) AS oldest_pending_seconds
         FROM outbox_events`,
    );
    const counts = rows[0]!;

    const { rows: topics } = await this.db.query<{ topic: string; n: string }>(
      `SELECT topic, count(*) AS n FROM outbox_events GROUP BY topic ORDER BY topic`,
    );
    const registered = this.handlers.some((h) => h.topics === '*');

    return {
      pending: Number(counts.pending),
      due: Number(counts.due),
      retrying: Number(counts.retrying),
      deadLettered: Number(counts.dead),
      dispatched: Number(counts.dispatched),
      oldestPendingSeconds: counts.oldest_pending_seconds === null ? null : Math.round(Number(counts.oldest_pending_seconds)),
      handlers: this.handlers.map((h) => ({ name: h.name, topics: h.topics })),
      // Honest about the current state: events are recorded correctly and nothing wants them yet.
      topicsWithoutHandler: registered ? [] : topics.filter((t) => handlersFor(this.handlers, t.topic).length === 0).map((t) => t.topic),
    };
  }
}
