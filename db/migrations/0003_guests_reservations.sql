-- 0003 Guests, reservations (incl. groups), room allocations with double-booking protection.
-- Spec: §12, §13, §15, §16

-- ---------------------------------------------------------------------------
-- Guests
-- ---------------------------------------------------------------------------

CREATE TABLE guests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  first_name      text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 60),
  last_name       text NOT NULL DEFAULT '',
  mobile          text NOT NULL CHECK (mobile ~ '^\+[1-9]\d{7,14}$'),
  email           citext,
  address_line    text,
  city            text,
  state           text,
  pin_code        text,
  country         char(2) NOT NULL DEFAULT 'IN',
  nationality     char(2) NOT NULL DEFAULT 'IN',
  date_of_birth   date,
  company_name    text,
  company_gstin   char(15),
  preferences     text,
  is_vip          boolean NOT NULL DEFAULT false,
  special_note    text,
  -- Merged duplicates point at the surviving profile; history is preserved (spec §16).
  merged_into_id  uuid REFERENCES guests(id),
  merged_at       timestamptz,
  source          text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'import')),
  import_job_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id),
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (property_id, id),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
CREATE INDEX guests_mobile_idx ON guests(property_id, mobile) WHERE merged_into_id IS NULL;
CREATE INDEX guests_name_trgm_idx ON guests USING gin ((lower(first_name || ' ' || last_name)) gin_trgm_ops);
CREATE INDEX guests_city_idx ON guests(property_id, lower(city));
CREATE TRIGGER guests_touch BEFORE UPDATE ON guests FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER guests_no_delete BEFORE DELETE ON guests FOR EACH ROW EXECUTE FUNCTION forbid_change('guests are merged or anonymised, never deleted');

-- ---------------------------------------------------------------------------
-- Reservations. One reservation may hold many rooms (groups, families, weddings).
-- ---------------------------------------------------------------------------

CREATE TABLE reservations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  number                 text NOT NULL,                          -- BK-000183
  primary_guest_id       uuid NOT NULL,
  source                 text NOT NULL CHECK (source IN (
                           'walk_in', 'phone', 'whatsapp', 'direct', 'website', 'makemytrip', 'goibibo',
                           'booking_com', 'agoda', 'airbnb', 'corporate', 'travel_agent', 'other')),
  ota_reference          text,
  arrival                date NOT NULL,
  departure              date NOT NULL,
  status                 text NOT NULL CHECK (status IN ('tentative', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show')),
  group_name             text,
  group_leader_guest_id  uuid,
  billing_mode           text NOT NULL DEFAULT 'separate' CHECK (billing_mode IN ('master', 'separate', 'split')),
  special_requests       text,
  internal_notes         text,
  cancelled_at           timestamptz,
  cancelled_by           uuid REFERENCES users(id),
  cancel_reason          text,
  cancel_note            text,
  cancel_money_option    text CHECK (cancel_money_option IN ('none', 'refund', 'cancellation_charge', 'guest_credit', 'partial_refund')),
  source_kind            text NOT NULL DEFAULT 'app' CHECK (source_kind IN ('app', 'import')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES users(id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES users(id),
  version                integer NOT NULL DEFAULT 1,
  UNIQUE (property_id, number),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, primary_guest_id) REFERENCES guests(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, group_leader_guest_id) REFERENCES guests(property_id, id) ON DELETE RESTRICT,
  CHECK (departure > arrival),
  CHECK (departure - arrival <= 90),
  CHECK (source NOT IN ('makemytrip', 'goibibo', 'booking_com', 'agoda', 'airbnb') OR ota_reference IS NOT NULL),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
-- OTA reference is unique per OTA (spec §33) — duplicate imports rejected by the database.
CREATE UNIQUE INDEX reservations_ota_ref_unique ON reservations(property_id, source, ota_reference) WHERE ota_reference IS NOT NULL;
CREATE INDEX reservations_arrival_idx ON reservations(property_id, arrival);
CREATE INDEX reservations_departure_idx ON reservations(property_id, departure);
CREATE INDEX reservations_guest_idx ON reservations(primary_guest_id);
CREATE INDEX reservations_status_idx ON reservations(property_id, status);
CREATE TRIGGER reservations_touch BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER reservations_no_delete BEFORE DELETE ON reservations FOR EACH ROW EXECUTE FUNCTION forbid_change('cancel instead of delete');

-- Status machine enforced in the database as a second guard (spec §12.3).
CREATE FUNCTION guard_reservation_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
       (OLD.status = 'tentative'  AND NEW.status IN ('confirmed', 'cancelled'))
    OR (OLD.status = 'confirmed'  AND NEW.status IN ('checked_in', 'cancelled', 'no_show'))
    OR (OLD.status = 'checked_in' AND NEW.status = 'checked_out')
  ) THEN
    RAISE EXCEPTION 'resortos: reservation cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservations_status_guard BEFORE UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION guard_reservation_status();

CREATE TABLE reservation_rooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  reservation_id  uuid NOT NULL,
  room_type_id    uuid NOT NULL,
  room_id         uuid,                      -- optional until check-in
  arrival         date NOT NULL,
  departure       date NOT NULL,
  adults          smallint NOT NULL CHECK (adults BETWEEN 1 AND 20),
  child_ages      smallint[] NOT NULL DEFAULT '{}',
  rate_plan_id    uuid REFERENCES rate_plans(id),
  meal_plan       text NOT NULL DEFAULT 'EP' CHECK (meal_plan IN ('EP', 'CP', 'MAP', 'AP')),
  nightly_rate    numeric(14,2) NOT NULL CHECK (nightly_rate >= 0),
  -- If rate is below the room type floor, who authorised it (Owner PIN)
  rate_authorised_by uuid REFERENCES users(id),
  status          text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'checked_in', 'checked_out', 'cancelled', 'no_show')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1,
  FOREIGN KEY (property_id, reservation_id) REFERENCES reservations(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, room_type_id) REFERENCES room_types(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, room_id) REFERENCES rooms(property_id, id) ON DELETE RESTRICT,
  CHECK (departure > arrival)
);
CREATE INDEX reservation_rooms_reservation_idx ON reservation_rooms(reservation_id);
CREATE INDEX reservation_rooms_type_dates_idx ON reservation_rooms(room_type_id, arrival, departure) WHERE status IN ('reserved', 'checked_in');
CREATE TRIGGER reservation_rooms_touch BEFORE UPDATE ON reservation_rooms FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER reservation_rooms_no_delete BEFORE DELETE ON reservation_rooms FOR EACH ROW EXECUTE FUNCTION forbid_change('cancel instead of delete');

-- ---------------------------------------------------------------------------
-- Room allocations: THE double-booking guard (spec §13). Hard database requirement.
-- ---------------------------------------------------------------------------

CREATE TABLE room_allocations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL REFERENCES properties(id),
  reservation_room_id  uuid NOT NULL REFERENCES reservation_rooms(id) ON DELETE RESTRICT,
  room_id              uuid NOT NULL,
  start_date           date NOT NULL,
  end_date             date NOT NULL,          -- exclusive: checkout day is free for a new arrival
  status               text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'checked_in', 'released', 'completed')),
  release_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              integer NOT NULL DEFAULT 1,
  FOREIGN KEY (property_id, room_id) REFERENCES rooms(property_id, id) ON DELETE RESTRICT,
  CHECK (end_date > start_date),
  CONSTRAINT no_overlapping_room_allocations EXCLUDE USING gist (
    room_id WITH =,
    daterange(start_date, end_date, '[)') WITH &&
  ) WHERE (status IN ('reserved', 'checked_in'))
);
CREATE INDEX room_allocations_room_dates_idx ON room_allocations(room_id, start_date, end_date);
CREATE INDEX room_allocations_rr_idx ON room_allocations(reservation_room_id);
CREATE TRIGGER room_allocations_touch BEFORE UPDATE ON room_allocations FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER room_allocations_no_delete BEFORE DELETE ON room_allocations FOR EACH ROW EXECUTE FUNCTION forbid_change('release instead of delete');

-- Released/completed allocations are history: their room and dates are frozen.
CREATE FUNCTION guard_allocation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('released', 'completed') THEN
    RAISE EXCEPTION 'resortos: closed room allocation cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.room_id <> OLD.room_id OR NEW.start_date <> OLD.start_date THEN
    RAISE EXCEPTION 'resortos: allocation room/start cannot change; release and create a new allocation'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_allocations_guard BEFORE UPDATE ON room_allocations FOR EACH ROW EXECUTE FUNCTION guard_allocation_update();

-- Guest credit (from cancellations kept as credit, spec §15.1) — ledger, never a mutable balance.
CREATE TABLE guest_credit_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  guest_id        uuid NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  reservation_id  uuid REFERENCES reservations(id),
  amount          numeric(14,2) NOT NULL CHECK (amount <> 0),   -- + credit given, − credit used
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id)
);
CREATE INDEX guest_credit_entries_guest_idx ON guest_credit_entries(guest_id);
CREATE TRIGGER guest_credit_entries_immutable BEFORE UPDATE OR DELETE ON guest_credit_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change('credit ledger is append-only');

-- Agreed rate per night (weekend/festival prices differ). Night audit posts from here (Phase 2).
CREATE TABLE reservation_room_nights (
  reservation_room_id  uuid NOT NULL REFERENCES reservation_rooms(id) ON DELETE RESTRICT,
  night_date           date NOT NULL,
  property_id          uuid NOT NULL REFERENCES properties(id),
  room_rate            numeric(14,2) NOT NULL CHECK (room_rate >= 0),     -- base/calendar rate after override
  extra_person_amount  numeric(14,2) NOT NULL DEFAULT 0 CHECK (extra_person_amount >= 0),
  meal_amount          numeric(14,2) NOT NULL DEFAULT 0 CHECK (meal_amount >= 0),
  rate_source          text NOT NULL CHECK (rate_source IN ('base', 'calendar', 'manual')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_room_id, night_date)
);
CREATE TRIGGER reservation_room_nights_no_delete BEFORE DELETE ON reservation_room_nights
  FOR EACH ROW EXECUTE FUNCTION forbid_change('nightly rates are history');
