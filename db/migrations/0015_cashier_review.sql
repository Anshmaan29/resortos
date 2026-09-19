-- 0015 Cashier shift thresholds and the owner review list (spec §34.3, §34.4).
--
-- `cashier_shifts` itself arrived in 0014 so that the very first payment could belong to a shift.
-- This adds the two thresholds the close and the review list are judged by, and the record of what
-- the owner has already looked at.

-- Owner settings (spec §34.3, §34.4). Columns on the property, like the night audit permission,
-- because they are read on every close and every review and must never be missing.
ALTER TABLE properties
  -- A cash difference larger than this needs a reason at close, and appears on the review list.
  ADD COLUMN cash_difference_threshold numeric(14,2) NOT NULL DEFAULT 100.00 CHECK (cash_difference_threshold >= 0),
  -- A discount above this percentage appears on the review list, whoever gave it.
  ADD COLUMN review_discount_percent   numeric(5,2)  NOT NULL DEFAULT 10.00 CHECK (review_discount_percent BETWEEN 0 AND 100);

-- The owner review list is derived from the records themselves — overrides, voids, reversals,
-- shift differences — so nothing here can drift from them. The only thing stored is that the
-- owner has seen an item, and that is never taken back.
CREATE TABLE owner_review_seen (
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  -- '<kind>:<record id>', e.g. 'reversal:6f1c…'. Stable because the records it points at are.
  item_key     text NOT NULL CHECK (item_key ~ '^[a-z_]+:[0-9a-f-]{36}$'),
  seen_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, item_key)
);
CREATE TRIGGER owner_review_seen_immutable BEFORE UPDATE OR DELETE ON owner_review_seen
  FOR EACH ROW EXECUTE FUNCTION forbid_change('what the owner has reviewed is kept');

COMMENT ON TABLE owner_review_seen IS 'Owner review list items marked Seen (spec §34.4). The items themselves are derived from the records.';

-- The account-wise ledger (the old software's "Ledger Entries"): every movement of money into or out
-- of an account, whatever recorded it. Payments today; company receipts, OTA payouts and expenses
-- add themselves to this view in their own migrations, so the ledger and the shift never need to
-- know where a row came from.
CREATE VIEW account_ledger AS
  SELECT p.property_id, p.payment_account_id AS account_id, 'payment'::text AS source, p.id AS source_id,
         p.number AS reference, p.business_date, p.received_at AS at, p.received_by AS by_user,
         p.cashier_shift_id, p.cash_effect AS amount,
         p.entry_type || CASE WHEN p.reverses_payment_id IS NULL THEN '' ELSE ' reversal' END AS description
    FROM payments p
   WHERE p.payment_account_id IS NOT NULL;

COMMENT ON VIEW account_ledger IS 'Every movement of money through a payment account, from every table that records one. Balances are sums of this, never stored.';
