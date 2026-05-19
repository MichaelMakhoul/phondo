-- SCRUM-294 follow-up — flip transfer_rules.require_confirmation default to TRUE.
--
-- Round 2 of the SCRUM-294 prompt fix makes the AI fire transfer_call the
-- moment it detects intent. That's the correct behaviour when the caller is
-- unambiguous, but it raises the risk of false-positive transfers (e.g.
-- caller says "transfer my prescription" or STT mishears).
--
-- The existing `require_confirmation` flag is the safety net: when true, the
-- AI asks "Shall I transfer you to <name>?" once and waits for yes/no before
-- dialling. Defaulting it to true gives new orgs the safer behaviour by
-- default; owners can opt out per-rule via the dashboard toggle.
--
-- Existing rows are left untouched — flipping the default does NOT change
-- any rule that's already been saved.

ALTER TABLE transfer_rules
  ALTER COLUMN require_confirmation SET DEFAULT TRUE;
