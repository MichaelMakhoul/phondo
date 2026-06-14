-- SCRUM-479 (subscription-lapse epic SCRUM-474): audit columns for the
-- DESTRUCTIVE number-release sweep cron (/api/cron/number-release-sweep).
--
-- Releasing a real phone number at the carrier is IRREVERSIBLE. The sweep
-- therefore SOFT-releases: after a successful Twilio release it sets
-- is_active=false + released_at, but NEVER deletes the row, because
-- calls.phone_number_id FKs reference it (ON DELETE SET NULL) and the row is
-- kept for call-history audit AND to stop the number ever being re-released
-- (the is_active=false guard drops it out of the next run's candidate set).
--
-- The cron ships dormant: it only releases when ENABLE_NUMBER_RELEASE_SWEEP is
-- exactly "true"; otherwise it is a no-op dry-run. These columns land ahead of
-- that flag ever being flipped.
--
-- DO NOT APPLY as part of this PR — apply it in production deliberately, before
-- the sweep is enabled.

ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS release_warned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

COMMENT ON COLUMN public.phone_numbers.released_at IS
  'Soft-release marker: set by the number-release-sweep cron AFTER the Twilio carrier release succeeds. The row is intentionally KEPT (not deleted) so calls.phone_number_id FKs stay valid for audit and so the number is never re-released. NULL = still held.';

COMMENT ON COLUMN public.phone_numbers.release_warned_at IS
  'Audit timestamp for when the customer was warned this number is due for release (the subscription-dunning release_warning notice). Lands with released_at so the release audit trail is one unit; the sweep itself gates on the cron_send_ledger delivered_at, not this column.';
