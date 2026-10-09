-- SCRUM-585 — owner_access: the registered mobile + PIN behind the owner
-- assistant (docs/superpowers/specs/2026-10-09-owner-assistant-design.md §7).
--
-- A business owner rings their own Phondo number from this mobile, enters the
-- PIN (keypad or voice, collected by Twilio before the AI connects), and the
-- receptionist becomes their assistant. One row per organization in phase 1.
--
-- The PIN is stored as scrypt(pin, pin_salt, 32) in lowercase hex with a
-- per-row 16-byte salt, itself stored as 32 lowercase hex chars. The 32-char
-- salt STRING (its UTF-8 bytes, not the hex-decoded bytes) is the scrypt salt
-- input: the writer and the verifier must agree on that. The Next.js route
-- /api/v1/owner-access writes it through the service-role admin client; the
-- voice server verifies it (lib/owner-auth.js). Failed-attempt lockout lives
-- in rate_limit_buckets (00135/00136) under keys owner-pin:<org>:<salt8> and
-- owner-pin-day:<org>:<salt8> (PR C's lib/owner-auth.js — a new PIN rotates
-- the salt, so it starts fresh buckets); no counters here.
--
-- Access posture:
--   * RLS SELECT for the org's owners/admins (the Settings page read).
--   * NO client write policies — only service_role inserts/updates/deletes,
--     after the route's own owner-role check.
--   * pin_hash and pin_salt are NOT granted to `authenticated` at all. A 4–8
--     digit PIN is a small space; handing the salted digest to any org admin's
--     browser session would let them crack the owner's PIN offline.

BEGIN;

CREATE TABLE IF NOT EXISTS public.owner_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- The mobile the owner calls from; Twilio's From is compared to this exactly.
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),

  -- scrypt(pin, pin_salt, 32) hex / 16 random bytes hex. See header.
  pin_hash text NOT NULL CHECK (pin_hash ~ '^[0-9a-f]{64}$'),
  pin_salt text NOT NULL CHECK (pin_salt ~ '^[0-9a-f]{32}$'),

  -- Drives Twilio's <Gather numDigits>: the length of the PIN the owner chose
  -- (no DB default; set from the PIN itself).
  pin_length smallint NOT NULL CHECK (pin_length BETWEEN 4 AND 8),

  enabled boolean NOT NULL DEFAULT true,

  -- Set by the voice server on a successful PIN; never by the dashboard.
  last_verified_at timestamptz,

  -- auth.users id of the owner who saved it. No FK (cross-schema coupling),
  -- same as appointment_events.actor_id (00146).
  created_by uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.owner_access IS
  'Owner assistant line (SCRUM-585): registered mobile + scrypt PIN per organization. Written by /api/v1/owner-access (service role); verified by the voice server. pin_hash/pin_salt are not readable by authenticated users.';

DROP TRIGGER IF EXISTS update_owner_access_updated_at ON public.owner_access;
CREATE TRIGGER update_owner_access_updated_at
  BEFORE UPDATE ON public.owner_access
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.owner_access ENABLE ROW LEVEL SECURITY;

-- Column-level read grant: everything except the secret columns.
-- (Supabase's default privileges grant ALL to anon/authenticated on new
-- public tables, so revoke first, then grant the allowed columns back.)
--
-- NOTE for future schema work: a NEW non-secret column must be added to this
-- list in a forward migration, or user-scoped reads of it fail with 42501.
-- `select *` from a user-scoped client always fails for the same reason
-- (pin_hash/pin_salt are withheld), so such reads must name their columns.
REVOKE ALL ON TABLE public.owner_access FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, organization_id, phone_e164, pin_length, enabled, last_verified_at, created_by, created_at, updated_at)
  ON public.owner_access TO authenticated;
-- service_role retains its implicit ALL grant.

DROP POLICY IF EXISTS "org owners and admins read owner access" ON public.owner_access;
CREATE POLICY "org owners and admins read owner access"
  ON public.owner_access FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.org_members
      WHERE user_id = (SELECT auth.uid()) AND role IN ('owner', 'admin')
    )
  );

COMMIT;
