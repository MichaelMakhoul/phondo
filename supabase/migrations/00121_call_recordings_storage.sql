-- 00121_call_recordings_storage.sql
-- Supabase Storage bucket for call recordings + new columns on calls.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS recording_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS recording_sid TEXT;

COMMENT ON COLUMN calls.recording_storage_path IS
  'Path within the call-recordings bucket, e.g. "<org_id>/<call_id>.mp3". NULL until recording is fetched from the provider.';

COMMENT ON COLUMN calls.recording_sid IS
  'Provider recording identifier (Twilio RecordingSid or Telnyx recording_id). Stored for idempotency when webhooks retry.';

-- Create bucket (private — never public).
INSERT INTO storage.buckets (id, name, public)
VALUES ('call-recordings', 'call-recordings', false)
ON CONFLICT (id) DO NOTHING;

-- Note on bucket access:
-- Supabase enables RLS on storage.objects by default. With no allow policy
-- for the call-recordings bucket, only the service role can read/write.
-- Dashboard reads go through a Next.js route that uses the service role to
-- issue short-lived signed URLs. We do NOT add an explicit ALTER TABLE here
-- because storage.objects is owned by supabase_storage_admin and the user-level
-- migration role lacks the privilege to alter it — running such a statement
-- would fail on any fresh Supabase project with `must be owner of table objects`.
