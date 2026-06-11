-- SCRUM-417 (audit finding #50): the org-level overlap exclusion constraint
-- compares raw tstzrange(start_time, end_time). When end_time IS NULL, Postgres
-- builds an unbounded range [start_time, ) that overlaps EVERY later booking in
-- the org, so a single open-ended appointment blocks all subsequent generic
-- (practitioner_id IS NULL) bookings.
--
-- Fix: bound the range with appointment_end(start_time, end_time, duration_minutes)
-- — the same IMMUTABLE helper the per-practitioner constraint already uses
-- (COALESCE(end_time, start_time + duration_minutes * interval '1 minute')).
-- This makes both overlap constraints consistent.
--
-- Safe to recreate: the new range is strictly narrower than the old unbounded
-- one, so any data that satisfied the old constraint also satisfies this one.

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS no_overlapping_appointments;

ALTER TABLE appointments
  ADD CONSTRAINT no_overlapping_appointments
  EXCLUDE USING gist (
    organization_id WITH =,
    tstzrange(start_time, appointment_end(start_time, end_time, duration_minutes)) WITH &&
  )
  WHERE (status IN ('confirmed', 'pending') AND practitioner_id IS NULL);
