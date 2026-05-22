-- SCRUM-281 — notify the business owner when an AI call ends "unsuccessful".
--
-- Adds a per-org toggle. Defaults to ON so existing orgs start receiving the
-- alert immediately (NOT NULL DEFAULT true backfills every existing row).
-- The owner can opt out from Settings -> Notifications.
--
-- Pairs with SCRUM-299: the call-completed classifier now routes AI-engaged
-- but unsatisfactory calls here instead of mislabeling them "missed call".

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS email_on_unsuccessful_call BOOLEAN NOT NULL DEFAULT true;
