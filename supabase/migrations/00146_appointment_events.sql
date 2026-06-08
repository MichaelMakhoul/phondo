-- SCRUM-398 — appointment audit trail (append-only event log).
--
-- Today the only history we keep is the reschedule supersede chain
-- (rescheduled_from_id, SCRUM-388). In-place edits (name/phone/email/notes/status)
-- and WHO made a change (staff via dashboard vs the AI on a call) are not recorded.
-- This table captures every appointment mutation as an immutable event so the
-- detail panel can show "Name: Michael → Mena · Edited by staff" next to
-- "Time: 11:00 → 12:30 · Changed via AI call".
--
-- Generic by design (works for any industry): `changed_fields` is a JSONB list of
-- {field, from, to} with RESOLVED human-readable values (e.g. practitioner names,
-- not FK UUIDs), so the log stays correct even if a practitioner/service is later
-- renamed or deleted.
--
-- Append-only: no updated_at, no update trigger. RLS exposes SELECT to org members;
-- there are NO write policies, so only the service_role (the server-side admin
-- client) can insert — every mutation path emits through it. Pure-additive: no
-- changes to existing tables, no backfill (chains without events still render from
-- the reschedule legs). Fully idempotent.

CREATE TABLE IF NOT EXISTS public.appointment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- What kind of change this was.
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'edited', 'rescheduled', 'cancelled', 'status_changed', 'restored'
  )),

  -- Who made it. AI = the voice receptionist; staff = a dashboard user;
  -- system = automated (e.g. an external calendar sync).
  actor_type text NOT NULL CHECK (actor_type IN ('ai', 'staff', 'system')),

  -- The staff user_id when actor_type='staff'. Nullable (AI/system have none).
  -- Intentionally NO FK to auth.users — avoids cross-schema coupling; the display
  -- name is resolved at render time (or frozen into `note`).
  actor_id uuid,

  -- How the change arrived. Mirrors deriveChannel() vocabulary so events and
  -- reschedule legs share one channel set.
  channel text NOT NULL CHECK (channel IN (
    'voice', 'dashboard', 'cal_com', 'calendly', 'google_calendar', 'system'
  )),

  -- [{ field, from, to }] with human-readable resolved values (see header).
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Optional free-text context (e.g. a cancellation reason).
  note text,

  -- Links an AI-driven event to the call it happened on (for the transcript link).
  call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-appointment timeline (the dashboard's primary read).
CREATE INDEX IF NOT EXISTS idx_appointment_events_appointment
  ON public.appointment_events (appointment_id, created_at);

-- Org-wide recent activity (future audit/admin views).
CREATE INDEX IF NOT EXISTS idx_appointment_events_org_created
  ON public.appointment_events (organization_id, created_at DESC);

ALTER TABLE public.appointment_events ENABLE ROW LEVEL SECURITY;

-- Org members can read their org's events (dashboard display). Writes are
-- service_role only — no INSERT/UPDATE/DELETE policies by design (append-only).
DROP POLICY IF EXISTS "org members read appointment events" ON public.appointment_events;
CREATE POLICY "org members read appointment events"
  ON public.appointment_events FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.org_members WHERE user_id = auth.uid()
    )
  );
