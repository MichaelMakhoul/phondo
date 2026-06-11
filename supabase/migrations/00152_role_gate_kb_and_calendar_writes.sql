-- SCRUM-428 (review of findings #32/#35): the new owner/admin route gates on
-- knowledge-base and calendar-integration writes were bypassable — both
-- tables' RLS policies were role-blind FOR ALL, so any org MEMBER could
-- INSERT/UPDATE/DELETE rows directly via PostgREST (anon key + session),
-- rewriting what the live AI tells callers or corrupting the integration
-- (including storing a cross-org assistant_id). Enforce the same boundary at
-- the DB layer.
--
-- Verified before applying: no client code writes either table directly
-- (dashboard components only read); the integration route writes via the
-- service-role client (saveCalendarIntegration), which bypasses RLS; zero
-- cross-org assistant refs exist in prod.

-- ── knowledge_bases: members read, owner/admin write ────────────────────────
DROP POLICY IF EXISTS "Users can manage their org knowledge bases" ON public.knowledge_bases;

CREATE POLICY "Members can view their org knowledge bases" ON public.knowledge_bases
  FOR SELECT
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Org admins can manage knowledge bases" ON public.knowledge_bases
  FOR ALL
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
        AND org_members.role = ANY (ARRAY['owner'::member_role, 'admin'::member_role])
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
        AND org_members.role = ANY (ARRAY['owner'::member_role, 'admin'::member_role])
    )
  );

-- ── calendar_integrations: members read; writes are service-role ONLY ──────
-- (the API route is the sole writer and uses the admin client, which
-- bypasses RLS — no client-side write policy is needed at all)
DROP POLICY IF EXISTS "Users can manage their org calendar integrations" ON public.calendar_integrations;

CREATE POLICY "Members can view their org calendar integrations" ON public.calendar_integrations
  FOR SELECT
  USING (
    organization_id IN (
      SELECT org_members.organization_id
      FROM org_members
      WHERE org_members.user_id = (SELECT auth.uid())
    )
  );

-- ── cross-org assistant_id closed at the DB level ───────────────────────────
-- Composite FK forces (assistant_id, organization_id) to match a real
-- assistant IN THE SAME ORG. NULL assistant_id still passes (MATCH SIMPLE).
-- ON DELETE CASCADE preserves the previous single-column FK's behavior.
CREATE UNIQUE INDEX IF NOT EXISTS assistants_id_org_key
  ON public.assistants (id, organization_id);

ALTER TABLE public.calendar_integrations
  DROP CONSTRAINT IF EXISTS calendar_integrations_assistant_id_fkey;

ALTER TABLE public.calendar_integrations
  ADD CONSTRAINT calendar_integrations_assistant_id_fkey
  FOREIGN KEY (assistant_id, organization_id)
  REFERENCES public.assistants (id, organization_id)
  ON DELETE CASCADE;
