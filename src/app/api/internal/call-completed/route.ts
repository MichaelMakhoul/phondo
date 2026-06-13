import { NextResponse } from "next/server";
import { runAfterResponse } from "@/lib/utils/after-response";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzeCall, type CallMetadata } from "@/lib/spam/spam-detector";
import {
  sendMissedCallNotification,
  sendFailedCallNotification,
  sendUnsuccessfulCallNotification,
} from "@/lib/notifications/notification-service";
import { classifyCallNotification } from "@/lib/notifications/classify-call";
import { sendMissedCallTextBack } from "@/lib/sms/caller-sms";
import { deliverWebhooks } from "@/lib/integrations/webhook-delivery";
import { withRateLimit } from "@/lib/security/rate-limiter";

function verifyInternalSecret(request: Request): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error("[Internal] INTERNAL_API_SECRET is not configured — all internal API requests will be rejected");
    return false;
  }

  const headerSecret = request.headers.get("X-Internal-Secret");
  if (!headerSecret) return false;

  const secretBuffer = Buffer.from(secret);
  const headerBuffer = Buffer.from(headerSecret);
  if (secretBuffer.length !== headerBuffer.length) return false;

  return crypto.timingSafeEqual(secretBuffer, headerBuffer);
}

interface CallCompletedPayload {
  callId: string | null;
  organizationId: string;
  // Null when the phone number had no assistant assigned (kill-switch
  // fallback / mid-onboarding / etc.) — the webhook still fires for billing
  // and notification purposes, just without the assistant-name lookup at line 261.
  assistantId: string | null;
  callerPhone: string;
  status: string;
  durationSeconds: number;
  transcript?: string;
  endedReason?: string;
  summary?: string;
  callerName?: string;
  collectedData?: Record<string, unknown>;
  successEvaluation?: string;
  unansweredQuestions?: string[];
}

/**
 * Internal endpoint called by the self-hosted voice server after a call ends.
 * Runs spam analysis, updates call record, increments billing, sends notifications, and delivers webhooks.
 */
export async function POST(request: Request) {
  // Rate limit
  const { allowed, headers: rlHeaders } = withRateLimit(request, "/api/internal/call-completed", "webhook");
  if (!allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: rlHeaders });
  }

  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: CallCompletedPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    callId,
    organizationId,
    assistantId,
    callerPhone,
    status,
    durationSeconds,
    transcript,
    endedReason,
    summary,
    callerName,
    collectedData,
    successEvaluation,
    unansweredQuestions,
  } = payload;

  if (!organizationId || typeof organizationId !== "string") {
    return NextResponse.json({ error: "Missing or invalid organizationId" }, { status: 400 });
  }

  if (typeof durationSeconds !== "number" || durationSeconds < 0) {
    return NextResponse.json({ error: "Invalid durationSeconds" }, { status: 400 });
  }

  const validStatuses = ["completed", "failed", "missed", "in-progress"];
  if (!status || !validStatuses.includes(status)) {
    return NextResponse.json({ error: `Invalid status, must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
  }

  const supabase = createAdminClient();

  // 1. Run spam analysis
  let spamAnalysis = null;
  let spamAnalysisFailed = false;
  if (callerPhone) {
    // The timing heuristic needs the ORG's timezone (scoring "unusual hours"
    // in server-UTC penalized every AU business-hours call — SCRUM-418), and
    // phone-format analysis needs the org's country (defaulting to US rules
    // mis-scored AU numbers). Fail-soft: on lookup error both stay undefined —
    // the timing signal is dropped and country falls back to US.
    let orgTimezone: string | undefined;
    let orgCountry: string | undefined;
    const { data: orgRow, error: orgError } = await (supabase as any)
      .from("organizations")
      .select("timezone, country")
      .eq("id", organizationId)
      .single();
    if (orgError) {
      console.error("[Internal] Failed to fetch org timezone/country for spam analysis — timing signal will be dropped:", {
        organizationId, error: orgError,
      });
    } else {
      orgTimezone = orgRow?.timezone || undefined;
      orgCountry = orgRow?.country || undefined;
      if (!orgTimezone) {
        // Third drop flavor (lookup OK, column NULL/empty) — keep it as
        // observable as the lookup-error and invalid-identifier paths.
        console.warn("[Internal] Org has no timezone — spam timing signal dropped:", { organizationId });
      } else if ((orgCountry || "").toUpperCase() === "AU" && !orgTimezone.startsWith("Australia/")) {
        // organizations.timezone has DB default 'America/New_York' — an AU
        // org stuck on the default gets its calls timing-scored in NY time
        // (9am Sydney = ~7pm New York). Cheap drift guard so the bad row is
        // findable in logs (SCRUM-441).
        console.warn("[Internal] AU org has a non-Australian timezone — spam timing signal will be scored in the wrong zone:", {
          organizationId, timezone: orgTimezone,
        });
      }
    }

    const spamMetadata: CallMetadata = {
      callerPhone,
      organizationId,
      countryCode: orgCountry,
      timestamp: new Date(),
      timezone: orgTimezone,
      duration: durationSeconds,
      transcript,
    };

    try {
      spamAnalysis = await analyzeCall(spamMetadata);
      console.log("[Internal] Spam analysis:", {
        callId,
        isSpam: spamAnalysis.isSpam,
        score: spamAnalysis.spamScore,
        recommendation: spamAnalysis.recommendation,
      });
    } catch (err) {
      console.error("[Internal] Spam analysis failed — call will be treated as non-spam:", err);
      spamAnalysisFailed = true;
    }
  }

  // 2. Update call record with spam results (merge metadata, don't overwrite).
  // completeCallRecord writes voice_provider + disclosure flags + successEvaluation
  // in a single update. notifyCallCompleted (which triggers this route) is called
  // after await completeCallRecord() in server.js cleanupSession(), so metadata
  // is already written by the time this route runs. Do NOT parallelize those calls.
  if (callId && spamAnalysis) {
    const { data: existingCall, error: fetchError } = await (supabase as any)
      .from("calls")
      .select("metadata")
      .eq("id", callId)
      .single();

    if (fetchError) {
      console.error("[Internal] Failed to fetch existing call metadata — skipping metadata merge to avoid data loss:", {
        callId, error: fetchError,
      });
    }

    const existingMetadata = fetchError ? null : (existingCall?.metadata || {});
    // If metadata fetch failed, still update spam columns but skip metadata merge
    const updatePayload: Record<string, unknown> = {
      is_spam: spamAnalysis.isSpam,
      spam_score: spamAnalysis.spamScore,
    };
    // Add structured analysis fields if provided by voice server
    if (summary) updatePayload.summary = summary;
    if (callerName) updatePayload.caller_name = callerName;
    if (collectedData) updatePayload.collected_data = collectedData;
    if (existingMetadata !== null) {
      updatePayload.metadata = {
        ...existingMetadata,
        ended_reason: endedReason,
        ...(successEvaluation && { successEvaluation }),
        ...(unansweredQuestions && unansweredQuestions.length > 0 && { unansweredQuestions }),
        spam_analysis: {
          reasons: spamAnalysis.reasons,
          confidence: spamAnalysis.confidence,
          recommendation: spamAnalysis.recommendation,
        },
      };
    }
    const { error: updateError } = await (supabase as any)
      .from("calls")
      .update(updatePayload)
      .eq("id", callId);

    if (updateError) {
      console.error("[Internal] Failed to update call with spam data:", { callId, error: updateError });
    }
  }

  // 3. Increment billing (skip spam calls, matching Vapi flow)
  const shouldTrackUsage = status === "completed" &&
    (!spamAnalysis?.isSpam || spamAnalysis?.recommendation !== "block");

  if (shouldTrackUsage) {
    // SCRUM-432 (finding #48): claim + increment in ONE transaction via the
    // claim_and_increment_call_usage RPC (migration 00154) — the old
    // two-round-trip claim→increment lost the count if the function died in
    // the gap. Idempotency (SCRUM-361) is inside the RPC: only the first
    // caller wins the usage_counted flip; retries return false and skip.
    try {
      if (callId) {
        const { data: counted, error: rpcError } = await (supabase as any).rpc(
          "claim_and_increment_call_usage",
          { p_call_id: callId, p_org_id: organizationId }
        );
        if (rpcError) {
          // Fail CLOSED (skip) — a dropped count on a rare DB blip is
          // recoverable; a double-bill is not.
          console.error("[Internal] claim_and_increment_call_usage failed (skipping to avoid double-bill):", { callId, organizationId, error: rpcError });
        } else if (counted === false) {
          // FALSE covers three states: already counted (benign retry), no
          // matching call row, or a callId/org mismatch — the RPC can't
          // distinguish them yet (tri-state return tracked in SCRUM-451).
          console.log("[Internal] Usage claim not won — already counted, call row missing, or org mismatch; skipping:", { callId, organizationId });
        }
      } else {
        // No callId → no call row to key on (the rare kill-switch fallback
        // where createCallRecord failed at call start). Use the plain atomic
        // increment without the idempotency guard; warn so this one
        // non-idempotent path stays visible. The old racy read-modify-write
        // fallback (for a missing RPC) is gone — the RPC has existed since
        // migration 00011 and a missing function is a deploy fault to
        // surface, not to paper over with a non-atomic write.
        console.warn("[Internal] Incrementing usage without idempotency guard — callId absent (no call row):", { organizationId });
        const { error: rpcError } = await (supabase as any).rpc("increment_call_usage", {
          org_id: organizationId,
        });
        if (rpcError) {
          console.error("[Internal] Failed to increment usage:", { organizationId, error: rpcError });
        }
      }
    } catch (err) {
      console.error("[Internal] Billing increment failed:", err);
    }
  }

  // 4. Send notifications (skip spam calls)
  //
  // Classification (SCRUM-281 + SCRUM-299). Order matters — the most specific
  // signal wins:
  //   1. status "failed"                    -> failed-call (technical failure)
  //   2. AI engaged + rated unsuccessful     -> unsuccessful-call (NEW)
  //      (has transcript AND successEvaluation in {unsuccessful, partial})
  //   3. very short, no engagement           -> missed-call
  //   4. otherwise                           -> no email (successful, or a
  //      booking/callback that fires its own notification)
  //
  // Before SCRUM-299, an AI-engaged-but-unsatisfactory call (e.g. caller asked
  // for a transfer the AI fumbled, then hung up at 41s) was mislabeled "Missed
  // Call". It now correctly routes to the unsuccessful-call alert.
  const hasTranscript = !!(transcript && transcript.trim().length > 0);
  const notificationKind = classifyCallNotification({
    status,
    durationSeconds,
    hasTranscript,
    successEvaluation,
  });
  // The senders report their real outcome (SCRUM-442): "sent" when at least
  // one channel was attempted and succeeded, "skipped" when every channel was
  // disabled by preference (previously misreported here as "sent").
  let notificationStatus: "sent" | "skipped" | "failed" = "skipped";
  if (!spamAnalysis?.isSpam) {
    try {
      if (notificationKind === "failed") {
        notificationStatus = await sendFailedCallNotification({
          organizationId,
          callId: callId || "unknown",
          callerPhone: callerPhone || "Unknown",
          timestamp: new Date(),
          duration: durationSeconds,
          transcript,
          failureReason: humanizeEndedReason(endedReason),
          endedReason,
        });
      } else if (notificationKind === "unsuccessful") {
        // AI answered and engaged but didn't satisfy the caller — a lead the
        // owner may be losing. Distinct from a truly missed call (SCRUM-281/299).
        notificationStatus = await sendUnsuccessfulCallNotification({
          organizationId,
          callId: callId || "unknown",
          callerPhone: callerPhone || "Unknown",
          timestamp: new Date(),
          duration: durationSeconds,
          transcript,
          summary,
          successEvaluation,
        });
      } else if (notificationKind === "missed") {
        // Very short AND no transcript = caller hung up before the AI engaged.
        notificationStatus = await sendMissedCallNotification({
          organizationId,
          callId: callId || "unknown",
          callerPhone: callerPhone || "Unknown",
          timestamp: new Date(),
          duration: durationSeconds,
        });
      }
    } catch (err) {
      console.error("[Internal] Failed to send notification — business owner will NOT be alerted:", {
        callId, organizationId, status, error: err,
      });
      notificationStatus = "failed";
    }

    if (spamAnalysisFailed && notificationStatus === "sent") {
      console.warn("[Internal] Notification sent despite spam analysis failure — may be for a spam call:", { callId });
    }

    // 4b. Send text-back SMS to caller for any call that didn't go well —
    // failed, missed, OR AI-engaged-but-unsuccessful. The unsuccessful case is
    // the most valuable to recover (a real lead who reached the AI and left
    // unsatisfied), so it must get the booking-link text-back too — not just
    // the short/missed calls. SCRUM-281 review follow-up.
    const shouldTextBack =
      notificationKind === "failed" ||
      notificationKind === "missed" ||
      notificationKind === "unsuccessful";
    if (shouldTextBack && !spamAnalysisFailed && callerPhone && callerPhone !== "Unknown") {
      // after() (not bare fire-and-forget) so the text-back survives Vercel's
      // post-response function freeze (SCRUM-410).
      runAfterResponse(async () => {
        try {
          await sendMissedCallTextBack(organizationId, callerPhone, spamAnalysis?.isSpam);
        } catch (err) {
          console.error("[Internal] Caller text-back failed:", { callId, organizationId, error: err });
        }
      });
    }
  }

  // 5. Deliver webhooks to user integrations
  let assistantName: string | null = null;
  if (assistantId) {
    const { data: assistantRecord, error: assistantError } = await (supabase as any)
      .from("assistants")
      .select("name")
      .eq("id", assistantId)
      .single();
    if (assistantError) {
      console.error("[Internal] Failed to look up assistant name for webhook:", { assistantId, error: assistantError });
    }
    if (assistantRecord) assistantName = assistantRecord.name;
  }

  // Map "failed" status to "call.missed" webhook event since there is no
  // "call.failed" event type — from the customer's perspective, a failed
  // call is functionally equivalent to a missed one.
  const webhookEvent = (status === "failed" || status === "missed")
    ? "call.missed" as const
    : "call.completed" as const;

  // after() so webhook delivery survives Vercel's post-response freeze (SCRUM-410).
  runAfterResponse(async () => {
    try {
      await deliverWebhooks(organizationId, webhookEvent, {
        callId: callId || "unknown",
        caller: callerPhone || "Unknown",
        transcript,
        duration: durationSeconds,
        assistantName,
        outcome: status,
      });
    } catch (err) {
      console.error("[Internal] Webhook delivery failed:", {
        organizationId, callId: callId || "unknown", webhookEvent, error: err,
      });
    }
  });

  return NextResponse.json({ received: true, notificationStatus });
}

function humanizeEndedReason(endedReason: string | undefined): string {
  switch (endedReason) {
    case "stt-error":
      return "The speech recognition system failed during the call.";
    case "llm-error":
      return "The AI assistant encountered a technical error and couldn't respond.";
    case "tts-error":
      return "The voice system failed during the call.";
    case "server-error":
      return "The voice server encountered an error processing the call.";
    default:
      if (!endedReason) return "The call ended unexpectedly for an unknown reason.";
      // Only use known safe characters in the reason string
      const safeReason = endedReason.substring(0, 100).replace(/[<>&"']/g, "");
      return `The call ended unexpectedly (${safeReason}).`;
  }
}
