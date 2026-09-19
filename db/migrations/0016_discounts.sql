-- 0016 Discounts (spec §28, §4.5, §30.2).
--
-- A discount is a negative bill line that points at the line it discounts. It is never a separate
-- "bill discount" floating above the lines, because GST on a room is decided per room per night on
-- the value *after* discount (§30.2): a ₹1,000 discount on an ₹8,000 night moves that night from 18%
-- to 5%, and the engine can only see that if the discount is attached to that night. A discount on
-- the whole bill is therefore spread across its lines, and the parts share a `discount_group_id` so
-- they are shown, and removed, as one.

ALTER TABLE folio_lines
  ADD COLUMN applies_to_line_id uuid,
  ADD COLUMN discount_group_id  uuid,
  -- The percentage the person giving the discount saw (of the whole bill for a bill discount). What
  -- the receptionist limit and the owner review list are judged on.
  ADD COLUMN discount_percent   numeric(6,2) CHECK (discount_percent BETWEEN 0 AND 100),
  ADD COLUMN discount_reason    text,
  -- Who authorised *removing* the line when that needed the owner. Separate from authorised_by,
  -- which on a discount records who authorised *giving* it; a void must not overwrite that.
  ADD COLUMN void_authorised_by uuid REFERENCES users(id) ON DELETE RESTRICT;

-- Lets a discount's foreign key insist that its target is on the same bill.
ALTER TABLE folio_lines ADD CONSTRAINT folio_lines_folio_id_id UNIQUE (folio_id, id);
ALTER TABLE folio_lines
  ADD CONSTRAINT folio_lines_discount_target_same_bill
    FOREIGN KEY (folio_id, applies_to_line_id) REFERENCES folio_lines(folio_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT folio_lines_discount_shape CHECK (
    (line_type = 'discount') = (applies_to_line_id IS NOT NULL)
    AND (line_type = 'discount') = (discount_group_id IS NOT NULL)
    AND (line_type = 'discount') = (discount_percent IS NOT NULL)
    AND (line_type <> 'discount' OR length(btrim(discount_reason)) >= 3)
    AND (line_type = 'discount' OR discount_reason IS NULL)
  );
CREATE INDEX folio_lines_discount_target_idx ON folio_lines(applies_to_line_id) WHERE applies_to_line_id IS NOT NULL;
CREATE INDEX folio_lines_discount_group_idx ON folio_lines(discount_group_id) WHERE discount_group_id IS NOT NULL;

-- What a discount may attach to, checked where the application cannot forget it:
--   * a real charge, not another discount, and not one already removed;
--   * the same tax category and room, so GST on the discounted night is worked out correctly;
--   * never more than the line is worth — a charge cannot be discounted below zero.
-- The target row is locked, so two discounts given at the same moment are summed one after the other.
CREATE FUNCTION guard_discount_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; already numeric;
BEGIN
  IF NEW.line_type <> 'discount' THEN RETURN NEW; END IF;
  SELECT * INTO t FROM folio_lines WHERE id = NEW.applies_to_line_id FOR UPDATE;
  IF t.line_type = 'discount' THEN
    RAISE EXCEPTION 'resortos: a discount cannot be discounted' USING ERRCODE = 'check_violation';
  END IF;
  IF t.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'resortos: that charge has been removed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.tax_category, NEW.room_id) IS DISTINCT FROM (t.tax_category, t.room_id) THEN
    RAISE EXCEPTION 'resortos: a discount must carry the tax category and room of the charge it discounts' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(-amount), 0) INTO already FROM folio_lines
   WHERE applies_to_line_id = t.id AND voided_at IS NULL;
  IF already - NEW.amount > t.amount THEN
    RAISE EXCEPTION 'resortos: discounts on a charge cannot add up to more than the charge' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER folio_lines_discount_guard BEFORE INSERT ON folio_lines FOR EACH ROW EXECUTE FUNCTION guard_discount_line();

-- The one-update rule from 0013, extended to the new columns, plus: a charge with a discount still
-- on it cannot be removed on its own. Removing it would leave a discount pointing at nothing,
-- lowering the bill for a charge that is no longer on it.
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
  RETURN NEW;
END $$;

COMMENT ON COLUMN folio_lines.applies_to_line_id IS
  'For a discount: the charge it reduces. GST is worked out on that charge net of its discounts (§30.2).';
COMMENT ON COLUMN folio_lines.discount_group_id IS
  'Shared by the parts of one discount. A bill discount is spread across its lines; the parts are shown and removed together.';
