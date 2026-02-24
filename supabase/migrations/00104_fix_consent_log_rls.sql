-- Fix RLS policy on caller_sms_consent_log
-- The service_role_all policy was overly permissive (USING (true)),
-- allowing any authenticated user to read/write all orgs' consent logs.
-- Restrict it to service_role only (used by admin client in webhooks).

DROP POLICY IF EXISTS "service_role_all_consent_log" ON caller_sms_consent_log;

CREATE POLICY "service_role_all_consent_log" ON caller_sms_consent_log
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
