-- A room move must not bill the same stay twice for the same night.
-- Explicit void/reposting is still possible; automatic posting respects existing voids.
CREATE UNIQUE INDEX folio_lines_one_posting_per_stay_night
  ON folio_lines (folio_id, business_date, line_type)
  WHERE source='night_audit' AND voided_at IS NULL;
