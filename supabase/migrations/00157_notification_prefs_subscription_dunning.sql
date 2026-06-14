-- SCRUM-478 — per-org toggles for subscription-lapse (dunning) notifications.
--
-- The daily subscription-dunning cron (src/app/api/cron/subscription-dunning)
-- emails the org owner as their subscription moves through the lapse timeline
-- (grace started → grace ending → AI diverting → number release warning).
--
-- email_on_subscription_dunning DEFAULTS ON: a lapsing customer must hear that
-- their AI is about to stop answering — losing that alert silently is exactly
-- the SCRUM-419 / finding-#21 failure mode. NOT NULL DEFAULT true backfills
-- every existing row so current orgs are covered immediately.
--
-- sms_on_subscription_dunning DEFAULTS OFF: the SMS variant ships behind a
-- triple gate (DUNNING_SMS_ENABLED env + the smsNotifications plan flag + this
-- pref), all off by default, so no SMS goes out until the feature is opened up.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so a from-migrations rebuild and the
-- live DB converge to the same shape.

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS email_on_subscription_dunning BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sms_on_subscription_dunning BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.notification_preferences.email_on_subscription_dunning IS
  'SCRUM-478: owner email for subscription-lapse milestones (grace started/ending, AI diverting, number release warning). Defaults ON.';

COMMENT ON COLUMN public.notification_preferences.sms_on_subscription_dunning IS
  'SCRUM-478: owner SMS for subscription-lapse milestones. Defaults OFF — also gated by the DUNNING_SMS_ENABLED env flag and the smsNotifications plan entitlement.';
