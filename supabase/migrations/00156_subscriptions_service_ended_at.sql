-- SCRUM-475 — subscriptions.service_ended_at (lapse anchor for cancellations).
--
-- Foundation for the subscription-lapse epic (SCRUM-474). The lapse-state
-- machine (src/lib/subscriptions/lapse-state.ts + voice-server/lib/lapse-state.js)
-- measures the active → in_grace → lapsed → release_pending timeline for a
-- CANCELED subscription from the moment paid access actually ENDED — NOT from
-- when the cancellation was requested. Stripe gives us the end instant on
-- customer.subscription.deleted as ended_at (the access-end for BOTH immediate
-- and cancel-at-period-end cancellations); canceled_at is the request time and
-- is correct ONLY for immediate cancels. The webhook therefore persists ended_at
-- (falling back to canceled_at) into this column so the gate/cron/banner can
-- compute grace + reclaim windows without re-querying Stripe.
--
-- NULLABLE, NO BACKFILL by design: this PR is a zero-behavior-change foundation
-- and there is no reliable historical service-end timestamp to backfill for
-- existing canceled rows. The lapse-state helper handles a null service_ended_at
-- by falling back to current_period_end (the period the org last paid through),
-- so legacy canceled rows still resolve to a sensible anchor.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so a from-migrations rebuild and the
-- live DB converge to the same shape.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS service_ended_at TIMESTAMPTZ;

COMMENT ON COLUMN public.subscriptions.service_ended_at IS
  'Lapse anchor = when paid access actually ENDED (Stripe ended_at, falling back to canceled_at then, in the helper, current_period_end). NOT the cancel-request time. Nullable, no backfill — legacy canceled rows fall back to current_period_end.';
