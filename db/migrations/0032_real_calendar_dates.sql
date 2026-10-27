-- A live property always operates on its real local calendar date. The stored
-- current_business_date remains solely a day-end review cursor. Demo replay stays deterministic.
CREATE FUNCTION property_calendar_date(p properties) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p.data_origin = 'demo' THEN p.current_business_date
              ELSE (CURRENT_TIMESTAMP AT TIME ZONE p.timezone)::date END
$$;

-- Automatic room-cleaning tasks must use the same calendar as reception.
CREATE OR REPLACE FUNCTION sync_housekeeping_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  who uuid := NEW.updated_by;
  kind_hint text := NULLIF(current_setting('resortos.housekeeping_kind', true), '');
BEGIN
  IF NEW.housekeeping_status IS NOT DISTINCT FROM OLD.housekeeping_status THEN RETURN NULL; END IF;
  IF NEW.housekeeping_status = 'dirty' THEN
    -- Back to dirty from cleaning: the same task, waiting for someone again.
    UPDATE housekeeping_tasks SET status = 'open', started_at = NULL, started_by = NULL
     WHERE room_id = NEW.id AND status = 'in_progress';
    INSERT INTO housekeeping_tasks (property_id, room_id, kind, business_date, created_by)
    SELECT NEW.property_id, NEW.id,
           CASE WHEN kind_hint IN ('checkout', 'stayover', 'manual') THEN kind_hint ELSE 'manual' END,
           property_calendar_date(p), who
      FROM properties p WHERE p.id = NEW.property_id
    ON CONFLICT DO NOTHING;
  ELSIF NEW.housekeeping_status = 'cleaning' THEN
    UPDATE housekeeping_tasks SET status = 'in_progress', started_at = now(), started_by = who
     WHERE room_id = NEW.id AND status = 'open';
  ELSE -- clean or inspected
    UPDATE housekeeping_tasks
       SET status = 'done', completed_at = now(), completed_by = who,
           started_at = COALESCE(started_at, now()), started_by = COALESCE(started_by, who)
     WHERE room_id = NEW.id AND status IN ('open', 'in_progress');
  END IF;
  RETURN NULL;
END $$;
