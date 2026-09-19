-- 0012 No-show (spec §15.2) — the resolution night audit's arrivals step offers.
--
-- Separate from 0011 because 0011 was already applied: an applied migration is never edited, so
-- that its checksum stays meaningful (CLAUDE.md, db/migrations).

-- `no_show` is already a legal reservation status (migration 0003's state machine), but there was
-- nowhere to record *when*, *by whom*, and what happened to any advance. Recorded separately from
-- cancellation because they are different facts about the booking: a cancellation was called off, a
-- no-show means the guest never arrived, and §15.3 counts the two separately.

ALTER TABLE reservations
  ADD COLUMN no_show_at           timestamptz,
  ADD COLUMN no_show_by           uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN no_show_note         text,
  ADD COLUMN no_show_money_option text
    CHECK (no_show_money_option IN ('none', 'refund', 'cancellation_charge', 'guest_credit', 'partial_refund')),
  ADD CONSTRAINT reservations_no_show_recorded CHECK ((status = 'no_show') = (no_show_at IS NOT NULL));

COMMENT ON COLUMN reservations.no_show_at IS
  'Set when night audit marked the booking a no-show (spec §15.2). Kept separate from cancellation: §15.3 counts them separately.';
