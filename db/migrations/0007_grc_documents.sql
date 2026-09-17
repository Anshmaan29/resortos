-- 0007 Guest registration card (spec §20, §76).
--
-- A row exists only after the server has re-read the stored PDF and the SHA-256 matched,
-- the same rule as guest documents (spec §19.5). Until then the stay has no GRC.
--
-- Append-only in the strongest sense: no column is ever updated. Regenerating a card
-- (an occupant was added, the guest signed again) writes a NEW version that points at the
-- one it replaces through supersedes_id, on its own storage key. Nothing is overwritten,
-- in the database or in object storage. The current card of a stay is its highest version.

CREATE TABLE grc_documents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            uuid NOT NULL REFERENCES properties(id),
  stay_id                uuid NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  -- One number per stay (GRC-000012), carried by every version of that stay's card.
  number                 text NOT NULL CHECK (number ~ '^GRC-[0-9]{6,12}$'),
  version                integer NOT NULL CHECK (version BETWEEN 1 AND 99),
  supersedes_id          uuid REFERENCES grc_documents(id) ON DELETE RESTRICT,
  storage_key            text NOT NULL UNIQUE,
  content_type           text NOT NULL DEFAULT 'application/pdf' CHECK (content_type = 'application/pdf'),
  size_bytes             integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256                 bytea NOT NULL CHECK (length(sha256) = 32),
  -- How the guest signed (spec §20): desk touchscreen, the phone capture session, or paper scanned back in.
  signature_method       text NOT NULL CHECK (signature_method IN ('touchscreen', 'phone', 'paper_scan')),
  signature_document_id  uuid NOT NULL REFERENCES guest_documents(id) ON DELETE RESTRICT,
  signed_at              timestamptz NOT NULL,
  -- Privacy-notice version the guest accepted, kept for DPDP consent records (spec §58.4).
  notice_version         text NOT NULL,
  -- Part of the rendered page, so the stored bytes can be reproduced from this row alone.
  generated_at           timestamptz NOT NULL,
  generated_by           uuid NOT NULL REFERENCES users(id),
  reason                 text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 300),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, number, version),
  UNIQUE (stay_id, version),
  -- Version 1 replaces nothing; later versions replace exactly one card and say why.
  CHECK ((version = 1) = (supersedes_id IS NULL)),
  CHECK (version = 1 OR reason IS NOT NULL)
);
CREATE INDEX grc_documents_stay_idx ON grc_documents(stay_id, version DESC);
CREATE UNIQUE INDEX grc_documents_supersedes_once ON grc_documents(supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TRIGGER grc_documents_no_delete BEFORE DELETE ON grc_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_change('registration cards are kept');
CREATE TRIGGER grc_documents_no_update BEFORE UPDATE ON grc_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_change('a registration card is replaced by a new version, never changed');

-- Every view of a registration card is logged, like a document image (spec §19.7).
ALTER TABLE document_access_log ADD COLUMN grc_document_id uuid REFERENCES grc_documents(id) ON DELETE RESTRICT;
ALTER TABLE document_access_log ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE document_access_log ADD CONSTRAINT document_access_log_one_target
  CHECK ((document_id IS NULL) <> (grc_document_id IS NULL));
