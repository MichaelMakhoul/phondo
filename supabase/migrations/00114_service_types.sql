-- Service types table — appointment categories with custom durations
CREATE TABLE service_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_service_types_org ON service_types(organization_id);
CREATE INDEX idx_service_types_active ON service_types(organization_id) WHERE is_active = true;

-- RLS
ALTER TABLE service_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_types_select" ON service_types FOR SELECT
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "service_types_insert" ON service_types FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "service_types_update" ON service_types FOR UPDATE
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "service_types_delete" ON service_types FOR DELETE
  USING (is_org_admin(organization_id, auth.uid()));

-- Add service_type_id to appointments
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_type_id UUID REFERENCES service_types(id) ON DELETE SET NULL;

-- Service role full access for voice server operations
CREATE POLICY "service_types_service_role" ON service_types FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
