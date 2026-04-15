-- SCRUM-240 Phase 1: track outbound confirmation message delivery
--
-- Problem this solves: the existing sendAppointmentConfirmationSMS is fire-and-
-- forget with no delivery tracking. After SCRUM-227 proved Sophie can still
-- hallucinate booking details despite 3 layers of defense, we need an
-- out-of-band confirmation channel the customer can cross-check against.
-- This table tracks every outbound confirmation / cancellation message the
-- system attempts to send, with full delivery status from the provider webhook.
--
-- Part 1 covers SMS only. Email (Phase 2), multi-language (Phase 3),
-- reminders (Phase 4), and polish (Phase 5) will extend the same table.

CREATE TABLE appointment_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- 'sms' for Phase 1; 'email' comes in Phase 2
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),

  -- Phone number or email address the message was sent to
  recipient text NOT NULL,

  -- Lifecycle: pending → sent → delivered (happy path)
  --           pending → sent → undelivered (carrier rejected / wrong number)
  --           pending → failed (couldn't send at all — Twilio API error)
  --           pending → opted_out (caller on opt-out list)
  --           pending → skipped_cap (rate-limited)
  --           pending → skipped_no_contact (no phone/email captured)
  --           pending → skipped_disabled (org disabled confirmations)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'sent', 'delivered', 'failed', 'undelivered',
      'opted_out', 'skipped_cap', 'skipped_no_contact', 'skipped_disabled'
    )),

  -- For retry accounting. Hard cap at 2 attempts (initial + 1 retry) in Phase 1.
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text,

  -- Twilio SID (SM...) or Resend ID. NULL until first send attempt succeeds.
  provider_message_id text,

  template_language text DEFAULT 'en',

  -- Prevents duplicate sends if the tool handler retries or if a reschedule
  -- + rebook fires twice. Key shape: `${appointment_id}:${channel}:${start_time}`.
  -- Uniqueness enforced so upserts are safe.
  idempotency_key text UNIQUE NOT NULL,

  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dashboard lookups: "show all confirmations for this appointment"
CREATE INDEX idx_appointment_confirmations_appointment
  ON appointment_confirmations (appointment_id);

-- Dashboard lookups: "recent confirmations for this org"
CREATE INDEX idx_appointment_confirmations_org_created
  ON appointment_confirmations (organization_id, created_at DESC);

-- Retry worker / alert queries: "find rows that need attention"
CREATE INDEX idx_appointment_confirmations_needs_attention
  ON appointment_confirmations (status, created_at)
  WHERE status IN ('pending', 'failed', 'undelivered');

-- Webhook lookup: Twilio status callback finds the row by provider SID.
-- Partial index — only populated for rows that have been sent.
CREATE INDEX idx_appointment_confirmations_provider_message_id
  ON appointment_confirmations (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Auto-bump updated_at using the existing helper function.
CREATE TRIGGER update_appointment_confirmations_updated_at
  BEFORE UPDATE ON appointment_confirmations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS: org members can read their own confirmations (for dashboard display).
-- Writes are service_role only (voice-server + webhook handler).
ALTER TABLE appointment_confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read own confirmations"
  ON appointment_confirmations FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies by design → service_role only.

-- ─── appointments: flag no-contact bookings ────────────────────────────────
-- When the caller refused to provide a phone and email, the booking still
-- gets created but we can't reach out post-call. Flag it so the dashboard
-- shows a warning and the owner can manually follow up.
ALTER TABLE appointments
  ADD COLUMN contact_missing boolean NOT NULL DEFAULT false,
  ADD COLUMN contact_missing_reason text;

COMMENT ON COLUMN appointments.contact_missing IS
  'SCRUM-240 Phase 1: true when neither phone nor email was collected — no confirmation was sent; owner should follow up manually';
COMMENT ON COLUMN appointments.contact_missing_reason IS
  'Why contact is missing: caller_refused | not_captured | invalid_phone';

-- ─── organizations: per-org confirmation toggle ────────────────────────────
-- Default ON. Businesses that explicitly don't want automated customer
-- confirmations (e.g., they have their own confirmation system) can toggle off.
ALTER TABLE organizations
  ADD COLUMN send_customer_confirmations boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN organizations.send_customer_confirmations IS
  'SCRUM-240 Phase 1: when false, no confirmation/cancellation SMS/email is sent to customers after bookings';
