-- SCRUM-247: separate rate-limit bucket for cancellation SMS.
--
-- Problem: cancellation SMS reuses the 'appointment_confirmation' message_type,
-- which means a caller who books then immediately cancels is rate-limited out
-- of the cancellation message (rate limit window is 1h per type per caller per org).
-- Fix: add 'appointment_cancellation' as its own message_type so it gets its
-- own bucket. The application code is updated in the same PR to use the new type.

ALTER TABLE caller_sms_log DROP CONSTRAINT IF EXISTS caller_sms_log_message_type_check;
ALTER TABLE caller_sms_log ADD CONSTRAINT caller_sms_log_message_type_check
  CHECK (message_type IN ('missed_call_textback', 'appointment_confirmation', 'appointment_cancellation'));
