-- Booking-specific agreed package prices and GST. Existing bookings continue using dated rules.
ALTER TABLE reservation_rooms
  ADD COLUMN includes_meal_plan boolean NOT NULL DEFAULT false,
  ADD COLUMN gst_rate_override numeric(5,2) CHECK (gst_rate_override BETWEEN 0 AND 100);
ALTER TABLE folio_lines
  ADD COLUMN gst_rate_override numeric(5,2) CHECK (gst_rate_override BETWEEN 0 AND 100);

CREATE FUNCTION guard_folio_gst_override() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gst_rate_override IS DISTINCT FROM OLD.gst_rate_override THEN
    RAISE EXCEPTION 'resortos: a bill line GST rate is never edited; correct the charge instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER folio_lines_gst_guard BEFORE UPDATE OF gst_rate_override ON folio_lines
  FOR EACH ROW EXECUTE FUNCTION guard_folio_gst_override();
