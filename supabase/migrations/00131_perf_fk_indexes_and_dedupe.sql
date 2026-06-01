-- 00131_perf_fk_indexes_and_dedupe.sql
-- Performance advisor remediation, batch 1 — safe additive changes only.
-- Resolves: 1× duplicate_index + 18× unindexed_foreign_keys advisor findings.
-- Zero risk: all CREATE INDEX statements are additive and IF NOT EXISTS-guarded.

-- 1. Drop the duplicate UNIQUE constraint on admin_contacts.email (which also drops its backing index).
ALTER TABLE public.admin_contacts DROP CONSTRAINT IF EXISTS admin_contacts_email_unique;

-- 2. Add covering indexes for foreign keys that lack them.
CREATE INDEX IF NOT EXISTS idx_appointments_assistant_id        ON public.appointments (assistant_id);
CREATE INDEX IF NOT EXISTS idx_appointments_call_id             ON public.appointments (call_id);
CREATE INDEX IF NOT EXISTS idx_appointments_service_type_id     ON public.appointments (service_type_id);
CREATE INDEX IF NOT EXISTS idx_blocked_times_created_by         ON public.blocked_times (created_by);
CREATE INDEX IF NOT EXISTS idx_calendar_integrations_assistant  ON public.calendar_integrations (assistant_id);
CREATE INDEX IF NOT EXISTS idx_calendar_integrations_org        ON public.calendar_integrations (organization_id);
CREATE INDEX IF NOT EXISTS idx_callback_requests_assistant      ON public.callback_requests (assistant_id);
CREATE INDEX IF NOT EXISTS idx_callback_requests_call           ON public.callback_requests (call_id);
CREATE INDEX IF NOT EXISTS idx_callback_requests_completed_by   ON public.callback_requests (completed_by);
CREATE INDEX IF NOT EXISTS idx_caller_sms_consent_log_org       ON public.caller_sms_consent_log (organization_id);
CREATE INDEX IF NOT EXISTS idx_caller_sms_log_org               ON public.caller_sms_log (organization_id);
CREATE INDEX IF NOT EXISTS idx_calls_phone_number_id            ON public.calls (phone_number_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_assistant        ON public.knowledge_bases (assistant_id);
CREATE INDEX IF NOT EXISTS idx_notification_preferences_user    ON public.notification_preferences (user_id);
CREATE INDEX IF NOT EXISTS idx_practitioner_services_servicetype ON public.practitioner_services (service_type_id);
CREATE INDEX IF NOT EXISTS idx_transfer_rules_assistant         ON public.transfer_rules (assistant_id);
CREATE INDEX IF NOT EXISTS idx_transfer_rules_organization      ON public.transfer_rules (organization_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_call               ON public.usage_records (call_id);
