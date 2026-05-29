-- SCRUM-349 (audit L3) — Stripe webhook idempotency ledger.
--
-- The webhook (src/app/api/webhooks/stripe/route.ts) verifies the signature but
-- records no processed event.id. Stripe delivers at-least-once, and a captured
-- signed payload can be replayed within the signature's tolerance window, so the
-- same event could be applied twice — double-running non-idempotent billing
-- mutations like resetMonthlyUsage(). This table lets the handler claim each
-- event.id exactly once before mutating any state.
--
-- RLS posture (mirrors rate_limit_buckets / 00135): RLS-on with NO policies, so
-- PostgREST denies anon/authenticated entirely. Only the service-role webhook
-- handler touches it (service_role bypasses RLS and keeps its implicit grants).

BEGIN;

CREATE TABLE public.stripe_processed_events (
  -- Stripe event id (e.g. "evt_..."). PK gives us the atomic
  -- INSERT ... ON CONFLICT dedup with no read-then-write race.
  event_id TEXT PRIMARY KEY,

  -- The event.type, for debugging/auditing which events were seen.
  event_type TEXT,

  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports a cheap retention scan if a cleanup cron is added later (Stripe does
-- not redeliver beyond a few days, so old rows are safe to prune).
CREATE INDEX idx_stripe_processed_events_processed_at
  ON public.stripe_processed_events(processed_at);

-- Lock the table down: only SECURITY DEFINER / service_role may touch it.
ALTER TABLE public.stripe_processed_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_processed_events FROM PUBLIC, anon, authenticated;
-- service_role retains its implicit ALL grant for the webhook INSERT/DELETE.

COMMIT;
