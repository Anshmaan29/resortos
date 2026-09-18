-- 0008 Remove on-device Aadhaar masking.
--
-- Product owner's decision after testing the capture flow on a real phone: the masking step (an
-- extra screen with a draggable black box and a confirmation tick-box) was not wanted. ID images
-- are now uploaded as captured.
--
-- **This deliberately differs from spec §19.4.5 and §58.3, which require masking.** It is recorded
-- in CLAUDE.md so a later change does not "restore" it by mistake.
--
-- Unchanged, and still true:
--   * only the last 4 characters of an ID number are ever stored (stay_occupants.id_last4)
--   * ID images stay in private storage, reachable only through 60-second signed URLs
--   * every view is written to document_access_log
--
-- `masked_on_device` keeps its column. Documents captured before this change really were masked, and
-- that is a fact about those files worth keeping; the column is historical from here on and nothing
-- writes it any more (it defaults to false). Dropping the column would erase that history and would
-- be a destructive change in the same release as the behaviour change (spec §77.3).

ALTER TABLE guest_documents DROP CONSTRAINT guest_documents_check2;

COMMENT ON COLUMN guest_documents.masked_on_device IS
  'Historical only: true for ID images captured while on-device Aadhaar masking existed (before migration 0008). Nothing sets it now.';
