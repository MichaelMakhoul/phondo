-- SCRUM-421 forward-fix (review findings on 00150): close direct PostgREST
-- INSERT into organizations entirely, and finish the anon/authenticated
-- privilege strip that 00150's comment claimed.
--
-- (a) 00150 re-granted INSERT (incl. slug, type) to `authenticated`, but NO
--     app code inserts organizations as the user role — creation goes
--     exclusively through create_organization_with_owner, which is
--     SECURITY DEFINER owned by postgres (verified in prod): the table owner
--     bypasses RLS (relforcerowsecurity = false) and needs no role grants,
--     so revoking INSERT and dropping the permissive INSERT policy cannot
--     break onboarding. Leaving direct INSERT open allowed slug-squatting on
--     the UNIQUE slug column and orphan-org creation outside the RPC's
--     one-org-per-user guard.
-- (b) Supabase's default GRANT ALL also left TRUNCATE/TRIGGER/REFERENCES on
--     the table for anon/authenticated. TRUNCATE in particular is NOT subject
--     to RLS. Not reachable through PostgREST today, but strip them so the
--     privilege state matches intent.
--
-- NOTE for future schema work: any NEW organizations column written by
-- user-scoped clients (settings forms, onboarding) must be added to the
-- 00150 GRANT UPDATE allowlist in a forward migration, or those writes fail
-- with 42501.

-- (a) No direct inserts — the SECURITY DEFINER RPC is the only creation path
REVOKE INSERT ON public.organizations FROM authenticated;
DROP POLICY IF EXISTS "Users can create organizations" ON public.organizations;

-- (b) Strip remaining unused table privileges from the JWT roles
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.organizations FROM anon, authenticated;
