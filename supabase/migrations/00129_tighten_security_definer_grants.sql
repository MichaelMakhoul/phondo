-- 00129_tighten_security_definer_grants.sql
-- Follow-up to 00128. Remove blanket PUBLIC EXECUTE on the four SECURITY DEFINER
-- functions that legitimately need to be callable from RLS policies and signup
-- flow, and re-grant explicitly to the roles that DO need them. This kills the
-- "anon Can Execute SECURITY DEFINER" advisor warnings (4 findings) while
-- preserving every legitimate caller.
--
-- The remaining "authenticated Can Execute SECURITY DEFINER" warnings are
-- accepted as by-design — these functions MUST be callable by signed-in users
-- for RLS policies (is_org_*, get_user_organizations) and signup
-- (create_organization_with_owner) to work.

-- get_user_organizations: only authenticated users (with internal IDOR guard
-- from 00128) and service_role need this.
REVOKE EXECUTE ON FUNCTION public.get_user_organizations(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_user_organizations(uuid) TO authenticated, service_role;

-- is_org_member / is_org_admin: called by RLS policies on every org-scoped
-- table. Only authenticated callers' policies need this; anon's policies
-- always evaluate to false (auth.uid() is NULL) so anon doesn't need to
-- be able to call the function.
REVOKE EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_org_admin(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.is_org_admin(uuid, uuid) TO authenticated, service_role;

-- create_organization_with_owner: called from the post-signup flow. Anon
-- has no business creating orgs (the function requires auth.uid() anyway,
-- and raises 'Not authenticated' if NULL).
REVOKE EXECUTE ON FUNCTION public.create_organization_with_owner(text, text, organization_type) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_organization_with_owner(text, text, organization_type) TO authenticated;
