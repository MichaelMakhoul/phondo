-- SCRUM-475 — subscriptions.canceled_at (lapse anchor for cancellations).
--
-- Foundation for the subscription-lapse epic (SCRUM-474). The lapse-state
-- machine (src/lib/subscriptions/lapse-state.ts + voice-server/lib/lapse-state.js)
-- measures the active → in_grace → lapsed → release_pending timeline for a
-- CANCELED subscription from the moment it was canceled. Stripe gives us that
-- instant on customer.subscription.deleted (event.canceled_at / ended_at); this
-- column persists it so the gate/cron/banner can compute grace + reclaim windows
-- without re-querying Stripe.
--
-- NULLABLE, NO BACKFILL by design: this PR is a zero-behavior-change foundation
-- and there is no reliable historical cancellation timestamp to backfill for
-- existing canceled rows. The lapse-state helper handles a null canceled_at by
-- falling back to current_period_end (the period the org last paid through), so
-- legacy canceled rows still resolve to a sensible anchor.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so a from-migrations rebuild and the
-- live DB converge to the same shape.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;

COMMENT ON COLUMN public.subscriptions.canceled_at IS
  'Lapse anchor for cancellations: when Stripe canceled the subscription (from customer.subscription.deleted canceled_at/ended_at). Nullable; no backfill — legacy canceled rows fall back to current_period_end. See SCRUM-475 / SCRUM-474.';
