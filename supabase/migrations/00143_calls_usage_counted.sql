-- SCRUM-361 (audit billing finding) — per-call usage idempotency flag.
--
-- Both the Vapi backup webhook (end-of-call-report) and the self-hosted
-- /api/internal/call-completed route increment subscription.calls_used with no
-- per-call guard. Vapi delivers at-least-once and the voice server retries the
-- internal notify on 5xx, so a redelivery/retry of the same call double-counts
-- usage → over-billing.
--
-- This adds a boolean on the calls row (the natural per-call idempotency key,
-- unique per vapi_call_id / call id). Both increment paths atomically flip it
-- false→true and only count usage when they win the flip — a redelivery finds it
-- already true and skips.
--
-- Backfill: mark every EXISTING call as already-counted, so a stray redelivery of
-- a historical call can't retroactively re-count it. Only calls created AFTER this
-- migration go through the claim path. (Spam calls are skipped by the
-- shouldTrackUsage gate regardless, so marking them true is harmless.)

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS usage_counted BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.calls SET usage_counted = TRUE WHERE usage_counted = FALSE;
