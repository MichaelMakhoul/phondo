-- 00120_cleaned_transcript.sql
-- Adds cleaned_transcript JSONB for post-call analysis STT-normalised output (SCRUM-208).
-- Structure: { turns: [{ role: 'user'|'assistant', text: string, original?: string, language?: string }] }
-- Nullable because cleanup is best-effort and older calls predate this column.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS cleaned_transcript JSONB;

COMMENT ON COLUMN calls.cleaned_transcript IS
  'STT-normalised transcript produced by post-call analysis. Nullable. Structure: { turns: [{role, text, original?, language?}] }.';
