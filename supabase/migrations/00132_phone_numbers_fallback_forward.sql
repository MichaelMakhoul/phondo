-- Kill switch fallback: when the customer toggles AI off on a number, calls
-- can be forwarded to a configured number (typically the owner's mobile)
-- instead of going to voicemail. NULL means voicemail (existing behavior).
--
-- Stored as E.164 (+61... / +1...). Validated at the API layer; DB stores
-- whatever the API passes after normalisation.

ALTER TABLE phone_numbers
  ADD COLUMN fallback_forward_number text;

COMMENT ON COLUMN phone_numbers.fallback_forward_number IS
  'E.164 number to dial when ai_enabled=false. NULL → voicemail TwiML fallback.';

-- DB-level invariants: never a non-E.164 string, never the row's own phone_number.
-- The API layer enforces these too, but a defense-in-depth CHECK closes the
-- gap for any future service-role writer (cron job, manual SQL, etc.).
ALTER TABLE phone_numbers
  ADD CONSTRAINT phone_numbers_fallback_forward_e164
    CHECK (
      fallback_forward_number IS NULL
      OR fallback_forward_number ~ '^\+[1-9][0-9]{7,14}$'
    );

ALTER TABLE phone_numbers
  ADD CONSTRAINT phone_numbers_fallback_forward_not_self
    CHECK (
      fallback_forward_number IS NULL
      OR fallback_forward_number IS DISTINCT FROM phone_number
    );

-- Tighten the existing UPDATE policy with a WITH CHECK clause so an org
-- member cannot pivot a row to another organization. The original policy
-- (migration 00101) only had USING; this is a defense-in-depth fix flagged
-- during code review of the kill-switch feature.
DROP POLICY IF EXISTS "Org members can update phone numbers" ON phone_numbers;
CREATE POLICY "Org members can update phone numbers" ON phone_numbers
  FOR UPDATE
  USING (is_org_member(organization_id, auth.uid()))
  WITH CHECK (is_org_member(organization_id, auth.uid()));
