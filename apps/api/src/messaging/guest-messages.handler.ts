import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import type { OutboxEvent, OutboxHandler } from '../jobs/outbox-handlers';
import { MessagingService } from './messaging.service';
import { WhatsAppService } from './whatsapp.service';
import type { TemplateKey } from './templates';

/**
 * Turns business events into queued guest messages (spec §40). It only writes message rows — the
 * sender delivers them — so this handler touches no network and can safely be delivered twice:
 * the cause key (`event:<outbox id>` or the booking itself) makes the second delivery a no-op.
 */
@Injectable()
export class GuestMessagesHandler implements OutboxHandler {
  readonly name = 'guest-messages';
  readonly topics = ['reservation.created', 'reservation.confirmed', 'stay.checked_in', 'invoice.issued', 'payment.recorded'] as const;

  constructor(private readonly db: DbService, private readonly messaging: MessagingService, private readonly whatsapp: WhatsAppService) {}

  async handle(event: OutboxEvent): Promise<void> {
    const plan = await this.plan(event);
    if (!plan) return;
    await this.db.tx({}, async q => {
      const req = { propertyId: event.propertyId, trigger: 'event' as const, ...plan };
      await this.messaging.queue(q, req);
      await this.whatsapp.queue(q, req);
    });
  }

  private async plan(event: OutboxEvent): Promise<{ templateKey: TemplateKey; sourceKey: string; reservationId?: string; stayId?: string; invoiceId?: string; paymentId?: string } | null> {
    switch (event.topic) {
      case 'reservation.created':
      case 'reservation.confirmed': {
        // Every confirmed booking, including walk-ins, gets one confirmation. Tentative bookings
        // wait until confirmed. Replayed events cannot send the same confirmation twice.
        const { rows } = await this.db.query<{ status: string }>(
          'SELECT status FROM reservations WHERE id = $1 AND property_id = $2',
          [event.aggregateId, event.propertyId],
        );
        if (!rows[0] || rows[0].status !== 'confirmed') return null;
        return { templateKey: 'booking_confirmation', sourceKey: `reservation:${event.aggregateId}:confirmation`, reservationId: event.aggregateId! };
      }
      case 'stay.checked_in': {
        // One welcome per booking, even when a family checks into three rooms at once.
        const reservationId = String(event.payload.reservationId ?? '');
        if (!reservationId) return null;
        return { templateKey: 'check_in_welcome', sourceKey: `reservation:${reservationId}:welcome`, reservationId, stayId: event.aggregateId! };
      }
      case 'invoice.issued': {
        // The thank-you with the invoice goes for the invoice itself, not for credit or debit notes.
        if (!['tax_invoice', 'bill_of_supply'].includes(String(event.payload.documentType))) return null;
        return { templateKey: 'invoice', sourceKey: `invoice:${event.aggregateId}`, invoiceId: event.aggregateId! };
      }
      case 'payment.recorded': {
        // A receipt for money received — not for a refund, and not for a settlement that moved no money.
        const { rows } = await this.db.query<{ entry_type: string; payment_account_id: string | null }>(
          `SELECT entry_type, payment_account_id FROM payments WHERE id = $1`, [event.aggregateId],
        );
        const p = rows[0];
        if (!p || !['payment', 'advance', 'deposit'].includes(p.entry_type) || !p.payment_account_id) return null;
        return { templateKey: 'receipt', sourceKey: `payment:${event.aggregateId}`, paymentId: event.aggregateId! };
      }
      default:
        return null;
    }
  }
}
