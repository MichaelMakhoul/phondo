import { NextResponse } from "next/server";
import Twilio from "twilio";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/webhooks/twilio-sms-status
 *
 * SCRUM-240 Phase 1: Twilio fires this callback for every status transition
 * on an outbound SMS (queued → sending → sent → delivered, or undelivered/failed).
 * We update the matching `appointment_confirmations` row by provider_message_id.
 *
 * Twilio status flow reference:
 *   queued → sending → sent → delivered  (happy path)
 *   queued → sending → sent → undelivered (carrier rejected / wrong number)
 *   queued → failed   (Twilio couldn't send)
 *
 * Response is always 200 + empty TwiML — if we return an error, Twilio retries
 * aggressively. On our end, we log and Sentry-alert but ack the delivery so
 * the provider stops retrying.
 */
export async function POST(request: Request) {
  try {
    // 1. Validate Twilio signature — same pattern as twilio-sms/route.ts:22-51
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    if (!twilioAuthToken) {
      console.error("[TwilioSMSStatus] TWILIO_AUTH_TOKEN not configured");
      return emptyTwiml(500);
    }

    const signature = request.headers.get("x-twilio-signature") || "";
    const url = process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio-sms-status`
      : request.url;

    const formData = await request.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = value.toString();
    });

    const isValid = Twilio.validateRequest(twilioAuthToken, signature, url, params);
    if (!isValid) {
      console.warn("[TwilioSMSStatus] Invalid Twilio signature — rejecting");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    // 2. Parse Twilio payload
    const messageSid = params.MessageSid || params.SmsSid || "";
    const messageStatus = (params.MessageStatus || params.SmsStatus || "").toLowerCase();
    const errorCode = params.ErrorCode || null;
    const errorMessage = params.ErrorMessage || null;

    if (!messageSid || !messageStatus) {
      console.warn("[TwilioSMSStatus] Missing MessageSid or MessageStatus", { params });
      return emptyTwiml(200);
    }

    // 3. Map Twilio status → our appointment_confirmations.status
    //    Ignore transient states (queued, sending, accepted, scheduled) — wait for terminal.
    const terminalMap: Record<string, "sent" | "delivered" | "undelivered" | "failed"> = {
      sent: "sent",
      delivered: "delivered",
      undelivered: "undelivered",
      failed: "failed",
    };
    const nextStatus = terminalMap[messageStatus];
    if (!nextStatus) {
      return emptyTwiml(200); // queued/sending/etc — no-op
    }

    // 4. Look up the row by provider_message_id
    const supabase = createAdminClient();
    const { data: confirmation, error: lookupErr } = await (supabase as any)
      .from("appointment_confirmations")
      .select("id, appointment_id, organization_id, attempts, status")
      .eq("provider_message_id", messageSid)
      .maybeSingle();

    if (lookupErr) {
      console.error("[TwilioSMSStatus] Lookup failed", { messageSid, error: lookupErr });
      Sentry.withScope((scope) => {
        scope.setTag("service", "twilio-sms-status");
        scope.setExtras({ messageSid });
        Sentry.captureException(lookupErr);
      });
      return emptyTwiml(200); // ack so Twilio stops retrying
    }

    if (!confirmation) {
      // Could be a textback SMS (not a booking confirmation) or a stale SID we don't track.
      // Log at info level — not an error.
      console.log(`[TwilioSMSStatus] No matching confirmation row for ${messageSid} (may be textback or untracked SMS)`);
      return emptyTwiml(200);
    }

    // 5. Build the update. Only move forward in the lifecycle — don't regress.
    const updates: Record<string, any> = {
      status: nextStatus,
      last_attempt_at: new Date().toISOString(),
    };
    if (nextStatus === "delivered") {
      updates.delivered_at = new Date().toISOString();
    }
    if (nextStatus === "undelivered" || nextStatus === "failed") {
      updates.last_error = errorMessage
        ? `${messageStatus}: ${errorMessage}${errorCode ? ` (code ${errorCode})` : ""}`
        : `${messageStatus}${errorCode ? ` (code ${errorCode})` : ""}`;
    }

    const { error: updateErr } = await (supabase as any)
      .from("appointment_confirmations")
      .update(updates)
      .eq("id", confirmation.id);

    if (updateErr) {
      console.error("[TwilioSMSStatus] Update failed", { id: confirmation.id, error: updateErr });
      Sentry.withScope((scope) => {
        scope.setTag("service", "twilio-sms-status");
        scope.setExtras({ messageSid, confirmationId: confirmation.id });
        Sentry.captureException(updateErr);
      });
      return emptyTwiml(200);
    }

    console.log(
      `[TwilioSMSStatus] ${messageSid} → ${nextStatus} for confirmation=${confirmation.id} appt=${confirmation.appointment_id}`
    );

    // 6. Alert on undelivered/failed — business owner should see this in the dashboard.
    //    For Phase 1 we just log + Sentry. Retry logic comes in Phase 1b.
    if (nextStatus === "undelivered" || nextStatus === "failed") {
      Sentry.withScope((scope) => {
        scope.setTag("service", "twilio-sms-status");
        scope.setTag("delivery_status", nextStatus);
        scope.setExtras({
          confirmationId: confirmation.id,
          appointmentId: confirmation.appointment_id,
          organizationId: confirmation.organization_id,
          errorCode,
          errorMessage,
        });
        Sentry.captureMessage(
          `Appointment confirmation ${nextStatus}: ${messageSid}`,
          "warning"
        );
      });
    }

    return emptyTwiml(200);
  } catch (err: unknown) {
    console.error("[TwilioSMSStatus] Unexpected error", err);
    Sentry.captureException(err);
    return emptyTwiml(200); // ack so Twilio stops retrying
  }
}

function emptyTwiml(status: number) {
  return new Response("<Response></Response>", {
    status,
    headers: { "Content-Type": "text/xml" },
  });
}
