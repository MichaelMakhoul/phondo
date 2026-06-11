/**
 * Notification Service
 *
 * Handles sending email and SMS notifications for various events:
 * - Missed calls
 * - Failed calls
 * - Voicemails
 * - Appointment bookings
 * - Daily summaries
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { ssrfSafeFetch, escapeHtml } from "@/lib/security/validation";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import * as Sentry from "@sentry/nextjs";
import { Resend } from "resend";
import Twilio from "twilio";

let resendClient: Resend | null = null;
let twilioClient: ReturnType<typeof Twilio> | null = null;

export interface NotificationPreferences {
  email_on_missed_call: boolean;
  email_on_voicemail: boolean;
  email_on_appointment_booked: boolean;
  email_on_failed_call: boolean;
  email_on_unsuccessful_call: boolean;
  email_on_callback_scheduled: boolean;
  email_daily_summary: boolean;
  sms_on_missed_call: boolean;
  sms_on_voicemail: boolean;
  sms_on_failed_call: boolean;
  sms_on_callback_scheduled: boolean;
  sms_phone_number: string | null;
  webhook_url: string | null;
  sms_textback_on_missed_call: boolean;
  sms_appointment_confirmation: boolean;
}

export interface CallNotificationData {
  organizationId: string;
  callId: string;
  callerPhone: string;
  callerName?: string;
  duration?: number;
  summary?: string;
  transcript?: string;
  outcome?: string;
  recordingUrl?: string;
  timestamp: Date;
}

export interface VoicemailNotificationData extends CallNotificationData {
  voicemailUrl: string;
  voicemailTranscript?: string;
}

export interface FailedCallNotificationData extends CallNotificationData {
  failureReason: string;
  endedReason?: string;
}

export interface UnsuccessfulCallNotificationData extends CallNotificationData {
  // Post-call analyzer rating: "unsuccessful" | "partial". Drives the
  // copy ("the AI couldn't fully help" vs "partially helped").
  successEvaluation?: string;
}

export interface AppointmentNotificationData {
  organizationId: string;
  callerPhone: string;
  callerName?: string;
  appointmentDate: Date;
  appointmentTime: string;
  serviceName?: string;
  confirmationCode?: string;
  // IANA timezone of the org (e.g. "Australia/Sydney"). Without it the date
  // renders in the server's UTC zone, which shifts a 9:30am Sydney booking
  // back to the previous day. SCRUM date-bug fix.
  timezone?: string;
}

export interface CallbackNotificationData {
  organizationId: string;
  callerName: string;
  callerPhone: string;
  reason: string;
  preferredTime?: string;
  urgency: string;
}

export interface DailySummaryData {
  organizationId: string;
  date: Date;
  totalCalls: number;
  answeredCalls: number;
  missedCalls: number;
  appointmentsBooked: number;
  averageCallDuration: number;
  topCallerIntents: string[];
}

/**
 * Conservative fallback used when the preferences row cannot be READ (real DB
 * error, not "no row"): email alerts on (the default channel — losing it
 * silently is audit finding #21), SMS/webhook off (we don't know the number /
 * URL, so there is nothing to send to anyway).
 */
function defaultNotificationPreferences(): NotificationPreferences {
  return {
    email_on_missed_call: true,
    email_on_voicemail: true,
    email_on_appointment_booked: true,
    email_on_failed_call: true,
    email_on_unsuccessful_call: true,
    email_on_callback_scheduled: true,
    email_daily_summary: true,
    sms_on_missed_call: false,
    sms_on_voicemail: false,
    sms_on_failed_call: false,
    sms_on_callback_scheduled: false,
    sms_phone_number: null,
    webhook_url: null,
    sms_textback_on_missed_call: false,
    sms_appointment_confirmation: false,
  };
}

/**
 * Get notification preferences for an organization.
 *
 * Returns null ONLY when the org genuinely has no preferences row (PGRST116).
 * A real DB error fails OPEN to the email-on defaults — previously it also
 * returned null, which `if (!prefs) return;` callers (appointment-booked,
 * daily-summary) treated as "nothing wanted", silently skipping the org's
 * only notification channel on a transient DB blip (SCRUM-419 / finding #21).
 */
export async function getNotificationPreferences(
  organizationId: string
): Promise<NotificationPreferences | null> {
  const supabase = createAdminClient();

  const { data, error } = await (supabase as any)
    .from("notification_preferences")
    .select("*")
    .eq("organization_id", organizationId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("[Notifications] Failed to load preferences — failing open to email-on defaults:", {
      organizationId,
      error: error.message || error.code,
    });
    return defaultNotificationPreferences();
  }

  if (error || !data) {
    return null; // no preferences row — callers decide their own defaults
  }

  return {
    email_on_missed_call: data.email_on_missed_call ?? true,
    email_on_voicemail: data.email_on_voicemail ?? true,
    email_on_appointment_booked: data.email_on_appointment_booked ?? true,
    email_on_failed_call: data.email_on_failed_call ?? true,
    email_on_unsuccessful_call: data.email_on_unsuccessful_call ?? true,
    email_on_callback_scheduled: data.email_on_callback_scheduled ?? true,
    email_daily_summary: data.email_daily_summary ?? true,
    sms_on_missed_call: data.sms_on_missed_call ?? false,
    sms_on_voicemail: data.sms_on_voicemail ?? false,
    sms_on_failed_call: data.sms_on_failed_call ?? false,
    sms_on_callback_scheduled: data.sms_on_callback_scheduled ?? false,
    sms_phone_number: data.sms_phone_number,
    webhook_url: data.webhook_url,
    sms_textback_on_missed_call: data.sms_textback_on_missed_call ?? false,
    sms_appointment_confirmation: data.sms_appointment_confirmation ?? false,
  };
}

/**
 * Strip plan-gated channels from prefs at SEND time (SCRUM-423, finding #13).
 *
 * Owner-alert SMS toggles require the smsNotifications plan flag and the
 * legacy prefs webhook_url requires webhookIntegrations. The PUT route gates
 * these at write time, but rows written BEFORE that gate (or while the org
 * was on a higher plan) would otherwise keep Professional features after a
 * downgrade — send time is the enforcement point that can't be bypassed.
 *
 * hasFeatureAccess fails OPEN on DB errors (its existing contract), so a
 * billing-lookup blip never drops a notification. Caller-facing SMS
 * (textback/confirmation) is gated separately in caller-sms.ts; integration
 * webhooks in webhook-delivery.ts.
 */
async function applyPlanGates(
  organizationId: string,
  prefs: NotificationPreferences | null,
  options: { smsCapable?: boolean } = {}
): Promise<NotificationPreferences | null> {
  if (!prefs) return prefs;

  // Senders without an SMS channel (unsuccessful-call, appointment, daily
  // summary) skip the SMS entitlement lookup — no wasted billing query and
  // no misleading "SMS channel skipped" log on paths that never send SMS.
  const { smsCapable = true } = options;

  let gated = prefs;

  const wantsOwnerSms =
    prefs.sms_on_missed_call ||
    prefs.sms_on_voicemail ||
    prefs.sms_on_failed_call ||
    prefs.sms_on_callback_scheduled;
  if (smsCapable && wantsOwnerSms && !(await hasFeatureAccess(organizationId, "smsNotifications"))) {
    reportPlanGateStrip(organizationId, "owner-sms");
    gated = {
      ...gated,
      sms_on_missed_call: false,
      sms_on_voicemail: false,
      sms_on_failed_call: false,
      sms_on_callback_scheduled: false,
    };
  }

  if (prefs.webhook_url && !(await hasFeatureAccess(organizationId, "webhookIntegrations"))) {
    reportPlanGateStrip(organizationId, "webhook");
    gated = { ...gated, webhook_url: null };
  }

  return gated;
}

/**
 * A plan-gate strip means the org has a channel CONFIGURED that its plan no
 * longer covers (downgrade / past_due / pre-gating row). The owner thinks
 * the channel works; it silently doesn't. Console for local grepping plus a
 * grouped Sentry warning so support sees it — and the set of affected orgs
 * doubles as an upsell list (SCRUM-423 review).
 */
function reportPlanGateStrip(organizationId: string, channel: "owner-sms" | "webhook"): void {
  console.warn(`[Notifications] ${channel} configured but not covered by plan — channel skipped:`, { organizationId });
  Sentry.withScope((scope) => {
    scope.setLevel("warning");
    scope.setTag("bug", "notification_channel_plan_stripped");
    scope.setTag("channel", channel);
    scope.setExtras({ organizationId, channel });
    Sentry.captureMessage("Notification channel stripped by plan gate");
  });
}

/**
 * Surface an owner-email lookup failure to Sentry. The owner's email is the
 * DEFAULT (often only) notification channel, so a lookup failure here usually
 * means the org silently stops hearing about missed/failed calls — it must be
 * observable in production, not just in console logs (SCRUM-419).
 */
function reportOwnerEmailLookupFailure(
  level: "error" | "warning",
  reason: string,
  extras: Record<string, unknown>
): void {
  Sentry.withScope((scope) => {
    scope.setLevel(level);
    scope.setTag("bug", "owner_email_lookup_failed");
    scope.setExtras(extras);
    Sentry.captureMessage(`Owner-email lookup failed: ${reason}`);
  });
}

/**
 * Get organization owner's email
 */
export async function getOrganizationOwnerEmail(
  organizationId: string
): Promise<string | null> {
  const supabase = createAdminClient();

  // Get owner's user_id
  const { data: member, error: memberError } = await (supabase as any)
    .from("org_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .single();

  if (memberError) {
    console.error("[Notifications] Failed to find org owner:", {
      organizationId,
      error: memberError.message || memberError.code,
    });
    reportOwnerEmailLookupFailure("error", "org owner query failed", {
      organizationId,
      error: memberError.message || memberError.code,
    });
    return null;
  }

  if (!member) {
    console.warn("[Notifications] No owner found for organization:", organizationId);
    reportOwnerEmailLookupFailure("warning", "organization has no owner member", { organizationId });
    return null;
  }

  // Get user's email from profile
  const { data: profile, error: profileError } = await (supabase as any)
    .from("user_profiles")
    .select("email")
    .eq("id", member.user_id)
    .single();

  if (profileError) {
    console.error("[Notifications] Failed to load owner profile:", {
      organizationId,
      userId: member.user_id,
      error: profileError.message || profileError.code,
    });
    reportOwnerEmailLookupFailure("error", "owner profile query failed", {
      organizationId,
      userId: member.user_id,
      error: profileError.message || profileError.code,
    });
    return null;
  }

  if (!profile?.email) {
    console.warn("[Notifications] Owner has no email:", {
      organizationId,
      userId: member.user_id,
    });
    reportOwnerEmailLookupFailure("warning", "owner profile has no email", {
      organizationId,
      userId: member.user_id,
    });
    return null;
  }

  return profile.email;
}

/**
 * Await all channel sends and enforce honest delivery reporting (SCRUM-419):
 *
 * - `droppedChannels` lists channels that were WANTED (per preferences) but
 *   could not even be attempted — e.g. the owner-email lookup failed. If that
 *   leaves ZERO channels to attempt, this throws so the caller records a
 *   failure instead of "sent" with nothing delivered.
 * - Zero channels with nothing dropped is a legitimate no-op (the org turned
 *   this notification off) and resolves silently.
 * - Otherwise: settle all channels and throw if any failed (degrade
 *   per-channel — one failure doesn't stop the others, but it is reported).
 */
async function settleChannels(
  notification: string,
  organizationId: string,
  channels: Promise<void>[],
  droppedChannels: string[]
): Promise<void> {
  if (droppedChannels.length > 0) {
    console.error(`[Notifications] ${notification}: wanted channel(s) unavailable — ${droppedChannels.join(", ")}:`, {
      organizationId,
      attemptedChannels: channels.length,
    });
  }

  if (channels.length === 0) {
    if (droppedChannels.length > 0) {
      // A channel was wanted but unavailable and nothing else delivered —
      // reporting success here would be a false positive (audit finding #21).
      throw new Error(
        `${notification}: 0 notification channels delivered — wanted channel(s) unavailable: ${droppedChannels.join(", ")}`
      );
    }
    return; // all channels disabled by preference — legitimate no-op
  }

  const results = await Promise.allSettled(channels);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${results.length} notification channels failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }
}

/**
 * Send missed call notification
 */
export async function sendMissedCallNotification(
  data: CallNotificationData
): Promise<void> {
  const prefs = await applyPlanGates(
    data.organizationId,
    await getNotificationPreferences(data.organizationId)
  );
  const shouldEmail = prefs ? prefs.email_on_missed_call : true;
  const shouldSms = prefs ? prefs.sms_on_missed_call && prefs.sms_phone_number : false;

  // Only look the owner up when the email channel is wanted — the lookup
  // Sentry-reports failures, so running it for email-off orgs is pure noise.
  const email = shouldEmail ? await getOrganizationOwnerEmail(data.organizationId) : null;

  const channels: Promise<void>[] = [];
  const droppedChannels: string[] = [];
  if (shouldEmail && !email) droppedChannels.push("owner-email");
  if (prefs?.sms_on_missed_call && !prefs.sms_phone_number) droppedChannels.push("sms");

  if (shouldEmail && email) {
    channels.push(sendEmail({
      to: email,
      subject: `Missed Call from ${data.callerName || data.callerPhone}`,
      template: "missed-call",
      data: {
        callerPhone: data.callerPhone,
        callerName: data.callerName,
        timestamp: data.timestamp.toLocaleString(),
        summary: data.summary,
      },
    }));
  }

  if (shouldSms && prefs?.sms_phone_number) {
    channels.push(sendSMS({
      to: prefs.sms_phone_number,
      message: `Missed call from ${data.callerName || data.callerPhone} at ${data.timestamp.toLocaleTimeString()}`,
    }));
  }

  if (prefs?.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "missed_call",
      data,
    }));
  }

  await settleChannels("missed-call", data.organizationId, channels, droppedChannels);
}

/**
 * Send failed call notification — alerts business owner when a call fails
 * so they can call the customer back.
 */
export async function sendFailedCallNotification(
  data: FailedCallNotificationData
): Promise<void> {
  const prefs = await applyPlanGates(
    data.organizationId,
    await getNotificationPreferences(data.organizationId)
  );
  // Failed calls always notify even without prefs — default to email-on
  const shouldEmail = prefs ? prefs.email_on_failed_call : true;
  const shouldSms = prefs ? prefs.sms_on_failed_call && prefs.sms_phone_number : false;

  const email = shouldEmail ? await getOrganizationOwnerEmail(data.organizationId) : null;

  const channels: Promise<void>[] = [];
  const droppedChannels: string[] = [];
  if (shouldEmail && !email) droppedChannels.push("owner-email");
  if (prefs?.sms_on_failed_call && !prefs.sms_phone_number) droppedChannels.push("sms");

  if (shouldEmail && email) {
    channels.push(sendEmail({
      to: email,
      subject: `Failed Call — Action Required`,
      template: "failed-call",
      data: {
        callerPhone: data.callerPhone,
        callerName: data.callerName,
        timestamp: data.timestamp.toLocaleString(),
        failureReason: data.failureReason,
        endedReason: data.endedReason,
        summary: data.summary,
        duration: data.duration,
      },
    }));
  }

  if (shouldSms && prefs?.sms_phone_number) {
    const caller = data.callerName || data.callerPhone;
    channels.push(sendSMS({
      to: prefs.sms_phone_number,
      message: `[Phondo] Failed call from ${caller} at ${data.timestamp.toLocaleTimeString()}. Please call them back. Reason: ${data.failureReason}`,
    }));
  }

  if (prefs?.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "call_failed",
      data,
    }));
  }

  await settleChannels("failed-call", data.organizationId, channels, droppedChannels);
}

/**
 * Send unsuccessful-call notification — alerts the owner when the AI engaged
 * but the caller hung up without a satisfactory outcome (successEvaluation
 * "unsuccessful" or "partial"). SCRUM-281.
 *
 * This is the correct destination for calls that SCRUM-299 was previously
 * mislabeling as "missed" — the AI DID answer, it just didn't resolve the
 * caller's need, which is a different (and arguably more urgent) signal for
 * the owner: a real lead they may be losing.
 */
export async function sendUnsuccessfulCallNotification(
  data: UnsuccessfulCallNotificationData
): Promise<void> {
  const prefs = await applyPlanGates(
    data.organizationId,
    await getNotificationPreferences(data.organizationId),
    { smsCapable: false }
  );
  const shouldEmail = prefs ? prefs.email_on_unsuccessful_call : true;

  const email = shouldEmail ? await getOrganizationOwnerEmail(data.organizationId) : null;

  const channels: Promise<void>[] = [];
  const droppedChannels: string[] = [];
  if (shouldEmail && !email) droppedChannels.push("owner-email");

  if (shouldEmail && email) {
    // First 200 chars of the transcript so the owner gets the gist without
    // opening the dashboard. escapeHtml runs in generateEmailHtml.
    const transcriptSnippet = data.transcript
      ? data.transcript.slice(0, 200) + (data.transcript.length > 200 ? "…" : "")
      : "";
    const dashboardLink = `${process.env.NEXT_PUBLIC_APP_URL || "https://phondo.ai"}/calls${
      data.callId && data.callId !== "unknown" ? `/${data.callId}` : ""
    }`;
    // Humanize the analyzer rating — owners shouldn't see jargon like "partial".
    const evalLower = (data.successEvaluation || "").toLowerCase();
    const outcomeLabel =
      evalLower === "partial"
        ? "The AI partially helped, but the caller's need wasn't fully resolved."
        : "The AI couldn't resolve the caller's request.";
    channels.push(sendEmail({
      to: email,
      subject: `Unsuccessful Call — ${data.callerName || data.callerPhone}`,
      template: "unsuccessful-call",
      data: {
        callerPhone: data.callerPhone,
        callerName: data.callerName,
        timestamp: data.timestamp.toLocaleString(),
        duration: data.duration,
        summary: data.summary,
        transcriptSnippet,
        outcomeLabel,
        dashboardLink,
      },
    }));
  }

  if (prefs?.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "call_unsuccessful",
      data,
    }));
  }

  await settleChannels("unsuccessful-call", data.organizationId, channels, droppedChannels);
}

/**
 * Send voicemail notification
 */
export async function sendVoicemailNotification(
  data: VoicemailNotificationData
): Promise<void> {
  const prefs = await applyPlanGates(
    data.organizationId,
    await getNotificationPreferences(data.organizationId)
  );
  const shouldEmail = prefs ? prefs.email_on_voicemail : true;
  const shouldSms = prefs ? prefs.sms_on_voicemail && prefs.sms_phone_number : false;

  const email = shouldEmail ? await getOrganizationOwnerEmail(data.organizationId) : null;

  const channels: Promise<void>[] = [];
  const droppedChannels: string[] = [];
  if (shouldEmail && !email) droppedChannels.push("owner-email");
  if (prefs?.sms_on_voicemail && !prefs.sms_phone_number) droppedChannels.push("sms");

  if (shouldEmail && email) {
    channels.push(sendEmail({
      to: email,
      subject: `New Voicemail from ${data.callerName || data.callerPhone}`,
      template: "voicemail",
      data: {
        callerPhone: data.callerPhone,
        callerName: data.callerName,
        timestamp: data.timestamp.toLocaleString(),
        voicemailUrl: data.voicemailUrl,
        transcript: data.voicemailTranscript,
        duration: data.duration,
      },
    }));
  }

  if (shouldSms && prefs?.sms_phone_number) {
    channels.push(sendSMS({
      to: prefs.sms_phone_number,
      message: `New voicemail from ${data.callerName || data.callerPhone}. ${data.voicemailTranscript ? `"${data.voicemailTranscript.substring(0, 100)}..."` : ""}`,
    }));
  }

  if (prefs?.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "voicemail",
      data,
    }));
  }

  await settleChannels("voicemail", data.organizationId, channels, droppedChannels);
}

/**
 * Format an appointment date in the org's timezone, unambiguously.
 *
 * Spelling out the month ("5 June 2026") avoids the D/M/Y vs M/D/Y confusion
 * entirely — an AU owner reading "6/4/2026" can't tell if it's 6 April or
 * June 4. The explicit timeZone stops the date shifting across the UTC
 * boundary (a 9:30am Sydney booking would otherwise render as the prior day).
 */
export function formatAppointmentDate(date: Date, timezone?: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(timezone && { timeZone: timezone }),
  }).format(date);
}

/**
 * Send appointment booking notification
 */
export async function sendAppointmentNotification(
  data: AppointmentNotificationData
): Promise<void> {
  const prefs = await applyPlanGates(
    data.organizationId,
    await getNotificationPreferences(data.organizationId),
    { smsCapable: false }
  );
  if (!prefs) return; // genuinely no prefs row — DB errors fail open to defaults upstream

  const email = prefs.email_on_appointment_booked
    ? await getOrganizationOwnerEmail(data.organizationId)
    : null;

  const channels: Promise<void>[] = [];
  const droppedChannels: string[] = [];
  if (prefs.email_on_appointment_booked && !email) droppedChannels.push("owner-email");

  if (prefs.email_on_appointment_booked && email) {
    const formattedDate = formatAppointmentDate(data.appointmentDate, data.timezone);
    channels.push(sendEmail({
      to: email,
      subject: `New Appointment Booked - ${formattedDate}`,
      template: "appointment-booked",
      data: {
        callerPhone: data.callerPhone,
        callerName: data.callerName,
        appointmentDate: formattedDate,
        appointmentTime: data.appointmentTime,
        serviceName: data.serviceName,
        confirmationCode: data.confirmationCode,
      },
    }));
  }

  if (prefs.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "appointment_booked",
      data,
    }));
  }

  await settleChannels("appointment-booked", data.organizationId, channels, droppedChannels);
}

/**
 * Send callback scheduled notification
 */
export async function sendCallbackNotification(
  data: CallbackNotificationData
): Promise<void> {
  const prefs = await applyPlanGates(
    data.organizationId,
    await getNotificationPreferences(data.organizationId)
  );
  const shouldEmail = prefs ? prefs.email_on_callback_scheduled : true;
  const shouldSms = prefs ? prefs.sms_on_callback_scheduled && prefs.sms_phone_number : false;

  const email = shouldEmail ? await getOrganizationOwnerEmail(data.organizationId) : null;

  const channels: Promise<void>[] = [];
  const droppedChannels: string[] = [];
  if (shouldEmail && !email) droppedChannels.push("owner-email");
  if (prefs?.sms_on_callback_scheduled && !prefs.sms_phone_number) droppedChannels.push("sms");

  if (shouldEmail && email) {
    channels.push(sendEmail({
      to: email,
      subject: `Callback Requested — ${data.callerName || data.callerPhone}`,
      template: "callback-scheduled",
      data: {
        callerName: data.callerName,
        callerPhone: data.callerPhone,
        reason: data.reason,
        preferredTime: data.preferredTime || "No preference",
        urgency: data.urgency,
        timestamp: new Date().toLocaleString(),
      },
    }));
  }

  if (shouldSms && prefs?.sms_phone_number) {
    const caller = data.callerName || data.callerPhone;
    channels.push(sendSMS({
      to: prefs.sms_phone_number,
      message: `[Phondo] Callback requested by ${caller} (${data.callerPhone}). Reason: ${data.reason}. ${data.urgency} urgency.`,
    }));
  }

  if (prefs?.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "callback_scheduled",
      data,
    }));
  }

  if (channels.length === 0) {
    console.warn("[Callback] No notification channels available — business may not see this callback:", {
      organizationId: data.organizationId,
      callerPhone: data.callerPhone,
    });
  }

  await settleChannels("callback-scheduled", data.organizationId, channels, droppedChannels);
}

/**
 * Send callback reminder notification — alerts when a scheduled callback is due
 */
export async function sendCallbackReminderNotification(
  data: CallbackNotificationData
): Promise<void> {
  const prefs = await applyPlanGates(
    data.organizationId,
    await getNotificationPreferences(data.organizationId)
  );
  const shouldEmail = prefs ? prefs.email_on_callback_scheduled : true;
  const shouldSms = prefs ? prefs.sms_on_callback_scheduled && prefs.sms_phone_number : false;

  const email = shouldEmail ? await getOrganizationOwnerEmail(data.organizationId) : null;

  const channels: Promise<void>[] = [];
  const droppedChannels: string[] = [];
  if (shouldEmail && !email) droppedChannels.push("owner-email");
  if (prefs?.sms_on_callback_scheduled && !prefs.sms_phone_number) droppedChannels.push("sms");

  if (shouldEmail && email) {
    channels.push(sendEmail({
      to: email,
      subject: `Callback Due — ${data.callerName || data.callerPhone}`,
      template: "callback-reminder",
      data: {
        callerName: data.callerName,
        callerPhone: data.callerPhone,
        reason: data.reason,
        preferredTime: data.preferredTime || "Now",
        urgency: data.urgency,
        timestamp: new Date().toLocaleString(),
      },
    }));
  }

  if (shouldSms && prefs?.sms_phone_number) {
    const caller = data.callerName || data.callerPhone;
    channels.push(sendSMS({
      to: prefs.sms_phone_number,
      message: `[Phondo] Reminder: callback to ${caller} (${data.callerPhone}) is now due. Reason: ${data.reason}.`,
    }));
  }

  if (prefs?.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "callback_reminder",
      data,
    }));
  }

  if (channels.length === 0) {
    console.warn("[Callback Reminder] No notification channels available — business will not receive this reminder:", {
      organizationId: data.organizationId,
      callerPhone: data.callerPhone,
    });
  }

  await settleChannels("callback-reminder", data.organizationId, channels, droppedChannels);
}

/**
 * Send daily summary notification
 */
export async function sendDailySummaryNotification(
  data: DailySummaryData
): Promise<void> {
  const prefs = await applyPlanGates(
    data.organizationId,
    await getNotificationPreferences(data.organizationId),
    { smsCapable: false }
  );
  if (!prefs) return; // genuinely no prefs row — DB errors fail open to defaults upstream

  const email = prefs.email_daily_summary
    ? await getOrganizationOwnerEmail(data.organizationId)
    : null;

  const channels: Promise<void>[] = [];
  const droppedChannels: string[] = [];
  if (prefs.email_daily_summary && !email) droppedChannels.push("owner-email");

  if (prefs.email_daily_summary && email) {
    channels.push(sendEmail({
      to: email,
      subject: `Daily Call Summary - ${data.date.toLocaleDateString()}`,
      template: "daily-summary",
      data: {
        date: data.date.toLocaleDateString(),
        totalCalls: data.totalCalls,
        answeredCalls: data.answeredCalls,
        missedCalls: data.missedCalls,
        appointmentsBooked: data.appointmentsBooked,
        // Pass the raw seconds average; formatCallDuration owns rounding so
        // there is a single rounding site (email + webhook reference the same
        // source value).
        averageCallDuration: data.averageCallDuration,
        answerRate: data.totalCalls > 0
          ? Math.round((data.answeredCalls / data.totalCalls) * 100)
          : 0,
      },
    }));
  }

  if (prefs.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "daily_summary",
      data,
    }));
  }

  await settleChannels("daily-summary", data.organizationId, channels, droppedChannels);
}

// ============================================================
// Email, SMS, and Webhook sending functions
// These are abstractions that can be replaced with actual providers
// ============================================================

interface EmailParams {
  to: string;
  subject: string;
  template: string;
  data: Record<string, any>;
}

interface SMSParams {
  to: string;
  message: string;
}

interface WebhookPayload {
  event: string;
  data: any;
}

/**
 * Send email using Resend
 */
async function sendEmail(params: EmailParams): Promise<void> {
  const { to, subject, template, data } = params;

  const apiKey = process.env.EMAIL_API_KEY;
  const fromEmail = process.env.EMAIL_FROM || "notifications@phondo.ai";

  if (!apiKey) {
    throw new Error(
      `[Email] EMAIL_API_KEY is not configured. Cannot send "${template}" email to ${to} (subject: "${subject}")`
    );
  }

  const html = generateEmailHtml(template, data);

  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }

  const { error } = await resendClient.emails.send({
    from: fromEmail,
    to,
    subject,
    html,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  console.log("[Email] Sent:", { to, subject, template });
}

/**
 * Send SMS using Twilio
 */
async function sendSMS(params: SMSParams): Promise<void> {
  const { to, message } = params;

  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!twilioAccountSid || !twilioAuthToken || !twilioFromNumber) {
    throw new Error(
      `[SMS] Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER). Cannot send SMS to ${to}`
    );
  }

  if (!twilioClient) {
    twilioClient = Twilio(twilioAccountSid, twilioAuthToken);
  }
  await twilioClient.messages.create({
    body: message,
    to,
    from: twilioFromNumber,
  });

  console.log("[SMS] Sent:", { to, message: message.substring(0, 50) });
}

/**
 * Send webhook notification
 * Includes SSRF protection to prevent webhooks to internal networks
 */
async function sendWebhook(url: string, payload: WebhookPayload): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    // ssrfSafeFetch does the DNS-resolving SSRF check and re-validates every
    // redirect hop against the internal-network blocklist (SCRUM-338).
    const response = await ssrfSafeFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Source": "phondo",
      },
      body: JSON.stringify({
        ...payload,
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Format a duration in seconds into a human-readable string for emails.
 * 0 → "0s", 45 → "45s", 221 → "3m 41s", 3600 → "1h 0m".
 * Exported for unit testing.
 */
export function formatCallDuration(seconds: number): string {
  const n = Number(seconds);
  // Number.isFinite rejects NaN AND ±Infinity — `Number(x) || 0` only caught
  // the falsy/NaN low end and let +Infinity through as "Infinityh NaNm".
  const total = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${secs}s`;
}

/**
 * Generate email HTML from template
 * All user-provided data is HTML-escaped to prevent XSS
 */
function generateEmailHtml(template: string, data: Record<string, any>): string {
  // Escape all user-provided data to prevent XSS
  const safeData: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      safeData[key] = escapeHtml(value);
    } else {
      safeData[key] = value;
    }
  }

  // Basic templates - in production, use a proper templating engine
  const templates: Record<string, (data: Record<string, any>) => string> = {
    "missed-call": (d) => `
      <h2>Missed Call</h2>
      <p>You missed a call from <strong>${d.callerName || d.callerPhone}</strong> at ${d.timestamp}.</p>
      ${d.summary ? `<p><em>Summary: ${d.summary}</em></p>` : ""}
      <p>Log in to your dashboard to see more details.</p>
    `,
    "failed-call": (d) => `
      <h2 style="color: #dc2626;">Failed Call — Action Required</h2>
      <p>A caller tried to reach your business but the call failed.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Caller</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.callerName ? `${d.callerName} (${d.callerPhone})` : d.callerPhone}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Time</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.timestamp}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Reason</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.failureReason}</td>
        </tr>
        ${d.duration ? `<tr><td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Duration</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.duration}s</td></tr>` : ""}
        ${d.summary ? `<tr><td style="padding: 8px; font-weight: bold;">Summary</td><td style="padding: 8px;">${d.summary}</td></tr>` : ""}
      </table>
      <p><strong>Please call them back as soon as possible.</strong></p>
    `,
    "unsuccessful-call": (d) => `
      <h2 style="color: #d97706;">Unsuccessful Call — You May Have Lost a Lead</h2>
      <p>Your AI receptionist answered a call but the caller hung up without a satisfactory outcome. This is a potential lead worth following up.</p>
      ${d.outcomeLabel ? `<p><strong>${d.outcomeLabel}</strong></p>` : ""}
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Caller</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.callerName ? `${d.callerName} (${d.callerPhone})` : d.callerPhone}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Time</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.timestamp}</td>
        </tr>
        ${d.duration ? `<tr><td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Duration</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.duration}s</td></tr>` : ""}
        ${d.summary ? `<tr><td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Summary</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.summary}</td></tr>` : ""}
        ${d.transcriptSnippet ? `<tr><td style="padding: 8px; font-weight: bold; vertical-align: top;">Transcript</td><td style="padding: 8px;"><em>${d.transcriptSnippet}</em></td></tr>` : ""}
      </table>
      <p><strong>Consider calling them back.</strong></p>
      <p><a href="${escapeHtml(d.dashboardLink || (process.env.NEXT_PUBLIC_APP_URL || "https://phondo.ai") + "/calls")}">View the full call</a></p>
    `,
    voicemail: (d) => `
      <h2>New Voicemail</h2>
      <p>You have a new voicemail from <strong>${d.callerName || d.callerPhone}</strong>.</p>
      <p>Received at: ${d.timestamp}</p>
      ${d.duration ? `<p>Duration: ${d.duration} seconds</p>` : ""}
      ${d.transcript ? `<p><strong>Transcript:</strong><br/>${d.transcript}</p>` : ""}
      ${d.voicemailUrl ? `<p><a href="${escapeHtml(d.voicemailUrl)}">Listen to voicemail</a></p>` : ""}
    `,
    "appointment-booked": (d) => `
      <h2>New Appointment Booked</h2>
      <p>A new appointment has been booked by <strong>${d.callerName || d.callerPhone}</strong>.</p>
      <p><strong>Date:</strong> ${d.appointmentDate}</p>
      <p><strong>Time:</strong> ${d.appointmentTime}</p>
      ${d.serviceName ? `<p><strong>Service:</strong> ${d.serviceName}</p>` : ""}
    `,
    "callback-scheduled": (d) => `
      <h2>Callback Requested</h2>
      <p>A caller has requested a callback from your business.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Caller</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.callerName} (${d.callerPhone})</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Reason</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.reason}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Preferred Time</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.preferredTime}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Urgency</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.urgency}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold;">Requested At</td>
          <td style="padding: 8px;">${d.timestamp}</td>
        </tr>
      </table>
      <p><strong>Please call them back as soon as possible.</strong></p>
      <p><a href="${process.env.NEXT_PUBLIC_APP_URL || "https://phondo.ai"}/callbacks">View all callbacks</a></p>
    `,
    "callback-reminder": (d) => `
      <h2 style="color: #f59e0b;">Callback Due</h2>
      <p>A scheduled callback is now due.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Caller</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.callerName} (${d.callerPhone})</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Reason</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.reason}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Scheduled For</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${d.preferredTime}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold;">Urgency</td>
          <td style="padding: 8px;">${d.urgency}</td>
        </tr>
      </table>
      <p><strong>Please call them back now.</strong></p>
      <p><a href="${process.env.NEXT_PUBLIC_APP_URL || "https://phondo.ai"}/callbacks">View all callbacks</a></p>
    `,
    "daily-summary": (d) => `
      <h2>Daily Call Summary - ${d.date}</h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">Total Calls</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>${d.totalCalls}</strong></td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">Answered Calls</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>${d.answeredCalls}</strong></td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">Missed Calls</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>${d.missedCalls}</strong></td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">Answer Rate</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>${d.answerRate}%</strong></td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">Appointments Booked</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>${d.appointmentsBooked}</strong></td>
        </tr>
        <tr>
          <td style="padding: 8px;">Avg Call Duration</td>
          <td style="padding: 8px;"><strong>${formatCallDuration(d.averageCallDuration)}</strong></td>
        </tr>
      </table>
    `,
  };

  const templateFn = templates[template];
  if (!templateFn) {
    // Don't expose raw data, return generic message
    return `<p>Notification from Phondo</p>`;
  }

  // Branded email shell. Table-based layout instead of flexbox because
  // Outlook 2016/2019 and several mobile clients still don't reliably
  // support flex.
  //
  // Logomark: a stylised "P" letter glyph in white on the brand-orange
  // tile. An earlier revision used an inline Lucide phone SVG, but code
  // review caught that Gmail web, Outlook desktop, Yahoo, and AOL all
  // strip <svg> at render time — the orange tile would appear empty for
  // a majority of recipients. A letter glyph renders everywhere. When
  // we have a hosted PNG at phondo.ai/email-assets/ we can swap in a
  // richer mark.
  //
  // Body typography is inlined on the inner <td> because Gmail web
  // strips <style> blocks above ~102KB and many clients ignore class
  // selectors entirely. The <style> block stays as progressive
  // enhancement for clients that do respect it.
  //
  // Brand colours match the marketing site:
  //   #f97316 (orange-500) — primary accent
  //   #0f172a (slate-900) — wordmark
  //   #6b7280 (gray-500)  — secondary text
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://phondo.ai";
  // Strip trailing slash so concatenation produces clean URLs even when
  // NEXT_PUBLIC_APP_URL is set with one (silent-failure-hunter P2 #1).
  const escapedAppUrl = escapeHtml(appUrl.replace(/\/$/, ""));
  const bodyFont =
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;";

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { margin: 0; padding: 0; background: #f9fafb; }
        .container { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; background: #ffffff; }
        .inner { padding: 32px 24px; }
        h2 { color: #0f172a; margin: 0 0 16px 0; font-size: 20px; font-weight: 700; }
        p { margin: 0 0 12px 0; }
        a { color: #f97316; text-decoration: underline; }
        table.data-table td { padding: 8px; }
      </style>
    </head>
    <body>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f9fafb;">
        <tr>
          <td align="center" style="padding: 24px 12px;">
            <table cellpadding="0" cellspacing="0" border="0" class="container" style="max-width: 600px; background: #ffffff;">
              <!-- Header -->
              <tr>
                <td style="background: #ffffff; padding: 20px 24px; border-bottom: 1px solid #e5e7eb;">
                  <table cellpadding="0" cellspacing="0" border="0" role="presentation">
                    <tr>
                      <td style="background: #f97316; border-radius: 8px; width: 36px; height: 36px; ${bodyFont} font-size: 22px; font-weight: 700; color: #ffffff; line-height: 36px; text-align: center; vertical-align: middle;" align="center" valign="middle" aria-hidden="true">P</td>
                      <td style="padding-left: 12px;" valign="middle">
                        <a href="${escapedAppUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration: none;" aria-label="Phondo">
                          <span style="font-size: 22px; font-weight: 700; color: #0f172a; ${bodyFont}">Phondo</span>
                        </a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td class="inner" style="background: #ffffff; padding: 32px 24px; ${bodyFont} line-height: 1.6; color: #1f2937; font-size: 15px;">
                  ${templateFn(safeData)}
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background: #f9fafb; padding: 20px 24px; border-top: 1px solid #e5e7eb; ${bodyFont}">
                  <p style="font-size: 12px; color: #6b7280; margin: 0; line-height: 1.6;">
                    This email was sent by Phondo AI Receptionist.<br/>
                    <a href="${escapedAppUrl}/settings/notifications" target="_blank" rel="noopener noreferrer" style="color: #6b7280; text-decoration: underline;">Manage notification preferences</a>
                    &nbsp;·&nbsp;
                    <a href="${escapedAppUrl}" target="_blank" rel="noopener noreferrer" style="color: #6b7280; text-decoration: underline;">Open dashboard</a>
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}
