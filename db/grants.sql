-- Re-applied after every migration run. Idempotent.
-- The API connects as resortos_app, which can read and write rows but can never
-- DROP, TRUNCATE, ALTER, or change triggers (spec §48).

GRANT USAGE ON SCHEMA public TO resortos_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO resortos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO resortos_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO resortos_app;

-- DELETE is granted only where rows are genuinely disposable. Protected tables
-- additionally carry BEFORE DELETE triggers as a second guard.
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM resortos_app;
GRANT DELETE ON idempotency_keys TO resortos_app;

-- Append-only tables: insert and read only.
REVOKE UPDATE ON audit_logs, room_status_history, auth_attempts, guest_credit_entries FROM resortos_app;
REVOKE UPDATE ON schema_migrations FROM resortos_app;
REVOKE INSERT ON schema_migrations FROM resortos_app;

-- Override history is append-only.
REVOKE UPDATE ON owner_overrides FROM resortos_app;

-- Stay history is append-only.
REVOKE UPDATE ON room_shifts, document_access_log FROM resortos_app;

-- A registration card is replaced by a new version, never edited (spec §20).
REVOKE UPDATE ON grc_documents FROM resortos_app;

-- A completed night audit run is never edited (spec §35).
REVOKE UPDATE ON night_audits FROM resortos_app;

-- Money and GST documents are append-only (spec §25.4, §29.4). Triggers refuse changes too; the
-- grant is the first of the two locks.
REVOKE UPDATE ON payments, invoices, invoice_lines, invoice_tax_groups, invoice_payments, owner_review_seen FROM resortos_app;

-- Bill lines accept exactly one update, the void, and a trigger enforces which columns (spec §23).
-- UPDATE stays granted because voiding is an update; the trigger is what makes it safe.

-- Job queue (pg-boss). Its schema is created and upgraded by the migration role; the API only
-- reads and writes jobs. DELETE is granted here because jobs genuinely are disposable — pg-boss
-- archives and prunes completed work — which is the exception the rule above describes.
GRANT USAGE ON SCHEMA pgboss TO resortos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO resortos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO resortos_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO resortos_app;
