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

-- Block all anon/authenticated access to call-recordings bucket; service role bypasses RLS by design.
-- Dashboard reads flow through a Next.js route that uses the service role to generate signed URLs.
CREATE POLICY "call-recordings deny all"
  ON storage.objects
  FOR ALL
  TO authenticated, anon
  USING (bucket_id <> 'call-recordings')
  WITH CHECK (bucket_id <> 'call-recordings');
