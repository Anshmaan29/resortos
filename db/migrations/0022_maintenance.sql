-- 0022 Maintenance (spec §38).
--
-- A ticket is a problem reported once and then worked, never edited into a different problem: the
-- room/area it was about, its status path and its cost are frozen by the guard below. A schedule is
-- the preventive side — AC service, generator, pump, water tank, fire extinguishers — and the night
-- audit opens a ticket when one is due (0023 registers the step).

CREATE TABLE maintenance_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  -- Exactly one target: a room, or a named area of the property ("generator", "lobby").
  room_id          uuid,
  area             text,
  title            text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
  description      text CHECK (description IS NULL OR length(description) <= 2000),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to      uuid REFERENCES users(id) ON DELETE RESTRICT,
  cost             numeric(14,2) CHECK (cost IS NULL OR cost >= 0),
  resolution_note  text CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  closed_at        timestamptz,
  closed_by        uuid REFERENCES users(id) ON DELETE RESTRICT,
  version          integer NOT NULL DEFAULT 1,
  FOREIGN KEY (property_id, room_id) REFERENCES rooms(property_id, id) ON DELETE RESTRICT,
  CONSTRAINT maintenance_tickets_target CHECK ((room_id IS NULL) <> (area IS NULL)),
  -- A ticket is resolved once (note and who) and closed once; closure keeps both facts.
  CONSTRAINT maintenance_tickets_resolved_has_time CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'closed' AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT maintenance_tickets_closed_complete CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  )
);
CREATE INDEX maintenance_tickets_open_idx ON maintenance_tickets(property_id, status) WHERE status IN ('open', 'in_progress');

CREATE TRIGGER maintenance_tickets_no_delete BEFORE DELETE ON maintenance_tickets
  FOR EACH ROW EXECUTE FUNCTION forbid_change('tickets are kept — close one instead');

-- The problem is history: what it was about, when it was raised and by whom never change, and the
-- status walks one path only: open → in_progress → resolved → closed (spec §38).
CREATE FUNCTION guard_maintenance_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id <> OLD.property_id OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.area IS DISTINCT FROM OLD.area OR NEW.title <> OLD.title
     OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'resortos: what a maintenance ticket was raised for cannot change' USING ERRCODE = 'check_violation';
  END IF;
  -- Who resolved/closed it and when is written once, when the status moves; it is never unset or
  -- rewritten afterwards.
  IF (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at)
     OR (OLD.resolved_by IS NOT NULL AND NEW.resolved_by IS DISTINCT FROM OLD.resolved_by)
     OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at)
     OR (OLD.closed_by IS NOT NULL AND NEW.closed_by IS DISTINCT FROM OLD.closed_by) THEN
    RAISE EXCEPTION 'resortos: a ticket is resolved and closed once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'resortos: a closed maintenance ticket is kept as it was' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW.status = OLD.status
          OR (OLD.status = 'open' AND NEW.status IN ('in_progress', 'resolved'))
          OR (OLD.status = 'in_progress' AND NEW.status IN ('open', 'resolved'))
          OR (OLD.status = 'resolved' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION 'resortos: a maintenance ticket cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER maintenance_tickets_guard BEFORE UPDATE ON maintenance_tickets
  FOR EACH ROW EXECUTE FUNCTION guard_maintenance_ticket();

COMMENT ON TABLE maintenance_tickets IS 'Fix-it work (spec §38). Append-only: resolved with a note and cost, closed once done; never edited or deleted.';

CREATE TABLE maintenance_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  area            text CHECK (area IS NULL OR length(area) <= 120),
  room_id         uuid,
  every_days      smallint NOT NULL CHECK (every_days BETWEEN 1 AND 3650),
  -- The next due date is data, not a generated column: the audit step moves it when it opens the
  -- ticket, so replaying a night audit cannot double-create or skip a due date.
  next_due        date NOT NULL,
  last_ticket_id  uuid REFERENCES maintenance_tickets(id) ON DELETE RESTRICT,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  version         integer NOT NULL DEFAULT 1,
  FOREIGN KEY (property_id, room_id) REFERENCES rooms(property_id, id) ON DELETE RESTRICT
);
COMMENT ON TABLE maintenance_schedules IS 'Preventive maintenance (spec §38): the night audit opens a ticket when next_due arrives and moves next_due forward.';

CREATE TRIGGER maintenance_schedules_no_delete BEFORE DELETE ON maintenance_schedules
  FOR EACH ROW EXECUTE FUNCTION forbid_change('schedules are deactivated, not deleted');

-- A room may be marked Maintenance or Out of order straight from its ticket; that is the existing
-- room service status (0002) and room_out_of_order, so nothing new is stored here.
