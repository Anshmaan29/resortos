-- 0010 Purpose of visit (parity with the old software's check-in form).
--
-- On the reservation rather than the guest: the same guest comes for a wedding one month and for
-- business the next, so it describes the visit, not the person.
--
-- A controlled list rather than free text, because it is read back by machines twice — the Form C
-- "purpose of stay" field (spec §58.1) and the revenue breakdowns (§62) — and a typed-in column
-- cannot be grouped. Anything that does not fit is 'other', with the detail going in the
-- special-requests or internal-notes fields the reservation already has.
--
-- Nullable: every booking made before today has no purpose recorded, and inventing one would be a lie.

ALTER TABLE reservations ADD COLUMN purpose text
  CHECK (purpose IN ('business', 'leisure', 'family_function', 'medical', 'pilgrimage', 'conference', 'other'));

CREATE INDEX reservations_purpose_idx ON reservations(property_id, purpose) WHERE purpose IS NOT NULL;

COMMENT ON COLUMN reservations.purpose IS
  'Why the guest is visiting. Feeds Form C and revenue breakdowns; null for bookings taken before this was recorded.';
