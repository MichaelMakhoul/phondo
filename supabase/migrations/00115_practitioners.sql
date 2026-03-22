-- Practitioners table — staff members who provide services
CREATE TABLE practitioners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  availability_override JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_practitioners_org ON practitioners(organization_id);

-- Practitioner-service join table
CREATE TABLE practitioner_services (
  practitioner_id UUID NOT NULL REFERENCES practitioners(id) ON DELETE CASCADE,
  service_type_id UUID NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,
  PRIMARY KEY (practitioner_id, service_type_id)
);

-- RLS for practitioners
ALTER TABLE practitioners ENABLE ROW LEVEL SECURITY;

CREATE POLICY "practitioners_select" ON practitioners FOR SELECT
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "practitioners_insert" ON practitioners FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "practitioners_update" ON practitioners FOR UPDATE
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "practitioners_delete" ON practitioners FOR DELETE
  USING (is_org_admin(organization_id, auth.uid()));

CREATE POLICY "practitioners_service_role" ON practitioners FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- RLS for practitioner_services — scoped through practitioners table
ALTER TABLE practitioner_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ps_select" ON practitioner_services FOR SELECT
  USING (practitioner_id IN (
    SELECT id FROM practitioners
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "ps_insert" ON practitioner_services FOR INSERT
  WITH CHECK (practitioner_id IN (
    SELECT id FROM practitioners
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "ps_delete" ON practitioner_services FOR DELETE
  USING (practitioner_id IN (
    SELECT id FROM practitioners
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "ps_service_role" ON practitioner_services FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Add practitioner_id to appointments
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS practitioner_id UUID REFERENCES practitioners(id) ON DELETE SET NULL;
