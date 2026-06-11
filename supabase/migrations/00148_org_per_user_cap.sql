-- SCRUM-412 [Security/Medium] Cap owned organizations per user (anti-abuse).
--
-- create_organization_with_owner is SECURITY DEFINER and granted to the
-- `authenticated` role, so any logged-in user could call it directly in a loop
-- to mint unlimited organizations — each of which can then claim a no-card
-- 14-day trial (audit findings #14, #23). Add a guard so a user who already
-- OWNS an organization cannot create another. Offboarding deletes the
-- org_members row (cascade on organization delete), which frees the cap.
-- Multi-org agencies (a Phase-3 product) will need this revisited.
--
-- CREATE OR REPLACE preserves the existing grants (authenticated EXECUTE, anon
-- revoked — migrations 00129/00130) and the SECURITY DEFINER + search_path.
-- The local variable is renamed v_user_id to avoid any column/variable
-- ambiguity in the new EXISTS check.
CREATE OR REPLACE FUNCTION create_organization_with_owner(
  org_name text,
  org_slug text,
  org_type organization_type DEFAULT 'business'::organization_type
)
RETURNS TABLE(id uuid, name text, slug text, type organization_type)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  new_org_id UUID;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- One owned organization per user (anti-abuse).
  IF EXISTS (
    SELECT 1 FROM public.org_members om
    WHERE om.user_id = v_user_id AND om.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'User already owns an organization';
  END IF;

  INSERT INTO public.organizations (name, slug, type)
  VALUES (org_name, org_slug, org_type)
  RETURNING organizations.id INTO new_org_id;

  INSERT INTO public.org_members (organization_id, user_id, role)
  VALUES (new_org_id, v_user_id, 'owner');

  RETURN QUERY
  SELECT o.id, o.name, o.slug, o.type
  FROM public.organizations o
  WHERE o.id = new_org_id;
END;
$$;

-- Race-proof backstop: the EXISTS check above is a friendly fast-path, but it is
-- not atomic (two concurrent RPC calls could both pass it and both INSERT a
-- second owner row, since org_members' UNIQUE is on (organization_id, user_id),
-- which does NOT prevent owning multiple DIFFERENT orgs). This partial unique
-- index makes the database reject a second owner row for the same user
-- atomically. A user can still be admin/member of other orgs — only role='owner'
-- is constrained. (Verified no existing user owns >1 org before creating it.)
CREATE UNIQUE INDEX IF NOT EXISTS org_members_one_owner_per_user
  ON public.org_members (user_id)
  WHERE role = 'owner';
