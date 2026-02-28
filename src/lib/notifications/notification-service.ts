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
import { isUrlAllowed, escapeHtml } from "@/lib/security/validation";
import { Resend } from "resend";
import Twilio from "twilio";

let resendClient: Resend | null = null;

export interface NotificationPreferences {
  email_on_missed_call: boolean;
  email_on_voicemail: boolean;
  email_on_appointment_booked: boolean;
  email_on_failed_call: boolean;
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

export interface AppointmentNotificationData {
  organizationId: string;
  callerPhone: string;
  callerName?: string;
  appointmentDate: Date;
  appointmentTime: string;
  serviceName?: string;
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
 * Get notification preferences for an organization
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

  if (error || !data) {
    if (error && error.code !== "PGRST116") {
      console.error("[Notifications] Failed to load preferences:", {
        organizationId,
        error: error.message || error.code,
      });
    }
    return null;
  }

  return {
    email_on_missed_call: data.email_on_missed_call ?? true,
    email_on_voicemail: data.email_on_voicemail ?? true,
    email_on_appointment_booked: data.email_on_appointment_booked ?? true,
    email_on_failed_call: data.email_on_failed_call ?? true,
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
    return null;
  }

  if (!member) {
    console.warn("[Notifications] No owner found for organization:", organizationId);
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
    return null;
  }

  if (!profile?.email) {
    console.warn("[Notifications] Owner has no email:", {
      organizationId,
      userId: member.user_id,
    });
    return null;
  }

  return profile.email;
}

/**
 * Send missed call notification
 */
export async function sendMissedCallNotification(
  data: CallNotificationData
): Promise<void> {
  const prefs = await getNotificationPreferences(data.organizationId);
  const shouldEmail = prefs ? prefs.email_on_missed_call : true;
  const shouldSms = prefs ? prefs.sms_on_missed_call && prefs.sms_phone_number : false;

  const email = await getOrganizationOwnerEmail(data.organizationId);

  const channels: Promise<void>[] = [];

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

  const results = await Promise.allSettled(channels);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${results.length} notification channels failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }
}

/**
 * Send failed call notification — alerts business owner when a call fails
 * so they can call the customer back.
 */
export async function sendFailedCallNotification(
  data: FailedCallNotificationData
): Promise<void> {
  const prefs = await getNotificationPreferences(data.organizationId);
  // Failed calls always notify even without prefs — default to email-on
  const shouldEmail = prefs ? prefs.email_on_failed_call : true;
  const shouldSms = prefs ? prefs.sms_on_failed_call && prefs.sms_phone_number : false;

  const email = await getOrganizationOwnerEmail(data.organizationId);

  const channels: Promise<void>[] = [];

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
      message: `[Hola Recep] Failed call from ${caller} at ${data.timestamp.toLocaleTimeString()}. Please call them back. Reason: ${data.failureReason}`,
    }));
  }

  if (prefs?.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "call_failed",
      data,
    }));
  }

  const results = await Promise.allSettled(channels);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${results.length} notification channels failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }
}

/**
 * Send voicemail notification
 */
export async function sendVoicemailNotification(
  data: VoicemailNotificationData
): Promise<void> {
  const prefs = await getNotificationPreferences(data.organizationId);
  const shouldEmail = prefs ? prefs.email_on_voicemail : true;
  const shouldSms = prefs ? prefs.sms_on_voicemail && prefs.sms_phone_number : false;

  const email = await getOrganizationOwnerEmail(data.organizationId);

  const channels: Promise<void>[] = [];

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

  const results = await Promise.allSettled(channels);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${results.length} notification channels failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }
}

/**
 * Send appointment booking notification
 */
export async function sendAppointmentNotification(
  data: AppointmentNotificationData
): Promise<void> {
  const prefs = await getNotificationPreferences(data.organizationId);
  if (!prefs) return;

  const email = await getOrganizationOwnerEmail(data.organizationId);

  const channels: Promise<void>[] = [];

  if (prefs.email_on_appointment_booked && email) {
    channels.push(sendEmail({
      to: email,
      subject: `New Appointment Booked - ${data.appointmentDate.toLocaleDateString()}`,
      template: "appointment-booked",
      data: {
        callerPhone: data.callerPhone,
        callerName: data.callerName,
        appointmentDate: data.appointmentDate.toLocaleDateString(),
        appointmentTime: data.appointmentTime,
        serviceName: data.serviceName,
      },
    }));
  }

  if (prefs.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "appointment_booked",
      data,
    }));
  }

  const results = await Promise.allSettled(channels);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${results.length} notification channels failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }
}

/**
 * Send callback scheduled notification
 */
export async function sendCallbackNotification(
  data: CallbackNotificationData
): Promise<void> {
  const prefs = await getNotificationPreferences(data.organizationId);
  const shouldEmail = prefs ? prefs.email_on_callback_scheduled : true;
  const shouldSms = prefs ? prefs.sms_on_callback_scheduled && prefs.sms_phone_number : false;

  const email = await getOrganizationOwnerEmail(data.organizationId);

  const channels: Promise<void>[] = [];

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
      message: `[Hola Recep] Callback requested by ${caller} (${data.callerPhone}). Reason: ${data.reason}. ${data.urgency} urgency.`,
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

  const results = await Promise.allSettled(channels);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${results.length} notification channels failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }
}

/**
 * Send callback reminder notification — alerts when a scheduled callback is due
 */
export async function sendCallbackReminderNotification(
  data: CallbackNotificationData
): Promise<void> {
  const prefs = await getNotificationPreferences(data.organizationId);
  const shouldEmail = prefs ? prefs.email_on_callback_scheduled : true;
  const shouldSms = prefs ? prefs.sms_on_callback_scheduled && prefs.sms_phone_number : false;

  const email = await getOrganizationOwnerEmail(data.organizationId);

  const channels: Promise<void>[] = [];

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
      message: `[Hola Recep] Reminder: callback to ${caller} (${data.callerPhone}) is now due. Reason: ${data.reason}.`,
    }));
  }

  if (prefs?.webhook_url) {
    channels.push(sendWebhook(prefs.webhook_url, {
      event: "callback_reminder",
      data,
    }));
  }

  const results = await Promise.allSettled(channels);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${results.length} notification channels failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }
}

/**
 * Send daily summary notification
 */
export async function sendDailySummaryNotification(
  data: DailySummaryData
): Promise<void> {
  const prefs = await getNotificationPreferences(data.organizationId);
  if (!prefs) return;

  const email = await getOrganizationOwnerEmail(data.organizationId);

  const channels: Promise<void>[] = [];

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
        averageCallDuration: Math.round(data.averageCallDuration),
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

  const results = await Promise.allSettled(channels);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${results.length} notification channels failed: ${(failures[0] as PromiseRejectedResult).reason}`);
  }
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
  const fromEmail = process.env.EMAIL_FROM || "notifications@holarecep.com";

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

  const client = Twilio(twilioAccountSid, twilioAuthToken);
  await client.messages.create({
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
  // SSRF Protection: Prevent webhooks to internal/private networks
  if (!isUrlAllowed(url)) {
    throw new Error(`Webhook URL blocked - internal or private address: ${url}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Source": "hola-recep",
    },
    body: JSON.stringify({
      ...payload,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}`);
  }
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
      <p><a href="${process.env.NEXT_PUBLIC_APP_URL || "https://holarecep.com"}/callbacks">View all callbacks</a></p>
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
      <p><a href="${process.env.NEXT_PUBLIC_APP_URL || "https://holarecep.com"}/callbacks">View all callbacks</a></p>
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
          <td style="padding: 8px;"><strong>${d.averageCallDuration}s</strong></td>
        </tr>
      </table>
    `,
  };

  const templateFn = templates[template];
  if (!templateFn) {
    // Don't expose raw data, return generic message
    return `<p>Notification from Hola Recep</p>`;
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        h2 { color: #1a1a1a; }
        a { color: #0066cc; }
      </style>
    </head>
    <body>
      ${templateFn(safeData)}
      <hr style="margin-top: 30px; border: none; border-top: 1px solid #ddd;" />
      <p style="font-size: 12px; color: #666;">
        This email was sent by Hola Recep AI Receptionist.
        <a href="${process.env.NEXT_PUBLIC_APP_URL || "https://holarecep.com"}/settings/notifications">Manage notification preferences</a>
      </p>
    </body>
    </html>
  `;
}
