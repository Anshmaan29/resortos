-- 0017 GST invoices, credit and debit notes, and gap-free numbering (spec §29, §30, §31).
--
-- Three rules shape this schema:
--
--   1. **An invoice exists only once it is final.** There is no draft row: the draft is the bill,
--      and the preview is computed from it. A number is taken from `document_counters` inside the
--      transaction that writes the invoice, so a rollback releases it and no number is ever skipped
--      (§31) — which a SEQUENCE cannot promise.
--   2. **A finalized invoice never changes.** Every table here refuses UPDATE and DELETE, and its
--      lines, tax groups and payment summary can only be written in the same transaction as the
--      invoice itself — so nothing can be added to an invoice afterwards either. A correction is a
--      credit note or a debit note: a new document pointing at the old one.
--   3. **The totals are checked by the database at commit.** Lines, tax groups and the header must
--      agree to the paisa, or the transaction does not commit.

-- ---------------------------------------------------------------------------
-- Numbering (spec §31)
-- ---------------------------------------------------------------------------

CREATE TABLE document_counters (
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  series          text NOT NULL CHECK (series IN ('INV', 'BOS', 'CN', 'DN', 'RV')),
  financial_year  text NOT NULL CHECK (financial_year ~ '^\d{2}-\d{2}$'),
  last_number     integer NOT NULL CHECK (last_number >= 0),
  PRIMARY KEY (property_id, series, financial_year)
);
CREATE TRIGGER document_counters_no_delete BEFORE DELETE ON document_counters
  FOR EACH ROW EXECUTE FUNCTION forbid_change('document counters are never reset');

-- The next number in a series. The row lock serialises finalization; a rollback releases the
-- number unused. Never called outside the transaction that writes the document.
CREATE FUNCTION next_document_number(p_property uuid, p_series text, p_fy text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  INSERT INTO document_counters (property_id, series, financial_year, last_number) VALUES (p_property, p_series, p_fy, 1)
  ON CONFLICT (property_id, series, financial_year) DO UPDATE SET last_number = document_counters.last_number + 1
  RETURNING last_number INTO n;
  RETURN n;
END $$;

-- A counter only ever goes up.
CREATE FUNCTION guard_document_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_number <> OLD.last_number + 1 OR (NEW.property_id, NEW.series, NEW.financial_year) IS DISTINCT FROM (OLD.property_id, OLD.series, OLD.financial_year) THEN
    RAISE EXCEPTION 'resortos: a document counter only moves forward by one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_counters_forward BEFORE UPDATE ON document_counters FOR EACH ROW EXECUTE FUNCTION guard_document_counter();

-- ---------------------------------------------------------------------------
-- Invoices, credit notes and debit notes (spec §29)
-- ---------------------------------------------------------------------------

CREATE TABLE invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  folio_id              uuid NOT NULL,
  document_type         text NOT NULL CHECK (document_type IN ('tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note')),
  series                text NOT NULL CHECK (series IN ('INV', 'BOS', 'CN', 'DN')),
  financial_year        text NOT NULL,
  seq                   integer NOT NULL CHECK (seq > 0),
  number                text NOT NULL CHECK (length(number) <= 16),
  invoice_date          date NOT NULL,
  -- A credit or debit note always points at the invoice it corrects, and says why.
  original_invoice_id   uuid REFERENCES invoices(id) ON DELETE RESTRICT,
  reason                text,

  -- Who sold, exactly as it was on the day. A later change to the property's address or GSTIN must
  -- not rewrite an invoice already given to a guest.
  seller_legal_name     text NOT NULL,
  seller_address        text NOT NULL,
  seller_gstin          char(15),
  seller_state_code     char(2) NOT NULL,
  -- Who bought: the guest, or the company the bill was moved to (§32).
  buyer_name            text NOT NULL,
  buyer_gstin           char(15) CHECK (buyer_gstin IS NULL OR buyer_gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  buyer_address         text,
  buyer_state_code      char(2),
  buyer_mobile          text,
  -- Accommodation is supplied where the property is (§29.2), so this is the property's state.
  place_of_supply       char(2) NOT NULL,
  supply_type           text NOT NULL CHECK (supply_type IN ('intra_state', 'inter_state')),
  stay_from             date,
  stay_to               date,
  room_numbers          text,
  reservation_number    text,

  taxable_total         numeric(14,2) NOT NULL,
  cgst_total            numeric(14,2) NOT NULL,
  sgst_total            numeric(14,2) NOT NULL,
  igst_total            numeric(14,2) NOT NULL,
  round_off             numeric(14,2) NOT NULL CHECK (round_off > -1 AND round_off < 1),
  grand_total           numeric(14,2) NOT NULL,
  -- What had been paid when it was issued, for the printed "Paid" line. Payments after that are on
  -- the bill and the receipts, never written back here.
  paid_at_issue         numeric(14,2) NOT NULL,

  finalized_at          timestamptz NOT NULL DEFAULT now(),
  finalized_by          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Owner who authorised it where that was needed (a credit note is always the owner's).
  authorised_by         uuid REFERENCES users(id) ON DELETE RESTRICT,

  FOREIGN KEY (property_id, folio_id) REFERENCES folios(property_id, id) ON DELETE RESTRICT,
  UNIQUE (property_id, number),
  UNIQUE (property_id, series, financial_year, seq),
  UNIQUE (id, series),
  CONSTRAINT invoices_series_matches_type CHECK (
    (document_type, series) IN (('tax_invoice', 'INV'), ('bill_of_supply', 'BOS'), ('credit_note', 'CN'), ('debit_note', 'DN'))
  ),
  CONSTRAINT invoices_correction_points_back CHECK (
    (document_type IN ('credit_note', 'debit_note')) = (original_invoice_id IS NOT NULL)
    AND (document_type NOT IN ('credit_note', 'debit_note') OR length(btrim(reason)) >= 3)
  ),
  -- A bill of supply carries no tax at all.
  CONSTRAINT invoices_bill_of_supply_untaxed CHECK (
    document_type <> 'bill_of_supply' OR (cgst_total = 0 AND sgst_total = 0 AND igst_total = 0)
  ),
  CONSTRAINT invoices_tax_split CHECK (
    (supply_type = 'intra_state' AND igst_total = 0 AND cgst_total = sgst_total)
    OR (supply_type = 'inter_state' AND cgst_total = 0 AND sgst_total = 0)
  ),
  CONSTRAINT invoices_total_adds_up CHECK (grand_total = taxable_total + cgst_total + sgst_total + igst_total + round_off),
  CONSTRAINT invoices_whole_rupees CHECK (grand_total = trunc(grand_total))
);
-- One tax invoice (or bill of supply) per bill. Anything later is a debit note against it.
CREATE UNIQUE INDEX invoices_one_per_bill ON invoices(folio_id) WHERE series IN ('INV', 'BOS');
CREATE INDEX invoices_original_idx ON invoices(original_invoice_id) WHERE original_invoice_id IS NOT NULL;
CREATE INDEX invoices_date_idx ON invoices(property_id, invoice_date);

CREATE TABLE invoice_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id               uuid NOT NULL,
  series                   text NOT NULL,
  line_no                  smallint NOT NULL CHECK (line_no > 0),
  -- The bill line it came from. On a credit note: null, and `credits_line_id` says what it reduces.
  folio_line_id            uuid REFERENCES folio_lines(id) ON DELETE RESTRICT,
  credits_line_id          uuid REFERENCES invoice_lines(id) ON DELETE RESTRICT,
  business_date            date NOT NULL,
  description              text NOT NULL,
  sac                      text NOT NULL,
  quantity                 numeric(10,3) NOT NULL CHECK (quantity > 0),
  rate                     numeric(14,2) NOT NULL,
  gross_amount             numeric(14,2) NOT NULL CHECK (gross_amount >= 0),
  discount_amount          numeric(14,2) NOT NULL CHECK (discount_amount >= 0),
  taxable_value            numeric(14,2) NOT NULL CHECK (taxable_value >= 0),
  gst_rate                 numeric(5,2) NOT NULL CHECK (gst_rate BETWEEN 0 AND 100),
  FOREIGN KEY (invoice_id, series) REFERENCES invoices(id, series) ON DELETE RESTRICT,
  UNIQUE (invoice_id, line_no),
  CONSTRAINT invoice_lines_net CHECK (taxable_value = gross_amount - discount_amount),
  CONSTRAINT invoice_lines_source CHECK (
    (series = 'CN') = (credits_line_id IS NOT NULL) AND (series = 'CN') = (folio_line_id IS NULL)
  )
);
-- A bill line is sold once: on the invoice, or on one debit note after it.
CREATE UNIQUE INDEX invoice_lines_sold_once ON invoice_lines(folio_line_id) WHERE series IN ('INV', 'BOS', 'DN');
CREATE INDEX invoice_lines_credits_idx ON invoice_lines(credits_line_id) WHERE credits_line_id IS NOT NULL;

CREATE TABLE invoice_tax_groups (
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  rate_percent    numeric(5,2) NOT NULL,
  taxable_value   numeric(14,2) NOT NULL,
  cgst            numeric(14,2) NOT NULL,
  sgst            numeric(14,2) NOT NULL,
  igst            numeric(14,2) NOT NULL,
  PRIMARY KEY (invoice_id, rate_percent)
);

-- "Paid: UPI ₹5,000 · Card ₹7,882" (§29.2), as it stood when the invoice was issued.
CREATE TABLE invoice_payments (
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  method      text NOT NULL,
  amount      numeric(14,2) NOT NULL,
  PRIMARY KEY (invoice_id, method)
);

-- Rule 2: nothing about an issued document ever changes.
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION forbid_change('a finalized invoice is never changed — issue a credit or debit note');
CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_change('a finalized invoice is never changed — issue a credit or debit note');
CREATE TRIGGER invoice_tax_groups_immutable BEFORE UPDATE OR DELETE ON invoice_tax_groups
  FOR EACH ROW EXECUTE FUNCTION forbid_change('a finalized invoice is never changed — issue a credit or debit note');
CREATE TRIGGER invoice_payments_immutable BEFORE UPDATE OR DELETE ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION forbid_change('a finalized invoice is never changed — issue a credit or debit note');

-- ... and nothing can be added to it later either: its parts are written in the transaction that
-- created it, or not at all.
CREATE FUNCTION guard_invoice_part_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = NEW.invoice_id AND i.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'resortos: an invoice is written whole, in one transaction — nothing can be added to it afterwards'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_lines_same_transaction BEFORE INSERT ON invoice_lines FOR EACH ROW EXECUTE FUNCTION guard_invoice_part_insert();
CREATE TRIGGER invoice_tax_groups_same_transaction BEFORE INSERT ON invoice_tax_groups FOR EACH ROW EXECUTE FUNCTION guard_invoice_part_insert();
CREATE TRIGGER invoice_payments_same_transaction BEFORE INSERT ON invoice_payments FOR EACH ROW EXECUTE FUNCTION guard_invoice_part_insert();

-- A credit note cannot credit more of a line than was sold, across every credit note against it.
CREATE FUNCTION guard_credit_note_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original record; credited numeric;
BEGIN
  IF NEW.series <> 'CN' THEN RETURN NEW; END IF;
  SELECT l.* INTO original FROM invoice_lines l WHERE l.id = NEW.credits_line_id;
  -- Serialise credits on the bill the invoice belongs to. (Not on the invoice: locking a row needs
  -- UPDATE privilege, and the application has none on invoices.)
  PERFORM 1 FROM folios f JOIN invoices i ON i.folio_id = f.id WHERE i.id = original.invoice_id FOR UPDATE OF f;
  IF original.series = 'CN' THEN
    RAISE EXCEPTION 'resortos: a credit note credits an invoice or debit note line, not another credit' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoices cn WHERE cn.id = NEW.invoice_id AND cn.original_invoice_id = original.invoice_id) THEN
    RAISE EXCEPTION 'resortos: a credit note line must credit the invoice the note points at' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.gst_rate <> original.gst_rate THEN
    RAISE EXCEPTION 'resortos: a credit is taxed at the rate the original was taxed at' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(taxable_value), 0) INTO credited FROM invoice_lines WHERE credits_line_id = NEW.credits_line_id;
  IF credited + NEW.taxable_value > original.taxable_value THEN
    RAISE EXCEPTION 'resortos: more would be credited than was invoiced' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_lines_credit_guard BEFORE INSERT ON invoice_lines FOR EACH ROW EXECUTE FUNCTION guard_credit_note_line();

-- Rule 3: at commit, the header, lines and tax groups agree to the paisa.
CREATE FUNCTION check_invoice_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i record; lines_taxable numeric; line_count integer; g record;
BEGIN
  SELECT * INTO i FROM invoices WHERE id = NEW.id;
  SELECT COALESCE(sum(taxable_value), 0), count(*) INTO lines_taxable, line_count FROM invoice_lines WHERE invoice_id = i.id;
  SELECT COALESCE(sum(taxable_value), 0) AS taxable, COALESCE(sum(cgst), 0) AS cgst, COALESCE(sum(sgst), 0) AS sgst,
         COALESCE(sum(igst), 0) AS igst INTO g
    FROM invoice_tax_groups WHERE invoice_id = i.id;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'resortos: invoice % has no lines', i.number USING ERRCODE = 'check_violation';
  END IF;
  IF lines_taxable <> i.taxable_total OR g.taxable <> i.taxable_total
     OR g.cgst <> i.cgst_total OR g.sgst <> i.sgst_total OR g.igst <> i.igst_total THEN
    RAISE EXCEPTION 'resortos: invoice % does not add up (lines %, groups %, header %)', i.number, lines_taxable, g.taxable, i.taxable_total
      USING ERRCODE = 'check_violation';
  END IF;
  -- Each rate's taxable value must be exactly the lines at that rate.
  IF EXISTS (
    SELECT 1 FROM invoice_tax_groups tg
     WHERE tg.invoice_id = i.id
       AND tg.taxable_value <> (SELECT COALESCE(sum(l.taxable_value), 0) FROM invoice_lines l WHERE l.invoice_id = i.id AND l.gst_rate = tg.rate_percent)
  ) OR EXISTS (
    SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id
       AND NOT EXISTS (SELECT 1 FROM invoice_tax_groups tg WHERE tg.invoice_id = i.id AND tg.rate_percent = l.gst_rate)
  ) THEN
    RAISE EXCEPTION 'resortos: invoice % tax groups do not match its lines', i.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoices_add_up AFTER INSERT ON invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_invoice_totals();

-- A bill line that has been invoiced cannot be removed from the bill any more: the guest holds an
-- invoice that includes it. Correcting it is a credit note (§29.4). Same function as 0016, plus that.
CREATE OR REPLACE FUNCTION guard_folio_line_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'resortos: a voided bill line cannot change again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.property_id, NEW.folio_id, NEW.business_date, NEW.line_type, NEW.name, NEW.quantity,
      NEW.unit_rate, NEW.amount, NEW.tax_category, NEW.source, NEW.room_id, NEW.charge_item_id,
      NEW.note, NEW.created_at, NEW.created_by,
      NEW.applies_to_line_id, NEW.discount_group_id, NEW.discount_percent, NEW.discount_reason, NEW.authorised_by)
     IS DISTINCT FROM
     (OLD.property_id, OLD.folio_id, OLD.business_date, OLD.line_type, OLD.name, OLD.quantity,
      OLD.unit_rate, OLD.amount, OLD.tax_category, OLD.source, OLD.room_id, OLD.charge_item_id,
      OLD.note, OLD.created_at, OLD.created_by,
      OLD.applies_to_line_id, OLD.discount_group_id, OLD.discount_percent, OLD.discount_reason, OLD.authorised_by) THEN
    RAISE EXCEPTION 'resortos: a bill line is never edited — void it with a reason and add the correct one'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'resortos: a bill line can only be updated to void it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM folio_lines d WHERE d.applies_to_line_id = OLD.id AND d.voided_at IS NULL) THEN
    RAISE EXCEPTION 'resortos: remove the discount on this charge before removing the charge' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM invoice_lines il WHERE il.folio_line_id IN (OLD.id, OLD.applies_to_line_id)) THEN
    RAISE EXCEPTION 'resortos: this charge is on an issued invoice — correct it with a credit note' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- The ledger of what a bill has been invoiced for, net of credit and debit notes, used by the
-- company statement (2.7) and the owner's reports.
CREATE VIEW invoice_balances AS
  SELECT i.id AS invoice_id, i.property_id, i.folio_id, i.number, i.invoice_date, i.grand_total,
         COALESCE((SELECT sum(n.grand_total) FROM invoices n WHERE n.original_invoice_id = i.id AND n.series = 'DN'), 0)
         - COALESCE((SELECT sum(n.grand_total) FROM invoices n WHERE n.original_invoice_id = i.id AND n.series = 'CN'), 0)
           AS adjustments
    FROM invoices i
   WHERE i.series IN ('INV', 'BOS');

COMMENT ON TABLE invoices IS
  'Finalized GST documents (spec §29): tax invoices, bills of supply, credit and debit notes. Written once, whole, in one transaction; never changed.';
COMMENT ON TABLE document_counters IS
  'Gap-free document numbers per series and financial year (spec §31). Never a SEQUENCE: a rollback releases the number.';
