-- Add after-hours configuration column to assistants
-- Stores custom greeting, instructions, and scheduling preferences for after-hours calls
ALTER TABLE assistants
ADD COLUMN IF NOT EXISTS after_hours_config JSONB DEFAULT NULL;

COMMENT ON COLUMN assistants.after_hours_config IS 'After-hours call handling config: { greeting?, customInstructions?, disableScheduling? }';
