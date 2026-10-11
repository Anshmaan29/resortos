-- Explicit WhatsApp opt-in. A phone number or stay consent alone is not messaging consent.
ALTER TABLE guests
  ADD COLUMN whatsapp_opted_in boolean NOT NULL DEFAULT false,
  ADD COLUMN whatsapp_consent_at timestamptz,
  ADD COLUMN whatsapp_consent_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT guests_whatsapp_consent_recorded CHECK
    (NOT whatsapp_opted_in OR (whatsapp_consent_at IS NOT NULL AND whatsapp_consent_by IS NOT NULL));
