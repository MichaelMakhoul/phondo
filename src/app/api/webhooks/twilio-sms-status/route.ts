import Twilio from "twilio";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { withRateLimit, getClientIp } from "@/lib/security/rate-limiter";

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

// Sentry alert sampling for invalid-signature events. Without sampling,
// a brute-force attacker pinging the endpoint with junk MessageSids can
// burn the Sentry quota and create alert noise. 1-in-50 is plenty to
// surface a real Twilio misconfiguration without amplifying abuse.
const INVALID_SIG_SENTRY_SAMPLE_RATE = 0.02;

export async function POST(request: Request) {
  try {
    // 0. IP-level rate limit BEFORE any expensive work (form parsing,
    //    signature validation, DB lookup). 1000/min/IP is generous for
    //    legit Twilio traffic but throttles a brute-force attacker
    //    spamming fake MessageSids. SCRUM-251 P0-2.
    const rl = withRateLimit(request, "twilio-sms-status", "webhook");
    if (!rl.allowed) {
      // Still ack with 200 so Twilio doesn't retry-storm. The rate limiter
      // protects us from amplification by *other* sources.
      console.warn("[TwilioSMSStatus] IP rate-limited", {
        ip: getClientIp(new Headers(request.headers)),
      });
      return emptyTwiml(200);
    }

    // 1. Validate Twilio signature — same pattern as twilio-sms/route.ts:22-51
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    if (!twilioAuthToken) {
      // Treat missing token as a deploy-breaking config bug, but ack with
      // 200 so Twilio doesn't pile up retries on top of an already-broken
      // deploy. SCRUM-251 P1-4.
      console.error("[TwilioSMSStatus] TWILIO_AUTH_TOKEN not configured — acking 200");
      Sentry.captureMessage(
        "TWILIO_AUTH_TOKEN missing in twilio-sms-status webhook",
        "error"
      );
      return emptyTwiml(200);
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
      // Don't return 4xx — Twilio retries on errors and we don't want a
      // bad-signature flood to cause a retry storm. Log + sample Sentry
      // and ack with empty TwiML so the provider stops retrying.
      // Sampling prevents Sentry quota burn on brute-force probing.
      const headers = new Headers(request.headers);
      console.warn("[TwilioSMSStatus] Invalid Twilio signature — silently dropping", {
        ip: getClientIp(headers),
        userAgent: headers.get("user-agent") || "unknown",
      });
      if (Math.random() < INVALID_SIG_SENTRY_SAMPLE_RATE) {
        Sentry.withScope((scope) => {
          scope.setTag("service", "twilio-sms-status");
          scope.setTag("reason", "invalid_signature");
          scope.setExtras({
            ip: getClientIp(headers),
            userAgent: headers.get("user-agent") || "unknown",
          });
          Sentry.captureMessage("Twilio SMS status webhook signature invalid (sampled)", "warning");
        });
      }
      return emptyTwiml(200);
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

    // 4a. Idempotency + lifecycle regression guard.
    //     Twilio re-fires callbacks; ignore duplicates (status already there)
    //     and never regress (e.g., delivered → sent shouldn't happen but guard anyway).
    if (confirmation.status === nextStatus) {
      return emptyTwiml(200);
    }
    if (statusRank(confirmation.status) > statusRank(nextStatus)) {
      console.log(
        `[TwilioSMSStatus] Skipping regression for ${messageSid}: ${confirmation.status} → ${nextStatus}`
      );
      return emptyTwiml(200);
    }
    // 4b. Terminal-state collision guard.
    //     delivered, undelivered, failed all share rank 2 — without this guard,
    //     an out-of-order `undelivered` callback arriving AFTER `delivered`
    //     would silently overwrite the success row. Log the discrepancy and
    //     skip the update so the Twilio console / Grafana can investigate.
    const TERMINAL = new Set(["delivered", "undelivered", "failed"]);
    if (TERMINAL.has(confirmation.status) && TERMINAL.has(nextStatus)) {
      console.warn(
        `[TwilioSMSStatus] Terminal-state collision for ${messageSid}: ${confirmation.status} → ${nextStatus} (keeping ${confirmation.status})`
      );
      Sentry.withScope((scope) => {
        scope.setTag("service", "twilio-sms-status");
        scope.setTag("reason", "terminal_state_collision");
        scope.setExtras({
          messageSid,
          confirmationId: confirmation.id,
          currentStatus: confirmation.status,
          incomingStatus: nextStatus,
        });
        Sentry.captureMessage(
          `Twilio status terminal collision: ${confirmation.status} → ${nextStatus}`,
          "warning"
        );
      });
      return emptyTwiml(200);
    }

    // 5. Apply the update — guards 4a/4b above already short-circuited
    //    duplicates, regressions, and terminal-state collisions.
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

    // Conditional update on the current status — if a racing webhook already
    // applied the same advance (rare; Twilio re-fires across data centers),
    // this no-ops cleanly instead of double-bumping updated_at.
    const { error: updateErr } = await (supabase as any)
      .from("appointment_confirmations")
      .update(updates)
      .eq("id", confirmation.id)
      .eq("status", confirmation.status);

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

// Higher rank = further along the lifecycle. Used to block regressions when
// Twilio re-fires an earlier callback after we've already advanced the row.
function statusRank(status: string): number {
  switch (status) {
    case "pending": return 0;
    case "sent": return 1;
    case "delivered":
    case "undelivered":
    case "failed":
    case "opted_out":
    case "skipped_cap":
    case "skipped_no_contact":
    case "skipped_disabled":
      return 2;
    default: return 0;
  }
}
