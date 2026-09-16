-- 0002 Property setup: room types, rooms, room status, meal plans, rate plans, tax rules.
-- Spec: §9, §10, §11, §30

-- ---------------------------------------------------------------------------
-- Room types
-- ---------------------------------------------------------------------------

CREATE TABLE room_types (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,8}$'),
  name               text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  description        text,
  base_occupancy     smallint NOT NULL CHECK (base_occupancy BETWEEN 1 AND 20),
  max_occupancy      smallint NOT NULL CHECK (max_occupancy BETWEEN 1 AND 30),
  base_rate          numeric(14,2) NOT NULL CHECK (base_rate >= 0),
  -- Floor: going below needs Owner PIN (spec §11.1)
  min_rate           numeric(14,2) NOT NULL CHECK (min_rate >= 0),
  extra_adult_rate   numeric(14,2) NOT NULL DEFAULT 0 CHECK (extra_adult_rate >= 0),
  extra_child_rate   numeric(14,2) NOT NULL DEFAULT 0 CHECK (extra_child_rate >= 0),
  sort_order         integer NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id),
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (property_id, code),
  UNIQUE (property_id, id),
  CHECK (max_occupancy >= base_occupancy),
  CHECK (base_rate >= min_rate)
);
CREATE TRIGGER room_types_touch BEFORE UPDATE ON room_types FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER room_types_no_delete BEFORE DELETE ON room_types FOR EACH ROW EXECUTE FUNCTION forbid_change('deactivate room types instead');

-- ---------------------------------------------------------------------------
-- Rooms. Housekeeping + service status stored; occupancy derived from allocations.
-- ---------------------------------------------------------------------------

CREATE TABLE rooms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  room_type_id         uuid NOT NULL,
  number               text NOT NULL CHECK (length(number) BETWEEN 1 AND 10),
  unit_type            text NOT NULL DEFAULT 'room' CHECK (unit_type IN ('room', 'cottage', 'villa', 'tent', 'suite')),
  view                 text CHECK (view IN ('pool', 'garden', 'lake', 'hill', 'other')),
  building             text,
  floor                text,
  amenities            text[] NOT NULL DEFAULT '{}',
  connecting_room_id   uuid REFERENCES rooms(id),
  is_accessible        boolean NOT NULL DEFAULT false,
  notes                text,
  housekeeping_status  text NOT NULL DEFAULT 'clean' CHECK (housekeeping_status IN ('dirty', 'cleaning', 'clean', 'inspected')),
  service_status       text NOT NULL DEFAULT 'in_service' CHECK (service_status IN ('in_service', 'maintenance', 'out_of_order')),
  sort_order           integer NOT NULL DEFAULT 0,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users(id),
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (property_id, number),
  UNIQUE (property_id, id),
  -- Room type must belong to the same property
  FOREIGN KEY (property_id, room_type_id) REFERENCES room_types(property_id, id) ON DELETE RESTRICT
);
CREATE INDEX rooms_type_idx ON rooms(room_type_id);
CREATE TRIGGER rooms_touch BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER rooms_no_delete BEFORE DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION forbid_change('rooms with history are deactivated, never deleted');

CREATE TABLE room_status_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  uuid NOT NULL REFERENCES properties(id),
  room_id      uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  dimension    text NOT NULL CHECK (dimension IN ('housekeeping', 'service')),
  from_status  text NOT NULL,
  to_status    text NOT NULL,
  reason       text,
  changed_by   uuid REFERENCES users(id),
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_status_history_room_idx ON room_status_history(room_id, changed_at DESC);
CREATE TRIGGER room_status_history_immutable BEFORE UPDATE OR DELETE ON room_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_change('status history is append-only');

-- Every status change is written to history automatically — cannot be forgotten by app code.
-- The acting user is passed via the transaction-local setting resortos.user_id.
CREATE FUNCTION record_room_status_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := NULLIF(current_setting('resortos.user_id', true), '')::uuid;
  why text := NULLIF(current_setting('resortos.reason', true), '');
BEGIN
  IF NEW.housekeeping_status IS DISTINCT FROM OLD.housekeeping_status THEN
    INSERT INTO room_status_history(property_id, room_id, dimension, from_status, to_status, reason, changed_by)
    VALUES (NEW.property_id, NEW.id, 'housekeeping', OLD.housekeeping_status, NEW.housekeeping_status, why, actor);
  END IF;
  IF NEW.service_status IS DISTINCT FROM OLD.service_status THEN
    INSERT INTO room_status_history(property_id, room_id, dimension, from_status, to_status, reason, changed_by)
    VALUES (NEW.property_id, NEW.id, 'service', OLD.service_status, NEW.service_status, why, actor);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_status_history AFTER UPDATE OF housekeeping_status, service_status ON rooms
  FOR EACH ROW EXECUTE FUNCTION record_room_status_change();

-- Out-of-order periods remove rooms from sellable inventory (spec §10, §38)
CREATE TABLE room_out_of_order (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties(id),
  room_id      uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  start_date   date NOT NULL,
  end_date     date NOT NULL,          -- exclusive
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  released_by  uuid REFERENCES users(id),
  CHECK (end_date > start_date),
  CONSTRAINT no_overlapping_out_of_order EXCLUDE USING gist (
    room_id WITH =, daterange(start_date, end_date, '[)') WITH &&
  ) WHERE (status = 'active')
);
CREATE TRIGGER room_out_of_order_no_delete BEFORE DELETE ON room_out_of_order
  FOR EACH ROW EXECUTE FUNCTION forbid_change('release instead of delete');

-- ---------------------------------------------------------------------------
-- Meal plans (EP / CP / MAP / AP)
-- ---------------------------------------------------------------------------

CREATE TABLE meal_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id),
  code                text NOT NULL CHECK (code IN ('EP', 'CP', 'MAP', 'AP')),
  name                text NOT NULL,
  adult_rate          numeric(14,2) NOT NULL DEFAULT 0 CHECK (adult_rate >= 0),
  child_rate          numeric(14,2) NOT NULL DEFAULT 0 CHECK (child_rate >= 0),
  -- Post meal component as its own folio line when tax/reporting needs it (spec §11.2)
  post_separately     boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (property_id, code)
);
CREATE TRIGGER meal_plans_touch BEFORE UPDATE ON meal_plans FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------------------------------------------------------------------------
-- Rate plans + dated price overrides (season, weekend, festival, day-of-week)
-- ---------------------------------------------------------------------------

CREATE TABLE rate_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties(id),
  code         text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,16}$'),
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'corporate', 'travel_agent', 'package')),
  is_default   boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (property_id, code)
);
CREATE UNIQUE INDEX rate_plans_one_default ON rate_plans(property_id) WHERE is_default;
CREATE TRIGGER rate_plans_touch BEFORE UPDATE ON rate_plans FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE rate_calendar (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES properties(id),
  rate_plan_id   uuid NOT NULL REFERENCES rate_plans(id) ON DELETE RESTRICT,
  room_type_id   uuid NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  label          text NOT NULL,                         -- "Diwali", "Weekend", "Peak season"
  start_date     date NOT NULL,
  end_date       date NOT NULL,                         -- exclusive
  -- 0=Sun … 6=Sat; empty = every day
  days_of_week   smallint[] NOT NULL DEFAULT '{}',
  rate           numeric(14,2) NOT NULL CHECK (rate >= 0),
  min_stay       smallint CHECK (min_stay BETWEEN 1 AND 30),
  -- Higher priority wins when entries overlap (festival > weekend > season)
  priority       smallint NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  CHECK (end_date > start_date),
  CHECK (days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[])
);
CREATE INDEX rate_calendar_lookup_idx ON rate_calendar(rate_plan_id, room_type_id, start_date, end_date) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Dated tax rules (spec §30.1). Rates are data, never code.
-- ---------------------------------------------------------------------------

CREATE TABLE tax_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL REFERENCES properties(id),
  tax_category       text NOT NULL CHECK (tax_category IN ('accommodation', 'food', 'activity', 'laundry', 'transport', 'other')),
  unit_value_above   numeric(14,2),     -- exclusive lower bound, NULL = none
  unit_value_up_to   numeric(14,2),     -- inclusive upper bound, NULL = none
  rate_percent       numeric(5,2) NOT NULL CHECK (rate_percent BETWEEN 0 AND 100),
  sac                text NOT NULL CHECK (sac ~ '^\d{4,8}$'),
  effective_from     date NOT NULL,
  effective_to       date,              -- inclusive, NULL = open-ended
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (unit_value_above IS NULL OR unit_value_up_to IS NULL OR unit_value_up_to > unit_value_above),
  -- Two rules can never apply to the same line: overlapping dates AND overlapping value bands are rejected.
  CONSTRAINT no_overlapping_tax_rules EXCLUDE USING gist (
    property_id WITH =,
    tax_category WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&,
    numrange(unit_value_above, unit_value_up_to, '(]') WITH &&
  )
);
-- Rules are corrected by closing (effective_to) and adding a new one; only effective_to may change.
CREATE FUNCTION guard_tax_rule_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tax_category, NEW.unit_value_above, NEW.unit_value_up_to, NEW.rate_percent, NEW.sac, NEW.effective_from)
     IS DISTINCT FROM
     (OLD.tax_category, OLD.unit_value_above, OLD.unit_value_up_to, OLD.rate_percent, OLD.sac, OLD.effective_from) THEN
    RAISE EXCEPTION 'resortos: tax rules cannot be edited; close the rule and add a new one'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_rules_guard BEFORE UPDATE ON tax_rules FOR EACH ROW EXECUTE FUNCTION guard_tax_rule_update();
CREATE TRIGGER tax_rules_no_delete BEFORE DELETE ON tax_rules FOR EACH ROW EXECUTE FUNCTION forbid_change('tax rules are kept forever');
