-- SCRUM-447: claim-vs-confirm reconciliation for cron sends.
--
-- Claim-FIRST semantics (ledger insert in 00153; the callback-reminders
-- conditional UPDATE on reminder_sent_at) mean a crash between claim and
-- send is indistinguishable from a delivered send — the claim marker exists
-- either way. A nullable confirmation timestamp, written only AFTER the send
-- call returns, makes that gap detectable.
--
-- cron_send_ledger.delivered_at — set by the daily-summary cron after a
-- successful OR partial send (partial = at least one channel reached an
-- inbox, so the claim is kept and the send is confirmed; a zero-delivery
-- failure releases the claim, deleting the row, so it never lingers
-- unconfirmed).
--
-- Reconciliation query — claimed but never confirmed, i.e. crashed between
-- claim and send, or the confirmation UPDATE itself failed (the latter is
-- Sentry-reported by the cron when it happens):
--
--   SELECT job_name, period_key, organization_id, sent_at
--     FROM public.cron_send_ledger
--    WHERE delivered_at IS NULL
--      AND sent_at < NOW() - INTERVAL '1 hour';
--
-- callback_requests.reminder_delivered_at — the same pattern for the
-- reminder cron, whose claim marker is reminder_sent_at. NOTE: reminders
-- abandoned as permanently undeliverable (org has no working channels —
-- SCRUM-419 semantics deliberately keep the claim) also stay unconfirmed;
-- cross-check the cron's "Abandoning reminder" logs / Sentry events before
-- treating a hit as a crash.
--
--   SELECT id, organization_id, reminder_sent_at
--     FROM public.callback_requests
--    WHERE reminder_sent_at IS NOT NULL
--      AND reminder_delivered_at IS NULL
--      AND reminder_sent_at < NOW() - INTERVAL '1 hour';

ALTER TABLE public.cron_send_ledger
  ADD COLUMN delivered_at TIMESTAMPTZ;

ALTER TABLE public.callback_requests
  ADD COLUMN reminder_delivered_at TIMESTAMPTZ;
