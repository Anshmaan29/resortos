-- Hotel cash controls stay mandatory. Private villas keep the same append-only money
-- records and account ledger, without a cashier opening/closing workflow.
-- Existing villa bookings retain their original whole-property exclusivity (mask 3).
ALTER TABLE villa_bookings ADD COLUMN resource_mask integer NOT NULL DEFAULT 3 CHECK(resource_mask IN (1,2,3));
ALTER TABLE villa_bookings DROP CONSTRAINT no_overlapping_private_villa;
ALTER TABLE villa_bookings ADD CONSTRAINT no_overlapping_private_villa EXCLUDE USING gist
  (property_id WITH =,
   int4range(CASE WHEN resource_mask=2 THEN 2 ELSE 1 END,CASE WHEN resource_mask=1 THEN 2 ELSE 3 END,'[)') WITH &&,
   tstzrange(starts_at,ends_at,'[)') WITH &&)
  WHERE (allocation_status IN ('reserved','occupied'));

CREATE FUNCTION guard_villa_room_choice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen_mask integer; selected_number text; final_status text; final_room uuid;
BEGIN
  SELECT resource_mask INTO chosen_mask FROM villa_bookings WHERE id=NEW.reservation_id;
  SELECT status,room_id INTO final_status,final_room FROM reservation_rooms WHERE id=NEW.id;
  IF chosen_mask IS NULL OR chosen_mask=3 OR final_status NOT IN ('reserved','checked_in') THEN RETURN NULL; END IF;
  SELECT number INTO selected_number FROM rooms WHERE id=final_room;
  IF (chosen_mask=1 AND selected_number IS DISTINCT FROM '1') OR (chosen_mask=2 AND selected_number IS DISTINCT FROM '2') THEN
    RAISE EXCEPTION 'resortos: choose the booked villa room; edit the villa booking to change rooms' USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reservation_villa_room_choice AFTER INSERT OR UPDATE ON reservation_rooms
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_villa_room_choice();

ALTER TABLE payments DROP CONSTRAINT payments_cash_in_shift;
ALTER TABLE expenses DROP CONSTRAINT expenses_cash_in_shift;
ALTER TABLE company_receipts DROP CONSTRAINT company_receipts_cash_in_shift;
CREATE FUNCTION require_hotel_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.method='cash' AND NEW.cashier_shift_id IS NULL
    AND EXISTS(SELECT 1 FROM properties p WHERE p.id=NEW.property_id AND p.booking_model<>'private_villa') THEN
    RAISE EXCEPTION 'resortos: hotel cash must be recorded within a cashier shift (%)', TG_TABLE_NAME||'_cash_in_shift'
      USING ERRCODE='check_violation', CONSTRAINT=TG_TABLE_NAME||'_cash_in_shift';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_require_hotel_shift BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION require_hotel_cash_shift();
CREATE TRIGGER expenses_require_hotel_shift BEFORE INSERT ON expenses FOR EACH ROW EXECUTE FUNCTION require_hotel_cash_shift();
CREATE TRIGGER company_receipts_require_hotel_shift BEFORE INSERT ON company_receipts FOR EACH ROW EXECUTE FUNCTION require_hotel_cash_shift();

-- Physical occupancy projection: a combined booking has one party/bill and occupies two rooms.
CREATE VIEW villa_room_usage AS
SELECT rm.id AS room_id,v.id AS reservation_id,v.property_id,v.use_kind,v.starts_at,v.ends_at,v.allocation_status
FROM rooms rm JOIN villa_bookings v ON v.property_id=rm.property_id
WHERE rm.number IN ('1','2') AND (v.resource_mask & CASE WHEN rm.number='2' THEN 2 ELSE 1 END)>0;
