-- SCRUM-405 [Security/Critical] Prevent authenticated users from self-promoting to platform admin.
--
-- Root cause: the `Users can update own profile` RLS policy on user_profiles is
-- FOR UPDATE USING (auth.uid() = id) with no WITH CHECK, and the default Supabase
-- grants give the `authenticated` role column-level UPDATE on every column —
-- including is_platform_admin (added in 00117). Postgres reuses the USING expression
-- as the implicit WITH CHECK; since `id` is unchanged the new row still satisfies it,
-- so any logged-in user could PATCH /rest/v1/user_profiles?id=eq.<own-uid>
-- {"is_platform_admin": true} and gain the platform-admin flag that gates the entire
-- (admin) dashboard (src/app/(admin)/layout.tsx, src/lib/admin/admin-auth.ts).
--
-- Two layers of defence, both required:
--   1. A BEFORE INSERT/UPDATE trigger that rejects any change to is_platform_admin
--      made by an end-user role (authenticated/anon). Only the service role and
--      superuser migrations (auth.role() NULL or 'service_role') may set/clear it.
--      This is the airtight layer — it holds even if grants drift back.
--   2. Tighten the column grant so `authenticated` cannot write is_platform_admin at
--      all. App code never UPDATEs user_profiles directly (profile edits go through
--      supabase.auth.updateUser; the signup row is created by the SECURITY DEFINER
--      handle_new_user()), so revoking table-level UPDATE and re-granting only the
--      user-editable columns is regression-free.

-- 1. Trigger guard --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_platform_admin_self_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- auth.role() is 'authenticated'/'anon' for PostgREST end-user requests, NULL for
  -- superuser migrations, and 'service_role' for trusted server-side writes.
  IF coalesce(auth.role(), '') IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' AND NEW.is_platform_admin IS TRUE THEN
      RAISE EXCEPTION 'permission denied: is_platform_admin can only be set by the platform'
        USING ERRCODE = 'insufficient_privilege';
    ELSIF TG_OP = 'UPDATE' AND NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin THEN
      RAISE EXCEPTION 'permission denied: is_platform_admin can only be changed by the platform'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_platform_admin_self_escalation ON public.user_profiles;
CREATE TRIGGER prevent_platform_admin_self_escalation
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_platform_admin_self_escalation();

-- 2. Remove is_platform_admin from the authenticated/anon writable column set -----
-- Revoke the blanket table-level UPDATE/INSERT, then re-grant only the columns a user
-- may legitimately write (id is the PK, created_at/is_platform_admin are
-- platform-managed). App code never writes user_profiles directly via PostgREST, so
-- this is regression-free defense-in-depth on top of the trigger.
REVOKE UPDATE ON public.user_profiles FROM authenticated, anon;
GRANT UPDATE (email, full_name, avatar_url, updated_at) ON public.user_profiles TO authenticated;

REVOKE INSERT ON public.user_profiles FROM authenticated, anon;
GRANT INSERT (id, email, full_name, avatar_url) ON public.user_profiles TO authenticated;

-- 3. Add the missing WITH CHECK to the UPDATE policy (closes the literal finding) ---
-- Previously the policy was USING-only, so Postgres reused USING as the implicit
-- WITH CHECK. Making it explicit documents intent and adds a third layer; it cannot
-- express "is_platform_admin unchanged" (RLS WITH CHECK sees only NEW), which is why
-- the trigger above is the airtight guard.
ALTER POLICY "Users can update own profile" ON public.user_profiles
  WITH CHECK ((SELECT auth.uid()) = id);
