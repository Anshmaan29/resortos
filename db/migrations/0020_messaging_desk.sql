-- 0020 Guest messages (spec §40, §41), shared desk computers (§5.3), and the owner settings both need.
--
-- Messages
-- --------
-- A guest message is a row before it is anything else. The outbox handler that notices "checked in"
-- only *queues* a message — idempotently, keyed on the event that caused it — and a separate sender
-- delivers it. So every message has one visible record with its template, channel, recipient,
-- status, retries and failure reason (§40), a failure can never reach a booking or a bill, and
-- "Resend" is a new row rather than an edit of history.
--
-- Channels: email now (Resend). WhatsApp and SMS use the same templates and the same rows; they are
-- switched off until Meta verification and DLT registration exist.

-- Owner settings for messages. Columns on the property: they are read on every message and must
-- always exist (the same reasoning as 0015 and 0019).
ALTER TABLE properties
  -- Off until the owner has verified the sending domain (§41: SPF, DKIM, DMARC) and switched it on.
  ADD COLUMN email_enabled              boolean NOT NULL DEFAULT false,
  ADD COLUMN email_from_name            text CHECK (email_from_name IS NULL OR length(email_from_name) <= 80),
  ADD COLUMN email_from_address         citext CHECK (email_from_address IS NULL OR email_from_address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD COLUMN email_reply_to             citext CHECK (email_reply_to IS NULL OR email_reply_to ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Quiet hours for non-urgent messages (§40), in the property's timezone. Default 21:30–08:00.
  ADD COLUMN quiet_hours_start          time NOT NULL DEFAULT '21:30',
  ADD COLUMN quiet_hours_end            time NOT NULL DEFAULT '08:00',
  -- The checkout reminder goes the evening before departure (§40).
  ADD COLUMN checkout_reminder_time     time NOT NULL DEFAULT '19:00',
  -- Skip it for a one-night stay checked in that same afternoon (§40, configurable).
  ADD COLUMN reminder_skip_same_day     boolean NOT NULL DEFAULT true,
  -- Template variables the resort fills in once (§40).
  ADD COLUMN reception_phone            text CHECK (reception_phone IS NULL OR length(reception_phone) <= 20),
  ADD COLUMN wifi_details               text CHECK (wifi_details IS NULL OR length(wifi_details) <= 120),
  ADD COLUMN location_link              text CHECK (location_link IS NULL OR location_link ~ '^https://'),
  -- Shared desk computers (§5.3): lock after this many minutes without use.
  ADD COLUMN desk_lock_minutes          smallint NOT NULL DEFAULT 5 CHECK (desk_lock_minutes BETWEEN 1 AND 60);

-- A guest reads messages in English or Hindi (§40).
ALTER TABLE guests ADD COLUMN preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'hi'));

-- The owner's wording for a message. Absent rows fall back to the built-in wording in the code, so a
-- fresh property sends sensible messages without anyone writing templates first.
CREATE TABLE message_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  template_key          text NOT NULL CHECK (template_key IN ('booking_confirmation', 'check_in_welcome', 'checkout_reminder', 'invoice', 'receipt')),
  channel               text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms')),
  language              text NOT NULL CHECK (language IN ('en', 'hi')),
  subject               text CHECK (subject IS NULL OR length(subject) <= 200),
  body                  text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  is_active             boolean NOT NULL DEFAULT true,
  -- WhatsApp: the Meta-approved template name and its approval state (§41). SMS: the DLT template id.
  provider_template_id  text,
  approval_status       text CHECK (approval_status IN ('not_submitted', 'pending', 'approved', 'rejected')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES users(id) ON DELETE RESTRICT,
  version               integer NOT NULL DEFAULT 1,
  UNIQUE (property_id, template_key, channel, language),
  CONSTRAINT message_templates_email_has_subject CHECK (channel <> 'email' OR subject IS NOT NULL)
);
CREATE TRIGGER message_templates_touch BEFORE UPDATE ON message_templates FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER message_templates_no_delete BEFORE DELETE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION forbid_change('templates are switched off, not deleted — sent messages refer to them');

CREATE TABLE messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  template_key          text NOT NULL,
  channel               text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms')),
  language              text NOT NULL CHECK (language IN ('en', 'hi')),
  -- The address it went to, as it was then. An email address, never a phone number for email.
  recipient             text NOT NULL,
  guest_id              uuid,
  reservation_id        uuid,
  stay_id               uuid,
  invoice_id            uuid,
  payment_id            uuid,
  -- What caused it: an outbox event, the reminder schedule, or a person pressing Resend.
  trigger               text NOT NULL CHECK (trigger IN ('event', 'schedule', 'resend', 'test')),
  source_key            text NOT NULL,
  -- Rendered when queued, so what was sent is what is shown, even if the template changes later.
  subject               text,
  body                  text NOT NULL,
  status                text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'opened', 'bounced', 'complained', 'failed', 'skipped')),
  -- Why a message was not sent at all (no email on file, channel off) or why it finally failed.
  skip_reason           text,
  last_error            text,
  attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Quiet hours move this forward; retries back off from it. Computed by the database clock.
  send_after            timestamptz NOT NULL DEFAULT now(),
  provider              text,
  provider_message_id   text,
  queued_at             timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,
  delivered_at          timestamptz,
  failed_at             timestamptz,
  created_by            uuid REFERENCES users(id) ON DELETE RESTRICT,
  resend_of             uuid REFERENCES messages(id) ON DELETE RESTRICT,

  FOREIGN KEY (property_id, guest_id) REFERENCES guests(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, reservation_id) REFERENCES reservations(property_id, id) ON DELETE RESTRICT,
  -- Queuing is idempotent: the same cause produces the same message once, however often the
  -- outbox delivers the event or the schedule runs. A resend has its own source key.
  CONSTRAINT messages_once_per_cause UNIQUE (property_id, source_key, template_key, channel),
  CONSTRAINT messages_skipped_has_reason CHECK (status <> 'skipped' OR skip_reason IS NOT NULL),
  CONSTRAINT messages_failed_has_error CHECK (status <> 'failed' OR last_error IS NOT NULL),
  CONSTRAINT messages_sent_recorded CHECK (status NOT IN ('sent', 'delivered', 'opened', 'bounced', 'complained') OR sent_at IS NOT NULL)
);
CREATE INDEX messages_due_idx ON messages(send_after) WHERE status = 'queued';
CREATE INDEX messages_reservation_idx ON messages(reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX messages_stay_idx ON messages(stay_id) WHERE stay_id IS NOT NULL;
CREATE UNIQUE INDEX messages_provider_id ON messages(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages FOR EACH ROW EXECUTE FUNCTION forbid_change('message history is kept');

-- What was sent never changes; only its delivery state moves on.
CREATE FUNCTION guard_message_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.property_id, NEW.template_key, NEW.channel, NEW.language, NEW.recipient, NEW.guest_id, NEW.reservation_id,
      NEW.stay_id, NEW.invoice_id, NEW.payment_id, NEW.trigger, NEW.source_key, NEW.subject, NEW.body, NEW.queued_at,
      NEW.created_by, NEW.resend_of)
     IS DISTINCT FROM
     (OLD.property_id, OLD.template_key, OLD.channel, OLD.language, OLD.recipient, OLD.guest_id, OLD.reservation_id,
      OLD.stay_id, OLD.invoice_id, OLD.payment_id, OLD.trigger, OLD.source_key, OLD.subject, OLD.body, OLD.queued_at,
      OLD.created_by, OLD.resend_of) THEN
    RAISE EXCEPTION 'resortos: a message is never rewritten — send it again instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('failed', 'skipped') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'resortos: a failed or skipped message stays that way — send it again instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_guard BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION guard_message_update();

-- Every delivery event the provider reported, as it reported it. Append-only.
CREATE TABLE message_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id   uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  status       text NOT NULL,
  detail       text,
  occurred_at  timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_events_message_idx ON message_events(message_id, occurred_at);
CREATE TRIGGER message_events_immutable BEFORE UPDATE OR DELETE ON message_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change('delivery history is append-only');

COMMENT ON TABLE messages IS
  'Every guest message (spec §40): what was sent, to whom, why, and what happened to it. Queued idempotently per cause; never rewritten.';

-- ---------------------------------------------------------------------------
-- Shared desk computers (spec §5.3)
-- ---------------------------------------------------------------------------
-- `trusted_devices` exists since 0001. A session on a trusted desk may be started with a staff PIN
-- instead of a password — but only by someone who logged in with their password earlier that day.

ALTER TABLE trusted_devices
  ADD COLUMN revoked_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT trusted_devices_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 60);
CREATE TRIGGER trusted_devices_no_delete BEFORE DELETE ON trusted_devices
  FOR EACH ROW EXECUTE FUNCTION forbid_change('trusted devices are revoked, not deleted');

-- A staff PIN is 4–6 digits, hashed like a password; set by its owner after a password check.
ALTER TABLE users ADD COLUMN staff_pin_set_at timestamptz;

-- When a non-urgent message may go (spec §40): now, or the end of the property's quiet hours if it is
-- inside them. Worked out by the database clock in the property's timezone — never the app's clock —
-- and correct for a window that crosses midnight (21:30–08:00) as well as one that does not.
CREATE FUNCTION quiet_hours_release(p_property uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN CASE WHEN p.quiet_hours_start > p.quiet_hours_end
                     THEN x.local_t >= p.quiet_hours_start OR x.local_t < p.quiet_hours_end
                     ELSE x.local_t >= p.quiet_hours_start AND x.local_t < p.quiet_hours_end END
           THEN ((CASE WHEN x.local_t < p.quiet_hours_end THEN x.local_d ELSE x.local_d + 1 END) + p.quiet_hours_end) AT TIME ZONE p.timezone
           ELSE now()
         END
    FROM properties p
    CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE p.timezone)::time AS local_t, (now() AT TIME ZONE p.timezone)::date AS local_d) x
   WHERE p.id = p_property
$$;
