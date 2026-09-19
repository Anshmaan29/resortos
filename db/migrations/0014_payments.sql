-- 0014 Payments, payment accounts and cashier shifts (spec §25, §26, §34).
--
-- ResortOS *records* payments; it never processes them (CLAUDE.md rule 15). Card payments happen on
-- the resort's own POS machine, UPI through its QR. What this schema has to get right is therefore
-- not money movement but bookkeeping: where the money landed, who took it, on which business date,
-- in whose shift, and what was done about it when it was wrong.
--
-- Three decisions, settled before this was written (docs/payments.md):
--
--   1. `method` and `payment_account_id` both exist and are not redundant. The method drives which
--      reference is mandatory (§25.1); the account is *where the money landed*. A constraint keeps
--      them consistent, so UPI money cannot be posted to the cash counter.
--   2. Nothing is ever updated. A wrong entry is reversed by a **new row** that points at it
--      (§25.4). The original keeps its numbers for ever, and "reversed" is derived from the
--      existence of that row rather than stored on it.
--   3. No balance is stored anywhere, here or on the folio. Every total is recalculated from rows,
--      and the nightly integrity check reports differences without repairing them (§49, §55).

-- ---------------------------------------------------------------------------
-- Where the money landed (§25.1, the old software's account-wise ledger)
-- ---------------------------------------------------------------------------

CREATE TABLE payment_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  kind            text NOT NULL CHECK (kind IN ('cash', 'bank', 'upi', 'card_pos', 'other')),
  -- Identifying details only. Never a full account number, never card data (spec §25.1).
  bank_name       text,
  account_last4   char(4) CHECK (account_last4 ~ '^\d{4}$'),
  upi_handle      text,
  pos_terminal    text,
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  version         integer NOT NULL DEFAULT 1,

  UNIQUE (property_id, id),
  CONSTRAINT payment_accounts_unique_name UNIQUE (property_id, name),
  -- Lets `payments` tie a method to an account *kind* with a plain foreign key (below).
  CONSTRAINT payment_accounts_id_kind UNIQUE (id, kind)
);
CREATE TRIGGER payment_accounts_touch BEFORE UPDATE ON payment_accounts FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER payment_accounts_no_delete BEFORE DELETE ON payment_accounts
  FOR EACH ROW EXECUTE FUNCTION forbid_change('payment accounts are deactivated, not deleted — old payments refer to them');

COMMENT ON TABLE payment_accounts IS
  'Cash counter, bank account, UPI handle or POS terminal (spec §25). Balances are never stored here: they are opening_balance plus the rows that reference the account.';

-- ---------------------------------------------------------------------------
-- Cashier shifts (spec §34)
-- ---------------------------------------------------------------------------
-- Created now, in 2.3, so that `payments.cashier_shift_id` can reference it from the first payment
-- ever recorded. 2.4 builds the open/close screens and the reconciliation on top; it needs no
-- migration of its own, and no payment is left without a shift in the meantime.

CREATE TABLE cashier_shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  business_date     date NOT NULL,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  opened_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opening_cash      numeric(14,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  closed_at         timestamptz,
  closed_by         uuid REFERENCES users(id) ON DELETE RESTRICT,
  -- What was actually counted at close, against what the rows say should be there (§34.3).
  counted_cash      numeric(14,2) CHECK (counted_cash >= 0),
  pos_batch_total   numeric(14,2) CHECK (pos_batch_total >= 0),
  -- What the rows said should be there at the moment of close, kept with the count it was judged
  -- against. The only cached totals in the money schema, and deliberately so: the nightly integrity
  -- check recalculates them from the payments in the shift and reports any difference (§55).
  expected_cash     numeric(14,2),
  expected_card     numeric(14,2),
  difference_reason text,
  handover_note     text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,

  UNIQUE (property_id, id),
  CONSTRAINT cashier_shifts_closed_recorded CHECK (
    (closed_at IS NULL AND closed_by IS NULL AND counted_cash IS NULL AND expected_cash IS NULL AND expected_card IS NULL)
    OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL AND expected_card IS NOT NULL)
  ),
  CONSTRAINT cashier_shifts_closed_after_open CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
-- One open shift per person at a time: a payment must never be ambiguous about which shift it fell in.
CREATE UNIQUE INDEX cashier_shifts_one_open_per_user ON cashier_shifts(property_id, opened_by) WHERE closed_at IS NULL;
CREATE INDEX cashier_shifts_business_date_idx ON cashier_shifts(property_id, business_date);
CREATE TRIGGER cashier_shifts_touch BEFORE UPDATE ON cashier_shifts FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER cashier_shifts_no_delete BEFORE DELETE ON cashier_shifts
  FOR EACH ROW EXECUTE FUNCTION forbid_change('shift history is kept');

-- A closed shift is locked (§34.3): the count and the reason are what the owner reviews.
CREATE FUNCTION guard_cashier_shift_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'resortos: a closed shift cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.property_id, NEW.business_date, NEW.opened_at, NEW.opened_by, NEW.opening_cash)
     IS DISTINCT FROM (OLD.property_id, OLD.business_date, OLD.opened_at, OLD.opened_by, OLD.opening_cash) THEN
    RAISE EXCEPTION 'resortos: how a shift opened is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cashier_shifts_guard BEFORE UPDATE ON cashier_shifts FOR EACH ROW EXECUTE FUNCTION guard_cashier_shift_update();

COMMENT ON TABLE cashier_shifts IS 'Cashier shifts (spec §34). Created in 2.3 so payments can reference a shift from the start; 2.4 adds the screens.';

-- ---------------------------------------------------------------------------
-- Payments (spec §25, §26)
-- ---------------------------------------------------------------------------

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  number              text NOT NULL,
  -- An advance can be taken before the guest arrives, when there is no bill yet (§26), so the
  -- folio is optional and the reservation is not. Such an advance counts on the reservation's first
  -- stay bill once there is one (`payment_folios`, below) — derived, so no row is ever re-pointed.
  folio_id            uuid,
  reservation_id      uuid NOT NULL,
  guest_id            uuid NOT NULL,

  -- payment / advance / refund       money towards (or back from) the bill
  -- deposit / deposit_refund         a security deposit held and given back — never income (§27)
  -- deposit_adjustment               part of a held deposit applied to the bill; moves no money
  entry_type          text NOT NULL CHECK (entry_type IN (
                        'payment', 'advance', 'deposit', 'refund', 'deposit_refund', 'deposit_adjustment')),
  method              text NOT NULL CHECK (method IN (
                        'cash', 'upi', 'card', 'bank_transfer', 'cheque', 'ota_prepaid', 'company_account',
                        'guest_credit', 'deposit')),
  payment_account_id  uuid,
  -- Denormalised only so the constraint below can be a plain CHECK. Kept honest by the composite
  -- foreign key, which cannot point at an account whose kind is different.
  account_kind        text,

  amount              numeric(14,2) NOT NULL CHECK (amount > 0),

  -- What this row does, computed by the database so it can never disagree with the row itself.
  -- A reversal (reverses_payment_id set) undoes exactly what the row it reverses did.
  --
  -- bill_effect     towards the guest's bill: what "Paid" on the bill adds up
  -- deposit_effect  on the security deposit held for the guest
  -- cash_effect     on the account the money landed in: what the ledger and the shift add up
  bill_effect         numeric(14,2) NOT NULL GENERATED ALWAYS AS (
                        amount
                        * (CASE entry_type WHEN 'payment' THEN 1 WHEN 'advance' THEN 1 WHEN 'deposit_adjustment' THEN 1
                                           WHEN 'refund' THEN -1 ELSE 0 END)
                        * (CASE WHEN reverses_payment_id IS NULL THEN 1 ELSE -1 END)
                      ) STORED,
  deposit_effect      numeric(14,2) NOT NULL GENERATED ALWAYS AS (
                        amount
                        * (CASE entry_type WHEN 'deposit' THEN 1 WHEN 'deposit_refund' THEN -1
                                           WHEN 'deposit_adjustment' THEN -1 ELSE 0 END)
                        * (CASE WHEN reverses_payment_id IS NULL THEN 1 ELSE -1 END)
                      ) STORED,
  cash_effect         numeric(14,2) NOT NULL GENERATED ALWAYS AS (
                        CASE WHEN payment_account_id IS NULL THEN 0 ELSE
                          amount
                          * (CASE WHEN entry_type IN ('refund', 'deposit_refund') THEN -1 ELSE 1 END)
                          * (CASE WHEN reverses_payment_id IS NULL THEN 1 ELSE -1 END)
                        END
                      ) STORED,

  reference           text,
  note                text,
  business_date       date NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  received_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cashier_shift_id    uuid,

  -- A correction is a new row pointing at the old one; nothing is ever overwritten (§25.4).
  reverses_payment_id uuid REFERENCES payments(id) ON DELETE RESTRICT,
  reversal_reason     text,
  -- Set when the entry needed Owner PIN (a refund, or a reversal on a closed business date).
  authorised_by       uuid REFERENCES users(id) ON DELETE RESTRICT,

  created_at          timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (property_id, reservation_id) REFERENCES reservations(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, folio_id) REFERENCES folios(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, guest_id) REFERENCES guests(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, cashier_shift_id) REFERENCES cashier_shifts(property_id, id) ON DELETE RESTRICT,
  -- Ties the account to its kind, so the CHECK below can trust `account_kind`.
  FOREIGN KEY (payment_account_id, account_kind) REFERENCES payment_accounts(id, kind) ON DELETE RESTRICT,

  UNIQUE (property_id, number),

  -- The money went somewhere, and it went somewhere that makes sense for the method. Company
  -- account, OTA prepaid, guest credit and a deposit adjustment move no money at the desk: they
  -- settle the bill against something else (a receivable, a credit, a deposit already banked).
  CONSTRAINT payments_account_matches_method CHECK (
    CASE method
      WHEN 'company_account' THEN payment_account_id IS NULL
      WHEN 'ota_prepaid'     THEN payment_account_id IS NULL
      WHEN 'guest_credit'    THEN payment_account_id IS NULL
      WHEN 'deposit'         THEN payment_account_id IS NULL
      WHEN 'cash'            THEN account_kind = 'cash'
      WHEN 'upi'             THEN account_kind = 'upi'
      WHEN 'card'            THEN account_kind = 'card_pos'
      WHEN 'bank_transfer'   THEN account_kind = 'bank'
      WHEN 'cheque'          THEN account_kind = 'bank'
    END
  ),
  CONSTRAINT payments_account_pair CHECK ((payment_account_id IS NULL) = (account_kind IS NULL)),
  -- A deposit adjustment, and only a deposit adjustment, is settled "by deposit".
  CONSTRAINT payments_deposit_method CHECK ((entry_type = 'deposit_adjustment') = (method = 'deposit')),
  -- Deposits are real money: taken and given back through an account (§27).
  CONSTRAINT payments_deposit_has_account CHECK (entry_type NOT IN ('deposit', 'deposit_refund') OR payment_account_id IS NOT NULL),
  -- Cash is counted at shift close (§34), so every rupee of it belongs to a shift.
  CONSTRAINT payments_cash_in_shift CHECK (method <> 'cash' OR cashier_shift_id IS NOT NULL),
  CONSTRAINT payments_reversal_has_reason CHECK (
    (reverses_payment_id IS NULL AND reversal_reason IS NULL)
    OR (reverses_payment_id IS NOT NULL AND length(btrim(reversal_reason)) >= 3)
  ),
  CONSTRAINT payments_not_self_reversing CHECK (reverses_payment_id IS NULL OR reverses_payment_id <> id)
);

-- A payment is reversed at most once. Without this, two reversals would credit the money back
-- twice, and the second would look exactly as legitimate as the first.
CREATE UNIQUE INDEX payments_one_reversal ON payments(reverses_payment_id) WHERE reverses_payment_id IS NOT NULL;
CREATE INDEX payments_folio_idx ON payments(folio_id) WHERE folio_id IS NOT NULL;
CREATE INDEX payments_reservation_idx ON payments(reservation_id);
CREATE INDEX payments_business_date_idx ON payments(property_id, business_date);
CREATE INDEX payments_shift_idx ON payments(cashier_shift_id) WHERE cashier_shift_id IS NOT NULL;
CREATE INDEX payments_account_idx ON payments(payment_account_id) WHERE payment_account_id IS NOT NULL;

-- Nothing about a payment is ever edited. A correction is a new row (§25.4).
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_change('a payment is never edited — reverse it with a reason and record the correct one');
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_change('payments are kept');

-- Money taken belongs to the shift of the person who took it, and only while that shift is open.
-- Otherwise a closed, counted and reviewed shift could quietly acquire money after the fact.
CREATE FUNCTION guard_payment_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  IF NEW.cashier_shift_id IS NULL THEN RETURN NEW; END IF;
  SELECT opened_by, closed_at INTO s FROM cashier_shifts WHERE id = NEW.cashier_shift_id FOR SHARE;
  IF s.opened_by IS DISTINCT FROM NEW.received_by THEN
    RAISE EXCEPTION 'resortos: money can only go into the shift of the person who took it' USING ERRCODE = 'check_violation';
  END IF;
  IF s.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'resortos: that shift is closed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_shift_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION guard_payment_shift();

COMMENT ON TABLE payments IS
  'Recorded payments, advances, deposits and refunds (spec §25–§27). Append-only: a correction is a new row that reverses an old one. "Reversed" is derived from that row existing, never stored.';
COMMENT ON COLUMN payments.bill_effect IS 'Database-computed effect on the bill balance (payments, advances, refunds, deposit adjustments).';
COMMENT ON COLUMN payments.deposit_effect IS 'Database-computed effect on the security deposit held (§27).';
COMMENT ON COLUMN payments.cash_effect IS 'Database-computed effect on the account the money landed in; zero when no money moved.';

-- Which bill a payment counts on. Normally its own folio_id; an advance taken before arrival has
-- none, and counts on the reservation's first stay bill once one exists (§26 "carries from
-- reservation to stay automatically"). Derived rather than stored, so no payment is ever re-pointed.
CREATE VIEW payment_folios AS
  SELECT p.id AS payment_id,
         COALESCE(p.folio_id, (
           SELECT f.id FROM folios f
            WHERE f.reservation_id = p.reservation_id AND f.kind = 'stay'
            ORDER BY f.opened_at, f.id LIMIT 1
         )) AS folio_id
    FROM payments p;

-- What the desk and the nightly integrity check both mean by "paid" (spec §49).
CREATE FUNCTION folio_paid(p_folio_id uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(p.bill_effect), 0)::numeric(14,2)
    FROM payment_folios pf JOIN payments p ON p.id = pf.payment_id
   WHERE pf.folio_id = p_folio_id
$$;

-- The security deposit held against a bill right now (§27).
CREATE FUNCTION folio_deposit_held(p_folio_id uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(p.deposit_effect), 0)::numeric(14,2)
    FROM payment_folios pf JOIN payments p ON p.id = pf.payment_id
   WHERE pf.folio_id = p_folio_id
$$;

COMMENT ON FUNCTION folio_paid(uuid) IS
  'Total paid on a bill, recalculated from the rows every time. There is deliberately no stored balance to drift (spec §49).';
