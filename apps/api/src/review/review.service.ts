import { Injectable } from '@nestjs/common';
import { formatINR, toMoneyString } from '@resortos/shared';
import type { Actor } from '../common/request-context';
import { DbService } from '../db/db.service';

export interface ReviewItem {
  key: string;
  kind: 'override' | 'discount' | 'void' | 'reversal' | 'shift' | 'credit_note' | 'pending_balance';
  at: Date;
  businessDate: string | null;
  who: string;
  what: string;
  amount: string | null;
  href: string | null;
  seen: boolean;
}

/**
 * The owner review list (spec §34.4): rule-based, no AI. Every item is derived from the records
 * themselves — overrides, large discounts, removed charges, reversed payments, cash differences,
 * credit notes, guests who left owing money — so the list cannot disagree with them. The only thing
 * stored is that the owner has seen an item (`owner_review_seen`), and that is never taken back.
 *
 * Thresholds are owner settings on the property (`review_discount_percent`, `cash_difference_threshold`).
 * With no dates it is a to-do list: everything not yet marked Seen, newest first.
 */
@Injectable()
export class ReviewService {
  constructor(private readonly db: DbService) {}

  async list(actor: Actor, range: { from?: string; to?: string }, includeSeen: boolean): Promise<ReviewItem[]> {
    const { rows } = await this.db.query<{
      key: string; kind: ReviewItem['kind']; at: Date; business_date: string | null; who: string; what: string;
      amount: string | null; href: string | null; seen: boolean;
    }>(
      `WITH p AS (SELECT id, review_discount_percent, cash_difference_threshold FROM properties WHERE id = $1),
       items AS (
         -- Owner PIN overrides used (who, what).
         SELECT 'override:' || o.id AS key, 'override' AS kind, o.created_at AS at, NULL::date AS business_date,
                u.full_name || COALESCE(' · authorised by ' || a.full_name, '') AS who, o.description AS what, NULL::numeric AS amount,
                CASE o.entity_type WHEN 'reservation' THEN '/reservations/' || o.entity_id WHEN 'stay' THEN '/stays/' || o.entity_id ELSE NULL END AS href
           FROM owner_overrides o JOIN users u ON u.id = o.performed_by LEFT JOIN users a ON a.id = o.authorised_by
          WHERE o.property_id = $1 AND (\$2::date IS NULL OR o.created_at::date >= \$2::date) AND (\$3::date IS NULL OR o.created_at::date <= \$3::date)

         UNION ALL
         -- Discounts above the owner's review threshold, one item per discount given.
         SELECT 'discount:' || l.discount_group_id, 'discount', min(l.created_at), min(l.business_date),
                min(u.full_name), 'Discount of ' || max(l.discount_percent) || '% — ' || min(l.discount_reason), -sum(l.amount),
                '/stays/' || min(f.stay_id::text)
           FROM folio_lines l JOIN users u ON u.id = l.created_by JOIN folios f ON f.id = l.folio_id, p
          WHERE l.property_id = $1 AND l.line_type = 'discount' AND l.discount_percent > p.review_discount_percent
            AND (\$2::date IS NULL OR l.business_date >= \$2::date) AND (\$3::date IS NULL OR l.business_date <= \$3::date)
          GROUP BY l.discount_group_id

         UNION ALL
         -- Charges removed from a bill (discounts removed are shown with their own kind above).
         SELECT 'void:' || l.id, 'void', l.voided_at, l.business_date, v.full_name,
                'Removed ' || l.name || ' — ' || l.void_reason, l.amount, '/stays/' || f.stay_id
           FROM folio_lines l JOIN users v ON v.id = l.voided_by JOIN folios f ON f.id = l.folio_id
          WHERE l.property_id = $1 AND l.voided_at IS NOT NULL AND l.line_type <> 'discount'
            AND (\$2::date IS NULL OR l.voided_at::date >= \$2::date) AND (\$3::date IS NULL OR l.voided_at::date <= \$3::date)

         UNION ALL
         -- Payments reversed.
         SELECT 'reversal:' || r.id, 'reversal', r.received_at, r.business_date, u.full_name,
                'Reversed ' || o.number || ' — ' || r.reversal_reason, r.amount,
                CASE WHEN f.stay_id IS NOT NULL THEN '/stays/' || f.stay_id ELSE '/reservations/' || r.reservation_id END
           FROM payments r JOIN payments o ON o.id = r.reverses_payment_id JOIN users u ON u.id = r.received_by
           LEFT JOIN folios f ON f.id = o.folio_id
          WHERE r.property_id = $1 AND (\$2::date IS NULL OR r.business_date >= \$2::date) AND (\$3::date IS NULL OR r.business_date <= \$3::date)

         UNION ALL
         -- Cash differences above the threshold at shift close.
         SELECT 'shift:' || s.id, 'shift', s.closed_at, s.business_date, u.full_name,
                'Cash ' || CASE WHEN s.counted_cash < s.expected_cash THEN 'short' ELSE 'over' END || ' at shift close'
                || COALESCE(' — ' || s.difference_reason, ''), abs(s.counted_cash - s.expected_cash), '/shifts/' || s.id
           FROM cashier_shifts s JOIN users u ON u.id = s.opened_by, p
          WHERE s.property_id = $1 AND s.closed_at IS NOT NULL
            AND abs(s.counted_cash - s.expected_cash) > p.cash_difference_threshold
            AND (\$2::date IS NULL OR s.business_date >= \$2::date) AND (\$3::date IS NULL OR s.business_date <= \$3::date)

         UNION ALL
         -- Invoices corrected by credit note.
         SELECT 'credit_note:' || i.id, 'credit_note', i.finalized_at, i.invoice_date, u.full_name,
                i.number || ' against ' || o.number || ' — ' || i.reason, i.grand_total, '/invoices/' || i.id
           FROM invoices i JOIN invoices o ON o.id = i.original_invoice_id JOIN users u ON u.id = i.finalized_by
          WHERE i.property_id = $1 AND i.series = 'CN' AND (\$2::date IS NULL OR i.invoice_date >= \$2::date) AND (\$3::date IS NULL OR i.invoice_date <= \$3::date)

         UNION ALL
         -- Guests who checked out owing money (an owner-authorised pending balance, §22).
         SELECT 'pending_balance:' || f.id, 'pending_balance', f.closed_at, s.business_date_out, u.full_name,
                'Checked out owing ' || f.number, due.amount, '/stays/' || f.stay_id
           FROM folios f JOIN stays s ON s.id = f.stay_id JOIN users u ON u.id = f.closed_by
           CROSS JOIN LATERAL (
             SELECT (COALESCE((SELECT sum(CASE WHEN i.series = 'CN' THEN -i.grand_total ELSE i.grand_total END) FROM invoices i WHERE i.folio_id = f.id), 0)
                     - folio_paid(f.id))::numeric(14,2) AS amount
           ) due
          WHERE f.property_id = $1 AND f.status = 'closed' AND due.amount > 0
            AND (\$2::date IS NULL OR s.business_date_out >= \$2::date) AND (\$3::date IS NULL OR s.business_date_out <= \$3::date)
       )
       SELECT items.*, (seen.item_key IS NOT NULL) AS seen
         FROM items LEFT JOIN owner_review_seen seen ON seen.property_id = $1 AND seen.item_key = items.key
        WHERE $4 OR seen.item_key IS NULL
        ORDER BY items.at DESC
        LIMIT 500`,
      [actor.user.propertyId, range.from ?? null, range.to ?? null, includeSeen],
    );
    return rows.map((r) => ({
      key: r.key, kind: r.kind, at: r.at, businessDate: r.business_date, who: r.who,
      what: r.kind === 'shift' && r.amount ? `${r.what} by ${formatINR(r.amount)}` : r.what,
      amount: r.amount === null ? null : toMoneyString(r.amount), href: r.href, seen: r.seen,
    }));
  }

  /** Mark items Seen. Idempotent: marking an item twice keeps the first mark. */
  async markSeen(actor: Actor, keys: string[]) {
    return this.db.tx({ userId: actor.user.id }, async (q) => {
      await q.query(
        `INSERT INTO owner_review_seen (property_id, item_key, seen_by)
         SELECT $1, k, $2 FROM unnest($3::text[]) AS k
         ON CONFLICT (property_id, item_key) DO NOTHING`,
        [actor.user.propertyId, actor.user.id, keys],
      );
      return { seen: keys.length };
    });
  }
}
