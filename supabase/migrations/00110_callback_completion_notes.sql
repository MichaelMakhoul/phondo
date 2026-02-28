-- Add completion_notes column to callback_requests
-- Stores optional notes added by staff when completing a callback

ALTER TABLE callback_requests
  ADD COLUMN IF NOT EXISTS completion_notes TEXT;
