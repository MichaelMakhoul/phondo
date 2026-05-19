-- SCRUM-279 — Fix copy-paste bug in practitioner_services.ps_update.
--
-- The original ps_update policy was keyed on `(auth.role() = 'service_role')`
-- — identical to ps_service_role on the same table. The other ps_* policies
-- (select / insert / delete) all key on `get_user_organizations(auth.uid())`,
-- so org members could SELECT/INSERT/DELETE practitioner_services but
-- silently could not UPDATE. Discovered during SCRUM-270 review and preserved
-- verbatim in migration 00133 to keep that PR a pure planner optimisation —
-- this migration is the logic fix.
--
-- The bug was latent (no current code path UPDATEs practitioner_services
-- from a user session — the practitioners API uses DELETE + INSERT to
-- rewrite associations at src/app/api/v1/practitioners/[id]/route.ts:92-118).
-- Fixing now so a future UPDATE-based UI doesn't silently fail.
--
-- The new predicate mirrors ps_select / ps_insert / ps_delete exactly,
-- with auth.uid() wrapped in (SELECT ...) per the initplan optimisation
-- from SCRUM-270.
--
-- ps_service_role (FOR ALL) continues to bypass this for the voice-server
-- and cron jobs — unchanged.

DROP POLICY IF EXISTS "ps_update" ON public.practitioner_services;
CREATE POLICY "ps_update" ON public.practitioner_services
  FOR UPDATE
  USING (
    practitioner_id IN (
      SELECT practitioners.id
      FROM practitioners
      WHERE practitioners.organization_id IN (
        SELECT get_user_organizations((SELECT auth.uid()))
      )
    )
  )
  WITH CHECK (
    practitioner_id IN (
      SELECT practitioners.id
      FROM practitioners
      WHERE practitioners.organization_id IN (
        SELECT get_user_organizations((SELECT auth.uid()))
      )
    )
  );

-- Post-migration verification (run via the Supabase MCP after apply):
--
--   SELECT pg_get_expr(polqual, polrelid) AS using_expr,
--          pg_get_expr(polwithcheck, polrelid) AS with_check_expr
--   FROM pg_policy
--   WHERE polname = 'ps_update'
--     AND polrelid = 'public.practitioner_services'::regclass;
--
-- Expected: both expressions reference `practitioner_id IN (...)`, not
-- `auth.role() = 'service_role'`.
