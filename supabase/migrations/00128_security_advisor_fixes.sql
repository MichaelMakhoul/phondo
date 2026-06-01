-- 00128_security_advisor_fixes.sql
-- Security advisor remediation, 2026-05-05.
--
-- Addresses three concrete findings:
--   (a) get_user_organizations IDOR — function returned any user's org list
--       when called via /rest/v1/rpc/get_user_organizations. Now guards against
--       cross-user lookups internally. RLS policies that pass auth.uid() are
--       unaffected.
--   (b) handle_new_user EXECUTE permission — it's a trigger function on
--       auth.users INSERT; no role should call it via RPC. Revoke EXECUTE.
--   (c) appointment_end mutable search_path — pin to pg_catalog, public.
--
-- Leaves these advisor warnings in place because they are required for the
-- RLS pattern and signup flow:
--   - is_org_member / is_org_admin PUBLIC EXECUTE (every RLS policy calls them)
--   - create_organization_with_owner PUBLIC EXECUTE (signup flow)
--
-- Applied via Supabase MCP apply_migration; mirrored here for source-of-truth.

-- 1. IDOR guard on get_user_organizations(uuid).
CREATE OR REPLACE FUNCTION public.get_user_organizations(user_uuid uuid)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role'
     AND (auth.uid() IS NULL OR user_uuid <> auth.uid())
  THEN
    RAISE EXCEPTION 'Cannot query organizations for another user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT organization_id FROM org_members WHERE user_id = user_uuid;
END;
$function$;

-- 2. Defense-in-depth: revoke anon EXECUTE on get_user_organizations.
REVOKE EXECUTE ON FUNCTION public.get_user_organizations(uuid) FROM anon;

-- 3. Revoke EXECUTE on handle_new_user — it's a trigger, never called by RPC.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;

-- 4. Pin search_path on appointment_end.
ALTER FUNCTION public.appointment_end(timestamptz, timestamptz, integer)
  SET search_path = pg_catalog, public;
