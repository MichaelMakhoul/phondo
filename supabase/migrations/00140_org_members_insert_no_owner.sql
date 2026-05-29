-- SCRUM-345 (audit M4) — close a within-tenant privilege-escalation hole in the
-- org_members INSERT policy.
--
-- The INSERT policy "Org admins can add members" gated only on
-- is_org_admin(organization_id, auth.uid()) with NO constraint on `role`.
-- is_org_admin() returns true for BOTH admin and owner, so a non-owner ADMIN
-- could INSERT a brand-new member with role='owner' (e.g. an accomplice
-- account). That accomplice-owner could then DELETE the legitimate owner via the
-- "Org owners can delete members" policy → full within-tenant org takeover.
--
-- The UPDATE policy already forbids role='owner'; INSERT was the gap. Owners are
-- only ever meant to be created at org-creation time, which happens through the
-- SECURITY DEFINER create_organization_with_owner() (RLS does not apply there),
-- so adding this guard does not break legitimate owner creation. Normal
-- member/admin invites are unaffected.
--
-- Match the init-plan-optimised (SELECT auth.uid()) form (see 00133) so the
-- subquery is evaluated once per statement, not per row.

ALTER POLICY "Org admins can add members" ON public.org_members
  WITH CHECK (
    is_org_admin(organization_id, (SELECT auth.uid()))
    AND role <> 'owner'::member_role
  );
