-- SCRUM-429 (audit finding #53): the daily-summary cron had no idempotency
-- marker — an overlapping or re-triggered run double-emailed every org.
--
-- One row per (job, period, org) claims a send atomically: the cron INSERTs
-- before sending and treats a 23505 duplicate as "another run already owns
-- this send". Crash-after-claim loses one email rather than doubling it —
-- the same "skip > double" trade the usage-counting ledger (00143) made.
--
-- Service-role only (like stripe_processed_events): RLS enabled with no
-- policies, so PostgREST clients can't read or forge markers.

CREATE TABLE public.cron_send_ledger (
  job_name TEXT NOT NULL,
  period_key TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_name, period_key, organization_id)
);

ALTER TABLE public.cron_send_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cron_send_ledger FROM anon, authenticated;
