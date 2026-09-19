import { Injectable } from '@nestjs/common';
import { formatINR } from '@resortos/shared';
import { emptyReport, type NightAuditContext, type NightAuditStep, type StepReport } from '../night-audit/night-audit-pipeline';

/**
 * Step 3 (spec §35.1): open cashier shifts must be closed. A day whose cash has not been counted
 * cannot be summarised, and a shift left open across the audit would carry money into a date that
 * is already closed.
 */
@Injectable()
export class OpenShiftsStep implements NightAuditStep {
  readonly name = 'open_shifts';
  readonly title = 'Open cashier shifts';
  readonly order = 30;
  readonly blocking = true;

  async inspect({ q, propertyId }: NightAuditContext): Promise<StepReport> {
    const { rows } = await q.query<{ id: string; opened_by_name: string; opened_at: Date; opening_cash: string }>(
      `SELECT s.id, u.full_name AS opened_by_name, s.opened_at, s.opening_cash
         FROM cashier_shifts s JOIN users u ON u.id = s.opened_by
        WHERE s.property_id = $1 AND s.closed_at IS NULL
        ORDER BY s.opened_at`,
      [propertyId],
    );
    const { rows: byMethod } = await q.query<{ method: string; total: string }>(
      `SELECT p.method, sum(p.cash_effect)::numeric(14,2) AS total
         FROM payments p JOIN properties pr ON pr.id = p.property_id
        WHERE p.property_id = $1 AND p.business_date = pr.current_business_date AND p.payment_account_id IS NOT NULL
        GROUP BY p.method ORDER BY p.method`,
      [propertyId],
    );
    return {
      ...emptyReport(),
      items: rows.map((r) => ({
        id: r.id,
        label: `${r.opened_by_name}'s shift · opened with ${formatINR(r.opening_cash)}`,
        href: `/shifts/${r.id}`,
        actions: ['close_shift'],
      })),
      facts: {
        openShifts: rows.length,
        // Payments by method for the summary (§35.1 step 6), recalculated from rows.
        paymentsByMethod: Object.fromEntries(byMethod.map((m) => [m.method, m.total])),
      },
    };
  }
}
