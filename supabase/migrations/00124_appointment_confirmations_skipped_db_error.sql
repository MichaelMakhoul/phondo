-- SCRUM-250 follow-up: distinguish "org toggle DB read failed" from
-- "org explicitly disabled" in appointment_confirmations.status.
--
-- When the dashboard or voice-server tries to send a confirmation but
-- checkOrgConfirmationEnabled() can't read the toggle (transient Postgres
-- error, etc.), we now fail closed AND write a `skipped_db_error` row so
-- the failure is observable in the table — instead of leaving zero trace
-- the way the original Phase 1 code did.

ALTER TABLE appointment_confirmations DROP CONSTRAINT IF EXISTS appointment_confirmations_status_check;
ALTER TABLE appointment_confirmations ADD CONSTRAINT appointment_confirmations_status_check
  CHECK (status IN (
    'pending', 'sent', 'delivered', 'failed', 'undelivered',
    'opted_out', 'skipped_cap', 'skipped_no_contact', 'skipped_disabled',
    'skipped_db_error'
  ));
