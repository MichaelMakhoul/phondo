-- Callback requests table
-- Stores callback requests made by callers via the AI receptionist

CREATE TABLE callback_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  caller_name TEXT NOT NULL,
  caller_phone TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_time TIMESTAMPTZ,
  urgency TEXT NOT NULL DEFAULT 'medium' CHECK (urgency IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled', 'expired')),
  notes TEXT,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for dashboard queries (pending callbacks for an org, sorted by recency)
CREATE INDEX idx_callback_requests_org_status ON callback_requests (organization_id, status, created_at DESC);

-- RLS
ALTER TABLE callback_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view their callbacks"
  ON callback_requests FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM org_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "Org members can update their callbacks"
  ON callback_requests FOR UPDATE
  USING (organization_id IN (
    SELECT organization_id FROM org_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM org_members WHERE user_id = auth.uid()
  ));

-- Service role inserts (from internal API via createAdminClient)
CREATE POLICY "Service role can insert callbacks"
  ON callback_requests FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- Add notification preference for callback requests
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS email_on_callback_scheduled BOOLEAN DEFAULT true;
