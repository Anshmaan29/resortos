-- 0001 Foundation: identity, sessions, audit log (hash chain), idempotency, outbox, settings.
-- Spec: §4, §5, §48, §50, §51, §8.2

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Generic trigger helpers
-- ---------------------------------------------------------------------------

-- Blocks UPDATE and/or DELETE on append-only or protected tables.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'resortos: % on % is not allowed (%)', TG_OP, TG_TABLE_NAME, COALESCE(TG_ARGV[0], 'protected record')
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

-- Maintains updated_at and increments version for optimistic concurrency.
CREATE FUNCTION touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Properties
-- ---------------------------------------------------------------------------

CREATE TABLE properties (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  legal_name             text NOT NULL,
  address_line1          text NOT NULL,
  address_line2          text,
  city                   text NOT NULL,
  state_code             char(2) NOT NULL CHECK (state_code ~ '^\d{2}$'),
  pin_code               char(6) NOT NULL CHECK (pin_code ~ '^[1-9]\d{5}$'),
  gstin                  char(15) CHECK (gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  phone                  text NOT NULL,
  email                  citext,
  logo_path              text,
  check_in_time          time NOT NULL DEFAULT '12:00',
  check_out_time         time NOT NULL DEFAULT '11:00',
  timezone               text NOT NULL DEFAULT 'Asia/Kolkata',
  financial_year_start_month smallint NOT NULL DEFAULT 4 CHECK (financial_year_start_month BETWEEN 1 AND 12),
  -- Business date moves forward only through night audit (spec §35).
  current_business_date  date NOT NULL,
  is_practice            boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer NOT NULL DEFAULT 1,
  -- GSTIN state code must match property state (place of supply)
  CONSTRAINT gstin_matches_state CHECK (gstin IS NULL OR substring(gstin, 1, 2) = state_code)
);
CREATE TRIGGER properties_touch BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER properties_no_delete BEFORE DELETE ON properties FOR EACH ROW EXECUTE FUNCTION forbid_change('properties are never deleted');

-- Business date may only move forward.
CREATE FUNCTION guard_business_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_business_date < OLD.current_business_date THEN
    RAISE EXCEPTION 'resortos: business date cannot move backwards (% -> %)', OLD.current_business_date, NEW.current_business_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER properties_business_date BEFORE UPDATE OF current_business_date ON properties
  FOR EACH ROW EXECUTE FUNCTION guard_business_date();

-- ---------------------------------------------------------------------------
-- Users (Owner, Receptionist, optional Cleaner — no manager role)
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  full_name                 text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 80),
  username                  citext NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._]{3,32}$'),
  mobile                    text UNIQUE,
  email                     citext,
  role                      text NOT NULL CHECK (role IN ('owner', 'receptionist', 'cleaner')),
  password_hash             text NOT NULL,
  must_change_password      boolean NOT NULL DEFAULT true,
  password_changed_at       timestamptz,
  failed_login_count        integer NOT NULL DEFAULT 0,
  locked_until              timestamptz,
  -- Receptionist limits (spec §4.5). Owner ignores limits.
  discount_limit_percent    numeric(5,2) NOT NULL DEFAULT 10.00 CHECK (discount_limit_percent BETWEEN 0 AND 100),
  can_run_night_audit       boolean NOT NULL DEFAULT false,
  can_prepare_compliance    boolean NOT NULL DEFAULT false,
  -- Quick-switch PIN on trusted devices (4–6 digits, all roles)
  staff_pin_hash            text,
  -- Owner authorisation PIN (6 digits, owners only), separate from password
  owner_pin_hash            text,
  owner_pin_failed_count    integer NOT NULL DEFAULT 0,
  owner_pin_locked_until    timestamptz,
  totp_secret_encrypted     text,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid REFERENCES users(id),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  version                   integer NOT NULL DEFAULT 1,
  CONSTRAINT owner_pin_only_for_owner CHECK (owner_pin_hash IS NULL OR role = 'owner')
);
CREATE INDEX users_property_idx ON users(property_id);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER users_no_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION forbid_change('deactivate users instead');

CREATE TABLE recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes(user_id) WHERE used_at IS NULL;

CREATE TABLE trusted_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  name          text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  -- Only a SHA-256 of the cookie token is stored; the token itself never touches the DB.
  token_hash      bytea NOT NULL UNIQUE,
  trusted_device_id uuid REFERENCES trusted_devices(id),
  ip              inet,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id) WHERE revoked_at IS NULL;

-- Durable login attempt log for per-account and per-IP rate limiting (spec §5.1).
CREATE TABLE auth_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('password', 'owner_pin', 'staff_pin', 'recovery')),
  login       citext,
  user_id     uuid REFERENCES users(id),
  ip          inet,
  succeeded   boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_ip_idx ON auth_attempts(ip, created_at DESC);
CREATE INDEX auth_attempts_login_idx ON auth_attempts(login, created_at DESC);

-- ---------------------------------------------------------------------------
-- Audit log: append-only + tamper-evident SHA-256 hash chain per property (spec §50)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  chain_position  bigint NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id         uuid REFERENCES users(id),
  authorised_by   uuid REFERENCES users(id),
  session_id      uuid,
  device          text,
  ip              inet,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  before_values   jsonb,
  after_values    jsonb,
  reason          text,
  request_id      text,
  prev_hash       bytea,
  hash            bytea NOT NULL,
  UNIQUE (property_id, chain_position)
);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id);
CREATE INDEX audit_logs_property_time_idx ON audit_logs(property_id, occurred_at DESC);

-- Canonical content that is hashed. jsonb text output is deterministic (sorted keys).
CREATE FUNCTION audit_canonical(a audit_logs) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', a.id, 'property_id', a.property_id, 'chain_position', a.chain_position,
    'occurred_at', to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'user_id', a.user_id, 'authorised_by', a.authorised_by, 'session_id', a.session_id,
    'device', a.device, 'ip', host(a.ip), 'action', a.action, 'entity_type', a.entity_type,
    'entity_id', a.entity_id, 'before', a.before_values, 'after', a.after_values,
    'reason', a.reason, 'request_id', a.request_id
  )::text
$$;

CREATE FUNCTION audit_chain_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_row audit_logs;
BEGIN
  -- Serialise chain appends per property. Held until the transaction ends,
  -- so chain order always equals commit order.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:' || NEW.property_id::text, 0));

  SELECT * INTO last_row FROM audit_logs
   WHERE property_id = NEW.property_id
   ORDER BY chain_position DESC LIMIT 1;

  NEW.chain_position := COALESCE(last_row.chain_position, 0) + 1;
  NEW.prev_hash := last_row.hash;
  NEW.occurred_at := clock_timestamp();
  NEW.hash := sha256(COALESCE(NEW.prev_hash, '\x'::bytea) || convert_to(audit_canonical(NEW), 'UTF8'));
  RETURN NEW;
END $$;

CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain_link();
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_change('audit log is append-only');
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_change('audit log is append-only');

-- Returns the first broken link (if any). Used by the nightly integrity job.
CREATE FUNCTION verify_audit_chain(p_property uuid)
RETURNS TABLE (ok boolean, checked bigint, first_bad_position bigint) LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_logs;
  expected_prev bytea := NULL;
  expected_pos bigint := 0;
  n bigint := 0;
BEGIN
  FOR r IN SELECT * FROM audit_logs WHERE property_id = p_property ORDER BY chain_position LOOP
    n := n + 1;
    expected_pos := expected_pos + 1;
    IF r.chain_position <> expected_pos
       OR r.prev_hash IS DISTINCT FROM expected_prev
       OR r.hash <> sha256(COALESCE(r.prev_hash, '\x'::bytea) || convert_to(audit_canonical(r), 'UTF8')) THEN
      RETURN QUERY SELECT false, n, r.chain_position;
      RETURN;
    END IF;
    expected_prev := r.hash;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint;
END $$;

-- ---------------------------------------------------------------------------
-- Idempotency (spec §51): same key → original result, nothing new
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  property_id      uuid NOT NULL REFERENCES properties(id),
  method           text NOT NULL,
  path             text NOT NULL,
  request_hash     bytea NOT NULL,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys(created_at);

-- ---------------------------------------------------------------------------
-- Transactional outbox (spec §8.2): side effects run only after commit
-- ---------------------------------------------------------------------------

CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES properties(id),
  topic          text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  available_at   timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX outbox_pending_idx ON outbox_events(available_at) WHERE dispatched_at IS NULL;

-- ---------------------------------------------------------------------------
-- Settings & feature flags
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  property_id  uuid NOT NULL REFERENCES properties(id),
  key          text NOT NULL,
  value        jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id),
  PRIMARY KEY (property_id, key)
);

CREATE TABLE feature_flags (
  property_id  uuid NOT NULL REFERENCES properties(id),
  flag         text NOT NULL,
  enabled      boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id),
  PRIMARY KEY (property_id, flag)
);

-- Human-readable running numbers (BK-000183). Row lock serialises; rollback releases.
CREATE TABLE reference_counters (
  property_id  uuid NOT NULL REFERENCES properties(id),
  name         text NOT NULL,
  last_number  bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (property_id, name)
);

CREATE FUNCTION next_reference(p_property uuid, p_name text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  INSERT INTO reference_counters(property_id, name, last_number) VALUES (p_property, p_name, 1)
  ON CONFLICT (property_id, name) DO UPDATE SET last_number = reference_counters.last_number + 1
  RETURNING last_number INTO n;
  RETURN n;
END $$;
