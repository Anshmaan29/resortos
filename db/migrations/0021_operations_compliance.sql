-- 0021 Housekeeping (spec §37), expenses (§39), Form C (§58.1) and the police register (§58.2).
--
-- Housekeeping
-- ------------
-- The board shows rooms by their housekeeping status, which already exists on `rooms` with its own
-- history (0002). A task is the work behind a status: who is cleaning which room, since when, and
-- who finished it. The two are kept in step by the database, not by every caller remembering to:
--
--   room becomes dirty     → an open task exists for it (created if none)
--   room becomes cleaning  → its task is in progress
--   room becomes clean     → its task is done, by whoever made it clean
--
-- So a receptionist who marks a room clean from the room board and a cleaner who taps
-- "Room cleaned" leave the same record, and a dirty room can never be missing from the task list.

ALTER TABLE properties
  -- Daily cleaning of occupied rooms (§37 "stayover cleaning tasks daily (setting)").
  ADD COLUMN housekeeping_stayovers   boolean NOT NULL DEFAULT true,
  -- A cleaned room waits for inspection before it counts as ready (§4.3).
  ADD COLUMN housekeeping_inspection  boolean NOT NULL DEFAULT false;

CREATE TABLE housekeeping_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  room_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('checkout', 'stayover', 'manual')),
  -- The day the cleaning is for.
  business_date    date NOT NULL,
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  assigned_to      uuid REFERENCES users(id) ON DELETE RESTRICT,
  note             text CHECK (note IS NULL OR length(note) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- NULL when the system created it (night audit, a status change with no user).
  created_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  started_at       timestamptz,
  started_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  completed_at     timestamptz,
  completed_by     uuid REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_reason text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  FOREIGN KEY (property_id, room_id) REFERENCES rooms(property_id, id) ON DELETE RESTRICT,
  UNIQUE (property_id, id),
  CONSTRAINT housekeeping_tasks_done_has_time CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT housekeeping_tasks_started_has_time CHECK (status <> 'in_progress' OR started_at IS NOT NULL),
  CONSTRAINT housekeeping_tasks_cancel_has_reason CHECK ((status = 'cancelled') = (cancelled_reason IS NOT NULL AND length(btrim(cancelled_reason)) >= 3))
);
-- One piece of open work per room: the board has one answer to "who is on 204".
CREATE UNIQUE INDEX housekeeping_tasks_one_open ON housekeeping_tasks(room_id) WHERE status IN ('open', 'in_progress');
-- Night audit creates stayover tasks; replaying it must not create them twice (see 0011's rules).
CREATE UNIQUE INDEX housekeeping_tasks_one_stayover ON housekeeping_tasks(room_id, business_date) WHERE kind = 'stayover';
CREATE INDEX housekeeping_tasks_board_idx ON housekeeping_tasks(property_id, status, business_date);
CREATE INDEX housekeeping_tasks_assignee_idx ON housekeeping_tasks(assigned_to) WHERE status IN ('open', 'in_progress');
CREATE TRIGGER housekeeping_tasks_touch BEFORE UPDATE ON housekeeping_tasks FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER housekeeping_tasks_no_delete BEFORE DELETE ON housekeeping_tasks
  FOR EACH ROW EXECUTE FUNCTION forbid_change('housekeeping tasks are kept — cancel one with a reason');

-- What a task was, and who finished it, is history. Only the live fields move, and only forwards
-- (a cleaner who stops half way puts the room back to dirty, which reopens the task).
CREATE FUNCTION guard_housekeeping_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id <> OLD.property_id OR NEW.room_id <> OLD.room_id OR NEW.kind <> OLD.kind
     OR NEW.business_date <> OLD.business_date OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'resortos: what a housekeeping task was for cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'resortos: a finished housekeeping task is kept as it was' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW.status = OLD.status
          OR (OLD.status = 'open' AND NEW.status IN ('in_progress', 'done', 'cancelled'))
          OR (OLD.status = 'in_progress' AND NEW.status IN ('open', 'done', 'cancelled'))) THEN
    RAISE EXCEPTION 'resortos: a housekeeping task cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER housekeeping_tasks_guard BEFORE UPDATE ON housekeeping_tasks FOR EACH ROW EXECUTE FUNCTION guard_housekeeping_task();

-- Keeps tasks in step with the room's housekeeping status (see the top of this file). A caller that
-- knows *why* a room became dirty (checkout, room change) says so with
--   SELECT set_config('resortos.housekeeping_kind', 'checkout', true)
-- before the update; anything else is a manual task.
CREATE FUNCTION sync_housekeeping_task() RETURNS trigger LANGUAGE plpgsql AS $$
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
           p.current_business_date, who
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
CREATE TRIGGER rooms_housekeeping_task AFTER UPDATE OF housekeeping_status ON rooms
  FOR EACH ROW EXECUTE FUNCTION sync_housekeeping_task();

-- Rooms already dirty when this migration runs get their task, so the board starts complete.
INSERT INTO housekeeping_tasks (property_id, room_id, kind, business_date, status, started_at)
SELECT r.property_id, r.id, 'manual', p.current_business_date,
       CASE r.housekeeping_status WHEN 'cleaning' THEN 'in_progress' ELSE 'open' END,
       CASE r.housekeeping_status WHEN 'cleaning' THEN now() END
  FROM rooms r JOIN properties p ON p.id = r.property_id
 WHERE r.housekeeping_status IN ('dirty', 'cleaning');

COMMENT ON TABLE housekeeping_tasks IS 'Cleaning work per room (spec §37). Kept in step with rooms.housekeeping_status by trigger rooms_housekeeping_task.';

-- ---------------------------------------------------------------------------
-- Expenses (spec §39)
-- ---------------------------------------------------------------------------
-- Money out, recorded the way money in is: append-only, into a payment account, a correction is a
-- reversing row. A cash expense comes out of the open shift of the person who paid it, so the shift's
-- expected cash falls by exactly that much (§39 "Cash expenses reduce shift expected cash") with no
-- change to the shift code — it already sums `account_ledger`.

CREATE TABLE expense_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 40),
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id) ON DELETE RESTRICT,
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (property_id, id),
  CONSTRAINT expense_categories_unique_name UNIQUE (property_id, name)
);
CREATE TRIGGER expense_categories_touch BEFORE UPDATE ON expense_categories FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER expense_categories_no_delete BEFORE DELETE ON expense_categories
  FOR EACH ROW EXECUTE FUNCTION forbid_change('categories are deactivated, not deleted — expenses refer to them');

-- The spec's starting list (§39), for every property that exists now. New properties get it from
-- the setup code.
INSERT INTO expense_categories (property_id, name, sort_order)
SELECT p.id, c.name, c.ord
  FROM properties p
 CROSS JOIN (VALUES ('Electricity', 1), ('Salaries', 2), ('Groceries', 3), ('Repairs', 4), ('Diesel', 5), ('Marketing', 6), ('Other', 99)) AS c(name, ord);

CREATE TABLE expenses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  number              text NOT NULL,
  category_id         uuid NOT NULL,
  -- The day the money was spent, which may be before the day it was entered.
  expense_date        date NOT NULL,
  method              text NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque')),
  payment_account_id  uuid NOT NULL,
  account_kind        text NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  -- Money leaves the account; a reversal puts it back.
  cash_effect         numeric(14,2) NOT NULL GENERATED ALWAYS AS (
                        amount * (CASE WHEN reverses_expense_id IS NULL THEN -1 ELSE 1 END)
                      ) STORED,
  paid_to             text NOT NULL CHECK (length(btrim(paid_to)) BETWEEN 2 AND 120),
  note                text CHECK (note IS NULL OR length(note) <= 500),
  -- The accounting day: the business date it was entered on, like every other money row.
  business_date       date NOT NULL,
  paid_at             timestamptz NOT NULL DEFAULT now(),
  paid_by             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cashier_shift_id    uuid,
  reverses_expense_id uuid REFERENCES expenses(id) ON DELETE RESTRICT,
  reversal_reason     text,
  -- A correction is a reversal plus the corrected entry, written together; this ties them.
  corrects_expense_id uuid REFERENCES expenses(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (property_id, category_id) REFERENCES expense_categories(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, cashier_shift_id) REFERENCES cashier_shifts(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (payment_account_id, account_kind) REFERENCES payment_accounts(id, kind) ON DELETE RESTRICT,
  UNIQUE (property_id, number),
  CONSTRAINT expenses_account_matches_method CHECK (
    CASE method
      WHEN 'cash' THEN account_kind = 'cash'
      WHEN 'upi' THEN account_kind = 'upi'
      WHEN 'card' THEN account_kind IN ('bank', 'other')
      ELSE account_kind = 'bank'
    END
  ),
  CONSTRAINT expenses_cash_in_shift CHECK (method <> 'cash' OR cashier_shift_id IS NOT NULL),
  CONSTRAINT expenses_not_after_entry CHECK (expense_date <= business_date),
  CONSTRAINT expenses_reversal_has_reason CHECK (
    (reverses_expense_id IS NULL AND reversal_reason IS NULL)
    OR (reverses_expense_id IS NOT NULL AND length(btrim(reversal_reason)) >= 3)
  ),
  CONSTRAINT expenses_reversal_is_not_correction CHECK (reverses_expense_id IS NULL OR corrects_expense_id IS NULL)
);
CREATE UNIQUE INDEX expenses_one_reversal ON expenses(reverses_expense_id) WHERE reverses_expense_id IS NOT NULL;
CREATE UNIQUE INDEX expenses_one_correction ON expenses(corrects_expense_id) WHERE corrects_expense_id IS NOT NULL;
CREATE INDEX expenses_date_idx ON expenses(property_id, business_date);
CREATE INDEX expenses_shift_idx ON expenses(cashier_shift_id) WHERE cashier_shift_id IS NOT NULL;
CREATE TRIGGER expenses_no_update BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION forbid_change('an expense is never edited — correct it, which reverses it and records the right one');
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION forbid_change('expenses are kept');

-- Same rule as money taken (0014): cash paid out comes from the payer's own open shift.
CREATE FUNCTION guard_expense_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  IF NEW.cashier_shift_id IS NULL THEN RETURN NEW; END IF;
  SELECT opened_by, closed_at INTO s FROM cashier_shifts WHERE id = NEW.cashier_shift_id FOR SHARE;
  IF s.opened_by IS DISTINCT FROM NEW.paid_by THEN
    RAISE EXCEPTION 'resortos: cash can only come out of the shift of the person who paid it' USING ERRCODE = 'check_violation';
  END IF;
  IF s.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'resortos: that shift is closed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expenses_shift_guard BEFORE INSERT ON expenses FOR EACH ROW EXECUTE FUNCTION guard_expense_shift();

-- A bill photo for an expense (§39), stored like guest documents: PENDING until the server has
-- re-read the bytes and they match the declared size and SHA-256.
CREATE TABLE expense_bills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  expense_id    uuid NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  storage_key   text NOT NULL UNIQUE,
  content_type  text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 15728640),
  sha256        char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
  failure_reason text,
  uploaded_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  verified_at   timestamptz,
  CONSTRAINT expense_bills_verified_has_time CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);
CREATE INDEX expense_bills_expense_idx ON expense_bills(expense_id);
CREATE TRIGGER expense_bills_no_delete BEFORE DELETE ON expense_bills FOR EACH ROW EXECUTE FUNCTION forbid_change('bill photos are kept');
CREATE FUNCTION guard_expense_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status = 'pending'
     OR (NEW.id, NEW.property_id, NEW.expense_id, NEW.storage_key, NEW.content_type, NEW.size_bytes, NEW.sha256, NEW.uploaded_by, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.property_id, OLD.expense_id, OLD.storage_key, OLD.content_type, OLD.size_bytes, OLD.sha256, OLD.uploaded_by, OLD.created_at) THEN
    RAISE EXCEPTION 'resortos: a bill photo only moves once, from pending to verified or failed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expense_bills_guard BEFORE UPDATE ON expense_bills FOR EACH ROW EXECUTE FUNCTION guard_expense_bill();

-- The account ledger now includes expenses (see 0015, 0018).
CREATE OR REPLACE VIEW account_ledger AS
  SELECT p.property_id, p.payment_account_id AS account_id, 'payment'::text AS source, p.id AS source_id,
         p.number AS reference, p.business_date, p.received_at AS at, p.received_by AS by_user,
         p.cashier_shift_id, p.cash_effect AS amount,
         p.entry_type || CASE WHEN p.reverses_payment_id IS NULL THEN '' ELSE ' reversal' END AS description
    FROM payments p
   WHERE p.payment_account_id IS NOT NULL
  UNION ALL
  SELECT r.property_id, r.payment_account_id, 'company_receipt', r.id, r.number, r.business_date, r.received_at,
         r.received_by, r.cashier_shift_id, r.cash_effect,
         'company payment' || CASE WHEN r.reverses_receipt_id IS NULL THEN '' ELSE ' reversal' END
    FROM company_receipts r
  UNION ALL
  SELECT o.property_id, o.payment_account_id, 'ota_payout', o.id, o.number, o.business_date, o.received_at,
         o.received_by, NULL, o.cash_effect,
         'OTA payout' || CASE WHEN o.reverses_payout_id IS NULL THEN '' ELSE ' reversal' END
    FROM ota_payouts o
  UNION ALL
  SELECT e.property_id, e.payment_account_id, 'expense', e.id, e.number, e.business_date, e.paid_at,
         e.paid_by, e.cashier_shift_id, e.cash_effect,
         'expense' || CASE WHEN e.reverses_expense_id IS NULL THEN '' ELSE ' reversal' END
    FROM expenses e;

COMMENT ON TABLE expenses IS 'Money paid out (spec §39). Append-only: a correction reverses the entry and records the right one. Reversed is derived, never stored.';

-- ---------------------------------------------------------------------------
-- Form C (spec §58.1)
-- ---------------------------------------------------------------------------
-- Foreign nationals must be reported to the Bureau of Immigration within 24 hours of arrival. The
-- record exists from the moment such a guest is checked in — created by the database, so no check-in
-- path can forget it — and the dashboard counts down until it is submitted.
--
-- These are the only full identity numbers ResortOS keeps (passport and visa), because the official
-- form requires them. Like every ID detail they never go to Google, messages, logs or the AI
-- provider (CLAUDE.md rule 12), and audit entries record that they changed, not what they are.

CREATE TABLE form_c_records (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  stay_id                   uuid NOT NULL,
  occupant_id               uuid NOT NULL UNIQUE REFERENCES stay_occupants(id) ON DELETE RESTRICT,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'departure_updated')),
  -- Arrival at the resort; the 24-hour deadline runs from here.
  arrived_at                timestamptz NOT NULL,
  passport_number           text CHECK (passport_number ~ '^[A-Z0-9]{5,20}$'),
  passport_place_of_issue   text CHECK (length(passport_place_of_issue) <= 80),
  passport_issue_date       date,
  passport_expiry_date      date,
  visa_number               text CHECK (visa_number ~ '^[A-Z0-9-]{3,30}$'),
  visa_type                 text CHECK (length(visa_type) <= 40),
  visa_place_of_issue       text CHECK (length(visa_place_of_issue) <= 80),
  visa_issue_date           date,
  visa_expiry_date          date,
  arrival_in_india_date     date,
  arrival_port              text CHECK (length(arrival_port) <= 80),
  next_destination          text CHECK (length(next_destination) <= 120),
  address_in_india          text CHECK (length(address_in_india) <= 300),
  contact_in_india          text CHECK (length(contact_in_india) <= 60),
  home_address              text CHECK (length(home_address) <= 300),
  home_contact              text CHECK (length(home_contact) <= 60),
  submitted_reference       text CHECK (length(btrim(submitted_reference)) BETWEEN 3 AND 60),
  submitted_at              timestamptz,
  submitted_by              uuid REFERENCES users(id) ON DELETE RESTRICT,
  departure_updated_at      timestamptz,
  departure_updated_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid REFERENCES users(id) ON DELETE RESTRICT,
  version                   integer NOT NULL DEFAULT 1,
  FOREIGN KEY (property_id, stay_id) REFERENCES stays(property_id, id) ON DELETE RESTRICT,
  CONSTRAINT form_c_passport_dates CHECK (passport_expiry_date IS NULL OR passport_issue_date IS NULL OR passport_expiry_date > passport_issue_date),
  CONSTRAINT form_c_visa_dates CHECK (visa_expiry_date IS NULL OR visa_issue_date IS NULL OR visa_expiry_date > visa_issue_date),
  -- Submitted means every field the official form asks for was there, and the portal's reference kept.
  CONSTRAINT form_c_submitted_complete CHECK (
    status = 'pending' OR (
      submitted_reference IS NOT NULL AND submitted_at IS NOT NULL AND submitted_by IS NOT NULL
      AND passport_number IS NOT NULL AND passport_place_of_issue IS NOT NULL AND passport_issue_date IS NOT NULL
      AND passport_expiry_date IS NOT NULL AND visa_number IS NOT NULL AND visa_type IS NOT NULL
      AND visa_place_of_issue IS NOT NULL AND visa_issue_date IS NOT NULL AND visa_expiry_date IS NOT NULL
      AND arrival_in_india_date IS NOT NULL AND arrival_port IS NOT NULL AND next_destination IS NOT NULL
      AND address_in_india IS NOT NULL AND home_address IS NOT NULL
    )
  ),
  CONSTRAINT form_c_departure_after_submit CHECK ((status = 'departure_updated') = (departure_updated_at IS NOT NULL))
);
CREATE INDEX form_c_pending_idx ON form_c_records(property_id, arrived_at) WHERE status = 'pending';
CREATE INDEX form_c_stay_idx ON form_c_records(stay_id);
CREATE TRIGGER form_c_records_touch BEFORE UPDATE ON form_c_records FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER form_c_records_no_delete BEFORE DELETE ON form_c_records
  FOR EACH ROW EXECUTE FUNCTION forbid_change('Form C records are kept as long as the law requires');

-- Status only moves forwards, and a submitted form's details are what was submitted.
CREATE FUNCTION guard_form_c() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id <> OLD.property_id OR NEW.stay_id <> OLD.stay_id OR NEW.occupant_id <> OLD.occupant_id OR NEW.arrived_at <> OLD.arrived_at THEN
    RAISE EXCEPTION 'resortos: which guest a Form C is for cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW.status = OLD.status
          OR (OLD.status = 'pending' AND NEW.status = 'submitted')
          OR (OLD.status = 'submitted' AND NEW.status = 'departure_updated')) THEN
    RAISE EXCEPTION 'resortos: Form C cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND (
       (NEW.passport_number, NEW.passport_place_of_issue, NEW.passport_issue_date, NEW.passport_expiry_date, NEW.visa_number, NEW.visa_type,
        NEW.visa_place_of_issue, NEW.visa_issue_date, NEW.visa_expiry_date, NEW.arrival_in_india_date, NEW.arrival_port,
        NEW.address_in_india, NEW.contact_in_india, NEW.home_address, NEW.home_contact, NEW.submitted_reference, NEW.submitted_at, NEW.submitted_by)
       IS DISTINCT FROM
       (OLD.passport_number, OLD.passport_place_of_issue, OLD.passport_issue_date, OLD.passport_expiry_date, OLD.visa_number, OLD.visa_type,
        OLD.visa_place_of_issue, OLD.visa_issue_date, OLD.visa_expiry_date, OLD.arrival_in_india_date, OLD.arrival_port,
        OLD.address_in_india, OLD.contact_in_india, OLD.home_address, OLD.home_contact, OLD.submitted_reference, OLD.submitted_at, OLD.submitted_by)) THEN
    RAISE EXCEPTION 'resortos: a submitted Form C keeps the details that were submitted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER form_c_records_guard BEFORE UPDATE ON form_c_records FOR EACH ROW EXECUTE FUNCTION guard_form_c();

-- Every foreign adult or child checked in gets a pending record in the same transaction.
CREATE FUNCTION open_form_c() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nationality <> 'IN' THEN
    INSERT INTO form_c_records (property_id, stay_id, occupant_id, arrived_at)
    SELECT NEW.property_id, NEW.stay_id, NEW.id, s.checked_in_at FROM stays s WHERE s.id = NEW.stay_id
    ON CONFLICT (occupant_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER stay_occupants_form_c AFTER INSERT ON stay_occupants FOR EACH ROW EXECUTE FUNCTION open_form_c();

-- Foreign guests already in the house when this runs get their record too.
INSERT INTO form_c_records (property_id, stay_id, occupant_id, arrived_at)
SELECT o.property_id, o.stay_id, o.id, s.checked_in_at
  FROM stay_occupants o JOIN stays s ON s.id = o.stay_id
 WHERE o.nationality <> 'IN' AND s.status = 'in_house';

COMMENT ON TABLE form_c_records IS 'Form C for foreign nationals (spec §58.1): Pending → Submitted (portal reference) → Departure updated. Opened by trigger at check-in.';

-- ---------------------------------------------------------------------------
-- Police / guest register (spec §58.2)
-- ---------------------------------------------------------------------------
-- One row per occupant, built from the stay records; nothing new is stored except which columns
-- the local police station wants, in their order.
ALTER TABLE properties
  ADD COLUMN police_register_columns text[] NOT NULL
    DEFAULT ARRAY['serial', 'arrival', 'name', 'age', 'nationality', 'address', 'mobile', 'id_type', 'id_last4', 'room', 'persons', 'purpose', 'vehicle', 'departure']
    CHECK (
      cardinality(police_register_columns) BETWEEN 1 AND 20
      AND police_register_columns <@ ARRAY['serial', 'arrival', 'name', 'age', 'nationality', 'address', 'mobile', 'id_type', 'id_last4',
                                           'room', 'persons', 'purpose', 'vehicle', 'departure', 'signature']
    );
