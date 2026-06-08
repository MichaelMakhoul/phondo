-- SCRUM-388 — appointment supersede chain for the reschedule lifecycle.
--
-- A reschedule books a NEW row then frees the OLD one. Today the old row is just
-- marked `cancelled` with no link to its successor, so a "move" is indistinguishable
-- from a real cancellation and there's no history. This adds:
--   * `rescheduled_from_id` — the NEW row points at the OLD row it superseded (a
--     queryable chain: 9am → 12pm → next-day 11am). The forward direction is the
--     reverse lookup (`WHERE rescheduled_from_id = $id`), so no second column.
--   * a partial index for that reverse walk.
--   * a one-time backfill that links existing chains and flips the superseded OLD
--     rows from `cancelled` to the distinct `rescheduled` status.
--
-- NOTE: the status CHECK already permits 'rescheduled' (see
-- 00100_consolidated_schema.sql and live `appointments_status_check`) — intentionally
-- NOT re-asserted here. Both overlap constraints + every availability query use an
-- allowlist `status IN ('confirmed','pending')`, so a `rescheduled` row keeps freeing
-- its slot exactly like a `cancelled` one. Fully idempotent.

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS rescheduled_from_id uuid;

-- Self-referential FK. ADD CONSTRAINT has no IF NOT EXISTS → guard on pg_constraint.
-- ON DELETE SET NULL: if an old row is ever hard-deleted, drop the link, don't block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointments'::regclass
      AND conname  = 'appointments_rescheduled_from_id_fkey'
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_rescheduled_from_id_fkey
      FOREIGN KEY (rescheduled_from_id)
      REFERENCES public.appointments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Reverse-lookup index (walk old → new when rendering history).
CREATE INDEX IF NOT EXISTS idx_appointments_rescheduled_from_id
  ON public.appointments (rescheduled_from_id)
  WHERE rescheduled_from_id IS NOT NULL;

-- ── Backfill existing chains (best-effort, idempotent) ────────────────────────
-- The reschedule handler books the NEW row then frees the OLD row back-to-back in
-- one synchronous op, so for a superseded OLD (status='cancelled') the true
-- successor is the row in the same org + same phone, a DIFFERENT start_time, created
-- AFTER the old, whose created_at is closest to OLD.updated_at (the trigger-maintained
-- free time). The 120s window + closest-match guards against false links; a dry-run
-- on current data found every linkable old row had exactly ONE candidate (0 ambiguous).
-- The reason text ("Rescheduled by caller") is not persisted to our DB, hence the
-- timing+phone heuristic; going forward the handler sets the link explicitly, so this
-- only ever runs on history.
WITH ranked AS (
  SELECT old.id AS old_id, nw.id AS new_id,
         row_number() OVER (
           PARTITION BY old.id
           ORDER BY abs(extract(epoch FROM (nw.created_at - old.updated_at)))
         ) AS rn
  FROM public.appointments old
  JOIN public.appointments nw
    ON  nw.organization_id = old.organization_id
    AND nw.attendee_phone  = old.attendee_phone
    AND nw.attendee_phone IS NOT NULL
    AND nw.id          <> old.id
    AND nw.start_time  <> old.start_time
    AND nw.created_at   > old.created_at
    AND abs(extract(epoch FROM (nw.created_at - old.updated_at))) <= 120
  WHERE old.status = 'cancelled'
)
UPDATE public.appointments nw
SET    rescheduled_from_id = r.old_id
FROM   ranked r
WHERE  nw.id = r.new_id
  AND  r.rn  = 1
  AND  nw.rescheduled_from_id IS NULL;   -- idempotent: skip already-linked rows

-- Flip the superseded OLD rows to the distinct terminal status. The superseded set
-- is exactly those now pointed at by a rescheduled_from_id; only flip rows still
-- `cancelled` (idempotent, and never touches a genuine standalone cancellation).
UPDATE public.appointments
SET    status = 'rescheduled'
WHERE  status = 'cancelled'
  AND  id IN (
    SELECT rescheduled_from_id FROM public.appointments
    WHERE rescheduled_from_id IS NOT NULL
  );
