-- Add practitioner_id to blocked_times for per-practitioner time-off/breaks
-- NULL = org-wide block (affects all practitioners), SET = practitioner-specific
ALTER TABLE blocked_times
  ADD COLUMN IF NOT EXISTS practitioner_id UUID REFERENCES practitioners(id) ON DELETE CASCADE;

-- Index for efficient per-practitioner queries
CREATE INDEX IF NOT EXISTS idx_blocked_times_practitioner
  ON blocked_times(practitioner_id)
  WHERE practitioner_id IS NOT NULL;
