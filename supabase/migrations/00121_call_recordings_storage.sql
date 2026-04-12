-- 00121_call_recordings_storage.sql
-- Supabase Storage bucket for call recordings + new columns on calls (SCRUM-207).

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

-- No RLS policies are added for call-recordings: storage.objects has RLS enabled and
-- default-denies, so absent any allow policy for this bucket, only the service role
-- can read/write. Dashboard reads go through a Next.js route that uses the service
-- role to issue short-lived signed URLs.
