-- 00130_revoke_anon_execute_on_security_definer_helpers.sql
-- Follow-up to 00129. The previous migration revoked from PUBLIC and granted
-- explicit access to authenticated + service_role, but explicit anon grants
-- still existed on these three SECURITY DEFINER functions, so the advisor
-- continued to flag them as anon-callable. Explicit REVOKE FROM anon is needed.
--
-- Anon doesn't need any of these:
--   - is_org_member / is_org_admin: would always return false for anon since
--     auth.uid() is NULL.
--   - create_organization_with_owner: raises 'Not authenticated' if auth.uid()
--     is NULL.
-- So removing anon's EXECUTE is functionally a no-op AND clears the lint.

REVOKE EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_org_admin(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_organization_with_owner(text, text, organization_type) FROM anon;
