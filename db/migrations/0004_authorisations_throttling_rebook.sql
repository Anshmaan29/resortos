-- 0004 Owner authorisations (single-use, bound, expiring), owner override history,
-- login throttling without account lockout abuse, owner recovery, rebooking,
-- booking edits, and demo-data markers that production refuses to run with.
-- Spec: §4.5, §5.1, §5.2, §15, §48

-- ---------------------------------------------------------------------------
-- Owner authorisations (spec §4.5)
--
-- 1. A receptionist's request that needs the owner is rejected; the server records a
--    PENDING authorisation holding the exact scope it computed (booking values).
-- 2. The owner enters their PIN for that authorisation → APPROVED, usable for 2 minutes.
-- 3. The receptionist retries; the server recomputes the scope from the new request and
--    consumes the authorisation only if the scope hash matches exactly. Single use.
-- ---------------------------------------------------------------------------

CREATE TABLE owner_authorisations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  requested_by    uuid NOT NULL REFERENCES users(id),
  session_id      uuid REFERENCES sessions(id),
  operation       text NOT NULL,                      -- e.g. reservation.create
  scope           jsonb NOT NULL,                     -- canonical values the approval is bound to
  scope_hash      bytea NOT NULL,
  reasons         jsonb NOT NULL,                     -- [{action, description}]
  description     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  request_expires_at timestamptz NOT NULL,            -- time allowed to enter the PIN
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  expires_at      timestamptz,                        -- time allowed to use the approval
  used_at         timestamptz,
  used_entity_type text,
  used_entity_id  uuid,
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CHECK ((approved_at IS NULL) = (expires_at IS NULL)),
  CHECK (expires_at IS NULL OR expires_at <= approved_at + interval '2 minutes'),
  CHECK (used_at IS NULL OR approved_at IS NOT NULL),
  CHECK (request_expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX owner_authorisations_requested_idx ON owner_authorisations(requested_by, created_at DESC);

-- Lifecycle can only move pending → approved → used; bound values never change.
CREATE FUNCTION guard_owner_authorisation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.property_id, NEW.requested_by, NEW.operation, NEW.scope, NEW.scope_hash, NEW.reasons, NEW.created_at)
     IS DISTINCT FROM (OLD.property_id, OLD.requested_by, OLD.operation, OLD.scope, OLD.scope_hash, OLD.reasons, OLD.created_at) THEN
    RAISE EXCEPTION 'resortos: owner authorisation scope is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (NEW.approved_at, NEW.approved_by, NEW.expires_at) IS DISTINCT FROM (OLD.approved_at, OLD.approved_by, OLD.expires_at) THEN
    RAISE EXCEPTION 'resortos: owner authorisation already approved' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'resortos: owner authorisation already used' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_authorisations_guard BEFORE UPDATE ON owner_authorisations FOR EACH ROW EXECUTE FUNCTION guard_owner_authorisation();
CREATE TRIGGER owner_authorisations_no_delete BEFORE DELETE ON owner_authorisations FOR EACH ROW EXECUTE FUNCTION forbid_change('authorisations are history');

-- Every action taken beyond receptionist limits — by the owner directly or via PIN.
-- Feeds the booking screen and, in Phase 2, the owner review list.
CREATE TABLE owner_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES properties(id),
  entity_type       text NOT NULL,
  entity_id         uuid NOT NULL,
  action            text NOT NULL,
  description       text NOT NULL,
  performed_by      uuid NOT NULL REFERENCES users(id),
  authorised_by     uuid NOT NULL REFERENCES users(id),
  authorisation_id  uuid REFERENCES owner_authorisations(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_overrides_entity_idx ON owner_overrides(entity_type, entity_id);
CREATE INDEX owner_overrides_property_time_idx ON owner_overrides(property_id, created_at DESC);
CREATE TRIGGER owner_overrides_immutable BEFORE UPDATE OR DELETE ON owner_overrides FOR EACH ROW EXECUTE FUNCTION forbid_change('override history is append-only');

-- ---------------------------------------------------------------------------
-- Login throttling (spec §5.1) without letting strangers lock the owner out.
-- Failures are throttled per (account, network) and per (account, known device);
-- a device that has logged in successfully before keeps working during an attack.
-- ---------------------------------------------------------------------------

CREATE TABLE known_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  token_hash    bytea NOT NULL UNIQUE,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX known_devices_user_idx ON known_devices(user_id) WHERE revoked_at IS NULL;

ALTER TABLE auth_attempts ADD COLUMN known_device_id uuid REFERENCES known_devices(id);
ALTER TABLE auth_attempts ADD COLUMN outcome text NOT NULL DEFAULT 'checked'
  CHECK (outcome IN ('checked', 'throttled'));
CREATE INDEX auth_attempts_user_idx ON auth_attempts(user_id, created_at DESC);

-- Failures before this moment are ignored (set by owner unlock or recovery).
ALTER TABLE users ADD COLUMN login_throttle_reset_at timestamptz;
-- Hard account lock is no longer used for passwords (it enabled lockout abuse).
UPDATE users SET locked_until = NULL, failed_login_count = 0;

ALTER TABLE recovery_codes ADD COLUMN revoked_at timestamptz;

-- ---------------------------------------------------------------------------
-- Rebooking and booking edits (spec §15)
-- ---------------------------------------------------------------------------

ALTER TABLE reservations ADD COLUMN rebooked_from_id uuid REFERENCES reservations(id);
CREATE INDEX reservations_rebooked_from_idx ON reservations(rebooked_from_id) WHERE rebooked_from_id IS NOT NULL;
ALTER TABLE reservations ADD CONSTRAINT rebook_not_self CHECK (rebooked_from_id IS NULL OR rebooked_from_id <> id);

-- Edited room lines are kept as history with status 'replaced'.
ALTER TABLE reservation_rooms DROP CONSTRAINT reservation_rooms_status_check;
ALTER TABLE reservation_rooms ADD CONSTRAINT reservation_rooms_status_check
  CHECK (status IN ('reserved', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'replaced'));
ALTER TABLE reservation_rooms ADD COLUMN replaced_by_edit_at timestamptz;

-- ---------------------------------------------------------------------------
-- Demo data markers — production boot refuses to start while any exist.
-- ---------------------------------------------------------------------------

ALTER TABLE properties ADD COLUMN data_origin text NOT NULL DEFAULT 'live' CHECK (data_origin IN ('live', 'demo'));
ALTER TABLE users ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE tax_rules ADD COLUMN origin text NOT NULL DEFAULT 'configured' CHECK (origin IN ('configured', 'demo_placeholder'));
