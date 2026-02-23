-- Consolidated RLS policies and indexes for the AU Supabase project
-- Derived from the live production DB state as of 2026-02-24.
-- Some policies differ from the incremental migration files (00001-00023)
-- because policies were also modified directly in production.

-- ============================================
-- ENABLE ROW LEVEL SECURITY
-- ============================================
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE caller_sms_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE caller_sms_log ENABLE ROW LEVEL SECURITY;

-- ============================================
-- USER PROFILES POLICIES
-- ============================================
CREATE POLICY "Users can view own profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON user_profiles
  FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can create their own profile" ON user_profiles
  FOR INSERT WITH CHECK (id = auth.uid());

-- ============================================
-- ORGANIZATIONS POLICIES
-- ============================================
CREATE POLICY "Users can view their organizations" ON organizations
  FOR SELECT USING (
    id IN (SELECT get_user_organizations(auth.uid()))
    OR parent_org_id IN (SELECT get_user_organizations(auth.uid()))
  );
CREATE POLICY "Users can create organizations" ON organizations
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Org admins can update organizations" ON organizations
  FOR UPDATE USING (is_org_admin(id, auth.uid()));
CREATE POLICY "Org owners can delete organizations" ON organizations
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM org_members
      WHERE organization_id = organizations.id
      AND user_id = auth.uid()
      AND role = 'owner'
    )
  );

-- ============================================
-- ORG MEMBERS POLICIES
-- ============================================
CREATE POLICY "Users can view org members" ON org_members
  FOR SELECT USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org admins can add members" ON org_members
  FOR INSERT WITH CHECK (is_org_admin(organization_id, auth.uid()));
CREATE POLICY "Org admins can update members" ON org_members
  FOR UPDATE USING (
    is_org_admin(organization_id, auth.uid())
    AND role != 'owner'
  );
CREATE POLICY "Org owners can delete members" ON org_members
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM org_members AS om
      WHERE om.organization_id = org_members.organization_id
      AND om.user_id = auth.uid()
      AND om.role = 'owner'
    )
    AND user_id != auth.uid()
  );

-- ============================================
-- ASSISTANTS POLICIES
-- ============================================
CREATE POLICY "Users can view org assistants" ON assistants
  FOR SELECT USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org members can create assistants" ON assistants
  FOR INSERT WITH CHECK (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org members can update assistants" ON assistants
  FOR UPDATE USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org admins can delete assistants" ON assistants
  FOR DELETE USING (is_org_admin(organization_id, auth.uid()));

-- ============================================
-- PHONE NUMBERS POLICIES
-- ============================================
CREATE POLICY "Users can view org phone numbers" ON phone_numbers
  FOR SELECT USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org admins can add phone numbers" ON phone_numbers
  FOR INSERT WITH CHECK (is_org_admin(organization_id, auth.uid()));
CREATE POLICY "Org members can update phone numbers" ON phone_numbers
  FOR UPDATE USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org admins can delete phone numbers" ON phone_numbers
  FOR DELETE USING (is_org_admin(organization_id, auth.uid()));

-- ============================================
-- CALLS POLICIES
-- ============================================
CREATE POLICY "Users can view org calls" ON calls
  FOR SELECT USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org members can create calls" ON calls
  FOR INSERT WITH CHECK (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org members can update calls" ON calls
  FOR UPDATE
  USING (is_org_member(organization_id, auth.uid()))
  WITH CHECK (is_org_member(organization_id, auth.uid()));

-- ============================================
-- SUBSCRIPTIONS POLICIES
-- ============================================
CREATE POLICY "Users can view org subscription" ON subscriptions
  FOR SELECT USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org members can create subscription" ON subscriptions
  FOR INSERT WITH CHECK (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org admins can update subscription" ON subscriptions
  FOR UPDATE
  USING (is_org_admin(organization_id, auth.uid()))
  WITH CHECK (is_org_admin(organization_id, auth.uid()));

-- ============================================
-- USAGE RECORDS POLICIES
-- ============================================
CREATE POLICY "Users can view org usage records" ON usage_records
  FOR SELECT USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org members can create usage records" ON usage_records
  FOR INSERT WITH CHECK (is_org_member(organization_id, auth.uid()));

-- ============================================
-- API KEYS POLICIES
-- ============================================
CREATE POLICY "Users can view org API keys" ON api_keys
  FOR SELECT USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org admins can create API keys" ON api_keys
  FOR INSERT WITH CHECK (is_org_admin(organization_id, auth.uid()));
CREATE POLICY "Org admins can update API keys" ON api_keys
  FOR UPDATE USING (is_org_admin(organization_id, auth.uid()));
CREATE POLICY "Org admins can delete API keys" ON api_keys
  FOR DELETE USING (is_org_admin(organization_id, auth.uid()));

-- ============================================
-- KNOWLEDGE BASES POLICIES
-- ============================================
CREATE POLICY "Users can manage their org knowledge bases" ON knowledge_bases
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- ============================================
-- CALENDAR INTEGRATIONS POLICIES
-- ============================================
CREATE POLICY "Users can manage their org calendar integrations" ON calendar_integrations
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- ============================================
-- TRANSFER RULES POLICIES
-- ============================================
CREATE POLICY "Users can manage their org transfer rules" ON transfer_rules
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- ============================================
-- NOTIFICATION PREFERENCES POLICIES
-- ============================================
CREATE POLICY "Org members can view notification preferences" ON notification_preferences
  FOR SELECT USING (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org members can create notification preferences" ON notification_preferences
  FOR INSERT WITH CHECK (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org members can update notification preferences" ON notification_preferences
  FOR UPDATE
  USING (is_org_member(organization_id, auth.uid()))
  WITH CHECK (is_org_member(organization_id, auth.uid()));
CREATE POLICY "Org members can delete notification preferences" ON notification_preferences
  FOR DELETE USING (is_org_member(organization_id, auth.uid()));

-- ============================================
-- ASSISTANT TEMPLATES POLICIES
-- ============================================
CREATE POLICY "Anyone can read assistant templates" ON assistant_templates
  FOR SELECT USING (true);

-- ============================================
-- APPOINTMENTS POLICIES
-- ============================================
CREATE POLICY "Users can manage their org appointments" ON appointments
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- ============================================
-- INTEGRATIONS POLICIES
-- ============================================
CREATE POLICY "Users can view their org integrations" ON integrations
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "Admins can create integrations in their org" ON integrations
  FOR INSERT WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );
CREATE POLICY "Admins can update their org integrations" ON integrations
  FOR UPDATE USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );
CREATE POLICY "Admins can delete their org integrations" ON integrations
  FOR DELETE USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );
CREATE POLICY "Service role full access to integrations" ON integrations
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- INTEGRATION LOGS POLICIES
-- ============================================
CREATE POLICY "Users can view logs for their org integrations" ON integration_logs
  FOR SELECT USING (
    integration_id IN (
      SELECT id FROM integrations WHERE organization_id IN (
        SELECT organization_id FROM org_members WHERE user_id = auth.uid()
      )
    )
  );
CREATE POLICY "Service role full access to integration_logs" ON integration_logs
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- CALLER SMS POLICIES
-- ============================================
CREATE POLICY "org_members_read_optouts" ON caller_sms_optouts
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "service_role_all_optouts" ON caller_sms_optouts
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "org_members_read_sms_log" ON caller_sms_log
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "service_role_all_sms_log" ON caller_sms_log
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- INDEXES
-- ============================================

-- Organizations
CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_parent ON organizations(parent_org_id);
CREATE INDEX idx_organizations_country ON organizations(country);

-- Org members
CREATE INDEX idx_org_members_org ON org_members(organization_id);
CREATE INDEX idx_org_members_user ON org_members(user_id);

-- Assistants
CREATE INDEX idx_assistants_org ON assistants(organization_id);
CREATE INDEX idx_assistants_vapi ON assistants(vapi_assistant_id);

-- Phone numbers
CREATE INDEX idx_phone_numbers_org ON phone_numbers(organization_id);
CREATE INDEX idx_phone_numbers_assistant ON phone_numbers(assistant_id);
CREATE INDEX idx_phone_numbers_phone_number ON phone_numbers(phone_number);
CREATE INDEX idx_phone_numbers_user_phone ON phone_numbers(user_phone_number) WHERE user_phone_number IS NOT NULL;

-- Calls
CREATE INDEX idx_calls_org ON calls(organization_id);
CREATE INDEX idx_calls_assistant ON calls(assistant_id);
CREATE INDEX idx_calls_vapi ON calls(vapi_call_id);
CREATE INDEX idx_calls_created ON calls(created_at DESC);
CREATE INDEX idx_calls_status ON calls(status);
CREATE INDEX idx_calls_is_spam ON calls(is_spam) WHERE is_spam = true;
CREATE INDEX idx_calls_spam_score ON calls(spam_score) WHERE spam_score IS NOT NULL;

-- Subscriptions
CREATE INDEX idx_subscriptions_org ON subscriptions(organization_id);
CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);

-- Usage records
CREATE INDEX idx_usage_records_org ON usage_records(organization_id);
CREATE INDEX idx_usage_records_period ON usage_records(period_start, period_end);

-- API keys
CREATE INDEX idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

-- Knowledge bases
CREATE INDEX idx_knowledge_bases_org ON knowledge_bases(organization_id);
CREATE INDEX idx_knowledge_bases_org_active ON knowledge_bases(organization_id) WHERE is_active = true;

-- Appointments
CREATE INDEX idx_appointments_org ON appointments(organization_id);
CREATE INDEX idx_appointments_time ON appointments(start_time);
CREATE INDEX idx_appointments_status ON appointments(status) WHERE status IN ('pending', 'confirmed');
CREATE INDEX idx_appointments_customer_phone ON appointments(attendee_phone);
CREATE INDEX no_overlapping_appointments ON appointments
  USING gist (organization_id, tstzrange(start_time, end_time))
  WHERE status IN ('confirmed', 'pending');

-- Integrations
CREATE INDEX idx_integrations_org_id ON integrations(organization_id);
CREATE INDEX idx_integrations_org_active ON integrations(organization_id, is_active);
CREATE INDEX idx_integration_logs_integration_id ON integration_logs(integration_id, attempted_at DESC);

-- Caller SMS
CREATE INDEX idx_caller_sms_optouts_org ON caller_sms_optouts(organization_id);
CREATE INDEX idx_caller_sms_log_ratelimit ON caller_sms_log(caller_phone, message_type, organization_id, created_at DESC);
