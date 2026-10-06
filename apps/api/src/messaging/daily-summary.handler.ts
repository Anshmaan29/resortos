import { Injectable } from '@nestjs/common';
import { formatDate, formatINR, money, toMoneyString } from '@resortos/shared';
import { DbService, gather, type Queryable } from '../db/db.service';
import type { OutboxEvent, OutboxHandler } from '../jobs/outbox-handlers';
import { MessagingService } from './messaging.service';

interface DayNumbers {
  occupancy: string | null;
  roomsOccupied: number | null;
  roomsActive: number | null;
  roomRevenue: string;
  food: string;
  activities: string;
  collected: string;
  byMethod: { method: string; total: string }[];
  pendingDues: string;
  cashDifference: string | null;
  needsALook: number;
  arrivalsTomorrow: number;
  departuresTomorrow: number;
}

/**
 * The owner's daily summary (spec §42): one plain-language message after the night audit closes a
 * day — occupancy, what was earned by line, what was collected by method, who left owing, the cash
 * difference, what needs a look, and what tomorrow looks like. Template-based text, no AI.
 *
 * Idempotent the same way every message is: one row per date and recipient
 * (`messages_once_per_cause`), so a replayed event sends nothing twice. Delivery itself — retries,
 * quiet hours, the provider — is the ordinary sender's job.
 */
@Injectable()
export class DailySummaryHandler implements OutboxHandler {
  readonly name = 'daily-summary';
  readonly topics = ['night_audit.completed'] as const;

  constructor(
    private readonly db: DbService,
    private readonly messaging: MessagingService,
  ) {}

  async handle(event: OutboxEvent): Promise<void> {
    const businessDate = String(event.payload.businessDate ?? '');
    if (!businessDate) return;
    await this.db.tx({}, async (q) => {
      const { rows: settings } = await q.query<{ value: unknown }>(
        `SELECT value FROM settings WHERE property_id = $1 AND key = 'daily_summary_recipients'`, [event.propertyId],
      );
      // The setting is an array of emails, or an object holding one; both come back as parsed jsonb.
      const raw = settings[0]?.value;
      const configured = Array.isArray(raw) ? (raw as string[]) : (raw as { recipients?: string[] } | null)?.recipients ?? null;
      const { rows: owners } = await q.query<{ email: string | null }>(
        `SELECT email FROM users WHERE property_id = $1 AND role = 'owner' AND is_active AND email IS NOT NULL`, [event.propertyId],
      );
      const recipients = configured ?? owners.map((o) => o.email!).filter(Boolean);
      if (!recipients.length) return; // nowhere to send it; the day log still holds the numbers

      const numbers = await this.numbers(q, event.propertyId, businessDate);
      const { rows: property } = await q.query<{ name: string }>(`SELECT name FROM properties WHERE id = $1`, [event.propertyId]);
      const body = render(businessDate, property[0]!.name, numbers);

      for (const recipient of recipients) {
        await this.messaging.queueDailySummary(q, {
          propertyId: event.propertyId, recipient, businessDate,
          subject: `${property[0]!.name} · ${formatDate(businessDate, { weekday: true })}`, body,
        });
      }
    });
  }

  private async numbers(q: Queryable, propertyId: string, date: string): Promise<DayNumbers> {
    const [summary, collected, pending, shifts, review, arrivals, departures] = await gather(q, [
      // Night audit's own facts, recorded with the run for that date.
      () => q.query<{ summary: Record<string, unknown> | null }>(
        `SELECT summary FROM night_audits WHERE property_id = $1 AND business_date = $2::date`, [propertyId, date],
      ),
      // Money taken that day, net of refunds, by method.
      () => q.query<{ method: string; total: string }>(
        `SELECT p.method, sum(p.cash_effect)::numeric(14,2) AS total
           FROM payments p
          WHERE p.property_id = $1 AND p.business_date = $2::date
          GROUP BY p.method HAVING sum(p.cash_effect) <> 0
          ORDER BY sum(p.cash_effect) DESC`,
        [propertyId, date],
      ),
      // Guests who left owing money that day (§22 pending balances).
      () => q.query<{ total: string }>(
        `SELECT COALESCE(sum(due.amount), 0)::numeric(14,2) AS total
           FROM folios f JOIN stays s ON s.id = f.stay_id
           CROSS JOIN LATERAL (
             SELECT (COALESCE((SELECT sum(CASE WHEN i.series = 'CN' THEN -i.grand_total ELSE i.grand_total END) FROM invoices i WHERE i.folio_id = f.id), 0)
                     - folio_paid(f.id))::numeric(14,2) AS amount
           ) due
          WHERE f.property_id = $1 AND f.status = 'closed' AND due.amount > 0 AND s.business_date_out = $2::date`,
        [propertyId, date],
      ),
      () => q.query<{ diff: string | null }>(
        `SELECT sum(counted_cash - expected_cash)::numeric(14,2) AS diff FROM cashier_shifts
          WHERE property_id = $1 AND business_date = $2::date AND closed_at IS NOT NULL
            AND counted_cash IS NOT NULL`, [propertyId, date],
      ),
      // "Needs a look": what the owner's review list holds for the day — the rules, no AI (§34.4).
      () => q.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM owner_overrides o WHERE o.property_id = $1 AND o.created_at::date = $2::date)
              + (SELECT count(*) FROM invoices i WHERE i.property_id = $1 AND i.series = 'CN' AND i.invoice_date = $2::date)
              + (SELECT count(*) FROM form_c_records f WHERE f.property_id = $1 AND f.status = 'pending') AS n`,
        [propertyId, date],
      ),
      () => q.query<{ n: string }>(`SELECT count(*) AS n FROM reservations WHERE property_id = $1 AND arrival = $2::date AND status IN ('confirmed', 'tentative')`, [propertyId, nextDate(date)]),
      () => q.query<{ n: string }>(`SELECT count(*) AS n FROM reservations WHERE property_id = $1 AND departure = $2::date AND status IN ('confirmed', 'checked_in')`, [propertyId, nextDate(date)]),
    ]);

    const facts = (summary.rows[0]?.summary ?? {}) as Record<string, unknown>;
    const moneyLine = (taxCategory: string) =>
      q.query<{ total: string }>(
        `SELECT COALESCE(sum(l.amount), 0)::numeric(14,2) AS total FROM folio_lines l
          LEFT JOIN folio_lines base ON base.id = l.applies_to_line_id
          WHERE l.property_id = $1 AND l.business_date = $2::date AND l.tax_category = $3
            AND l.voided_at IS NULL AND base.voided_at IS NULL`,
        [propertyId, date, taxCategory],
      );
    const [food, activities, roomRevenue] = await gather(q, [
      () => moneyLine('food'), () => moneyLine('activity'),
      () => moneyLine('accommodation'),
    ]);

    const collectedRows = collected.rows.map((r) => ({ method: r.method, total: r.total }));
    return {
      occupancy: facts.occupancyPercent !== undefined && facts.occupancyPercent !== null ? `${facts.occupancyPercent}%` : null,
      roomsOccupied: facts.roomsOccupied !== undefined ? Number(facts.roomsOccupied) : null,
      roomsActive: facts.roomsActive !== undefined ? Number(facts.roomsActive) : null,
      roomRevenue: roomRevenue.rows[0]!.total,
      food: food.rows[0]!.total,
      activities: activities.rows[0]!.total,
      collected: toMoneyString(collectedRows.reduce((t, r) => t.plus(r.total), money(0))),
      byMethod: collectedRows,
      pendingDues: pending.rows[0]!.total,
      cashDifference: shifts.rows[0]?.diff ?? null,
      needsALook: Number(review.rows[0]!.n),
      arrivalsTomorrow: Number(arrivals.rows[0]!.n),
      departuresTomorrow: Number(departures.rows[0]!.n),
    };
  }
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function render(date: string, property: string, n: DayNumbers): string {
  const lines: string[] = [];
  lines.push(`${property} · ${formatDate(date, { weekday: true })}`);
  lines.push('');
  if (n.occupancy !== null && n.roomsActive !== null && n.roomsOccupied !== null) {
    lines.push(`Occupancy      ${n.occupancy}  (${n.roomsOccupied} of ${n.roomsActive} rooms)`);
  }
  lines.push(`Room revenue   ${formatINR(n.roomRevenue)}`);
  lines.push(`Food           ${formatINR(n.food)}`);
  lines.push(`Activities     ${formatINR(n.activities)}`);
  lines.push(`Collected      ${formatINR(n.collected)}`);
  if (n.byMethod.length) {
    lines.push(`  ${n.byMethod.map((m) => `${methodLabel(m.method)} ${formatINR(m.total)}`).join(' · ')}`);
  }
  lines.push(`Pending dues   ${formatINR(n.pendingDues)}`);
  if (n.cashDifference !== null && Number(n.cashDifference) !== 0) {
    lines.push(`Cash difference ${formatINR(n.cashDifference)}`);
  }
  lines.push(`Needs a look   ${n.needsALook} item${n.needsALook === 1 ? '' : 's'}`);
  lines.push(`Tomorrow       ${n.arrivalsTomorrow} arrival${n.arrivalsTomorrow === 1 ? '' : 's'} · ${n.departuresTomorrow} departure${n.departuresTomorrow === 1 ? '' : 's'}`);
  return lines.join('\n');
}

function methodLabel(method: string): string {
  const labels: Record<string, string> = {
    cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank', cheque: 'Cheque',
    ota_prepaid: 'OTA', company_account: 'Company', guest_credit: 'Guest credit', deposit: 'Deposit',
  };
  return labels[method] ?? method;
}
