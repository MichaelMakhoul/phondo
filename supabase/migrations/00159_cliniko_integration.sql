-- SCRUM-12: Cliniko CRM integration
-- 1) Allow 'cliniko' as a calendar integration + appointment provider
ALTER TABLE calendar_integrations DROP CONSTRAINT IF EXISTS calendar_integrations_provider_check;
ALTER TABLE calendar_integrations ADD CONSTRAINT calendar_integrations_provider_check
  CHECK (provider IN ('cal_com', 'calendly', 'google_calendar', 'cliniko'));

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_provider_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_provider_check
  CHECK (provider IN ('cal_com', 'calendly', 'google_calendar', 'manual', 'internal', 'cliniko'));

-- 2) External refs on the local catalog (imported from the CRM)
ALTER TABLE practitioners ADD COLUMN IF NOT EXISTS external_provider TEXT;
ALTER TABLE practitioners ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_practitioners_external_ref
  ON practitioners(organization_id, external_provider, external_id)
  WHERE external_provider IS NOT NULL;

ALTER TABLE service_types ADD COLUMN IF NOT EXISTS external_provider TEXT;
ALTER TABLE service_types ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_types_external_ref
  ON service_types(organization_id, external_provider, external_id)
  WHERE external_provider IS NOT NULL;

-- 3) Phone -> CRM patient link cache (backend-only; service role)
CREATE TABLE IF NOT EXISTS crm_patient_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('cliniko')),
  -- Normalized matching key (last 9 digits of the caller number), NOT a full E.164 string
  phone_key TEXT NOT NULL,
  external_patient_id TEXT NOT NULL,
  patient_name TEXT,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (organization_id, provider, phone_key)
);
CREATE INDEX IF NOT EXISTS idx_crm_patient_links_org ON crm_patient_links(organization_id);
ALTER TABLE crm_patient_links ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only (same posture as subscriptions).

COMMENT ON TABLE crm_patient_links IS 'Cache mapping caller phone numbers to CRM patient ids (Cliniko has no phone filter on patients).';
