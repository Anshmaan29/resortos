-- 0005 Check-in drafts, phone-as-scanner capture sessions, guest documents, stays,
-- occupants, vehicles, room shifts, checkout. Spec: §17–§22.
--
-- Checkout here is a stay/room status change only. Billing (Phase 2) plugs its
-- settle → invoice steps into the checkout pipeline; no bill data lives in these tables.

-- ---------------------------------------------------------------------------
-- Check-in drafts: every step is saved server-side (refresh / power cut safe)
-- ---------------------------------------------------------------------------

CREATE TABLE check_in_drafts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id),
  reservation_id        uuid NOT NULL,
  reservation_room_ids  uuid[] NOT NULL CHECK (cardinality(reservation_room_ids) BETWEEN 1 AND 100),
  step                  smallint NOT NULL DEFAULT 1 CHECK (step BETWEEN 1 AND 7),
  data                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'abandoned')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES users(id),
  confirmed_at          timestamptz,
  version               integer NOT NULL DEFAULT 1,
  FOREIGN KEY (property_id, reservation_id) REFERENCES reservations(property_id, id) ON DELETE RESTRICT,
  UNIQUE (property_id, id)
);
CREATE UNIQUE INDEX check_in_drafts_one_active ON check_in_drafts(reservation_id) WHERE status = 'active';
CREATE TRIGGER check_in_drafts_touch BEFORE UPDATE ON check_in_drafts FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER check_in_drafts_no_delete BEFORE DELETE ON check_in_drafts FOR EACH ROW EXECUTE FUNCTION forbid_change('drafts are kept as history');

-- ---------------------------------------------------------------------------
-- Phone-as-scanner capture sessions (spec §19.2)
-- ---------------------------------------------------------------------------

CREATE TABLE capture_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id),
  draft_id            uuid NOT NULL REFERENCES check_in_drafts(id) ON DELETE RESTRICT,
  token_hash          bytea NOT NULL UNIQUE,           -- QR token; only its SHA-256 is stored
  device_secret_hash  bytea UNIQUE,                    -- set when the first phone claims the QR
  claimed_at          timestamptz,
  claimed_user_agent  text,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  closed_at           timestamptz,
  closed_reason       text CHECK (closed_reason IN ('done', 'confirmed', 'expired', 'replaced', 'abandoned')),
  files_received      integer NOT NULL DEFAULT 0,
  CHECK (expires_at <= created_at + interval '10 minutes'),
  CHECK ((claimed_at IS NULL) = (device_secret_hash IS NULL)),
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
);
CREATE INDEX capture_sessions_draft_idx ON capture_sessions(draft_id);

-- A session is claimed once, closed once, and its binding never changes.
CREATE FUNCTION guard_capture_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.property_id, NEW.draft_id, NEW.token_hash, NEW.created_by, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.property_id, OLD.draft_id, OLD.token_hash, OLD.created_by, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'resortos: capture session binding is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.device_secret_hash IS NOT NULL AND NEW.device_secret_hash IS DISTINCT FROM OLD.device_secret_hash THEN
    RAISE EXCEPTION 'resortos: capture session already claimed by a device' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.closed_at IS NOT NULL AND (NEW.closed_at, NEW.closed_reason, NEW.device_secret_hash) IS DISTINCT FROM (OLD.closed_at, OLD.closed_reason, OLD.device_secret_hash) THEN
    RAISE EXCEPTION 'resortos: capture session is closed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_sessions_guard BEFORE UPDATE ON capture_sessions FOR EACH ROW EXECUTE FUNCTION guard_capture_session();
CREATE TRIGGER capture_sessions_no_delete BEFORE DELETE ON capture_sessions FOR EACH ROW EXECUTE FUNCTION forbid_change('capture sessions are audit history');

-- ---------------------------------------------------------------------------
-- Stays (one per checked-in reservation room)
-- ---------------------------------------------------------------------------

CREATE TABLE stays (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id),
  reservation_id        uuid NOT NULL,
  reservation_room_id   uuid NOT NULL UNIQUE REFERENCES reservation_rooms(id) ON DELETE RESTRICT,
  room_id               uuid NOT NULL,
  primary_guest_id      uuid NOT NULL,
  check_in_draft_id     uuid NOT NULL REFERENCES check_in_drafts(id),
  status                text NOT NULL DEFAULT 'in_house' CHECK (status IN ('in_house', 'checked_out')),
  checked_in_at         timestamptz NOT NULL DEFAULT now(),
  checked_in_by         uuid NOT NULL REFERENCES users(id),
  business_date_in      date NOT NULL,
  expected_departure    date NOT NULL,
  checked_out_at        timestamptz,
  checked_out_by        uuid REFERENCES users(id),
  business_date_out     date,
  early_departure       boolean NOT NULL DEFAULT false,
  version               integer NOT NULL DEFAULT 1,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (property_id, reservation_id) REFERENCES reservations(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, room_id) REFERENCES rooms(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, primary_guest_id) REFERENCES guests(property_id, id) ON DELETE RESTRICT,
  UNIQUE (property_id, id),
  CHECK (expected_departure > business_date_in),
  CHECK ((status = 'checked_out') = (checked_out_at IS NOT NULL)),
  CHECK (business_date_out IS NULL OR business_date_out >= business_date_in)
);
CREATE INDEX stays_room_in_house_idx ON stays(room_id) WHERE status = 'in_house';
CREATE INDEX stays_reservation_idx ON stays(reservation_id);
CREATE TRIGGER stays_touch BEFORE UPDATE ON stays FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER stays_no_delete BEFORE DELETE ON stays FOR EACH ROW EXECUTE FUNCTION forbid_change('stays are never deleted');

CREATE FUNCTION guard_stay_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'checked_out' THEN
    RAISE EXCEPTION 'resortos: a checked-out stay cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.reservation_id, NEW.reservation_room_id, NEW.primary_guest_id, NEW.checked_in_at, NEW.checked_in_by, NEW.business_date_in, NEW.check_in_draft_id)
     IS DISTINCT FROM (OLD.reservation_id, OLD.reservation_room_id, OLD.primary_guest_id, OLD.checked_in_at, OLD.checked_in_by, OLD.business_date_in, OLD.check_in_draft_id) THEN
    RAISE EXCEPTION 'resortos: check-in facts of a stay are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stays_guard BEFORE UPDATE ON stays FOR EACH ROW EXECUTE FUNCTION guard_stay_update();

CREATE TABLE stay_occupants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id),
  stay_id       uuid NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  occupant_key  text NOT NULL,                        -- id used by the draft UI and document slots
  full_name     text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  is_primary    boolean NOT NULL DEFAULT false,
  is_child      boolean NOT NULL DEFAULT false,
  age           smallint CHECK (age BETWEEN 0 AND 120),
  relation      text,
  nationality   char(2) NOT NULL DEFAULT 'IN',
  id_type       text NOT NULL DEFAULT 'none' CHECK (id_type IN ('aadhaar', 'passport', 'driving_licence', 'voter_id', 'pan', 'other', 'none')),
  -- Never a full ID number (spec §58.3): last 4 characters only.
  id_last4      text CHECK (id_last4 ~ '^[A-Za-z0-9]{4}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES users(id),
  UNIQUE (stay_id, occupant_key),
  CHECK (NOT is_child OR age IS NOT NULL)
);
CREATE UNIQUE INDEX stay_occupants_one_primary ON stay_occupants(stay_id) WHERE is_primary;
CREATE TRIGGER stay_occupants_no_delete BEFORE DELETE ON stay_occupants FOR EACH ROW EXECUTE FUNCTION forbid_change('occupant records are kept');

CREATE TABLE stay_vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES properties(id),
  stay_id          uuid NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  registration     text NOT NULL CHECK (registration ~ '^[A-Z0-9]{4,20}$'),
  vehicle_type     text NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'bus', 'other')),
  parking_slot     text,
  non_standard     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX stay_vehicles_registration_idx ON stay_vehicles(property_id, registration);
CREATE TRIGGER stay_vehicles_no_delete BEFORE DELETE ON stay_vehicles FOR EACH ROW EXECUTE FUNCTION forbid_change('vehicle records are kept');

-- ---------------------------------------------------------------------------
-- Guest documents (spec §19.5–§19.7): PENDING until the server has verified size + SHA-256
-- ---------------------------------------------------------------------------

CREATE TABLE guest_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id),
  draft_id            uuid REFERENCES check_in_drafts(id) ON DELETE RESTRICT,
  stay_id             uuid REFERENCES stays(id) ON DELETE RESTRICT,
  occupant_key        text,
  doc_type            text NOT NULL CHECK (doc_type IN ('guest_photo', 'id_front', 'id_back', 'id_extra', 'signature', 'grc', 'other')),
  id_type             text CHECK (id_type IN ('aadhaar', 'passport', 'driving_licence', 'voter_id', 'pan', 'other')),
  masked_on_device    boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'orphaned')),
  storage_key         text NOT NULL UNIQUE,
  content_type        text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/webp', 'image/png', 'application/pdf')),
  size_bytes          integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256              bytea NOT NULL CHECK (length(sha256) = 32),
  source              text NOT NULL CHECK (source IN ('desk_camera', 'phone_scanner', 'file_upload', 'signature_pad', 'server_generated')),
  capture_session_id  uuid REFERENCES capture_sessions(id),
  uploaded_by         uuid REFERENCES users(id),
  device              text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  verified_at         timestamptz,
  failure_reason      text,
  CHECK (draft_id IS NOT NULL OR stay_id IS NOT NULL),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  -- Aadhaar images must have been masked on the device before upload (spec §19.4, §58.3).
  CHECK (id_type IS DISTINCT FROM 'aadhaar' OR doc_type NOT IN ('id_front', 'id_back', 'id_extra') OR masked_on_device)
);
CREATE INDEX guest_documents_draft_idx ON guest_documents(draft_id);
CREATE INDEX guest_documents_stay_idx ON guest_documents(stay_id);
CREATE INDEX guest_documents_pending_idx ON guest_documents(created_at) WHERE status = 'pending';
CREATE TRIGGER guest_documents_no_delete BEFORE DELETE ON guest_documents FOR EACH ROW EXECUTE FUNCTION forbid_change('documents are removed only by the retention job');

-- Declared facts never change; status only moves forward; a stay can be attached once.
CREATE FUNCTION guard_guest_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.property_id, NEW.draft_id, NEW.doc_type, NEW.id_type, NEW.masked_on_device, NEW.storage_key, NEW.content_type, NEW.size_bytes, NEW.sha256, NEW.source, NEW.capture_session_id, NEW.created_at)
     IS DISTINCT FROM (OLD.property_id, OLD.draft_id, OLD.doc_type, OLD.id_type, OLD.masked_on_device, OLD.storage_key, OLD.content_type, OLD.size_bytes, OLD.sha256, OLD.source, OLD.capture_session_id, OLD.created_at) THEN
    RAISE EXCEPTION 'resortos: document facts are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('verified', 'failed') AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'orphaned' THEN
    RAISE EXCEPTION 'resortos: document status % cannot change to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.stay_id IS NOT NULL AND NEW.stay_id IS DISTINCT FROM OLD.stay_id THEN
    RAISE EXCEPTION 'resortos: document already belongs to a stay' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_documents_guard BEFORE UPDATE ON guest_documents FOR EACH ROW EXECUTE FUNCTION guard_guest_document();

-- Every view of a document image is logged (spec §19.7).
CREATE TABLE document_access_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  uuid NOT NULL REFERENCES properties(id),
  document_id  uuid NOT NULL REFERENCES guest_documents(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  purpose      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER document_access_log_immutable BEFORE UPDATE OR DELETE ON document_access_log FOR EACH ROW EXECUTE FUNCTION forbid_change('access log is append-only');

-- ---------------------------------------------------------------------------
-- Room shifts (spec §21)
-- ---------------------------------------------------------------------------

CREATE TABLE room_shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  stay_id         uuid NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  from_room_id    uuid NOT NULL REFERENCES rooms(id),
  to_room_id      uuid NOT NULL REFERENCES rooms(id),
  business_date   date NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  rate_decision   text NOT NULL CHECK (rate_decision IN ('keep_rate', 'new_room_type_rate')),
  authorised_by   uuid REFERENCES users(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (from_room_id <> to_room_id)
);
CREATE INDEX room_shifts_stay_idx ON room_shifts(stay_id);
CREATE TRIGGER room_shifts_immutable BEFORE UPDATE OR DELETE ON room_shifts FOR EACH ROW EXECUTE FUNCTION forbid_change('room shift history is append-only');

-- Check-in policy defaults (owner-configurable).
INSERT INTO settings (property_id, key, value)
SELECT id, 'check_in_policy', '{"idRequiredFor":"all_adults","requireGuestPhoto":true,"requireSignature":true}'::jsonb FROM properties
ON CONFLICT DO NOTHING;
