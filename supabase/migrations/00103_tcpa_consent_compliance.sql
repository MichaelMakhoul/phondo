-- TCPA/Consent Compliance
-- Adds recording consent settings, SMS consent audit log, and business state tracking.

-- 1. Add business_state and recording_consent_mode to organizations
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS business_state TEXT,
  ADD COLUMN IF NOT EXISTS recording_consent_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (recording_consent_mode IN ('auto', 'always', 'never'));

-- 2. Consent audit log — tracks all SMS opt-in/opt-out actions for TCPA compliance
CREATE TABLE IF NOT EXISTS caller_sms_consent_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('opt_out', 'opt_in')),
  source TEXT NOT NULL,
  keyword TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE caller_sms_consent_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_consent_log" ON caller_sms_consent_log
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "org_members_read_consent_log" ON caller_sms_consent_log
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_consent_log_phone_org
  ON caller_sms_consent_log(phone_number, organization_id, created_at DESC);

-- 3. Add blocked_plan status to caller_sms_log (from tier gating work)
-- The CHECK constraint needs updating to include the new status value
ALTER TABLE caller_sms_log DROP CONSTRAINT IF EXISTS caller_sms_log_status_check;
ALTER TABLE caller_sms_log ADD CONSTRAINT caller_sms_log_status_check
  CHECK (status IN ('sent', 'failed', 'blocked_optout', 'blocked_spam', 'blocked_ratelimit', 'blocked_plan', 'skipped'));
