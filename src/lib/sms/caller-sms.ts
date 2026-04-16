/**
 * Caller SMS Service
 *
 * Sends SMS messages TO CALLERS (not business owners):
 * - Missed-call text-back with booking link + callback number
 * - Appointment confirmation after AI books
 *
 * Guards: feature toggle, plan eligibility, opt-out check, rate limiting.
 * Spam protection applies to missed-call text-back only (caller provides isSpam).
 * Sends from the org's Twilio number (caller recognizes it).
 */

import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { getNotificationPreferences } from "@/lib/notifications/notification-service";
import { getTwilioClient } from "@/lib/twilio/client";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";

type MessageType =
  | "missed_call_textback"
  | "appointment_confirmation"
  | "appointment_cancellation";

type SMSStatus = "sent" | "skipped" | "blocked_plan" | "blocked_spam" | "blocked_optout" | "blocked_ratelimit" | "failed";

interface SMSSendResult {
  sent: boolean;
  status: SMSStatus;
  reason?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolveOrgPhoneNumber(
  orgId: string
): Promise<{ phoneNumber: string; telephonyProvider: string } | null> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("phone_numbers")
    .select("phone_number, telephony_provider")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) return null;
  return { phoneNumber: data.phone_number, telephonyProvider: data.telephony_provider || "twilio" };
}

// Backwards-compatible wrapper
async function resolveOrgTwilioNumber(orgId: string): Promise<string | null> {
  const result = await resolveOrgPhoneNumber(orgId);
  return result?.phoneNumber || null;
}

/**
 * Resolve the SMS sender for an org. Prefers the alphanumeric sender ID (SCRUM-260)
 * so customer-facing SMS show the business name instead of a phone number.
 * Falls back to the org's phone number when:
 *   - `sms_sender` is null (not configured), OR
 *   - The provider is Telnyx (Telnyx doesn't support alphanumeric senders the same way)
 */
async function resolveSmsSender(
  orgId: string
): Promise<{ sender: string; isAlphanumeric: boolean; telephonyProvider: string } | null> {
  const supabase = createAdminClient();
  const phoneInfo = await resolveOrgPhoneNumber(orgId);
  if (!phoneInfo) return null;

  const provider = phoneInfo.telephonyProvider;

  // Only Twilio supports alphanumeric senders in this codebase.
  // Telnyx requires a provisioned sender profile; until we wire that, use phone.
  if (provider !== "twilio") {
    return { sender: phoneInfo.phoneNumber, isAlphanumeric: false, telephonyProvider: provider };
  }

  const { data, error } = await (supabase as any)
    .from("organizations")
    .select("sms_sender")
    .eq("id", orgId)
    .maybeSingle();

  if (error) {
    // 42703 (column doesn't exist): expected pre-migration — silent fallback.
    // Any other error is unexpected (RLS, timeout, connection pool) — log to
    // Sentry so we catch regressions where branded senders silently degrade
    // to phone numbers.
    if (error.code === "42703") {
      return { sender: phoneInfo.phoneNumber, isAlphanumeric: false, telephonyProvider: provider };
    }
    console.error("[CallerSMS] Failed to read sms_sender (degraded to phone):", {
      orgId, code: error.code, message: error.message,
    });
    Sentry.withScope((scope) => {
      scope.setTag("service", "caller-sms");
      scope.setTag("reason", "sms_sender_read_failed");
      scope.setExtras({ orgId, code: error.code });
      Sentry.captureException(error);
    });
    return { sender: phoneInfo.phoneNumber, isAlphanumeric: false, telephonyProvider: provider };
  }

  const alphanumeric = data?.sms_sender;
  if (alphanumeric && /[A-Za-z]/.test(alphanumeric)) {
    return { sender: alphanumeric, isAlphanumeric: true, telephonyProvider: provider };
  }
  return { sender: phoneInfo.phoneNumber, isAlphanumeric: false, telephonyProvider: provider };
}

/**
 * SCRUM-260: Rewrite the opt-out instructions when the SMS sender is
 * alphanumeric (e.g. "SmileHub"). Recipients can't reply STOP to an
 * alphanumeric sender — the reply goes nowhere — so we replace the
 * "Reply STOP to opt-out." line with a working opt-out channel.
 *
 * Compliance note (Australian Spam Act 2003 / US TCPA): every commercial
 * SMS MUST carry a working unsubscribe facility. We NEVER drop the opt-out
 * line silently. Resolution order:
 *   1. Business phone configured → "Call {phone} to opt out"
 *   2. No business phone → fallback to Phondo's platform opt-out email
 *      (PHONDO_OPT_OUT_EMAIL, default support@phondo.ai) so there's ALWAYS
 *      a working channel.
 */
const OPT_OUT_MARKER_RE = /\n+Reply STOP to opt-?out\.?\s*$/i;
const DEFAULT_OPT_OUT_EMAIL = "support@phondo.ai";

async function rewriteOptOutForAlphanumeric(
  body: string,
  orgId: string
): Promise<string> {
  if (!OPT_OUT_MARKER_RE.test(body)) {
    // No opt-out marker present — the template must have been modified.
    // Surface this as a compliance alert so we can fix the template.
    console.error("[CallerSMS] Alphanumeric SMS body has no opt-out marker — compliance risk:", {
      orgId, bodyPreview: body.slice(0, 60),
    });
    Sentry.withScope((scope) => {
      scope.setTag("service", "caller-sms");
      scope.setTag("reason", "sms_opt_out_marker_missing");
      scope.setExtras({ orgId, bodyPreview: body.slice(0, 60) });
      Sentry.captureMessage("SMS body missing opt-out marker — compliance alert", "error");
    });
    return body;
  }

  const supabase = createAdminClient();
  const { data: org, error } = await (supabase as any)
    .from("organizations")
    .select("business_phone")
    .eq("id", orgId)
    .maybeSingle();

  if (error) {
    console.error("[CallerSMS] Failed to read business_phone for opt-out rewrite:", {
      orgId, code: error.code, message: error.message,
    });
    Sentry.withScope((scope) => {
      scope.setTag("service", "caller-sms");
      scope.setTag("reason", "opt_out_phone_read_failed");
      scope.setExtras({ orgId, code: error.code });
      Sentry.captureException(error);
    });
    // Fall through — use platform email fallback so we still send a
    // compliant opt-out instruction rather than silently dropping it.
  }

  const phone = org?.business_phone;
  const email = process.env.PHONDO_OPT_OUT_EMAIL || DEFAULT_OPT_OUT_EMAIL;
  const replacement = phone
    ? `\n\nTo opt out of these messages, please call ${phone}.`
    : `\n\nTo opt out of these messages, email ${email}.`;
  return body.replace(OPT_OUT_MARKER_RE, replacement);
}

async function isCallerOptedOut(
  phone: string,
  orgId: string
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("caller_sms_optouts")
    .select("id")
    .eq("phone_number", phone)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error) {
    console.error("[CallerSMS] Opt-out check failed — blocking send to be safe:", { phone, orgId, error });
    Sentry.withScope((scope) => {
      scope.setTag("service", "caller-sms");
      scope.setTag("reason", "optout_check_failed");
      scope.setExtras({ orgId, code: error.code });
      Sentry.captureException(error);
    });
    return true; // Fail closed: treat as opted out
  }
  return !!data;
}

async function isRateLimited(
  phone: string,
  messageType: MessageType,
  orgId: string
): Promise<boolean> {
  const supabase = createAdminClient();

  // missed_call_textback: max 1 per caller per org per 24h
  // appointment_confirmation / appointment_cancellation: max 1 per type per caller per org per 1h
  const windowHours = messageType === "missed_call_textback" ? 24 : 1;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const { count, error } = await (supabase as any)
    .from("caller_sms_log")
    .select("id", { count: "exact", head: true })
    .eq("caller_phone", phone)
    .eq("message_type", messageType)
    .eq("organization_id", orgId)
    .eq("status", "sent")
    .gte("created_at", since);

  if (error) {
    console.error("[CallerSMS] Rate limit check failed — blocking send to be safe:", { phone, messageType, orgId, error });
    Sentry.withScope((scope) => {
      scope.setTag("service", "caller-sms");
      scope.setTag("reason", "rate_limit_check_failed");
      scope.setExtras({ orgId, messageType, code: error.code });
      Sentry.captureException(error);
    });
    return true; // Fail closed: treat as rate limited
  }
  return (count ?? 0) > 0;
}

async function logSMSSend(params: {
  orgId: string;
  callerPhone: string;
  fromNumber: string;
  messageType: MessageType;
  messageBody: string;
  twilioMessageSid?: string;
  status: SMSStatus;
  errorMessage?: string;
}): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await (supabase as any).from("caller_sms_log").insert({
    organization_id: params.orgId,
    caller_phone: params.callerPhone,
    from_number: params.fromNumber,
    message_type: params.messageType,
    message_body: params.messageBody,
    twilio_message_sid: params.twilioMessageSid || null,
    status: params.status,
    error_message: params.errorMessage || null,
  });
  if (error) {
    // Failure here breaks rate limiting (the rate limit query counts these
    // log rows), so it's important to surface — Sentry, not just console.
    console.error("[CallerSMS] Failed to log SMS send — rate limiting may be affected:", {
      messageType: params.messageType, callerPhone: params.callerPhone, error,
    });
    Sentry.withScope((scope) => {
      scope.setTag("service", "caller-sms");
      scope.setTag("reason", "sms_log_insert_failed");
      scope.setExtras({
        orgId: params.orgId,
        messageType: params.messageType,
        status: params.status,
        code: error.code,
      });
      Sentry.captureException(error);
    });
  }
}

async function sendViaTwilio(
  to: string,
  from: string,
  body: string,
  opts?: { statusCallback?: string }
): Promise<string> {
  const client = getTwilioClient();
  const message = await client.messages.create({
    body,
    to,
    from,
    ...(opts?.statusCallback ? { statusCallback: opts.statusCallback } : {}),
  });
  return message.sid;
}

async function sendViaTelnyx(
  to: string,
  from: string,
  body: string
): Promise<string> {
  // Telnyx status callbacks use a different mechanism (webhook profile
  // configured at account level, not per-message). Phase 1 Twilio-only.
  const { sendSms } = await import("@/lib/telnyx/client");
  const result = await sendSms(from, to, body);
  return result.messageId;
}

async function sendSmsViaProvider(
  to: string,
  from: string,
  body: string,
  provider: string,
  opts?: { statusCallback?: string }
): Promise<string> {
  if (provider === "telnyx") {
    return sendViaTelnyx(to, from, body);
  }
  return sendViaTwilio(to, from, body, opts);
}

// ─── Main send function ─────────────────────────────────────────────────────

// SCRUM-240 Phase 1: optional appointment tracking for confirmation/cancellation SMS.
// When these are provided, a row is written to `appointment_confirmations` so
// the Twilio status webhook can update delivery state.
//
// `intent` separates confirmation vs cancellation rows for the same appointment
// so they don't collide on idempotency_key. Each intent gets its own row.
interface AppointmentContext {
  appointmentId: string;
  appointmentStartTime: string | Date;
  channel: "sms" | "email";
  intent: "confirmation" | "cancellation";
}

// 3-state result: lets the caller distinguish "user disabled it" from "we
// couldn't read the toggle". The unknown branch writes a `skipped_db_error`
// row to appointment_confirmations so the failure is observable in the dashboard.
type OrgConfirmationCheck = "enabled" | "disabled" | "unknown";

async function checkOrgConfirmationEnabled(orgId: string): Promise<OrgConfirmationCheck> {
  // Org-level opt-out gate: organizations.send_customer_confirmations (default TRUE).
  //
  // Failure modes:
  //  - 42703 (column missing) → pre-migration schema, fail OPEN (default behavior is on)
  //  - any other error        → retry once with 100ms backoff. If still failing,
  //                             return "unknown" so the caller can write a
  //                             skipped_db_error row instead of dropping the
  //                             SMS silently. SCRUM-251 P0-3.
  const supabase = createAdminClient();

  // Retry helper — a single transient ECONNRESET / DNS hiccup shouldn't
  // kill confirmations for an entire booking session.
  async function readOnce(): Promise<{ data: any; error: any }> {
    return await (supabase as any)
      .from("organizations")
      .select("send_customer_confirmations")
      .eq("id", orgId)
      .maybeSingle();
  }

  let { data, error } = await readOnce();
  if (error && error.code !== "42703") {
    // First retry — short backoff. Don't retry on 42703 since that's deterministic.
    await new Promise((r) => setTimeout(r, 100));
    ({ data, error } = await readOnce());
  }

  if (error) {
    if (error.code === "42703") {
      console.warn("[CallerSMS] send_customer_confirmations column missing — defaulting to enabled (pre-migration)");
      return "enabled";
    }
    console.error("[CallerSMS] Failed to read send_customer_confirmations after retry — returning UNKNOWN:", {
      orgId,
      code: error.code,
      message: error.message,
    });
    Sentry.withScope((scope) => {
      scope.setTag("service", "caller-sms");
      scope.setTag("reason", "org_toggle_read_failed");
      scope.setLevel("error");
      scope.setExtras({ orgId, code: error.code });
      Sentry.captureException(error);
    });
    return "unknown";
  }
  return data?.send_customer_confirmations !== false ? "enabled" : "disabled";
}

async function upsertAppointmentConfirmation(params: {
  orgId: string;
  appointmentId: string;
  appointmentStartTime: string | Date;
  channel: "sms" | "email";
  intent: "confirmation" | "cancellation";
  recipient: string;
  status:
    | "sent"
    | "failed"
    | "opted_out"
    | "skipped_cap"
    | "skipped_disabled"
    | "skipped_db_error";
  providerMessageId?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const startIso =
    params.appointmentStartTime instanceof Date
      ? params.appointmentStartTime.toISOString()
      : params.appointmentStartTime;
  // SCRUM-247: include `intent` so confirmation and cancellation rows for the
  // same appointment get separate rows (otherwise a cancellation upsert would
  // overwrite the confirmation row's provider_message_id, breaking delivery
  // tracking for the original confirmation).
  const idempotencyKey = `${params.appointmentId}:${params.channel}:${params.intent}:${startIso}`;
  const now = new Date().toISOString();

  const supabase = createAdminClient();
  const row: Record<string, any> = {
    appointment_id: params.appointmentId,
    organization_id: params.orgId,
    channel: params.channel,
    recipient: params.recipient,
    status: params.status,
    idempotency_key: idempotencyKey,
    last_attempt_at: now,
    attempts: 1,
  };
  if (params.providerMessageId) row.provider_message_id = params.providerMessageId;
  if (params.errorMessage) row.last_error = params.errorMessage;
  if (params.status === "sent") row.sent_at = now;

  const { error } = await (supabase as any)
    .from("appointment_confirmations")
    .upsert(row, { onConflict: "idempotency_key" });

  if (error) {
    console.error("[CallerSMS] Failed to upsert appointment_confirmations:", {
      appointmentId: params.appointmentId,
      intent: params.intent,
      status: params.status,
      error: error.message,
    });
    Sentry.withScope((scope) => {
      scope.setTag("service", "caller-sms");
      scope.setTag("reason", "confirmation_upsert_failed");
      scope.setExtras({
        appointmentId: params.appointmentId,
        intent: params.intent,
        status: params.status,
        idempotencyKey,
      });
      Sentry.captureException(error);
    });
    // Non-fatal — SMS was (maybe) sent even if we can't track it
  }
}

async function sendCallerSMS(params: {
  orgId: string;
  callerPhone: string;
  messageType: MessageType;
  messageBody: string;
  isSpam?: boolean;
  appointment?: AppointmentContext;
}): Promise<SMSSendResult> {
  const { orgId, callerPhone, messageType, messageBody, isSpam, appointment } = params;

  // 0. Org-level opt-out (SCRUM-240 Phase 1) — applies to both confirmation and
  //    cancellation messages. If the business turned off customer SMS we honor it.
  //    Missed-call textback stays on its own feature toggle.
  const isAppointmentMessage =
    messageType === "appointment_confirmation" || messageType === "appointment_cancellation";
  if (isAppointmentMessage) {
    const orgCheck = await checkOrgConfirmationEnabled(orgId);
    if (orgCheck === "disabled") {
      if (appointment) {
        await upsertAppointmentConfirmation({
          orgId,
          appointmentId: appointment.appointmentId,
          appointmentStartTime: appointment.appointmentStartTime,
          channel: "sms",
          intent: appointment.intent,
          recipient: callerPhone,
          status: "skipped_disabled",
        });
      }
      return { sent: false, status: "skipped", reason: "org_disabled" };
    }
    if (orgCheck === "unknown") {
      // SCRUM-251 P0-3: fail closed but with an observable trace. The dashboard
      // can surface skipped_db_error rows so ops know "we couldn't read the
      // toggle for this org during this window" — instead of zero trace.
      if (appointment) {
        await upsertAppointmentConfirmation({
          orgId,
          appointmentId: appointment.appointmentId,
          appointmentStartTime: appointment.appointmentStartTime,
          channel: "sms",
          intent: appointment.intent,
          recipient: callerPhone,
          status: "skipped_db_error",
          errorMessage: "checkOrgConfirmationEnabled returned unknown after retry",
        });
      }
      return { sent: false, status: "skipped", reason: "db_error" };
    }
  }

  // 1. Check feature toggle (per-user notification_preferences toggle)
  const prefs = await getNotificationPreferences(orgId);
  // Both confirmation and cancellation share the same per-user toggle —
  // turning off "appointment confirmations" turns off both.
  const toggleKey =
    messageType === "missed_call_textback"
      ? "sms_textback_on_missed_call"
      : "sms_appointment_confirmation";

  if (!prefs || !prefs[toggleKey]) {
    if (appointment) {
      await upsertAppointmentConfirmation({
        orgId,
        appointmentId: appointment.appointmentId,
        appointmentStartTime: appointment.appointmentStartTime,
        channel: "sms",
        intent: appointment.intent,
        recipient: callerPhone,
        status: "skipped_disabled",
      });
    }
    return { sent: false, status: "skipped", reason: "feature_disabled" };
  }

  // 2. Plan eligibility check
  if (!(await hasFeatureAccess(orgId, "smsNotifications"))) {
    return { sent: false, status: "blocked_plan", reason: "plan_not_eligible" };
  }

  // 3. Spam protection
  if (isSpam) {
    return { sent: false, status: "blocked_spam", reason: "caller_is_spam" };
  }

  // 4. Resolve SMS sender — prefers alphanumeric sender ID (business name)
  //    so voice-only AU numbers can still send SMS. Falls back to the org's
  //    phone number when no sms_sender is configured, or for Telnyx.
  const senderInfo = await resolveSmsSender(orgId);
  if (!senderInfo) {
    return { sent: false, status: "failed", reason: "no_org_phone_number" };
  }
  const fromNumber = senderInfo.sender;
  const smsProvider = senderInfo.telephonyProvider;

  // 5. Opt-out check
  if (await isCallerOptedOut(callerPhone, orgId)) {
    await logSMSSend({
      orgId,
      callerPhone,
      fromNumber,
      messageType,
      messageBody,
      status: "blocked_optout",
    });
    if (appointment) {
      await upsertAppointmentConfirmation({
        orgId,
        appointmentId: appointment.appointmentId,
        appointmentStartTime: appointment.appointmentStartTime,
        channel: "sms",
        intent: appointment.intent,
        recipient: callerPhone,
        status: "opted_out",
      });
    }
    return { sent: false, status: "blocked_optout", reason: "caller_opted_out" };
  }

  // 6. Rate limit check
  if (await isRateLimited(callerPhone, messageType, orgId)) {
    await logSMSSend({
      orgId,
      callerPhone,
      fromNumber,
      messageType,
      messageBody,
      status: "blocked_ratelimit",
    });
    if (appointment) {
      await upsertAppointmentConfirmation({
        orgId,
        appointmentId: appointment.appointmentId,
        appointmentStartTime: appointment.appointmentStartTime,
        channel: "sms",
        intent: appointment.intent,
        recipient: callerPhone,
        status: "skipped_cap",
      });
    }
    return { sent: false, status: "blocked_ratelimit", reason: "rate_limited" };
  }

  // 7. Send via provider (Twilio or Telnyx)
  // SCRUM-240: pass statusCallback so Twilio POSTs back delivery updates
  // to /api/webhooks/twilio-sms-status which updates appointment_confirmations.
  const statusCallback = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio-sms-status`
    : undefined;

  // SCRUM-260: alphanumeric senders are one-way — recipients can't reply STOP.
  // Replace the standard opt-out line with a phone-based instruction so the
  // message remains compliant (Spam Act 2003 / TCPA require a working opt-out).
  const finalMessageBody = senderInfo.isAlphanumeric
    ? await rewriteOptOutForAlphanumeric(messageBody, orgId)
    : messageBody;

  try {
    const sid = await sendSmsViaProvider(callerPhone, fromNumber, finalMessageBody, smsProvider, {
      statusCallback,
    });
    await logSMSSend({
      orgId,
      callerPhone,
      fromNumber,
      messageType,
      messageBody: finalMessageBody,
      twilioMessageSid: sid,
      status: "sent",
    });
    if (appointment) {
      await upsertAppointmentConfirmation({
        orgId,
        appointmentId: appointment.appointmentId,
        appointmentStartTime: appointment.appointmentStartTime,
        channel: "sms",
        intent: appointment.intent,
        recipient: callerPhone,
        status: "sent",
        providerMessageId: sid,
      });
    }
    console.log(`[CallerSMS] Sent ${messageType} to ${callerPhone} from ${fromNumber}`);
    return { sent: true, status: "sent" };
  } catch (err: any) {
    await logSMSSend({
      orgId,
      callerPhone,
      fromNumber,
      messageType,
      messageBody: finalMessageBody,
      status: "failed",
      errorMessage: err.message,
    });
    if (appointment) {
      await upsertAppointmentConfirmation({
        orgId,
        appointmentId: appointment.appointmentId,
        appointmentStartTime: appointment.appointmentStartTime,
        channel: "sms",
        intent: appointment.intent,
        recipient: callerPhone,
        status: "failed",
        errorMessage: err.message,
      });
    }
    throw err;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function sendMissedCallTextBack(
  orgId: string,
  callerPhone: string,
  isSpam?: boolean
): Promise<SMSSendResult> {
  const supabase = createAdminClient();

  // Fetch org data for message template
  const { data: org } = await (supabase as any)
    .from("organizations")
    .select("business_name, business_phone")
    .eq("id", orgId)
    .single();

  const businessName = org?.business_name || "our office";
  const businessPhone = org?.business_phone || "";

  // Fetch booking URL if calendar is set up
  const { data: calIntegration } = await (supabase as any)
    .from("calendar_integrations")
    .select("booking_url")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .maybeSingle();

  const bookingUrl = calIntegration?.booking_url;

  // Build message
  let message = `Hi, thanks for calling ${businessName}! We're sorry we missed your call.`;
  if (bookingUrl) {
    message += ` Book an appointment at ${bookingUrl}`;
    if (businessPhone) message += ` or call us back at ${businessPhone}.`;
    else message += ".";
  } else if (businessPhone) {
    message += ` Call us back at ${businessPhone}.`;
  }
  message += "\n\nReply STOP to opt-out.";

  return sendCallerSMS({
    orgId,
    callerPhone,
    messageType: "missed_call_textback",
    messageBody: message,
    isSpam,
  });
}

export async function sendAppointmentConfirmationSMS(
  orgId: string,
  callerPhone: string,
  startTime: Date,
  timezone?: string,
  // SCRUM-259: confirmationCode parameter removed — codes are no longer
  // included in customer-facing SMS to avoid confusion with business's
  // own confirmation systems.
  _confirmationCode?: string,
  // SCRUM-240 Phase 1: optional appointment tracking.
  // When provided, a row is written to appointment_confirmations so the
  // Twilio status webhook can update delivery state.
  appointmentId?: string
): Promise<SMSSendResult> {
  const supabase = createAdminClient();

  const { data: org } = await (supabase as any)
    .from("organizations")
    .select("business_name, business_phone, timezone")
    .eq("id", orgId)
    .single();

  const businessName = org?.business_name || "our office";
  const businessPhone = org?.business_phone || "";

  const tz = timezone || org?.timezone || "Australia/Sydney";
  const dateStr = startTime.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
  const timeStr = startTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });

  let message = `Your appointment at ${businessName} is confirmed for ${dateStr} at ${timeStr}.`;
  if (businessPhone) {
    message += ` To reschedule, call ${businessPhone}.`;
  }
  message += "\n\nReply STOP to opt-out.";

  return sendCallerSMS({
    orgId,
    callerPhone,
    messageType: "appointment_confirmation",
    messageBody: message,
    appointment: appointmentId
      ? {
          appointmentId,
          appointmentStartTime: startTime,
          channel: "sms",
          intent: "confirmation",
        }
      : undefined,
  });
}

/**
 * SCRUM-240 Phase 1: send a cancellation SMS when an appointment is cancelled
 * via cancel_appointment tool. User decided we should send one.
 *
 * SCRUM-247: uses its own `appointment_cancellation` message type so the rate
 * limit bucket is independent from the booking confirmation. Without this,
 * a caller who books and immediately cancels gets blocked from the cancellation
 * SMS for an hour because the confirmation already filled the bucket.
 */
export async function sendCancellationSMS(
  orgId: string,
  callerPhone: string,
  startTime: Date,
  timezone?: string,
  appointmentId?: string
): Promise<SMSSendResult> {
  const supabase = createAdminClient();

  const { data: org } = await (supabase as any)
    .from("organizations")
    .select("business_name, business_phone, timezone")
    .eq("id", orgId)
    .single();

  const businessName = org?.business_name || "our office";
  const businessPhone = org?.business_phone || "";

  const tz = timezone || org?.timezone || "Australia/Sydney";
  const dateStr = startTime.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
  const timeStr = startTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });

  let message = `Your appointment at ${businessName} on ${dateStr} at ${timeStr} has been cancelled.`;
  if (businessPhone) {
    message += ` If this was a mistake, please call ${businessPhone}.`;
  }
  message += "\n\nReply STOP to opt-out.";

  return sendCallerSMS({
    orgId,
    callerPhone,
    messageType: "appointment_cancellation",
    messageBody: message,
    appointment: appointmentId
      ? {
          appointmentId,
          appointmentStartTime: startTime,
          channel: "sms",
          intent: "cancellation",
        }
      : undefined,
  });
}
