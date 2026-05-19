-- SCRUM-277 follow-up — Lock down `check_rate_limit_bucket` from
-- `authenticated` to `service_role` only.
--
-- The original 00135 migration granted EXECUTE to both authenticated and
-- service_role. PR-review (silent-failure-hunter + security review on the
-- 00135 PR) flagged a HIGH-severity cross-tenant rate-limit poisoning
-- vector: the RPC accepts an attacker-controlled `p_key TEXT` and trusts
-- whatever shape the caller invents. Since the application's key convention
-- is `{org_uuid}:{endpoint}` and the function does not validate that the
-- caller's JWT belongs to the embedded org, ANY authenticated user could
-- call the RPC directly via PostgREST with a victim org's UUID and bump
-- the victim's counter — locking the victim out of paid-action endpoints
-- for the full window. The org-membership check in the route fires before
-- the limiter, but it is the limiter row itself that gets poisoned, so the
-- route-level check cannot save the victim.
--
-- The fix-forward chosen here: restrict EXECUTE to `service_role`. The Node
-- side now calls the RPC through a service-role client (via
-- `createAdminClient()` from `lib/supabase/admin.ts`); the user-bound
-- client never touches the RPC. Authenticated users have zero direct
-- access. The route's own admin-role + org-membership checks continue to
-- gate who can TRIGGER a limiter call.
--
-- An alternative we considered: keep the authenticated grant but move the
-- key construction inside the RPC (`p_org_id UUID` + RAISE EXCEPTION
-- unless auth.uid() is in org_members). That is the cleaner long-term
-- shape, but it ties the RPC to a single key schema (org-based) and would
-- require a separate RPC for IP-based or session-based identifiers later.
-- Restricting to service_role keeps the RPC generic for future
-- identifier types and shifts the authz responsibility back to the
-- application — same trust boundary as our other service-role-only
-- functions (`cleanup_rate_limit_buckets`, `increment_call_usage`, etc.).

BEGIN;

REVOKE EXECUTE ON FUNCTION public.check_rate_limit_bucket(TEXT, INTEGER, INTEGER)
  FROM authenticated;

-- service_role retains its 00135 grant — not re-issued here so the diff
-- stays minimal. A re-issue would be a no-op anyway.

COMMIT;
