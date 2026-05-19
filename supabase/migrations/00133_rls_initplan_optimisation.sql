-- SCRUM-270 — Wrap auth.uid() / auth.role() calls in (SELECT ...) across every
-- RLS policy in the public schema. The Supabase performance advisor flagged 76
-- instances of the `auth_rls_initplan` lint: every policy that calls auth.uid()
-- (directly or transitively via is_org_member / is_org_admin /
-- get_user_organizations) re-evaluates the function once per row instead of
-- once per query. Wrapping in a subquery makes Postgres treat the result as
-- constant for the duration of the statement → one evaluation, not N.
--
-- Reference:
--   https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--
-- This migration is a pure planner optimisation. Every policy is recreated with
-- byte-identical semantics — only the auth.uid() / auth.role() call sites are
-- wrapped. RLS coverage and grants are preserved.
--
-- Risk:
--   Low. Supabase wraps the migration in a transaction, so a single syntax
--   error rolls everything back (no partial state). Existing migrations in
--   this repo do not include BEGIN/COMMIT and rely on the runner — matched
--   here for consistency.
--   Spot-check verifications (SELECT/INSERT/UPDATE/DELETE on a representative
--   table from both authenticated and service_role contexts) are listed in the
--   Test plan of the PR.

-- ────────────────────────────────────────────────────────────────────────────
-- admin_contacts
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_contacts_service_role" ON public.admin_contacts;
CREATE POLICY "admin_contacts_service_role" ON public.admin_contacts
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- admin_email_campaigns
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "campaigns_service_role" ON public.admin_email_campaigns;
CREATE POLICY "campaigns_service_role" ON public.admin_email_campaigns
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- admin_email_log
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "email_log_service_role" ON public.admin_email_log;
CREATE POLICY "email_log_service_role" ON public.admin_email_log
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- admin_email_sends
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "email_sends_service_role" ON public.admin_email_sends;
CREATE POLICY "email_sends_service_role" ON public.admin_email_sends
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- api_keys (4 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view org API keys" ON public.api_keys;
CREATE POLICY "Users can view org API keys" ON public.api_keys
  FOR SELECT
  USING (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org admins can create API keys" ON public.api_keys;
CREATE POLICY "Org admins can create API keys" ON public.api_keys
  FOR INSERT
  WITH CHECK (is_org_admin(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org admins can update API keys" ON public.api_keys;
CREATE POLICY "Org admins can update API keys" ON public.api_keys
  FOR UPDATE
  USING (is_org_admin(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org admins can delete API keys" ON public.api_keys;
CREATE POLICY "Org admins can delete API keys" ON public.api_keys
  FOR DELETE
  USING (is_org_admin(organization_id, (SELECT auth.uid())));

-- ────────────────────────────────────────────────────────────────────────────
-- appointment_confirmations
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "org members read own confirmations" ON public.appointment_confirmations;
CREATE POLICY "org members read own confirmations" ON public.appointment_confirmations
  FOR SELECT
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- appointments
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage their org appointments" ON public.appointments;
CREATE POLICY "Users can manage their org appointments" ON public.appointments
  FOR ALL
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- assistants (4 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view org assistants" ON public.assistants;
CREATE POLICY "Users can view org assistants" ON public.assistants
  FOR SELECT
  USING (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org members can create assistants" ON public.assistants;
CREATE POLICY "Org members can create assistants" ON public.assistants
  FOR INSERT
  WITH CHECK (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org members can update assistants" ON public.assistants;
CREATE POLICY "Org members can update assistants" ON public.assistants
  FOR UPDATE
  USING (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org admins can delete assistants" ON public.assistants;
CREATE POLICY "Org admins can delete assistants" ON public.assistants
  FOR DELETE
  USING (is_org_admin(organization_id, (SELECT auth.uid())));

-- ────────────────────────────────────────────────────────────────────────────
-- blocked_times (2 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "org_members_select_blocked_times" ON public.blocked_times;
CREATE POLICY "org_members_select_blocked_times" ON public.blocked_times
  FOR SELECT
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "org_admins_manage_blocked_times" ON public.blocked_times;
CREATE POLICY "org_admins_manage_blocked_times" ON public.blocked_times
  FOR ALL
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
        AND org_members.role = ANY (ARRAY['owner'::member_role, 'admin'::member_role])
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- calendar_integrations
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage their org calendar integrations" ON public.calendar_integrations;
CREATE POLICY "Users can manage their org calendar integrations" ON public.calendar_integrations
  FOR ALL
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- callback_requests (3 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org members can view their callbacks" ON public.callback_requests;
CREATE POLICY "Org members can view their callbacks" ON public.callback_requests
  FOR SELECT
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Org members can update their callbacks" ON public.callback_requests;
CREATE POLICY "Org members can update their callbacks" ON public.callback_requests
  FOR UPDATE
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Service role can insert callbacks" ON public.callback_requests;
CREATE POLICY "Service role can insert callbacks" ON public.callback_requests
  FOR INSERT
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- caller_sms_consent_log (2 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "org_members_read_consent_log" ON public.caller_sms_consent_log;
CREATE POLICY "org_members_read_consent_log" ON public.caller_sms_consent_log
  FOR SELECT
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "service_role_all_consent_log" ON public.caller_sms_consent_log;
CREATE POLICY "service_role_all_consent_log" ON public.caller_sms_consent_log
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- caller_sms_log (2 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "org_members_read_sms_log" ON public.caller_sms_log;
CREATE POLICY "org_members_read_sms_log" ON public.caller_sms_log
  FOR SELECT
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "service_role_all_sms_log" ON public.caller_sms_log;
CREATE POLICY "service_role_all_sms_log" ON public.caller_sms_log
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- caller_sms_optouts (2 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "org_members_read_optouts" ON public.caller_sms_optouts;
CREATE POLICY "org_members_read_optouts" ON public.caller_sms_optouts
  FOR SELECT
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "service_role_all_optouts" ON public.caller_sms_optouts;
CREATE POLICY "service_role_all_optouts" ON public.caller_sms_optouts
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- calls (3 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view org calls" ON public.calls;
CREATE POLICY "Users can view org calls" ON public.calls
  FOR SELECT
  USING (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org members can create calls" ON public.calls;
CREATE POLICY "Org members can create calls" ON public.calls
  FOR INSERT
  WITH CHECK (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org members can update calls" ON public.calls;
CREATE POLICY "Org members can update calls" ON public.calls
  FOR UPDATE
  USING (is_org_member(organization_id, (SELECT auth.uid())))
  WITH CHECK (is_org_member(organization_id, (SELECT auth.uid())));

-- ────────────────────────────────────────────────────────────────────────────
-- integration_logs (2 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view logs for their org integrations" ON public.integration_logs;
CREATE POLICY "Users can view logs for their org integrations" ON public.integration_logs
  FOR SELECT
  USING (
    integration_id IN (
      SELECT integrations.id
      FROM integrations
      WHERE integrations.organization_id IN (
        SELECT org_members.organization_id
        FROM org_members
        WHERE org_members.user_id = (SELECT auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "Service role full access to integration_logs" ON public.integration_logs;
CREATE POLICY "Service role full access to integration_logs" ON public.integration_logs
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- integrations (5 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view their org integrations" ON public.integrations;
CREATE POLICY "Users can view their org integrations" ON public.integrations
  FOR SELECT
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Service role full access to integrations" ON public.integrations;
CREATE POLICY "Service role full access to integrations" ON public.integrations
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text);

DROP POLICY IF EXISTS "Admins can create integrations in their org" ON public.integrations;
CREATE POLICY "Admins can create integrations in their org" ON public.integrations
  FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
        AND org_members.role = ANY (ARRAY['owner'::member_role, 'admin'::member_role])
    )
  );

DROP POLICY IF EXISTS "Admins can update their org integrations" ON public.integrations;
CREATE POLICY "Admins can update their org integrations" ON public.integrations
  FOR UPDATE
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
        AND org_members.role = ANY (ARRAY['owner'::member_role, 'admin'::member_role])
    )
  );

DROP POLICY IF EXISTS "Admins can delete their org integrations" ON public.integrations;
CREATE POLICY "Admins can delete their org integrations" ON public.integrations
  FOR DELETE
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
        AND org_members.role = ANY (ARRAY['owner'::member_role, 'admin'::member_role])
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- knowledge_bases
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage their org knowledge bases" ON public.knowledge_bases;
CREATE POLICY "Users can manage their org knowledge bases" ON public.knowledge_bases
  FOR ALL
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- notification_preferences (4 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Org members can view notification preferences" ON public.notification_preferences;
CREATE POLICY "Org members can view notification preferences" ON public.notification_preferences
  FOR SELECT
  USING (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org members can create notification preferences" ON public.notification_preferences;
CREATE POLICY "Org members can create notification preferences" ON public.notification_preferences
  FOR INSERT
  WITH CHECK (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org members can update notification preferences" ON public.notification_preferences;
CREATE POLICY "Org members can update notification preferences" ON public.notification_preferences
  FOR UPDATE
  USING (is_org_member(organization_id, (SELECT auth.uid())))
  WITH CHECK (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org members can delete notification preferences" ON public.notification_preferences;
CREATE POLICY "Org members can delete notification preferences" ON public.notification_preferences
  FOR DELETE
  USING (is_org_member(organization_id, (SELECT auth.uid())));

-- ────────────────────────────────────────────────────────────────────────────
-- org_members (4 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view org members" ON public.org_members;
CREATE POLICY "Users can view org members" ON public.org_members
  FOR SELECT
  USING (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org admins can add members" ON public.org_members;
CREATE POLICY "Org admins can add members" ON public.org_members
  FOR INSERT
  WITH CHECK (is_org_admin(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org admins can update members" ON public.org_members;
CREATE POLICY "Org admins can update members" ON public.org_members
  FOR UPDATE
  USING (
    is_org_admin(organization_id, (SELECT auth.uid()))
    AND role <> 'owner'::member_role
  );

DROP POLICY IF EXISTS "Org owners can delete members" ON public.org_members;
CREATE POLICY "Org owners can delete members" ON public.org_members
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM org_members om
      WHERE om.organization_id = org_members.organization_id
        AND om.user_id = (SELECT auth.uid())
        AND om.role = 'owner'::member_role
    )
    AND user_id <> (SELECT auth.uid())
  );

-- ────────────────────────────────────────────────────────────────────────────
-- organizations (4 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view their organizations" ON public.organizations;
CREATE POLICY "Users can view their organizations" ON public.organizations
  FOR SELECT
  USING (
    id IN (SELECT get_user_organizations((SELECT auth.uid())))
    OR parent_org_id IN (SELECT get_user_organizations((SELECT auth.uid())))
  );

DROP POLICY IF EXISTS "Users can create organizations" ON public.organizations;
CREATE POLICY "Users can create organizations" ON public.organizations
  FOR INSERT
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Org admins can update organizations" ON public.organizations;
CREATE POLICY "Org admins can update organizations" ON public.organizations
  FOR UPDATE
  USING (is_org_admin(id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org owners can delete organizations" ON public.organizations;
CREATE POLICY "Org owners can delete organizations" ON public.organizations
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM org_members
      WHERE org_members.organization_id = organizations.id
        AND org_members.user_id = (SELECT auth.uid())
        AND org_members.role = 'owner'::member_role
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- phone_numbers (4 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view org phone numbers" ON public.phone_numbers;
CREATE POLICY "Users can view org phone numbers" ON public.phone_numbers
  FOR SELECT
  USING (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org admins can add phone numbers" ON public.phone_numbers;
CREATE POLICY "Org admins can add phone numbers" ON public.phone_numbers
  FOR INSERT
  WITH CHECK (is_org_admin(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org members can update phone numbers" ON public.phone_numbers;
CREATE POLICY "Org members can update phone numbers" ON public.phone_numbers
  FOR UPDATE
  USING (is_org_member(organization_id, (SELECT auth.uid())))
  WITH CHECK (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org admins can delete phone numbers" ON public.phone_numbers;
CREATE POLICY "Org admins can delete phone numbers" ON public.phone_numbers
  FOR DELETE
  USING (is_org_admin(organization_id, (SELECT auth.uid())));

-- ────────────────────────────────────────────────────────────────────────────
-- practitioner_services (5 policies)
-- NOTE: ps_update currently uses auth.role() (not auth.uid()) in both qual and
-- with_check — that's an open bug separate from this optimisation. We preserve
-- the existing semantics here (wrap auth.role()) and ticket the bug-fix
-- separately so this migration stays a pure planner rewrite.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "ps_select" ON public.practitioner_services;
CREATE POLICY "ps_select" ON public.practitioner_services
  FOR SELECT
  USING (
    practitioner_id IN (
      SELECT practitioners.id
      FROM practitioners
      WHERE practitioners.organization_id IN (
        SELECT get_user_organizations((SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS "ps_insert" ON public.practitioner_services;
CREATE POLICY "ps_insert" ON public.practitioner_services
  FOR INSERT
  WITH CHECK (
    practitioner_id IN (
      SELECT practitioners.id
      FROM practitioners
      WHERE practitioners.organization_id IN (
        SELECT get_user_organizations((SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS "ps_update" ON public.practitioner_services;
CREATE POLICY "ps_update" ON public.practitioner_services
  FOR UPDATE
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

DROP POLICY IF EXISTS "ps_delete" ON public.practitioner_services;
CREATE POLICY "ps_delete" ON public.practitioner_services
  FOR DELETE
  USING (
    practitioner_id IN (
      SELECT practitioners.id
      FROM practitioners
      WHERE practitioners.organization_id IN (
        SELECT get_user_organizations((SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS "ps_service_role" ON public.practitioner_services;
CREATE POLICY "ps_service_role" ON public.practitioner_services
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- practitioners (5 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "practitioners_select" ON public.practitioners;
CREATE POLICY "practitioners_select" ON public.practitioners
  FOR SELECT
  USING (organization_id IN (SELECT get_user_organizations((SELECT auth.uid()))));

DROP POLICY IF EXISTS "practitioners_insert" ON public.practitioners;
CREATE POLICY "practitioners_insert" ON public.practitioners
  FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_organizations((SELECT auth.uid()))));

DROP POLICY IF EXISTS "practitioners_update" ON public.practitioners;
CREATE POLICY "practitioners_update" ON public.practitioners
  FOR UPDATE
  USING (organization_id IN (SELECT get_user_organizations((SELECT auth.uid()))));

DROP POLICY IF EXISTS "practitioners_delete" ON public.practitioners;
CREATE POLICY "practitioners_delete" ON public.practitioners
  FOR DELETE
  USING (is_org_admin(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "practitioners_service_role" ON public.practitioners;
CREATE POLICY "practitioners_service_role" ON public.practitioners
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- service_types (5 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "service_types_select" ON public.service_types;
CREATE POLICY "service_types_select" ON public.service_types
  FOR SELECT
  USING (organization_id IN (SELECT get_user_organizations((SELECT auth.uid()))));

DROP POLICY IF EXISTS "service_types_insert" ON public.service_types;
CREATE POLICY "service_types_insert" ON public.service_types
  FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_organizations((SELECT auth.uid()))));

DROP POLICY IF EXISTS "service_types_update" ON public.service_types;
CREATE POLICY "service_types_update" ON public.service_types
  FOR UPDATE
  USING (organization_id IN (SELECT get_user_organizations((SELECT auth.uid()))));

DROP POLICY IF EXISTS "service_types_delete" ON public.service_types;
CREATE POLICY "service_types_delete" ON public.service_types
  FOR DELETE
  USING (is_org_admin(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "service_types_service_role" ON public.service_types;
CREATE POLICY "service_types_service_role" ON public.service_types
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- subscriptions
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view org subscription" ON public.subscriptions;
CREATE POLICY "Users can view org subscription" ON public.subscriptions
  FOR SELECT
  USING (is_org_member(organization_id, (SELECT auth.uid())));

-- ────────────────────────────────────────────────────────────────────────────
-- system_health
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "system_health_service_role" ON public.system_health;
CREATE POLICY "system_health_service_role" ON public.system_health
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role'::text)
  WITH CHECK ((SELECT auth.role()) = 'service_role'::text);

-- ────────────────────────────────────────────────────────────────────────────
-- transfer_rules
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage their org transfer rules" ON public.transfer_rules;
CREATE POLICY "Users can manage their org transfer rules" ON public.transfer_rules
  FOR ALL
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- usage_records (2 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view org usage records" ON public.usage_records;
CREATE POLICY "Users can view org usage records" ON public.usage_records
  FOR SELECT
  USING (is_org_member(organization_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS "Org members can create usage records" ON public.usage_records;
CREATE POLICY "Org members can create usage records" ON public.usage_records
  FOR INSERT
  WITH CHECK (is_org_member(organization_id, (SELECT auth.uid())));

-- ────────────────────────────────────────────────────────────────────────────
-- user_profiles (3 policies)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view own profile" ON public.user_profiles;
CREATE POLICY "Users can view own profile" ON public.user_profiles
  FOR SELECT
  USING ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.user_profiles;
CREATE POLICY "Users can update own profile" ON public.user_profiles
  FOR UPDATE
  USING ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "Users can create their own profile" ON public.user_profiles;
CREATE POLICY "Users can create their own profile" ON public.user_profiles
  FOR INSERT
  WITH CHECK (id = (SELECT auth.uid()));

-- Post-migration verification (run manually via the Supabase MCP after apply):
--
-- Postgres' POSIX `~` operator does not support negative lookbehind, so the
-- check uses a positive-match plus negative-match pair instead:
--
--   SELECT COUNT(*) AS remaining
--   FROM pg_policies pp
--   JOIN pg_policy pol ON pol.polname = pp.policyname
--   JOIN pg_class c ON c.oid = pol.polrelid AND c.relname = pp.tablename
--   WHERE pp.schemaname = 'public'
--     AND (
--       (pg_get_expr(polqual, polrelid) ~ 'auth\.(uid|role)\(\)'
--          AND pg_get_expr(polqual, polrelid) !~ 'SELECT auth\.(uid|role)\(\)')
--       OR
--       (pg_get_expr(polwithcheck, polrelid) ~ 'auth\.(uid|role)\(\)'
--          AND pg_get_expr(polwithcheck, polrelid) !~ 'SELECT auth\.(uid|role)\(\)')
--     );
--
-- Expected: 0
--
-- Then re-run `mcp__supabase-phondo__get_advisors performance` and confirm the
-- `auth_rls_initplan` lint count drops to 0.
