-- 0009 Dead-letter marker for the outbox (spec §8.2).
--
-- An event that a handler keeps refusing must stop being retried, without ever being thrown away:
-- a failed WhatsApp message is still a record that the system meant to send one. `failed_at` marks
-- an event as given up on, so the dispatcher skips it while it stays visible in job status and in
-- the Data Safety panel later.
--
-- The table needs no delete protection: `resortos_app` has no DELETE right on it (`db/grants.sql`
-- revokes DELETE everywhere except `idempotency_keys`), so the API cannot lose an event even by
-- mistake. Pruning dispatched events is a retention job for Phase 3, run deliberately.

ALTER TABLE outbox_events ADD COLUMN failed_at timestamptz;

-- An event is pending, dispatched, or dead — never two of those.
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_one_outcome
  CHECK (dispatched_at IS NULL OR failed_at IS NULL);

-- Status counts and the operator's "what is stuck" list.
CREATE INDEX outbox_failed_idx ON outbox_events(created_at DESC) WHERE failed_at IS NOT NULL;

COMMENT ON COLUMN outbox_events.failed_at IS
  'Set when the dispatcher gave up after the maximum attempts. The event is kept forever; it is never retried again unless an operator clears this.';
