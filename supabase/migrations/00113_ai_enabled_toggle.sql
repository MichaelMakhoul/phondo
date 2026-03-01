-- Add ai_enabled toggle to phone_numbers.
-- Distinct from is_active (provisioning status): a number can be provisioned but AI-paused.
-- Defaults to true so existing numbers continue working.
ALTER TABLE phone_numbers ADD COLUMN ai_enabled BOOLEAN NOT NULL DEFAULT true;
