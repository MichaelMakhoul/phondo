-- Add language column to assistants table for multilingual support.
-- Defaults to 'en' (English). Supported values: 'en', 'es' (Spanish).
ALTER TABLE assistants ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';

-- Add a CHECK constraint to limit to supported languages
ALTER TABLE assistants ADD CONSTRAINT assistants_language_check CHECK (language IN ('en', 'es'));

COMMENT ON COLUMN assistants.language IS 'Language code for the assistant (en=English, es=Spanish). Controls STT, TTS voice, and system prompt language.';
