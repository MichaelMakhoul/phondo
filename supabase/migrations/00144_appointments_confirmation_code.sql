-- SCRUM-385 (schema drift) — reconcile appointments.confirmation_code.
--
-- The confirmation_code column, its UNIQUE constraint, and its partial lookup
-- index were added to the database long ago (live migration history still shows
-- "add_confirmation_code_to_appointments", 2026-03-29) but were DROPPED from the
-- repo migrations when the early schema was squashed into
-- 00100_consolidated_schema.sql — the consolidation omitted them, and no later
-- migration re-adds them. So a database rebuilt purely from these migration files
-- (fresh env, CI ephemeral DB, disaster recovery, new region) would LACK the
-- column, breaking every booking / cancel / reschedule / lookup (they all
-- SELECT/INSERT confirmation_code). SCRUM-384 also now relies on the unique code
-- to disambiguate two same-minute appointments, so the dependency is load-bearing.
--
-- Fully idempotent and verified against the live schema: a no-op on the live DB
-- (column, constraint, and index already present — confirmed contype='u' for the
-- constraint and the exact partial predicate for the index), and it recreates all
-- three on a from-migrations rebuild. Recreated as a UNIQUE CONSTRAINT (not a bare
-- unique index) to match live exactly.

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS confirmation_code text;

-- UNIQUE constraint. ADD CONSTRAINT has no IF NOT EXISTS, so guard on pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointments'::regclass
      AND conname = 'appointments_confirmation_code_key'
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_confirmation_code_key UNIQUE (confirmation_code);
  END IF;
END $$;

-- Partial lookup index (matches live: WHERE confirmation_code IS NOT NULL).
CREATE INDEX IF NOT EXISTS idx_appointments_confirmation_code
  ON public.appointments (confirmation_code)
  WHERE confirmation_code IS NOT NULL;
