-- Optional guest signatures must never be recorded as signed when no image was collected.
ALTER TABLE grc_documents DROP CONSTRAINT grc_documents_signature_method_check;
ALTER TABLE grc_documents ALTER COLUMN signature_document_id DROP NOT NULL;
ALTER TABLE grc_documents ALTER COLUMN signed_at DROP NOT NULL;
ALTER TABLE grc_documents ADD CONSTRAINT grc_documents_signature_method_check
  CHECK (signature_method IN ('touchscreen', 'phone', 'paper_scan', 'not_collected'));
ALTER TABLE grc_documents ADD CONSTRAINT grc_documents_signature_consistency
  CHECK ((signature_method = 'not_collected' AND signature_document_id IS NULL AND signed_at IS NULL)
      OR (signature_method <> 'not_collected' AND signature_document_id IS NOT NULL AND signed_at IS NOT NULL));
-- The hotel's requested default; retain all other check-in settings.
UPDATE settings SET value = jsonb_set(value, '{requireSignature}', 'false'::jsonb)
  WHERE key = 'check_in_policy';
