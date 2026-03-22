-- Fix: The org-level overlap constraint blocks concurrent bookings for
-- different practitioners at the same time.  When practitioner_id is set,
-- the per-practitioner constraint (no_overlapping_practitioner_appointments)
-- already prevents double-booking.  The org-level constraint should only
-- apply to generic (non-practitioner) bookings.

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS no_overlapping_appointments;

-- Re-create scoped to practitioner_id IS NULL only
ALTER TABLE appointments
  ADD CONSTRAINT no_overlapping_appointments
  EXCLUDE USING gist (
    organization_id WITH =,
    tstzrange(start_time, end_time) WITH &&
  )
  WHERE (status IN ('confirmed', 'pending') AND practitioner_id IS NULL);
