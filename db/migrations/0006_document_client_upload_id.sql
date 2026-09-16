-- 0006 Idempotent document creation (spec §19.5).
-- The device generates an id per captured photo. If the page reloads after the server created
-- the document but before the device saved the reply, retrying returns the same document
-- instead of leaving an orphaned "pending" one.

ALTER TABLE guest_documents ADD COLUMN client_upload_id uuid;
CREATE UNIQUE INDEX guest_documents_client_upload_unique ON guest_documents(draft_id, client_upload_id) WHERE client_upload_id IS NOT NULL;
