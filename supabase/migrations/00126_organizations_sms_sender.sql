-- SCRUM-260: Alphanumeric SMS sender for customer-facing SMS
-- Allows AU (and other supported country) SMS to come from the business name
-- instead of a phone number. Free, works on voice-only AU Local numbers.

ALTER TABLE organizations
  ADD COLUMN sms_sender TEXT;

-- Alphanumeric sender IDs are 1-11 chars, alphanumeric + space only.
-- Must contain at least one letter (Twilio rule).
-- Null means "fall back to the org's phone number" (existing behavior).
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

-- Backfill: generate a default sms_sender from business_name (or org name) for
-- existing orgs. Strip non-alphanumeric chars, collapse spaces, truncate to 11.
UPDATE organizations
SET sms_sender = LEFT(
  TRIM(REGEXP_REPLACE(
    REGEXP_REPLACE(COALESCE(NULLIF(business_name, ''), name), '[^A-Za-z0-9 ]', '', 'g'),
    '\s+', ' ', 'g'
  )),
  11
)
WHERE sms_sender IS NULL
  AND COALESCE(NULLIF(business_name, ''), name) IS NOT NULL
  AND LEFT(
    TRIM(REGEXP_REPLACE(
      REGEXP_REPLACE(COALESCE(NULLIF(business_name, ''), name), '[^A-Za-z0-9 ]', '', 'g'),
      '\s+', ' ', 'g'
    )),
    11
  ) ~ '[A-Za-z]';

COMMENT ON COLUMN organizations.sms_sender IS 'Alphanumeric SMS sender ID shown to recipients (e.g. "SmileHub"). 1-11 chars, alphanumeric + space, at least one letter. Null falls back to the org''s phone number.';
