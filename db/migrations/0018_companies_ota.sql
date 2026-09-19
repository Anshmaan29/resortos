-- 0018 Company billing and OTA tracking (spec §32, §33).
--
-- A company account is a receivable: a guest's bill is settled "to the company" (a payment with
-- method company_account that moves no money), and the company pays later, into a real account. The
-- company's statement is those two sets of rows and nothing else — no stored balance.
--
-- An OTA booking is the same shape: the guest's bill is settled "prepaid via OTA", and the OTA's
-- payout arrives later, less its commission and taxes. ResortOS tracks both; it connects to no OTA.

-- ---------------------------------------------------------------------------
-- Companies (spec §32)
-- ---------------------------------------------------------------------------

CREATE TABLE companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  gstin               char(15) CHECK (gstin IS NULL OR gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  billing_address     text,
  contact_person      text,
  phone               text,
  email               citext,
  credit_limit        numeric(14,2) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  payment_terms_days  integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users(id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (property_id, id),
  CONSTRAINT companies_unique_name UNIQUE (property_id, name)
);
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER companies_no_delete BEFORE DELETE ON companies
  FOR EACH ROW EXECUTE FUNCTION forbid_change('companies are deactivated, not deleted — their statements refer to them');

-- A bill settled to a company names the company. Every company_account payment must, and nothing
-- else may. (No company_account payment exists before this migration outside a test database.)
ALTER TABLE payments ADD COLUMN company_id uuid;
ALTER TABLE payments
  ADD CONSTRAINT payments_company_fk FOREIGN KEY (property_id, company_id) REFERENCES companies(property_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT payments_company_when_company_account CHECK ((method = 'company_account') = (company_id IS NOT NULL));
CREATE INDEX payments_company_idx ON payments(company_id) WHERE company_id IS NOT NULL;

-- The invoice records which company it was made out to, when it was.
ALTER TABLE invoices ADD COLUMN company_id uuid;
ALTER TABLE invoices ADD CONSTRAINT invoices_company_fk FOREIGN KEY (property_id, company_id) REFERENCES companies(property_id, id) ON DELETE RESTRICT;

-- Money a company pays against its account, into a real account. Append-only like payments.
CREATE TABLE company_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  number              text NOT NULL,
  company_id          uuid NOT NULL,
  method              text NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque')),
  payment_account_id  uuid NOT NULL,
  account_kind        text NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  cash_effect         numeric(14,2) NOT NULL GENERATED ALWAYS AS (
                        amount * (CASE WHEN reverses_receipt_id IS NULL THEN 1 ELSE -1 END)
                      ) STORED,
  reference           text,
  note                text,
  business_date       date NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  received_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cashier_shift_id    uuid,
  reverses_receipt_id uuid REFERENCES company_receipts(id) ON DELETE RESTRICT,
  reversal_reason     text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (property_id, company_id) REFERENCES companies(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, cashier_shift_id) REFERENCES cashier_shifts(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (payment_account_id, account_kind) REFERENCES payment_accounts(id, kind) ON DELETE RESTRICT,
  UNIQUE (property_id, number),
  CONSTRAINT company_receipts_account_matches_method CHECK (
    CASE method
      WHEN 'cash' THEN account_kind = 'cash'
      WHEN 'upi' THEN account_kind = 'upi'
      WHEN 'card' THEN account_kind = 'card_pos'
      ELSE account_kind = 'bank'
    END
  ),
  CONSTRAINT company_receipts_cash_in_shift CHECK (method <> 'cash' OR cashier_shift_id IS NOT NULL),
  CONSTRAINT company_receipts_reversal_has_reason CHECK (
    (reverses_receipt_id IS NULL AND reversal_reason IS NULL)
    OR (reverses_receipt_id IS NOT NULL AND length(btrim(reversal_reason)) >= 3)
  )
);
CREATE UNIQUE INDEX company_receipts_one_reversal ON company_receipts(reverses_receipt_id) WHERE reverses_receipt_id IS NOT NULL;
CREATE INDEX company_receipts_company_idx ON company_receipts(company_id);
CREATE TRIGGER company_receipts_no_update BEFORE UPDATE ON company_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_change('a receipt is never edited — reverse it with a reason and record the correct one');
CREATE TRIGGER company_receipts_no_delete BEFORE DELETE ON company_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_change('receipts are kept');
-- Same rule as a payment: money goes into the open shift of the person who took it.
CREATE TRIGGER company_receipts_shift_guard BEFORE INSERT ON company_receipts FOR EACH ROW EXECUTE FUNCTION guard_payment_shift();

-- ---------------------------------------------------------------------------
-- OTA bookings (spec §33)
-- ---------------------------------------------------------------------------

-- The commercial side of an OTA booking. One row per reservation, kept beside it rather than on
-- it so the booking form and its validation stay exactly as they are.
CREATE TABLE ota_bookings (
  reservation_id      uuid PRIMARY KEY,
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  payment_mode        text NOT NULL CHECK (payment_mode IN ('prepaid_to_ota', 'pay_at_resort')),
  -- What the OTA sold the stay for, which is also what the guest's invoice must show (§33).
  gross_amount        numeric(14,2) NOT NULL CHECK (gross_amount >= 0),
  commission_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  -- TCS / TDS the OTA deducts, as the CA says (§33). Recorded, never computed here.
  tax_withheld        numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_withheld >= 0),
  expected_payout     numeric(14,2) NOT NULL GENERATED ALWAYS AS (
                        CASE WHEN payment_mode = 'prepaid_to_ota' THEN gross_amount - commission_amount - tax_withheld
                             ELSE 0 END
                      ) STORED,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users(id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  FOREIGN KEY (property_id, reservation_id) REFERENCES reservations(property_id, id) ON DELETE RESTRICT,
  CONSTRAINT ota_bookings_deductions_fit CHECK (commission_amount + tax_withheld <= gross_amount)
);
CREATE TRIGGER ota_bookings_touch BEFORE UPDATE ON ota_bookings FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER ota_bookings_no_delete BEFORE DELETE ON ota_bookings FOR EACH ROW EXECUTE FUNCTION forbid_change('OTA booking terms are kept');

-- Only an OTA booking has OTA terms.
CREATE FUNCTION guard_ota_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reservations r WHERE r.id = NEW.reservation_id
                  AND r.source IN ('makemytrip', 'goibibo', 'booking_com', 'agoda', 'airbnb')) THEN
    RAISE EXCEPTION 'resortos: only a booking from an OTA has OTA terms' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ota_bookings_guard BEFORE INSERT OR UPDATE ON ota_bookings FOR EACH ROW EXECUTE FUNCTION guard_ota_booking();

-- Money an OTA actually paid out for a booking, into a bank account. Append-only; a batch payout
-- covering several bookings is several rows with the same reference.
CREATE TABLE ota_payouts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  number              text NOT NULL,
  reservation_id      uuid NOT NULL REFERENCES ota_bookings(reservation_id) ON DELETE RESTRICT,
  payment_account_id  uuid NOT NULL,
  account_kind        text NOT NULL CHECK (account_kind IN ('bank', 'other')),
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  cash_effect         numeric(14,2) NOT NULL GENERATED ALWAYS AS (
                        amount * (CASE WHEN reverses_payout_id IS NULL THEN 1 ELSE -1 END)
                      ) STORED,
  reference           text NOT NULL CHECK (length(btrim(reference)) >= 2),
  business_date       date NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  received_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reverses_payout_id  uuid REFERENCES ota_payouts(id) ON DELETE RESTRICT,
  reversal_reason     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payment_account_id, account_kind) REFERENCES payment_accounts(id, kind) ON DELETE RESTRICT,
  UNIQUE (property_id, number),
  CONSTRAINT ota_payouts_reversal_has_reason CHECK (
    (reverses_payout_id IS NULL AND reversal_reason IS NULL)
    OR (reverses_payout_id IS NOT NULL AND length(btrim(reversal_reason)) >= 3)
  )
);
CREATE UNIQUE INDEX ota_payouts_one_reversal ON ota_payouts(reverses_payout_id) WHERE reverses_payout_id IS NOT NULL;
CREATE INDEX ota_payouts_reservation_idx ON ota_payouts(reservation_id);
CREATE TRIGGER ota_payouts_no_update BEFORE UPDATE ON ota_payouts
  FOR EACH ROW EXECUTE FUNCTION forbid_change('a payout is never edited — reverse it with a reason');
CREATE TRIGGER ota_payouts_no_delete BEFORE DELETE ON ota_payouts
  FOR EACH ROW EXECUTE FUNCTION forbid_change('payouts are kept');

-- ---------------------------------------------------------------------------
-- The account ledger now includes company receipts and OTA payouts (see 0015).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW account_ledger AS
  SELECT p.property_id, p.payment_account_id AS account_id, 'payment'::text AS source, p.id AS source_id,
         p.number AS reference, p.business_date, p.received_at AS at, p.received_by AS by_user,
         p.cashier_shift_id, p.cash_effect AS amount,
         p.entry_type || CASE WHEN p.reverses_payment_id IS NULL THEN '' ELSE ' reversal' END AS description
    FROM payments p
   WHERE p.payment_account_id IS NOT NULL
  UNION ALL
  SELECT r.property_id, r.payment_account_id, 'company_receipt', r.id, r.number, r.business_date, r.received_at,
         r.received_by, r.cashier_shift_id, r.cash_effect,
         'company payment' || CASE WHEN r.reverses_receipt_id IS NULL THEN '' ELSE ' reversal' END
    FROM company_receipts r
  UNION ALL
  SELECT o.property_id, o.payment_account_id, 'ota_payout', o.id, o.number, o.business_date, o.received_at,
         o.received_by, NULL, o.cash_effect,
         'OTA payout' || CASE WHEN o.reverses_payout_id IS NULL THEN '' ELSE ' reversal' END
    FROM ota_payouts o;

COMMENT ON TABLE companies IS 'Company accounts (spec §32). The outstanding balance is company_account payments less company_receipts, never stored.';
COMMENT ON TABLE ota_bookings IS 'Commission, deductions and expected payout for an OTA booking (spec §33).';

-- What a company owes right now: bills moved to its account, less what it has paid. Recalculated
-- every time; there is no balance column to drift (§49).
CREATE FUNCTION company_outstanding(p_company_id uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT (COALESCE((SELECT sum(bill_effect) FROM payments WHERE company_id = p_company_id), 0)
        - COALESCE((SELECT sum(cash_effect) FROM company_receipts WHERE company_id = p_company_id), 0))::numeric(14,2)
$$;
