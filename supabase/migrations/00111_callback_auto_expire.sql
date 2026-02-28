-- Add columns for callback auto-expiry and reminder tracking
ALTER TABLE callback_requests
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- Partial index for cron efficiency: quickly find pending callbacks older than threshold
CREATE INDEX IF NOT EXISTS idx_callback_requests_pending_created
  ON callback_requests (status, created_at)
  WHERE status = 'pending';
