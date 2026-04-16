-- SCRUM-260 follow-up: business email for customer-facing contact
-- Used as an opt-out channel on alphanumeric SMS when no business_phone
-- is set, and may be used in other customer touchpoints later.

ALTER TABLE organizations
  ADD COLUMN business_email TEXT;

-- Loose email validation — we don't want to reject valid addresses with
-- aggressive regex. Just require an @ with something either side.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_business_email_valid
  CHECK (
    business_email IS NULL
    OR (
      length(business_email) <= 254
      AND business_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    )
  );

COMMENT ON COLUMN organizations.business_email IS 'Customer-facing email address for the business. Appears in outbound SMS/email opt-out instructions when set.';
