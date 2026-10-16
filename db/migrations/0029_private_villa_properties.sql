-- Additive property access and private-villa time allocations. No hotel data is rewritten.
ALTER TABLE properties ADD COLUMN booking_model text NOT NULL DEFAULT 'hotel'
  CHECK (booking_model IN ('hotel','private_villa'));
CREATE TABLE property_owner_access (
  property_id uuid NOT NULL REFERENCES properties(id),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id,user_id)
);
CREATE TRIGGER property_owner_access_no_delete BEFORE DELETE ON property_owner_access
  FOR EACH ROW EXECUTE FUNCTION forbid_change('property access is retained for audit');
ALTER TABLE property_owner_access ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE reservations ADD COLUMN booking_model text NOT NULL DEFAULT 'hotel'
  CHECK (booking_model IN ('hotel','private_villa'));
ALTER TABLE reservations DROP CONSTRAINT reservations_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_dates_valid
  CHECK ((booking_model='hotel' AND departure>arrival) OR (booking_model='private_villa' AND departure>=arrival));
ALTER TABLE folios DROP CONSTRAINT folios_kind_check;
ALTER TABLE folios ADD CONSTRAINT folios_kind_check CHECK(kind IN ('stay','group_master','villa'));
CREATE TABLE villa_bookings (
  id uuid PRIMARY KEY REFERENCES reservations(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  use_kind text NOT NULL CHECK(use_kind IN ('one_bedroom','both_bedrooms','whole_villa','pool','garden')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  guest_count integer NOT NULL CHECK(guest_count BETWEEN 1 AND 1000),
  -- Overnight: per-night price; pool/garden: price for the entire time slot.
  meal_plan text NOT NULL DEFAULT 'EP' CHECK(meal_plan IN ('EP','CP','MAP','AP')),
  price numeric(14,2) NOT NULL CHECK(price>=0),
  gst_percent numeric(5,2) NOT NULL CHECK(gst_percent BETWEEN 0 AND 100),
  allocation_status text NOT NULL DEFAULT 'reserved' CHECK(allocation_status IN ('reserved','occupied','released','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id,id) REFERENCES reservations(property_id,id),
  CHECK(ends_at>starts_at),
  CONSTRAINT no_overlapping_private_villa EXCLUDE USING gist
    (property_id WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&)
    WHERE (allocation_status IN ('reserved','occupied'))
);
CREATE TRIGGER villa_bookings_no_delete BEFORE DELETE ON villa_bookings
  FOR EACH ROW EXECUTE FUNCTION forbid_change('villa bookings are never deleted');
CREATE FUNCTION sync_villa_allocation_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE villa_bookings SET allocation_status=CASE NEW.status
    WHEN 'checked_in' THEN 'occupied' WHEN 'checked_out' THEN 'completed'
    WHEN 'cancelled' THEN 'released' WHEN 'no_show' THEN 'released' ELSE 'reserved' END
    WHERE id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER reservations_villa_status AFTER UPDATE OF status ON reservations
  FOR EACH ROW WHEN (NEW.booking_model='private_villa') EXECUTE FUNCTION sync_villa_allocation_status();
-- All routes (including older hotel endpoints) must leave one consistent allocation.
CREATE FUNCTION guard_private_villa_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid; r reservations; v villa_bookings; model text;
BEGIN
  rid:=NEW.id;
  SELECT * INTO r FROM reservations WHERE id=rid;
  SELECT booking_model INTO model FROM properties WHERE id=r.property_id;
  IF model<>'private_villa' AND r.booking_model='hotel' THEN RETURN NULL; END IF;
  SELECT * INTO v FROM villa_bookings WHERE id=rid;
  IF model<>'private_villa' OR r.booking_model<>'private_villa' OR v.id IS NULL
    OR r.arrival<>(v.starts_at AT TIME ZONE 'Asia/Kolkata')::date
    OR r.departure<>(v.ends_at AT TIME ZONE 'Asia/Kolkata')::date
    OR v.property_id<>r.property_id
    OR EXISTS(SELECT 1 FROM reservation_rooms rr WHERE rr.reservation_id=r.id AND (rr.arrival<>r.arrival OR rr.departure<>r.departure)) THEN
    RAISE EXCEPTION 'resortos: use the villa booking screen to change dates or create villa bookings' USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reservations_private_villa_guard AFTER INSERT OR UPDATE ON reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_private_villa_booking();
CREATE CONSTRAINT TRIGGER villa_booking_dates_guard AFTER INSERT OR UPDATE ON villa_bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_private_villa_booking();
