-- SCRUM-260: Alphanumeric SMS sender for customer-facing SMS
-- Allows AU (and other supported country) SMS to come from the business name
-- instead of a phone number. Free, works on voice-only AU Local numbers.
--
-- Structured in 3 separate statements (add column → backfill → add constraint)
-- so a bad backfill row can't roll back the schema change. Safer for production.

-- 1. Add the column (nullable — no default, existing rows get NULL and fall
--    back to the org's phone number at send time)
ALTER TABLE organizations
  ADD COLUMN sms_sender TEXT;

COMMENT ON COLUMN organizations.sms_sender IS 'Alphanumeric SMS sender ID shown to recipients (e.g. "SmileHub"). 1-11 chars, alphanumeric + space, at least one letter. Null falls back to the org''s phone number.';

-- 2. Backfill: generate a default sms_sender from business_name (or org name)
--    for existing orgs. Strip non-alphanumeric chars, collapse spaces, truncate
--    to 11 chars. Skip rows where no valid sender can be produced (names that
--    are only punctuation / emoji / digits).
WITH computed AS (
  SELECT
    id,
    LEFT(
      TRIM(REGEXP_REPLACE(
        REGEXP_REPLACE(COALESCE(NULLIF(business_name, ''), name), '[^A-Za-z0-9 ]', '', 'g'),
        '\s+', ' ', 'g'
      )),
      11
    ) AS candidate
  FROM organizations
  WHERE sms_sender IS NULL
    AND COALESCE(NULLIF(business_name, ''), name) IS NOT NULL
)
UPDATE organizations o
SET sms_sender = c.candidate
FROM computed c
WHERE o.id = c.id
  AND c.candidate ~ '[A-Za-z]'      -- must contain a letter (CHECK requirement)
  AND length(c.candidate) BETWEEN 1 AND 11;

-- 3. Add the CHECK constraint AFTER backfill so a bad computed value
--    would fail loudly here without discarding the new column.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_sms_sender_valid
  CHECK (
    sms_sender IS NULL
    OR (
      length(sms_sender) BETWEEN 1 AND 11
      AND sms_sender ~ '^[A-Za-z0-9 ]+$'
      AND sms_sender ~ '[A-Za-z]'
    )
  );
