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

import { createAdminClient } from "@/lib/supabase/admin";
import { getNotificationPreferences } from "@/lib/notifications/notification-service";
import { getTwilioClient } from "@/lib/twilio/client";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";

type MessageType = "missed_call_textback" | "appointment_confirmation";

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
  // appointment_confirmation: max 1 per caller per org per 1h
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
    console.error("[CallerSMS] Failed to log SMS send — rate limiting may be affected:", {
      messageType: params.messageType, callerPhone: params.callerPhone, error,
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
interface AppointmentContext {
  appointmentId: string;
  appointmentStartTime: string | Date;
  channel: "sms" | "email";
}

async function checkOrgConfirmationEnabled(orgId: string): Promise<boolean> {
  // Org-level opt-out gate: organizations.send_customer_confirmations (default TRUE).
  // Returns true if enabled (default), false if the business disabled it.
  // Fail-open on DB error — missing column means pre-migration schema.
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("organizations")
    .select("send_customer_confirmations")
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    console.warn("[CallerSMS] Failed to read send_customer_confirmations, failing open:", {
      orgId,
      error: error.message,
    });
    return true;
  }
  return data?.send_customer_confirmations !== false;
}

async function upsertAppointmentConfirmation(params: {
  orgId: string;
  appointmentId: string;
  appointmentStartTime: string | Date;
  channel: "sms" | "email";
  recipient: string;
  status: "sent" | "failed" | "opted_out" | "skipped_cap" | "skipped_disabled";
  providerMessageId?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const startIso =
    params.appointmentStartTime instanceof Date
      ? params.appointmentStartTime.toISOString()
      : params.appointmentStartTime;
  const idempotencyKey = `${params.appointmentId}:${params.channel}:${startIso}`;
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
      error: error.message,
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

  // 0. Org-level opt-out (SCRUM-240 Phase 1) — only applies to appointment_confirmation,
  //    missed-call textback stays on its own feature toggle.
  if (messageType === "appointment_confirmation") {
    const orgEnabled = await checkOrgConfirmationEnabled(orgId);
    if (!orgEnabled) {
      if (appointment) {
        await upsertAppointmentConfirmation({
          orgId,
          appointmentId: appointment.appointmentId,
          appointmentStartTime: appointment.appointmentStartTime,
          channel: "sms",
          recipient: callerPhone,
          status: "skipped_disabled",
        });
      }
      return { sent: false, status: "skipped", reason: "org_disabled" };
    }
  }

  // 1. Check feature toggle
  const prefs = await getNotificationPreferences(orgId);
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

  // 4. Resolve org's phone number + provider
  const phoneInfo = await resolveOrgPhoneNumber(orgId);
  if (!phoneInfo) {
    return { sent: false, status: "failed", reason: "no_org_phone_number" };
  }
  const fromNumber = phoneInfo.phoneNumber;
  const smsProvider = phoneInfo.telephonyProvider;

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
  try {
    const sid = await sendSmsViaProvider(callerPhone, fromNumber, messageBody, smsProvider, {
      statusCallback,
    });
    await logSMSSend({
      orgId,
      callerPhone,
      fromNumber,
      messageType,
      messageBody,
      twilioMessageSid: sid,
      status: "sent",
    });
    if (appointment) {
      await upsertAppointmentConfirmation({
        orgId,
        appointmentId: appointment.appointmentId,
        appointmentStartTime: appointment.appointmentStartTime,
        channel: "sms",
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
      messageBody,
      status: "failed",
      errorMessage: err.message,
    });
    if (appointment) {
      await upsertAppointmentConfirmation({
        orgId,
        appointmentId: appointment.appointmentId,
        appointmentStartTime: appointment.appointmentStartTime,
        channel: "sms",
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
  confirmationCode?: string,
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

  const tz = timezone || org?.timezone || "America/New_York";
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
  if (confirmationCode) {
    message += ` Your confirmation code: ${confirmationCode}`;
  }
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
      ? { appointmentId, appointmentStartTime: startTime, channel: "sms" }
      : undefined,
  });
}

/**
 * SCRUM-240 Phase 1: send a cancellation SMS when an appointment is cancelled
 * via cancel_appointment tool. User decided we should send one.
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

  const tz = timezone || org?.timezone || "America/New_York";
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
    messageType: "appointment_confirmation", // reuse the same rate limit bucket
    messageBody: message,
    appointment: appointmentId
      ? { appointmentId, appointmentStartTime: startTime, channel: "sms" }
      : undefined,
  });
}
