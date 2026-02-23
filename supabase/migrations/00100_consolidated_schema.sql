-- Consolidated schema for the AU Supabase project (ap-southeast-2 / Sydney)
-- Derived from the live production DB state as of 2026-02-24.
-- Supersedes the incremental migration files (00001-00023) which had drifted
-- from production. Those files are retained for git history but should NOT be
-- run alongside this migration. For a fresh project, run only 00100 + 00101.

-- ============================================
-- EXTENSIONS
-- ============================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ============================================
-- CUSTOM TYPES
-- ============================================
CREATE TYPE organization_type AS ENUM ('business', 'agency');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE call_status AS ENUM ('queued', 'ringing', 'in-progress', 'completed', 'failed', 'no-answer', 'busy');
CREATE TYPE plan_type AS ENUM ('free', 'starter', 'professional', 'business', 'agency_starter', 'agency_growth', 'agency_scale');
CREATE TYPE subscription_status AS ENUM ('active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'trialing', 'unpaid');
CREATE TYPE industry_type AS ENUM ('dental', 'legal', 'home_services', 'medical', 'real_estate', 'other');

-- ============================================
-- TABLES
-- ============================================

-- User profiles (extends Supabase auth.users)
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Organizations (multi-tenant root)
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type organization_type NOT NULL DEFAULT 'business',
  logo_url TEXT,
  primary_color TEXT DEFAULT '#3B82F6',
  parent_org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  stripe_customer_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  industry TEXT,
  business_name TEXT,
  business_phone TEXT,
  business_address TEXT,
  business_website TEXT,
  timezone TEXT DEFAULT 'Australia/Sydney',
  business_hours JSONB DEFAULT '{"friday": {"open": "09:00", "close": "17:00"}, "monday": {"open": "09:00", "close": "17:00"}, "sunday": null, "tuesday": {"open": "09:00", "close": "17:00"}, "saturday": null, "thursday": {"open": "09:00", "close": "17:00"}, "wednesday": {"open": "09:00", "close": "17:00"}}'::jsonb,
  country TEXT NOT NULL DEFAULT 'AU',
  default_appointment_duration INTEGER NOT NULL DEFAULT 30,
  CONSTRAINT check_appointment_duration CHECK (default_appointment_duration >= 5 AND default_appointment_duration <= 480)
);

-- Organization members
CREATE TABLE org_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role member_role NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, user_id)
);

-- AI assistants
CREATE TABLE assistants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  vapi_assistant_id TEXT UNIQUE,
  system_prompt TEXT NOT NULL,
  first_message TEXT NOT NULL DEFAULT 'Hello! How can I help you today?',
  voice_id TEXT NOT NULL DEFAULT 'rachel',
  voice_provider TEXT NOT NULL DEFAULT 'elevenlabs',
  model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  model_provider TEXT NOT NULL DEFAULT 'openai',
  knowledge_base JSONB,
  tools JSONB,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settings JSONB DEFAULT '{}',
  prompt_config JSONB
);

-- Phone numbers
CREATE TABLE phone_numbers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  phone_number TEXT NOT NULL UNIQUE,
  vapi_phone_number_id TEXT UNIQUE,
  twilio_sid TEXT UNIQUE,
  friendly_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type TEXT NOT NULL DEFAULT 'purchased' CHECK (source_type IN ('purchased', 'forwarded')),
  user_phone_number TEXT,
  forwarding_status TEXT DEFAULT NULL CHECK (forwarding_status IN ('pending_setup', 'active', 'paused') OR forwarding_status IS NULL),
  carrier TEXT DEFAULT NULL,
  voice_provider TEXT NOT NULL DEFAULT 'vapi' CHECK (voice_provider IN ('vapi', 'self_hosted')),
  CONSTRAINT chk_forwarded_has_user_phone CHECK (source_type != 'forwarded' OR user_phone_number IS NOT NULL)
);

-- Calls
CREATE TABLE calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  phone_number_id UUID REFERENCES phone_numbers(id) ON DELETE SET NULL,
  vapi_call_id TEXT NOT NULL UNIQUE,
  caller_phone TEXT,
  direction call_direction NOT NULL DEFAULT 'inbound',
  status call_status NOT NULL DEFAULT 'queued',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  transcript TEXT,
  recording_url TEXT,
  summary TEXT,
  sentiment TEXT,
  metadata JSONB,
  cost_cents INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome TEXT CHECK (outcome IN ('answered', 'voicemail', 'transferred', 'spam', 'abandoned', 'failed')),
  is_spam BOOLEAN DEFAULT false,
  caller_name TEXT,
  action_taken TEXT,
  follow_up_required BOOLEAN DEFAULT false,
  spam_score INTEGER,
  collected_data JSONB
);

-- Subscriptions
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_price_id TEXT NOT NULL,
  plan_type plan_type NOT NULL DEFAULT 'free',
  status subscription_status NOT NULL DEFAULT 'active',
  included_minutes INTEGER NOT NULL DEFAULT 50,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  calls_limit INTEGER,
  calls_used INTEGER DEFAULT 0,
  assistants_limit INTEGER,
  phone_numbers_limit INTEGER
);

-- Usage records
CREATE TABLE usage_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  minutes_used NUMERIC(10, 2) NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  reported_to_stripe BOOLEAN NOT NULL DEFAULT false,
  stripe_usage_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  record_type TEXT DEFAULT 'call' CHECK (record_type IN ('call', 'minute', 'sms', 'transfer'))
);

-- API keys
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read', 'write'],
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Knowledge bases
CREATE TABLE knowledge_bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id UUID REFERENCES assistants(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('website', 'faq', 'document', 'manual')),
  source_url TEXT,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  title TEXT
);

-- Calendar integrations
CREATE TABLE calendar_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id UUID REFERENCES assistants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('cal_com', 'calendly', 'google_calendar')),
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  calendar_id TEXT,
  booking_url TEXT,
  settings JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transfer rules
CREATE TABLE transfer_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_keywords TEXT[],
  trigger_intent TEXT,
  transfer_to_phone TEXT NOT NULL,
  transfer_to_name TEXT,
  announcement_message TEXT,
  priority INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notification preferences
CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email_on_missed_call BOOLEAN DEFAULT true,
  email_on_voicemail BOOLEAN DEFAULT true,
  email_on_appointment_booked BOOLEAN DEFAULT true,
  email_daily_summary BOOLEAN DEFAULT true,
  sms_on_missed_call BOOLEAN DEFAULT false,
  sms_on_voicemail BOOLEAN DEFAULT false,
  sms_phone_number TEXT,
  webhook_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  email_on_failed_call BOOLEAN NOT NULL DEFAULT true,
  sms_on_failed_call BOOLEAN NOT NULL DEFAULT false,
  sms_textback_on_missed_call BOOLEAN DEFAULT false,
  sms_appointment_confirmation BOOLEAN DEFAULT false
);

-- Assistant templates
CREATE TABLE assistant_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  industry TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  first_message TEXT NOT NULL,
  sample_faqs JSONB DEFAULT '[]',
  voice_id TEXT,
  recommended_settings JSONB DEFAULT '{}',
  is_featured BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Appointments
CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id TEXT,
  provider TEXT NOT NULL DEFAULT 'cal_com' CHECK (provider IN ('cal_com', 'calendly', 'google_calendar', 'manual', 'internal')),
  assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  attendee_name TEXT NOT NULL,
  attendee_phone TEXT,
  attendee_email TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'rescheduled', 'completed', 'no_show')),
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  end_time TIMESTAMPTZ
);

-- Integrations (webhooks)
CREATE TABLE integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'webhook',
  webhook_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{call.completed}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Integration logs
CREATE TABLE integration_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  success BOOLEAN NOT NULL DEFAULT false,
  attempted_at TIMESTAMPTZ DEFAULT now(),
  retry_count INTEGER DEFAULT 0
);

-- Caller SMS opt-outs
CREATE TABLE caller_sms_optouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'twilio_stop',
  UNIQUE(phone_number, organization_id)
);

-- Caller SMS log
CREATE TABLE caller_sms_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  caller_phone TEXT NOT NULL,
  from_number TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('missed_call_textback', 'appointment_confirmation')),
  message_body TEXT NOT NULL,
  twilio_message_sid TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'blocked_optout', 'blocked_spam', 'blocked_ratelimit')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Auto-create user profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Trigger on auth.users for profile creation
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Check organization membership
CREATE OR REPLACE FUNCTION is_org_member(org_id UUID, user_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM org_members
    WHERE organization_id = org_id AND user_id = user_uuid
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Check organization admin/owner role
CREATE OR REPLACE FUNCTION is_org_admin(org_id UUID, user_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM org_members
    WHERE organization_id = org_id
    AND user_id = user_uuid
    AND role IN ('owner', 'admin')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Get user's organizations
CREATE OR REPLACE FUNCTION get_user_organizations(user_uuid UUID)
RETURNS SETOF UUID AS $$
BEGIN
  RETURN QUERY
  SELECT organization_id FROM org_members WHERE user_id = user_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Atomic call usage increment
CREATE OR REPLACE FUNCTION increment_call_usage(org_id UUID)
RETURNS TABLE(calls_used INTEGER, calls_limit INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE subscriptions
  SET calls_used = COALESCE(subscriptions.calls_used, 0) + 1
  WHERE organization_id = org_id
  RETURNING subscriptions.calls_used, subscriptions.calls_limit;
END;
$$;

-- Only service_role may call this (voice server). No authenticated grant (IDOR risk).
REVOKE ALL ON FUNCTION increment_call_usage(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_call_usage(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_call_usage(UUID) TO service_role;

-- Create organization with owner (atomic)
CREATE OR REPLACE FUNCTION create_organization_with_owner(
  org_name text,
  org_slug text,
  org_type organization_type DEFAULT 'business'::organization_type
)
RETURNS TABLE(id uuid, name text, slug text, type organization_type)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  new_org_id UUID;
  user_id UUID;
BEGIN
  user_id := auth.uid();
  IF user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  INSERT INTO public.organizations (name, slug, type)
  VALUES (org_name, org_slug, org_type)
  RETURNING organizations.id INTO new_org_id;
  INSERT INTO public.org_members (organization_id, user_id, role)
  VALUES (new_org_id, user_id, 'owner');
  RETURN QUERY
  SELECT o.id, o.name, o.slug, o.type
  FROM public.organizations o
  WHERE o.id = new_org_id;
END;
$$;

-- ============================================
-- TRIGGERS (updated_at)
-- ============================================
CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_organizations_updated_at
  BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_org_members_updated_at
  BEFORE UPDATE ON org_members FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_assistants_updated_at
  BEFORE UPDATE ON assistants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_phone_numbers_updated_at
  BEFORE UPDATE ON phone_numbers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_knowledge_bases_updated_at
  BEFORE UPDATE ON knowledge_bases FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_calendar_integrations_updated_at
  BEFORE UPDATE ON calendar_integrations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_transfer_rules_updated_at
  BEFORE UPDATE ON transfer_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_notification_preferences_updated_at
  BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_appointments_updated_at
  BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_integrations_updated_at
  BEFORE UPDATE ON integrations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
