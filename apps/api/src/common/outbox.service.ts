import { Injectable } from '@nestjs/common';
import type { Queryable } from '../db/db.service';

/**
 * Transactional outbox (spec §8.2). Events are written in the same transaction as the
 * business change; workers (WhatsApp, Sheets, PDFs) pick them up only after commit.
 */
@Injectable()
export class OutboxService {
  async emit(
    q: Queryable,
    propertyId: string,
    topic: string,
    aggregate: { type: string; id: string | null },
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await q.query(
      `INSERT INTO outbox_events (property_id, topic, aggregate_type, aggregate_id, payload) VALUES ($1,$2,$3,$4,$5)`,
      [propertyId, topic, aggregate.type, aggregate.id, JSON.stringify(payload)],
    );
  }
}
