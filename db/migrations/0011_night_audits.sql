-- 0011 Night audit runs and the business date (spec §35).
--
-- The business date is the one number the rest of Phase 2 hangs off: every folio line, payment,
-- invoice and daily metric is attributed to it. `properties.current_business_date` already exists
-- and already cannot move backwards (trigger `properties_business_date`, migration 0001). This
-- migration adds the record of the audits that move it, and the shared definition of a closed date.
--
-- Design note: there is no `status` column. A row here means "this business date was closed", and
-- nothing else. That is what makes `UNIQUE (property_id, business_date)` a real idempotency
-- guarantee rather than a hint — a second audit for the same date cannot be inserted at all, no
-- matter how the application behaves. See docs/night-audit.md.

CREATE TABLE night_audits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  -- The date that was closed, not the date the audit ran on.
  business_date   date NOT NULL,
  started_at      timestamptz NOT NULL,
  completed_at    timestamptz NOT NULL DEFAULT now(),
  completed_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- One entry per registered step: what it posted, what it skipped, and why. The Day Audit Log.
  steps           jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  -- Occupancy and counts for the closed date; revenue and payments join it in 2.2 and 2.3.
  summary         jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- A business date is closed exactly once. Two people pressing Complete at the same moment cannot
  -- both succeed, whatever the application does.
  CONSTRAINT night_audits_one_per_date UNIQUE (property_id, business_date),
  CONSTRAINT night_audits_completed_after_start CHECK (completed_at >= started_at)
);

-- A completed run is evidence, not a status field.
CREATE TRIGGER night_audits_no_update BEFORE UPDATE ON night_audits
  FOR EACH ROW EXECUTE FUNCTION forbid_change('a night audit run is never changed after it completes');
CREATE TRIGGER night_audits_no_delete BEFORE DELETE ON night_audits
  FOR EACH ROW EXECUTE FUNCTION forbid_change('night audit history is kept');

COMMENT ON TABLE night_audits IS
  'One row per closed business date (spec §35). Append-only: the row is written when the audit completes and never edited.';
COMMENT ON COLUMN night_audits.business_date IS
  'The business date this audit closed. The property moved to business_date + 1 in the same transaction.';

-- The shared definition of "that date is closed". 2.2 folio lines and 2.3 payments call this rather
-- than each re-deriving it, so corrections cannot land on a date the audit has already summarised.
CREATE FUNCTION is_business_date_closed(p_property_id uuid, p_date date) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM night_audits WHERE property_id = p_property_id AND business_date = p_date)
$$;

COMMENT ON FUNCTION is_business_date_closed(uuid, date) IS
  'True once night audit has closed that business date. Corrections belong on the current date (spec §35.2).';

-- Owner setting from §35.2: who may run the audit. Default true, which is how the resort works today;
-- the owner settings screen will expose it. Added now so that screen needs no migration of its own.
ALTER TABLE properties ADD COLUMN receptionist_can_run_night_audit boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN properties.receptionist_can_run_night_audit IS
  'Owner setting (spec §35.2). When false only the owner may complete a night audit.';
