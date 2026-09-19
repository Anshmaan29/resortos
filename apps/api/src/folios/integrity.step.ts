import { Injectable } from '@nestjs/common';
import { formatDate } from '@resortos/shared';
import { emptyReport, type NightAuditContext, type NightAuditStep, type StepReport } from '../night-audit/night-audit-pipeline';

/**
 * Nightly integrity check (spec §55) — **reports, never repairs**.
 *
 * A job that quietly fixed what it found would destroy the only evidence that something is wrong,
 * and the thing it "fixed" might have been the correct value. Findings are shown to the owner and
 * left exactly as they are.
 *
 * Almost no balance is stored: the bill total, the amount paid, the deposit held and every account
 * balance are recalculated from rows on every read (§49). The one cached copy is what a closed
 * cashier shift was judged against, and that is recalculated here and compared. The rest of the
 * check is the set of things that genuinely can go wrong — money attached to the wrong booking, a
 * reversal that does not match what it reverses, money on a day already closed, a deposit or a
 * guest credit that has gone below zero.
 */
@Injectable()
export class BalanceIntegrityStep implements NightAuditStep {
  readonly name = 'integrity_check';
  readonly title = 'Integrity check';
  readonly order = 60;
  readonly blocking = false;

  async inspect({ q, propertyId, businessDate }: NightAuditContext): Promise<StepReport> {
    const { rows } = await q.query<{ kind: string; detail: string }>(
      `-- A payment whose bill belongs to a different booking: the money is attached to the wrong guest.
       SELECT 'payment_folio_mismatch' AS kind,
              p.number || ' is on a bill for a different booking' AS detail
         FROM payments p JOIN folios f ON f.id = p.folio_id
        WHERE p.property_id = $1 AND f.reservation_id <> p.reservation_id

       UNION ALL
       -- A reversal must undo exactly what it reverses; anything else changes the books silently.
       SELECT 'reversal_mismatch',
              r.number || ' does not match ' || o.number || ' that it reverses'
         FROM payments r JOIN payments o ON o.id = r.reverses_payment_id
        WHERE r.property_id = $1
          AND (r.amount, r.method, r.entry_type, r.payment_account_id)
              IS DISTINCT FROM (o.amount, o.method, o.entry_type, o.payment_account_id)

       UNION ALL
       -- Money written onto a day *after* night audit had summarised and reported it. Rows dated
       -- a closed day are normal; rows that arrived there after it closed are not.
       SELECT 'money_on_closed_date',
              p.number || ' was recorded on ' || to_char(p.business_date, 'DD Mon YYYY') || ' after that day was closed'
         FROM payments p
         JOIN night_audits na ON na.property_id = p.property_id AND na.business_date = p.business_date
        WHERE p.property_id = $1 AND p.created_at > na.completed_at

       UNION ALL
       -- Same, for charges.
       SELECT 'charge_on_closed_date',
              l.name || ' was added to ' || to_char(l.business_date, 'DD Mon YYYY') || ' after that day was closed'
         FROM folio_lines l
         JOIN night_audits na ON na.property_id = l.property_id AND na.business_date = l.business_date
        WHERE l.property_id = $1 AND l.voided_at IS NULL AND l.created_at > na.completed_at

       UNION ALL
       -- A closed shift's stored expected cash and card, recalculated from the rows in it.
       SELECT 'shift_expected_mismatch',
              'Shift closed ' || to_char(s.closed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' by ' || u.full_name
              || ' was closed against ₹' || s.expected_cash || ' cash / ₹' || s.expected_card
              || ' card, but its payments now add up to ₹' || calc.cash || ' / ₹' || calc.card
         FROM cashier_shifts s
         JOIN users u ON u.id = s.closed_by
         CROSS JOIN LATERAL (
           SELECT (s.opening_cash + COALESCE(sum(l.amount) FILTER (WHERE a.kind = 'cash'), 0))::numeric(14,2) AS cash,
                  COALESCE(sum(l.amount) FILTER (WHERE a.kind = 'card_pos'), 0)::numeric(14,2) AS card
             FROM account_ledger l JOIN payment_accounts a ON a.id = l.account_id
            WHERE l.cashier_shift_id = s.id
         ) calc
        WHERE s.property_id = $1 AND s.closed_at IS NOT NULL
          AND (calc.cash, calc.card) IS DISTINCT FROM (s.expected_cash, s.expected_card)

       UNION ALL
       -- More security deposit given back or applied than was ever taken.
       SELECT 'deposit_negative',
              'Bill ' || f.number || ' has ₹' || folio_deposit_held(f.id) || ' of deposit held'
         FROM folios f
        WHERE f.property_id = $1 AND folio_deposit_held(f.id) < 0

       UNION ALL
       -- More guest credit used than the guest was ever given.
       SELECT 'guest_credit_negative',
              'A guest has used ₹' || (-sum(c.amount)) || ' more credit than they had'
         FROM guest_credit_entries c
        WHERE c.property_id = $1
        GROUP BY c.guest_id HAVING sum(c.amount) < 0

       UNION ALL
       -- A guest still in house whose bill was closed: charges would have nowhere to go.
       SELECT 'closed_bill_in_house',
              'Bill ' || f.number || ' is closed but the guest is still in house'
         FROM folios f JOIN stays s ON s.id = f.stay_id
        WHERE f.property_id = $1 AND f.status = 'closed' AND s.status = 'in_house'
       ORDER BY 1, 2`,
      [propertyId],
    );

    return {
      ...emptyReport(),
      warnings: rows.map((r) => r.detail),
      willDo: rows.length
        ? `Record ${rows.length} thing${rows.length === 1 ? '' : 's'} to look at — nothing will be changed automatically`
        : `Nothing to report for ${formatDate(businessDate)}`,
      facts: { integrityFindings: rows.length },
    };
  }
}
