-- SCRUM-277 — Shared (cross-instance) rate-limit store.
--
-- The Node-side limiter in `src/lib/security/rate-limiter.ts` is a per-process
-- Map. On Vercel serverless each lambda instance has its own Map, so a
-- motivated abuser hitting from parallel cold-start instances can trivially
-- bypass per-org caps on paid-action endpoints (the immediate trigger is
-- `phone-numbers/[id]/test-fallback`, which dials Twilio on every accepted
-- request).
--
-- This migration creates a single shared atomic counter in Postgres that the
-- Node side can call via RPC. It's intentionally narrow:
--   - one tiny table (`rate_limit_buckets`) with no PII
--   - one SECURITY DEFINER function (`check_rate_limit_bucket`) that does the
--     UPSERT + return in a single round-trip (no read-then-write race)
--   - one cleanup function (`cleanup_rate_limit_buckets`) the existing daily
--     cron can invoke to prune expired rows
--
-- Why Supabase + Postgres instead of Upstash Redis: we already operate a
-- single-region Supabase project on AU, the latency budget (a few extra ms on
-- a paid-action call that already takes ~2-5s for Twilio dial) is generous,
-- and avoiding a brand-new dependency for a P2 control plane is the right
-- trade-off until traffic warrants Redis. The Node helper can be swapped
-- behind the same interface if/when we move to Redis.
--
-- RLS posture: the table is RLS-on with NO policies, so PostgREST denies
-- direct SELECT/INSERT/UPDATE entirely. All access goes through the
-- SECURITY DEFINER function, which is the only thing that can read or mutate
-- rows. Anon role has zero capability against this table.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Storage
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE public.rate_limit_buckets (
  -- `{identifier}:{endpoint}` — opaque to the DB; the application owns the
  -- shape. Identifier may be an org UUID (per-org limits), an IP address
  -- (per-IP limits), or a session token (per-user limits). The endpoint
  -- string is a short label like "phone-numbers/test-fallback".
  key TEXT PRIMARY KEY,

  -- Number of requests served in the current window.
  count INTEGER NOT NULL DEFAULT 0,

  -- When the current window ENDS (NOT created_at). The bucket is "expired"
  -- when NOW() > reset_time, at which point the next request resets count
  -- to 1 and rolls reset_time forward.
  reset_time TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cleanup needs a fast scan of expired rows.
CREATE INDEX idx_rate_limit_buckets_reset_time
  ON public.rate_limit_buckets(reset_time);

-- Lock the table down before granting RPC access. RLS-on with no policies
-- means PostgREST denies SELECT/INSERT/UPDATE/DELETE for anon/authenticated;
-- only SECURITY DEFINER functions (executed as the function owner) bypass.
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC, anon, authenticated;
-- service_role retains its implicit ALL grant for backfill/debugging.

-- ─────────────────────────────────────────────────────────────────────────
-- Atomic increment-or-reset RPC
-- ─────────────────────────────────────────────────────────────────────────

-- Returns the post-increment state of the bucket. The caller compares
-- count <= max_requests to decide allow/deny — the function itself doesn't
-- short-circuit so we can tell "just hit the cap" apart from "way over the
-- cap" if we ever want to surface that in metrics.
CREATE OR REPLACE FUNCTION public.check_rate_limit_bucket(
  p_key TEXT,
  p_window_ms INTEGER,
  p_max_requests INTEGER
)
RETURNS TABLE(
  count INTEGER,
  reset_time TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_window INTERVAL := (p_window_ms || ' milliseconds')::INTERVAL;
BEGIN
  -- Defensive validation. The Node side already constrains these, but a
  -- bad call with windowMs=0 would create permanent buckets (reset_time
  -- == NOW()) so the next request would always reset and forever allow.
  IF p_window_ms <= 0 THEN
    RAISE EXCEPTION 'p_window_ms must be > 0 (got %)', p_window_ms;
  END IF;
  IF p_max_requests <= 0 THEN
    RAISE EXCEPTION 'p_max_requests must be > 0 (got %)', p_max_requests;
  END IF;

  -- Single-statement UPSERT: insert a fresh bucket with count=1, OR on
  -- conflict either reset (if expired) or increment (if active).
  --
  -- Atomicity guarantee: Postgres takes a row-level lock on the conflict-
  -- target row inside DO UPDATE, AND the CASE expressions re-read the
  -- post-update row visibility — so two concurrent calls against an
  -- expired bucket cannot BOTH reset to count=1 (the loser observes the
  -- winner's already-rolled-forward reset_time and goes to the ELSE
  -- branch, incrementing to 2). The cap is preserved even under heavy
  -- contention. Do NOT refactor this to a CTE-based (`WITH … INSERT …
  -- RETURNING`) shape or a BEFORE-INSERT trigger without re-validating
  -- the concurrent-reset case: those refactors break the row-lock /
  -- post-update-visibility chain and would silently introduce the
  -- cap-doubling race this comment is warning about.
  RETURN QUERY
  INSERT INTO public.rate_limit_buckets (key, count, reset_time)
  VALUES (p_key, 1, v_now + v_window)
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
          WHEN public.rate_limit_buckets.reset_time < v_now THEN 1
          ELSE public.rate_limit_buckets.count + 1
        END,
        reset_time = CASE
          WHEN public.rate_limit_buckets.reset_time < v_now THEN v_now + v_window
          ELSE public.rate_limit_buckets.reset_time
        END
  RETURNING
    public.rate_limit_buckets.count,
    public.rate_limit_buckets.reset_time;
END;
$$;

-- Default function permissions (PUBLIC EXECUTE) would let anon hammer the
-- RPC with arbitrary keys to enumerate active buckets or denial-of-service
-- the table. Lock it down to authenticated + service_role; routes call this
-- through a server-side Supabase client, never client-side.
REVOKE ALL ON FUNCTION public.check_rate_limit_bucket(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_bucket(TEXT, INTEGER, INTEGER)
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Cleanup
-- ─────────────────────────────────────────────────────────────────────────

-- The UPSERT above leaves expired rows in place — they're harmless (every
-- subsequent hit resets them) but they accumulate. A 24h-old prune is fine:
-- the longest live window today is `webhook` at 60s, so anything an hour
-- past reset_time is definitively garbage.
CREATE OR REPLACE FUNCTION public.cleanup_rate_limit_buckets()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.rate_limit_buckets
    WHERE reset_time < NOW() - INTERVAL '1 hour';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_rate_limit_buckets()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limit_buckets()
  TO service_role;

COMMIT;
