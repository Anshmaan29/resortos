-- Preserve the exact provider payload between attempts, including sender and PDF bytes.
-- No provider credentials are stored here. A stalled send beyond the provider's 24h
-- deduplication window is held for manual reconciliation instead of retried blindly.
ALTER TABLE messages ADD COLUMN outgoing_payload jsonb;
ALTER TABLE messages ADD COLUMN first_attempt_at timestamptz;
