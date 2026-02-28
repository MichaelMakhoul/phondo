-- Add SMS notification preference for callback requests
-- Mirrors existing sms_on_missed_call, sms_on_voicemail, sms_on_failed_call pattern

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS sms_on_callback_scheduled BOOLEAN DEFAULT false;
