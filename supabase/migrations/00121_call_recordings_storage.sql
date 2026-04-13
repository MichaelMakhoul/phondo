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

-- Defense-in-depth: ensure RLS is enabled on storage.objects. Supabase enables
-- this by default but we assert it here so a future config drift can't silently
-- expose the bucket. With RLS on and no allow policies for this bucket, only
-- service-role keys can read/write. Dashboard reads go through a Next.js route
-- that uses the service role to issue short-lived signed URLs.
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
