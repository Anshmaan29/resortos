-- Guest photo is optional, like the signature. Retain all existing captured images.
UPDATE settings SET value = jsonb_set(value, '{requireGuestPhoto}', 'false'::jsonb)
  WHERE key = 'check_in_policy';

-- A returning guest's ID is copied to a new private object for their new stay. Keep provenance
-- without reassigning or modifying the historical document or its storage object.
ALTER TABLE guest_documents ADD COLUMN reused_from_document_id uuid REFERENCES guest_documents(id);
ALTER TABLE guest_documents DROP CONSTRAINT guest_documents_source_check;
ALTER TABLE guest_documents ADD CONSTRAINT guest_documents_source_check CHECK
  (source IN ('desk_camera','phone_scanner','file_upload','signature_pad','server_generated','saved_guest_id'));
ALTER TABLE guest_documents ADD CONSTRAINT guest_documents_reuse_source_check CHECK
  ((source = 'saved_guest_id') = (reused_from_document_id IS NOT NULL));
CREATE INDEX guest_documents_reused_from_idx ON guest_documents(reused_from_document_id)
  WHERE reused_from_document_id IS NOT NULL;
CREATE FUNCTION guard_reused_document_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reused_from_document_id IS DISTINCT FROM OLD.reused_from_document_id THEN
    RAISE EXCEPTION 'resortos: document reuse provenance is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_documents_reuse_guard BEFORE UPDATE ON guest_documents
  FOR EACH ROW EXECUTE FUNCTION guard_reused_document_source();
