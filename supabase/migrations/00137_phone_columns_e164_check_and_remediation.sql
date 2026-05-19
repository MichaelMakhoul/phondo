-- SCRUM-295 — Enforce E.164 on user-entered phone columns + remediate
-- existing broken values.
--
-- Three columns store user-entered phone numbers and were observed to
-- contain non-E.164 values during the 2026-05-20 production audit:
--   organizations.business_phone        — 3 of 3 broken
--   notification_preferences.sms_phone_number — 1 of 1 broken
--   transfer_rules.transfer_to_phone    — 1 of 1 broken (caused call
--                                          035fa552 to fail mid-transfer)
--
-- Twilio's <Dial> verb silently refuses non-E.164 destinations, so a
-- transfer rule with "041414141883" (12 digits, leading zero) just hangs
-- up the caller instead of connecting them. This migration:
--   1. Auto-normalises recoverable AU values (0XXXXXXXXX → +61XXXXXXXXX)
--   2. NULLs unrecoverable values in optional columns
--   3. Disables transfer rules with unrecoverable phones (preserves the
--      user's intent — they can fix and re-enable)
--   4. Adds CHECK constraints so future writes can't introduce bad values
--
-- Out of scope: appointments.attendee_phone and callback_requests.caller_phone
-- come from the AI tool handlers (caller-spoken input), not user-facing
-- forms. Those normalisation gaps are tracked in SCRUM-303.

-- ---------------------------------------------------------------------------
-- Step 1: Audit log — emit every non-E.164 value as a NOTICE before mutating.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT 'organizations'::text AS tbl, id::text AS row_id, business_phone AS bad_val
      FROM organizations
      WHERE business_phone IS NOT NULL
        AND business_phone !~ '^\+[1-9][0-9]{7,14}$'
    UNION ALL
    SELECT 'notification_preferences', organization_id::text, sms_phone_number
      FROM notification_preferences
      WHERE sms_phone_number IS NOT NULL
        AND sms_phone_number !~ '^\+[1-9][0-9]{7,14}$'
    UNION ALL
    SELECT 'transfer_rules', id::text, transfer_to_phone
      FROM transfer_rules
      WHERE transfer_to_phone IS NOT NULL
        AND transfer_to_phone !~ '^\+[1-9][0-9]{7,14}$'
  LOOP
    RAISE NOTICE 'SCRUM-295 pre-fix non-E.164: %.% = "%"', rec.tbl, rec.row_id, rec.bad_val;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Step 2: Auto-normalise recoverable AU 10-digit local values.
-- Strips formatting (spaces/parens/dashes) and prepends +61 when the result
-- matches ^0[23478][0-9]{8}$ — i.e. AU mobiles (04XX) or landlines (02/03/07/08).
-- Anything ambiguous is left for steps 3-4 below.
-- ---------------------------------------------------------------------------
WITH norm AS (
  SELECT id,
         '+61' || substring(regexp_replace(business_phone, '\D', '', 'g') from 2) AS new_phone
    FROM organizations
   WHERE business_phone IS NOT NULL
     AND business_phone !~ '^\+[1-9][0-9]{7,14}$'
     AND regexp_replace(business_phone, '\D', '', 'g') ~ '^0[23478][0-9]{8}$'
)
UPDATE organizations o
   SET business_phone = n.new_phone
  FROM norm n
 WHERE o.id = n.id;

WITH norm AS (
  SELECT organization_id,
         '+61' || substring(regexp_replace(sms_phone_number, '\D', '', 'g') from 2) AS new_phone
    FROM notification_preferences
   WHERE sms_phone_number IS NOT NULL
     AND sms_phone_number !~ '^\+[1-9][0-9]{7,14}$'
     AND regexp_replace(sms_phone_number, '\D', '', 'g') ~ '^0[23478][0-9]{8}$'
)
UPDATE notification_preferences p
   SET sms_phone_number = n.new_phone
  FROM norm n
 WHERE p.organization_id = n.organization_id;

WITH norm AS (
  SELECT id,
         '+61' || substring(regexp_replace(transfer_to_phone, '\D', '', 'g') from 2) AS new_phone
    FROM transfer_rules
   WHERE transfer_to_phone IS NOT NULL
     AND transfer_to_phone !~ '^\+[1-9][0-9]{7,14}$'
     AND regexp_replace(transfer_to_phone, '\D', '', 'g') ~ '^0[23478][0-9]{8}$'
)
UPDATE transfer_rules t
   SET transfer_to_phone = n.new_phone
  FROM norm n
 WHERE t.id = n.id;

-- ---------------------------------------------------------------------------
-- Step 3: Disable transfer rules that still have a bad phone after step 2.
-- We DON'T delete — that loses the owner's intent. Leaving the row with
-- is_active=false means it shows up in the dashboard with a clear "this
-- rule is disabled because the phone is invalid" surface (the CHECK
-- constraint at step 5 only allows bad phones on disabled rules).
-- ---------------------------------------------------------------------------
UPDATE transfer_rules
   SET is_active = false
 WHERE transfer_to_phone IS NOT NULL
   AND transfer_to_phone !~ '^\+[1-9][0-9]{7,14}$';

-- ---------------------------------------------------------------------------
-- Step 4: NULL unrecoverable values in optional columns. The user can
-- re-enter from the dashboard — losing the bad value is better than leaving
-- it as a silent Twilio rejection trap.
-- ---------------------------------------------------------------------------
UPDATE organizations
   SET business_phone = NULL
 WHERE business_phone IS NOT NULL
   AND business_phone !~ '^\+[1-9][0-9]{7,14}$';

UPDATE notification_preferences
   SET sms_phone_number = NULL
 WHERE sms_phone_number IS NOT NULL
   AND sms_phone_number !~ '^\+[1-9][0-9]{7,14}$';

-- ---------------------------------------------------------------------------
-- Step 5: Add CHECK constraints. From here on, the DB itself enforces E.164.
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD CONSTRAINT organizations_business_phone_e164_chk
  CHECK (business_phone IS NULL OR business_phone ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_sms_phone_e164_chk
  CHECK (sms_phone_number IS NULL OR sms_phone_number ~ '^\+[1-9][0-9]{7,14}$');

-- transfer_rules.transfer_to_phone is NOT NULL. Allow bad values to linger
-- ONLY when is_active=false so that step 3 doesn't conflict with the
-- constraint. Re-enabling a rule whose phone hasn't been fixed will fail
-- at the DB layer — the owner has to enter a valid number first.
ALTER TABLE transfer_rules
  ADD CONSTRAINT transfer_rules_transfer_to_phone_e164_chk
  CHECK (transfer_to_phone ~ '^\+[1-9][0-9]{7,14}$' OR is_active = false);

-- ---------------------------------------------------------------------------
-- Step 6: Final audit log.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  org_bad INT;
  np_bad INT;
  tr_bad INT;
  tr_disabled_bad INT;
BEGIN
  SELECT count(*) INTO org_bad FROM organizations
    WHERE business_phone IS NOT NULL AND business_phone !~ '^\+[1-9][0-9]{7,14}$';
  SELECT count(*) INTO np_bad FROM notification_preferences
    WHERE sms_phone_number IS NOT NULL AND sms_phone_number !~ '^\+[1-9][0-9]{7,14}$';
  SELECT count(*) INTO tr_bad FROM transfer_rules
    WHERE transfer_to_phone !~ '^\+[1-9][0-9]{7,14}$';
  SELECT count(*) INTO tr_disabled_bad FROM transfer_rules
    WHERE transfer_to_phone !~ '^\+[1-9][0-9]{7,14}$' AND is_active = false;
  RAISE NOTICE 'SCRUM-295 post-fix: organizations.business_phone bad=%, notification_preferences.sms_phone bad=%, transfer_rules.transfer_to_phone bad=% (of which disabled=%)',
    org_bad, np_bad, tr_bad, tr_disabled_bad;
END $$;
