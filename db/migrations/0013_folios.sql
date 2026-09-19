-- 0013 The bill: folios, folio lines and saved charge items (spec §23, §24).
--
-- Design and reasoning: docs/folio.md. Three things drive the shape of this schema:
--
--   1. A line is never edited. A mistake is voided with a reason and re-added; the voided line
--      stays visible. Enforced by a trigger, so it is true even when the application is wrong.
--   2. Balances are never stored. Balance is recalculated from the lines every time, and the
--      nightly integrity check (2.4b) compares and reports rather than repairs (spec §49).
--   3. Room nights post once per room per business date — a partial unique index, so that the
--      night audit step can rely on the database rather than on checking first.

CREATE TABLE folios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  number          text NOT NULL,
  -- One bill per stay. Null on a group master bill, which belongs to the reservation (spec §12.4).
  stay_id         uuid REFERENCES stays(id) ON DELETE RESTRICT,
  reservation_id  uuid NOT NULL,
  kind            text NOT NULL DEFAULT 'stay' CHECK (kind IN ('stay', 'group_master')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opened_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  closed_at       timestamptz,
  closed_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1,

  FOREIGN KEY (property_id, reservation_id) REFERENCES reservations(property_id, id) ON DELETE RESTRICT,
  UNIQUE (property_id, number),
  UNIQUE (property_id, id),
  -- A stay has exactly one bill.
  CONSTRAINT folios_one_per_stay UNIQUE (stay_id),
  CONSTRAINT folios_stay_kind CHECK ((kind = 'stay') = (stay_id IS NOT NULL)),
  CONSTRAINT folios_closed_recorded CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX folios_reservation_idx ON folios(reservation_id);
CREATE TRIGGER folios_touch BEFORE UPDATE ON folios FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER folios_no_delete BEFORE DELETE ON folios FOR EACH ROW EXECUTE FUNCTION forbid_change('bills are never deleted');

COMMENT ON TABLE folios IS 'The running bill for a stay (spec §23). Balance is never stored — it is recalculated from folio_lines.';

-- ---------------------------------------------------------------------------
-- Saved charge items — the quick-pick list behind "Add charge" (spec §24.2)
-- ---------------------------------------------------------------------------
-- A list, not a menu system: no kitchen tickets, no stock, no restaurant login (CLAUDE.md rule 16).
-- This is the old software's "Room Service Items" (docs/old-system-parity.md).

CREATE TABLE charge_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  line_type     text NOT NULL,
  default_rate  numeric(14,2) NOT NULL CHECK (default_rate >= 0),
  tax_category  text NOT NULL CHECK (tax_category IN ('accommodation', 'food', 'activity', 'laundry', 'transport', 'other')),
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id) ON DELETE RESTRICT,
  version       integer NOT NULL DEFAULT 1,

  UNIQUE (property_id, id),
  CONSTRAINT charge_items_unique_name UNIQUE (property_id, name)
);
CREATE TRIGGER charge_items_touch BEFORE UPDATE ON charge_items FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER charge_items_no_delete BEFORE DELETE ON charge_items
  FOR EACH ROW EXECUTE FUNCTION forbid_change('charge items are deactivated, not deleted — old bills refer to them');

-- ---------------------------------------------------------------------------
-- Folio lines (spec §23)
-- ---------------------------------------------------------------------------

CREATE TABLE folio_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  folio_id       uuid NOT NULL,
  -- The date the charge belongs to, which is not the same as when somebody typed it.
  business_date  date NOT NULL,
  line_type      text NOT NULL CHECK (line_type IN (
                   'room_night', 'extra_person', 'meal', 'food', 'beverage', 'activity',
                   'laundry', 'transport', 'early_checkin', 'late_checkout', 'damage', 'other', 'discount')),
  -- Appears on the invoice exactly as entered (§24.1): "Paneer Tikka", "Jeep Safari".
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  quantity       numeric(10,3) NOT NULL CHECK (quantity > 0),
  unit_rate      numeric(14,2) NOT NULL,
  amount         numeric(14,2) NOT NULL,
  -- Drives GST and the SAC on the invoice; the receptionist never picks a rate (§24.3).
  tax_category   text NOT NULL CHECK (tax_category IN ('accommodation', 'food', 'activity', 'laundry', 'transport', 'other')),
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'night_audit', 'import')),
  room_id        uuid,
  charge_item_id uuid REFERENCES charge_items(id) ON DELETE RESTRICT,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- The one change a line ever accepts, and only once (spec §23, §4.5).
  voided_at      timestamptz,
  voided_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  void_reason    text,
  -- Set when voiding needed Owner PIN, i.e. after night audit closed that business date.
  authorised_by  uuid REFERENCES users(id) ON DELETE RESTRICT,

  FOREIGN KEY (property_id, folio_id) REFERENCES folios(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, room_id) REFERENCES rooms(property_id, id) ON DELETE RESTRICT,
  CONSTRAINT folio_lines_void_recorded CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(btrim(void_reason)) >= 3)
  ),
  -- A discount is negative, everything else is not. Both are stored as they will be shown.
  CONSTRAINT folio_lines_sign CHECK ((line_type = 'discount') = (amount < 0))
);

CREATE INDEX folio_lines_folio_idx ON folio_lines(folio_id, business_date, created_at);
CREATE INDEX folio_lines_business_date_idx ON folio_lines(property_id, business_date);

-- Room nights post once per room per business date (spec §35.2). Partial on voided_at so that a
-- wrongly posted night can be voided and re-posted, which a plain unique index would forbid.
-- The night audit step relies on this rather than checking first: a check-then-insert is a race.
CREATE UNIQUE INDEX folio_lines_one_posting_per_room_night
  ON folio_lines (folio_id, room_id, business_date, line_type)
  WHERE source = 'night_audit' AND voided_at IS NULL;

-- A line is never edited. The only accepted UPDATE is the void, and only from not-voided to voided.
CREATE FUNCTION guard_folio_line_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'resortos: a voided bill line cannot change again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.property_id, NEW.folio_id, NEW.business_date, NEW.line_type, NEW.name, NEW.quantity,
      NEW.unit_rate, NEW.amount, NEW.tax_category, NEW.source, NEW.room_id, NEW.charge_item_id,
      NEW.note, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.property_id, OLD.folio_id, OLD.business_date, OLD.line_type, OLD.name, OLD.quantity,
      OLD.unit_rate, OLD.amount, OLD.tax_category, OLD.source, OLD.room_id, OLD.charge_item_id,
      OLD.note, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'resortos: a bill line is never edited — void it with a reason and add the correct one'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'resortos: a bill line can only be updated to void it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER folio_lines_guard BEFORE UPDATE ON folio_lines FOR EACH ROW EXECUTE FUNCTION guard_folio_line_update();
CREATE TRIGGER folio_lines_no_delete BEFORE DELETE ON folio_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_change('bill lines are voided, never deleted');

COMMENT ON TABLE folio_lines IS
  'Charges on a bill (spec §23). Append-only apart from a single void; a mistake is voided with a reason and re-added.';
COMMENT ON COLUMN folio_lines.amount IS
  'Line total as shown. Negative only for a discount. Tax is never stored here — it is computed from tax_category and the dated tax_rules.';
