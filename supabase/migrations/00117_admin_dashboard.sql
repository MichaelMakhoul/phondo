-- Platform admin flag
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

-- Set Michael as admin
UPDATE user_profiles SET is_platform_admin = true WHERE email = 'michaelmakhoul97@gmail.com';

-- Admin contacts (marketing leads, non-users)
CREATE TABLE admin_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  email TEXT NOT NULL UNIQUE,
  company TEXT,
  industry TEXT,
  tags TEXT[] DEFAULT '{}',
  source TEXT DEFAULT 'manual',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ
);
ALTER TABLE admin_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_contacts_service_role" ON admin_contacts FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Email campaigns
CREATE TABLE admin_email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  audience_filter JSONB,
  status TEXT NOT NULL DEFAULT 'draft',
  sent_count INTEGER DEFAULT 0,
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE admin_email_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "campaigns_service_role" ON admin_email_campaigns FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Per-recipient email send tracking
CREATE TABLE admin_email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES admin_email_campaigns(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_email_sends_campaign ON admin_email_sends(campaign_id);
ALTER TABLE admin_email_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "email_sends_service_role" ON admin_email_sends FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- System email log (all emails sent by the platform)
CREATE TABLE admin_email_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  provider_id TEXT,
  organization_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_email_log_created ON admin_email_log(created_at DESC);
CREATE INDEX idx_email_log_type ON admin_email_log(type);
ALTER TABLE admin_email_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "email_log_service_role" ON admin_email_log FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
