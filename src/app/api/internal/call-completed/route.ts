import { NextResponse } from "next/server";
import { runAfterResponse } from "@/lib/utils/after-response";
import { checkPlanUsageAlert } from "@/lib/billing/plan-usage-alert";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzeCall, type CallMetadata } from "@/lib/spam/spam-detector";
import {
  sendMissedCallNotification,
  sendFailedCallNotification,
  sendUnsuccessfulCallNotification,
  sendOwnerPinLockedNotification,
  sendOwnerAssistantRecapNotification,
  sendCustomerCallOutcomeNotification,
} from "@/lib/notifications/notification-service";
import { classifyCallNotification } from "@/lib/notifications/classify-call";
import { humanizeEndedReason } from "@/lib/notifications/humanize-ended-reason";
import { sendMissedCallTextBack } from "@/lib/sms/caller-sms";
import { deliverWebhooks } from "@/lib/integrations/webhook-delivery";
import { withRateLimit, rateLimitDistributed } from "@/lib/security/rate-limiter";
import { maskPhoneForOwner } from "@/lib/owner-assistant/mask-phone";
import { formatOwnerLockTime } from "@/lib/owner-assistant/lock-email-time";
import { isOwnerCallMetadata, isCustomerNotifyCallMetadata, CUSTOMER_NOTIFY_CALL_TYPE } from "@/lib/owner-assistant/owner-call";
import { buildOwnerRecap } from "@/lib/owner-assistant/recap";
import { buildCallOutcome } from "@/lib/owner-assistant/call-outcome";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";

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
  // and notification purposes, just without the assistant-name lookup at step 5.
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
  /** Informational: the voice server's own word on the call's type. The route reads
   *  calls.metadata; only an unreadable row falls back to this (SCRUM-598). */
  callType?: string;
}

/**
 * SCRUM-586: stamp calls.metadata.owner_lock_emailed_at once the lockout email
 * has gone out, so a reprocessed call is not emailed twice. Best-effort and
 * never throws — the email is already sent, and a failed stamp must neither turn
 * that into a failure nor take the rest of the route down with it.
 *
 * Re-reads calls.metadata immediately before the write and merges ONLY this key.
 * The route's first read is stale by now (the spam merge, and the voice server's
 * own post-call writers, have touched the row since) and writing that copy back
 * would silently undo them. If the re-read fails no stamp is written at all: the
 * cost is a possible repeat email for a reprocessed call, never lost call data.
 */
async function stampOwnerLockEmailed(
  supabase: ReturnType<typeof createAdminClient>,
  callId: string
): Promise<void> {
  const stampFailed = "[Internal] Could not stamp owner_lock_emailed_at — a reprocessed call could repeat the lockout email:";
  try {
    const { data: fresh, error: readError } = await (supabase as any)
      .from("calls")
      .select("metadata")
      .eq("id", callId)
      .single();
    if (readError) {
      console.error(stampFailed, { callId, stage: "re-read", error: readError });
      return;
    }
    const { error: writeError } = await (supabase as any)
      .from("calls")
      .update({ metadata: { ...(fresh?.metadata || {}), owner_lock_emailed_at: new Date().toISOString() } })
      .eq("id", callId);
    if (writeError) {
      console.error(stampFailed, { callId, stage: "write", error: writeError });
    }
  } catch (err) {
    console.error(stampFailed, { callId, stage: "unexpected", error: err });
  }
}

/**
 * SCRUM-586: the org's IANA timezone for the lockout email's "when", read here
 * only because the spam analysis (step 1) did not supply one — it never looked
 * (no caller number), its lookup failed, or the column is empty. Never throws: a
 * failed read is logged and returns undefined, and the email then reads in the
 * default zone (formatOwnerLockTime), never the server's. Dropping a security
 * alert over a timezone would be the worse failure.
 */
async function readOrgTimezoneOnce(
  supabase: ReturnType<typeof createAdminClient>,
  organizationId: string,
  purpose = "the PIN-lockout email"
): Promise<string | undefined> {
  const failed = `[Internal] Could not read the org timezone for ${purpose} — it will read in the default zone:`;
  try {
    const { data, error } = await (supabase as any)
      .from("organizations")
      .select("timezone")
      .eq("id", organizationId)
      .single();
    if (error) {
      console.error(failed, { organizationId, error });
      return undefined;
    }
    return data?.timezone || undefined;
  } catch (err) {
    console.error(failed, { organizationId, error: err });
    return undefined;
  }
}

/**
 * SCRUM-586: email the business owner that their assistant-line PIN is locked,
 * then stamp the call so a reprocessed call does not repeat it. Never throws.
 *
 * - "sent"      — the owner was emailed (and the call stamped, best-effort)
 * - "skipped"   — nothing to send (the public demo org has no owner); NOT stamped
 * - "throttled" — another lockout for this org was emailed <15 min ago; NOT sent,
 *   NOT stamped
 * - "failed"    — the owner could not be emailed. This pages [ALERT:error]: they
 *   do not know someone is guessing their PIN. NOT stamped, so it can still go.
 *
 * Only the masked number reaches the sender — never the raw caller number, and
 * the PIN is never in the voice server's payload to begin with. The time is when
 * the locked call STARTED (`startedAt`: this route runs after the call ends, and the
 * owner matches the email against their phone's call log), and it reaches the sender
 * already written in the org's zone ("Thursday 15 October at 3:04 pm"): the zone the
 * spam analysis read if there was one (`knownTimezone`), else one read of
 * organizations.timezone; an empty or unusable zone reads as Sydney.
 */
async function emailOwnerPinLockOnce(
  supabase: ReturnType<typeof createAdminClient>,
  call: {
    callId: string;
    organizationId: string;
    callerPhone: string | undefined;
    knownTimezone: string | undefined;
    startedAt: Date;
  }
): Promise<"sent" | "skipped" | "throttled" | "failed"> {
  const { callId, organizationId, callerPhone, knownTimezone, startedAt } = call;
  let outcome: "sent" | "skipped";
  try {
    const rl = await rateLimitDistributed(supabase, organizationId, "owner-lock-email", "ownerLockEmail");
    if (!rl.allowed) {
      console.warn("[Internal] PIN-lockout email throttled — at most one per org per 15 minutes:", { organizationId, callId });
      return "throttled";
    }
    const timezone = knownTimezone || (await readOrgTimezoneOnce(supabase, organizationId));
    outcome = await sendOwnerPinLockedNotification({
      organizationId,
      callId,
      callerPhoneMasked: maskPhoneForOwner(callerPhone || ""),
      localTime: formatOwnerLockTime(startedAt, timezone),
    });
  } catch (err) {
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.OWNER_PIN_LOCK_EMAIL_FAILED,
      level: "error",
      err,
      message: "owner PIN lockout email failed — the owner does not know their PIN was locked",
      extras: { organizationId, callId },
    });
    return "failed";
  }
  if (outcome === "sent") await stampOwnerLockEmailed(supabase, callId);
  return outcome;
}

/** SCRUM-597: how far before the call's start a text attempt still counts for its recap. */
const RECAP_SINCE_MARGIN_MS = 10 * 60_000;

/**
 * SCRUM-597: claim one of the call's owner emails, once. The write is conditional —
 * it only lands while metadata[key] is absent — so a retried call-completed (the
 * voice server retries a non-2xx or a timeout; SCRUM-598's status callback and a
 * session can both finish a customer call) can't send a second copy. False when
 * another delivery already claimed it. A claim that fails to read or write still
 * lets the email go: the owner asked for this safety net, and a rare duplicate is
 * the lesser harm.
 */
async function claimCallEmail(
  supabase: ReturnType<typeof createAdminClient>,
  callId: string,
  key: "owner_recap_emailed_at" | "notify_outcome_emailed_at",
  what: string
): Promise<boolean> {
  const failed = `[Internal] Could not claim the ${what} — sending anyway (a retried call could repeat it):`;
  try {
    const { data: fresh, error: readError } = await (supabase as any)
      .from("calls")
      .select("metadata")
      .eq("id", callId)
      .single();
    if (readError) {
      console.error(failed, { callId, stage: "re-read", error: readError });
      return true;
    }
    if (fresh?.metadata?.[key]) return false;
    const { data: claimed, error: writeError } = await (supabase as any)
      .from("calls")
      .update({ metadata: { ...(fresh?.metadata || {}), [key]: new Date().toISOString() } })
      .eq("id", callId)
      .is(`metadata->>${key}`, null)
      .select("id");
    if (writeError) {
      console.error(failed, { callId, stage: "write", error: writeError });
      return true;
    }
    return Array.isArray(claimed) && claimed.length > 0;
  } catch (err) {
    console.error(failed, { callId, stage: "unexpected", error: err });
    return true;
  }
}

/**
 * SCRUM-597: email the owner what their assistant actually changed on this call —
 * read from the audit trail and the text log (buildOwnerRecap), never from the
 * AI's words — so a mishearing or a made-up confirmation is caught before it
 * becomes a dispute with a customer. Nothing changed ⇒ no email. A failure pages
 * and never throws.
 */
async function emailOwnerRecapOnce(
  supabase: ReturnType<typeof createAdminClient>,
  call: { callId: string; organizationId: string; channel: "web" | "phone"; since: Date }
): Promise<"sent" | "skipped" | "no_changes" | "claimed_elsewhere" | "failed"> {
  const { callId, organizationId, channel, since } = call;
  try {
    const orgTimezone = await readOrgTimezoneOnce(supabase, organizationId, "the owner recap email");
    const timezone = orgTimezone || "Australia/Sydney";
    const items = await buildOwnerRecap(supabase, { organizationId, callId, timezone, since });
    if (items === null) throw new Error("the call's changes could not be read");
    if (items.length === 0) return "no_changes";
    if (!(await claimCallEmail(supabase, callId, "owner_recap_emailed_at", "owner recap email"))) return "claimed_elsewhere";
    return await sendOwnerAssistantRecapNotification({ organizationId, callId, channel, items, timesInDefaultZone: !orgTimezone });
  } catch (err) {
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.OWNER_RECAP_EMAIL_FAILED,
      level: "error",
      err,
      message: "owner assistant recap email failed — the owner has no record of what their assistant changed",
      extras: { organizationId, callId },
    });
    return "failed";
  }
}

/**
 * SCRUM-598: email the owner how a call the assistant placed to a customer went —
 * the phone system's result and the diary (buildCallOutcome), with the AI's own
 * note and summary labelled as such. Every finished customer call gets one, a
 * no-answer included (the owner then knows the customer wasn't told). A failure
 * pages and never throws.
 */
async function emailCustomerCallOutcomeOnce(
  supabase: ReturnType<typeof createAdminClient>,
  call: { callId: string; organizationId: string }
): Promise<"sent" | "skipped" | "claimed_elsewhere" | "failed"> {
  const { callId, organizationId } = call;
  try {
    const orgTimezone = await readOrgTimezoneOnce(supabase, organizationId, "the customer-call outcome email");
    const timezone = orgTimezone || "Australia/Sydney";
    const report = await buildCallOutcome(supabase, { organizationId, callId, timezone });
    if (report === null) throw new Error("the call's records could not be read");
    if (!(await claimCallEmail(supabase, callId, "notify_outcome_emailed_at", "customer-call outcome email"))) return "claimed_elsewhere";
    return await sendCustomerCallOutcomeNotification({ organizationId, report, timesInDefaultZone: !orgTimezone });
  } catch (err) {
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.CUSTOMER_CALL_OUTCOME_EMAIL_FAILED,
      level: "error",
      err,
      message: "customer-call outcome email failed — the owner doesn't know how the assistant's call went",
      extras: { organizationId, callId },
    });
    return "failed";
  }
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

  // SCRUM-586: read the call's stored metadata up front, for the owner-call and
  // PIN-lockout decisions only (the spam merge at step 2 re-reads right before
  // its write — this copy is stale by then). An OWNER call — the business owner
  // ringing their own assistant — is marked by the voice server's
  // completeCallRecord as metadata.call_type = 'owner' BEFORE this route is
  // called (see the ordering note at step 2). It is not a customer interaction:
  // no spam scoring, no missed/failed/unsuccessful alert (that would email the
  // owner about their own call), no caller text-back, no call.completed /
  // call.missed webhook. Billing still counts it. Read from the DB, never the
  // payload. A failed read falls back to the customer pipeline — dropping a
  // customer alert is the worse failure. The same row carries the PIN outcome
  // (metadata.owner_auth) read for the lockout email at step 4c.
  let storedMetadata: Record<string, unknown> | null = null;
  if (callId) {
    const { data: existingCall, error: fetchError } = await (supabase as any)
      .from("calls")
      .select("metadata")
      .eq("id", callId)
      .single();
    if (fetchError) {
      console.error("[Internal] Failed to fetch existing call metadata — owner-call and PIN-lockout-email checks skipped:", {
        callId, error: fetchError,
      });
      // SCRUM-597: an OWNER call read this way runs the customer pipeline and loses
      // its recap email (what the assistant changed) — so this pages, not just logs.
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.CALL_METADATA_READ_FAILED,
        level: "error",
        err: fetchError,
        message: "call metadata unreadable — an owner call would run the customer pipeline and lose its recap email",
        extras: { callId, organizationId },
      });
    } else {
      storedMetadata = (existingCall?.metadata || {}) as Record<string, unknown>;
    }
  }
  const isOwnerCall = isOwnerCallMetadata(storedMetadata);
  // SCRUM-598: a call the assistant placed to a customer for the owner. Not a customer
  // calling in: no spam scoring, no missed/failed alert, no text-back (we called
  // THEM — "sorry we missed your call" would be wrong), no integrations webhook, and
  // not a plan call (the default until the owner decides). The owner gets the call's
  // outcome email instead (step 4e). Read from the row like an owner call; only an
  // unreadable row falls back to the voice server's own word in the payload.
  const isCustomerNotifyCall = storedMetadata
    ? isCustomerNotifyCallMetadata(storedMetadata)
    : payload.callType === CUSTOMER_NOTIFY_CALL_TYPE;
  const skipCustomerPipeline = isOwnerCall || isCustomerNotifyCall;

  // 1. Run spam analysis
  let spamAnalysis = null;
  let spamAnalysisFailed = false;
  // The org's timezone as the spam analysis' org lookup read it (undefined when that
  // lookup did not run or failed, or the column is empty) — hoisted so the PIN-lockout
  // email at step 4c can quote the owner's local time without a second query.
  let orgTimezone: string | undefined;
  if (callerPhone && !skipCustomerPipeline) {
    // The timing heuristic needs the ORG's timezone (scoring "unusual hours"
    // in server-UTC penalized every AU business-hours call — SCRUM-418), and
    // phone-format analysis needs the org's country (defaulting to US rules
    // mis-scored AU numbers). Fail-soft: on lookup error both stay undefined —
    // the timing signal is dropped and country falls back to US.
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
    // Read the metadata RIGHT before the write, never reuse the hoisted copy: the
    // spam analysis ran in between, and another post-call writer (e.g. the voice
    // server's re-transcription stamping transcript_source) may have merged into
    // the same JSON since — writing the stale copy back would silently undo it.
    // (SCRUM-586 final review; same pattern as stampOwnerLockEmailed.)
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

  // 3. Increment billing (skip spam calls, matching Vapi flow). SCRUM-598: a call the
  // assistant placed to a customer is not a plan call (the default until the owner decides).
  const shouldTrackUsage = status === "completed" && !isCustomerNotifyCall &&
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
        } else if (counted === true) {
          // SCRUM-608: this call counted — a heads-up past 125% / 150% of the plan's calls.
          runAfterResponse(() => checkPlanUsageAlert(organizationId));
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
  if (!spamAnalysis?.isSpam && !skipCustomerPipeline) {
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

  // 4c. SCRUM-586: PIN lockout email. A caller from the registered owner mobile
  // who tripped the owner-line lockout (too many wrong PINs; the owner saving a
  // new PIN clears it) CONTINUED AS A CUSTOMER call — call_type is not 'owner',
  // so every step above and below applies to it unchanged. Additionally the
  // owner is emailed ONCE per locked call, deduped by metadata.owner_lock_emailed_at
  // (stamped after a successful send), and at most once per org per 15 minutes —
  // a guesser who keeps redialling is throttled, not emailed per call.
  //
  // It goes out HERE, after the step-2 write, never between that write's metadata
  // read and the write itself: a Resend round trip in that gap would stretch the
  // read-modify-write window to ~1 s. It is not spam-gated (a PIN guesser's call
  // can look like spam and the owner should still hear about it), and a failure
  // pages and never fails the route. Reads the DB row (storedMetadata), never the
  // payload. The email quotes the time the call STARTED (now minus its duration) in
  // the ORG's timezone (the one step 1 read, else one read here), never the server's
  // — see emailOwnerPinLockOnce.
  let ownerLockEmail: "sent" | "skipped" | "throttled" | "failed" | undefined;
  if (callId && storedMetadata?.owner_auth === "locked" && !storedMetadata.owner_lock_emailed_at) {
    ownerLockEmail = await emailOwnerPinLockOnce(supabase, {
      callId,
      organizationId,
      callerPhone,
      knownTimezone: orgTimezone,
      startedAt: new Date(Date.now() - durationSeconds * 1000),
    });
  }

  // 4d. SCRUM-597: the owner-assistant recap. After an OWNER call (web or phone)
  // that changed at least one booking, the owner is emailed what actually changed —
  // read from the audit trail and the text log, never from the AI's words — in case
  // the AI misheard or made something up. Whatever the call's status: a session
  // that failed after a change still made it. After the response (the voice server
  // times out at 15 s and retries), once per call (claimed on the call row); a
  // failure pages and never fails the route. Reads the DB row's metadata, never
  // the payload.
  if (isOwnerCall && callId) {
    const recapCall = {
      callId,
      organizationId,
      channel: storedMetadata?.channel === "web" ? ("web" as const) : ("phone" as const),
      // Text attempts from before the session never count (a margin covers setup).
      since: new Date(Date.now() - durationSeconds * 1000 - RECAP_SINCE_MARGIN_MS),
    };
    runAfterResponse(async () => {
      const outcome = await emailOwnerRecapOnce(supabase, recapCall);
      console.log("[Internal] Owner recap email:", { callId, organizationId, outcome });
    });
  }

  // 4e. SCRUM-598: how a call the assistant placed to a customer went — the phone
  // system's result and the diary, the AI's words labelled. Every finished customer
  // call (a no-answer too), after the response, once per call (claimed on the row).
  if (isCustomerNotifyCall && callId) {
    const outcomeCall = { callId, organizationId };
    runAfterResponse(async () => {
      const outcome = await emailCustomerCallOutcomeOnce(supabase, outcomeCall);
      console.log("[Internal] Customer-call outcome email:", { callId, organizationId, outcome });
    });
  }

  // 5. Deliver webhooks to user integrations
  // SCRUM-586: an owner call is not a customer event for integrations — nor is a
  // call the assistant placed to a customer (SCRUM-598).
  if (!skipCustomerPipeline) {
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
  }

  return NextResponse.json({
    received: true,
    notificationStatus,
    ...(isOwnerCall && { ownerCall: true }),
    ...(isCustomerNotifyCall && { customerNotifyCall: true }),
    ...(ownerLockEmail && { ownerLockEmail }),
  });
}
