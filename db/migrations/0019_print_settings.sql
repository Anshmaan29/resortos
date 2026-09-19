-- 0019 What printed documents say beyond the transaction itself (spec §29.2, §36).
--
-- Owner settings that every invoice, receipt and shift report reads. Columns on the property rather
-- than rows in `settings`, like the night audit permission and the cash threshold: they must always
-- exist, and a typo in a settings key would silently print nothing.

ALTER TABLE properties
  -- Printed under the invoice total: payment terms, cancellation terms (§29.2).
  ADD COLUMN invoice_terms        text CHECK (invoice_terms IS NULL OR length(invoice_terms) <= 1000),
  -- Bank account / UPI details for a guest or company paying later (§29.2).
  ADD COLUMN invoice_bank_details text CHECK (invoice_bank_details IS NULL OR length(invoice_bank_details) <= 500),
  -- Printouts show the guest mobile partly masked unless the owner turns this off (§29.2, §36).
  ADD COLUMN print_mask_mobile    boolean NOT NULL DEFAULT true,
  -- The desk's receipt printer: A4 or an 80 mm thermal roll (§36).
  ADD COLUMN receipt_paper        text NOT NULL DEFAULT 'a4' CHECK (receipt_paper IN ('a4', 'thermal_80'));
