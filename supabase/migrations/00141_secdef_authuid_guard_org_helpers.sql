-- SCRUM-348 (audit L2) — add an auth.uid() guard to the is_org_member /
-- is_org_admin SECURITY DEFINER helpers.
--
-- Both are SECURITY DEFINER and EXECUTE-able by `authenticated`, with no binding
-- between the `user_uuid` argument and the caller. A signed-in user could call
-- them via /rest/v1/rpc/is_org_member?... with an arbitrary user_uuid + org_id to
-- enumerate cross-tenant membership (IDOR). This mirrors the guard
-- get_user_organizations received in 00128.
--
-- Safe for RLS: every policy that calls these helpers passes (SELECT auth.uid())
-- as user_uuid (verified across all 26 policies), so user_uuid = auth.uid() and
-- the guard never trips during policy evaluation. service_role (internal admin
-- client) is exempt, and no SECURITY DEFINER function body or app .rpc() call
-- invokes these with a non-self uuid (verified). EXECUTE grants are unchanged —
-- authenticated must keep EXECUTE for RLS policy evaluation; the guard makes
-- direct RPC abuse harmless instead.

CREATE OR REPLACE FUNCTION public.is_org_member(org_id uuid, user_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role'
     AND (auth.uid() IS NULL OR user_uuid <> auth.uid())
  THEN
    RAISE EXCEPTION 'Cannot check membership for another user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM org_members
    WHERE organization_id = org_id AND user_id = user_uuid
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_org_admin(org_id uuid, user_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role'
     AND (auth.uid() IS NULL OR user_uuid <> auth.uid())
  THEN
    RAISE EXCEPTION 'Cannot check membership for another user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM org_members
    WHERE organization_id = org_id
    AND user_id = user_uuid
    AND role IN ('owner', 'admin')
  );
END;
$function$;
