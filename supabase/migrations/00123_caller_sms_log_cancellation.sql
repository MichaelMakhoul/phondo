-- SCRUM-247: separate rate-limit bucket for cancellation SMS.
--
-- Problem: cancellation SMS reuses the 'appointment_confirmation' message_type,
-- which means a caller who books then immediately cancels is rate-limited out
-- of the cancellation message (rate limit window is 1h per type per caller per org).
-- Fix: add 'appointment_cancellation' as its own message_type so it gets its
-- own bucket. The application code is updated in the same PR to use the new type.
--
-- Defensive pre-check: bail out if any existing row violates the new constraint
-- (would happen only if a future migration partially ran or a hand-inserted row
-- snuck in). Without this check, ADD CONSTRAINT would abort the transaction and
-- leave the table constraint-less.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM caller_sms_log
    WHERE message_type NOT IN (
      'missed_call_textback',
      'appointment_confirmation',
      'appointment_cancellation'
    )
  ) THEN
    RAISE EXCEPTION 'caller_sms_log has rows incompatible with new message_type CHECK; aborting migration';
  END IF;
END $$;

ALTER TABLE caller_sms_log DROP CONSTRAINT IF EXISTS caller_sms_log_message_type_check;
ALTER TABLE caller_sms_log ADD CONSTRAINT caller_sms_log_message_type_check
  CHECK (message_type IN (
    'missed_call_textback',
    'appointment_confirmation',
    'appointment_cancellation'
  )) NOT VALID;
ALTER TABLE caller_sms_log VALIDATE CONSTRAINT caller_sms_log_message_type_check;
