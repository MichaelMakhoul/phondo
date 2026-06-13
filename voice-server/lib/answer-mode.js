const { getSupabase } = require("./supabase");
const { Sentry } = require("./sentry");
const { maskPhone } = require("./mask-phone");
const { SENTRY_REASONS, setReasonTag } = require("./sentry-reasons");
const { computeLapseState } = require("./lapse-state");

/**
 * Emit a Sentry event for a fail-open path in the AI-enabled check.
 * Centralised so all four call sites tag identically — Grafana alerts
 * key off `reason=fail-open` (or the specific sub-reason) to fire when
 * customer intent (AI paused) is being silently violated.
 *
 * Wrapped in try/catch as defense-in-depth: a defect in the Sentry shim
 * must not propagate out and crash the route that called us.
 *
 * SCRUM-297: `reason` is now typed against `SENTRY_REASONS` via JSDoc.
 * Callers pass `SENTRY_REASONS.FAIL_OPEN` / `SENTRY_REASONS.CONTEXT_LOOKUP_FAILED`
 * etc. so a typo trips IDE diagnostics instead of silently breaking
 * the matching Grafana alert rule.
 *
 * @param {unknown} err
 * @param {import("./sentry-reasons").SentryReason} reason
 * @param {string} calledNumber
 * @param {"warning" | "error"} [level]
 * @param {Record<string, unknown>} [extras]
 */
function captureFailOpen(err, reason, calledNumber, level = "warning", extras = {}) {
  try {
    Sentry.withScope((scope) => {
      scope.setTag("service", "voice-server");
      setReasonTag(scope, reason);
      scope.setLevel(level);
      scope.setExtras({
        calledMasked: maskPhone(calledNumber),
        ...extras,
      });
      Sentry.captureException(err);
    });
  } catch (sentryErr) {
    console.error("[AnswerMode] captureFailOpen failed (suppressed):", sentryErr.message);
  }
}

/**
 * SCRUM-408: whether the subscription gate is active. Read at CALL time (not
 * module load) so the Fly secret can be flipped without a restart and tests can
 * toggle it. Default OFF — deploying this code is a no-op until it is "true".
 */
function subscriptionGateEnabled() {
  return process.env.ENFORCE_SUBSCRIPTION_GATE === "true";
}

/**
 * SCRUM-476: optional grace / reclaim window overrides for the lapse machine,
 * read at CALL time (not module load) so a Fly secret can be flipped without a
 * restart — same rationale as subscriptionGateEnabled(). Returns a config for
 * computeLapseState; when neither override is set/valid the helper falls back to
 * its own DEFAULT_GRACE_DAYS / DEFAULT_RECLAIM_DAYS.
 *
 * Defensive parse: only a finite, strictly-positive number is honoured. This
 * deliberately ignores empty-string (Number("") === 0), NaN and non-positive
 * values so a fat-fingered secret cannot silently zero out the grace window and
 * cut customers off the instant they lapse — the opposite of this ticket's intent.
 *
 * @returns {{ graceDays?: number, reclaimDays?: number }}
 */
function readLapseConfig() {
  /** @type {{ graceDays?: number, reclaimDays?: number }} */
  const cfg = {};
  const grace = Number(process.env.GRACE_WINDOW_DAYS);
  if (Number.isFinite(grace) && grace > 0) cfg.graceDays = grace;
  const reclaim = Number(process.env.RECLAIM_WINDOW_DAYS);
  if (Number.isFinite(reclaim) && reclaim > 0) cfg.reclaimDays = reclaim;
  return cfg;
}

/**
 * SCRUM-408 / SCRUM-476: whether an org's subscription permits AI call answering
 * on the live inbound-call path.
 *
 * Delegates to the shared lapse-state machine (computeLapseState, JS port in
 * ./lapse-state) so the call gate, the lapse-sweep cron and the dashboard banner
 * all read ONE timeline: active → in_grace → lapsed → release_pending. `callable`
 * is true for `active` and `in_grace` only.
 *
 * SCRUM-476 behavior change (DELIBERATE — pinned by answer-mode-grace.test.js):
 * canceled / incomplete_expired / unpaid / expired-trial now stay CALLABLE for
 * the grace window (DEFAULT_GRACE_DAYS, override GRACE_WINDOW_DAYS) and only
 * divert AFTER it. Previously canceled / incomplete_expired / unpaid were blocked
 * the instant they lapsed and an expired trial was blocked immediately; the grace
 * window now gives a lapsed customer a few days to recover before calls fall
 * through to the existing kill-switch ladder (fallback_forward_number → Dial →
 * voicemail). past_due is STILL always callable — it is Stripe's own dunning
 * grace and never enters this machine.
 *
 * FAIL-OPEN: gate off, null/undefined subscription, a terminal status with no
 * usable anchor, or ANY throw from the lapse machine → callable. We never cut a
 * customer off on missing/malformed data or a helper defect; the audited exploit
 * (post-grace freeloading) is still blocked once the window elapses.
 *
 * @param {{ status?: string, trial_end?: string | null, service_ended_at?: string | null, current_period_end?: string | null } | null} [subscription]
 * @returns {boolean}
 */
function isSubscriptionCallable(subscription) {
  if (!subscriptionGateEnabled()) return true; // dormant unless explicitly enabled
  if (!subscription) return true; // unknown / no row → allow (fail-open)
  try {
    // Pure helper: pass the clock in (Date.now) so the gate, cron and banner
    // share one notion of "now". Returns callable=true for active + in_grace.
    return computeLapseState(subscription, Date.now(), readLapseConfig()).callable;
  } catch (err) {
    // The lapse machine is pure and parity-tested and is fed a plain DB row, so a
    // throw here is effectively unreachable in production — but if it ever does,
    // fail OPEN rather than drop a paying customer's call, matching this file's ethos.
    console.error("[AnswerMode] computeLapseState failed (fail-open, callable):", err.message);
    return true;
  }
}

/**
 * Extract the single subscription row embedded under `organizations` by
 * lookupPhoneNumber. PostgREST may return it as an object or a one-element
 * array depending on relationship detection; tolerate both and undefined.
 *
 * @param {{ organizations?: { subscriptions?: any } } | null} [phoneRecord]
 * @returns {{ status?: string, trial_end?: string | null, service_ended_at?: string | null, current_period_end?: string | null } | null}
 */
function getEmbeddedSubscription(phoneRecord) {
  const subs = phoneRecord && phoneRecord.organizations && phoneRecord.organizations.subscriptions;
  if (!subs) return null;
  return Array.isArray(subs) ? (subs[0] || null) : subs;
}

/**
 * Single phone_numbers lookup used by /twiml to avoid redundant DB queries.
 * Returns the combined data needed by isAiEnabled, getAnswerMode, getPhoneNumberContext,
 * and loadCallContext — or null if not found.
 *
 * @param {string} calledNumber - E.164 phone number
 * @param {object} [opts] - Optional context for observability
 * @param {string} [opts.callSid] - CallSid for Sentry triage (correlates alert → call leg)
 */
async function lookupPhoneNumber(calledNumber, opts = {}) {
  try {
    const supabase = getSupabase();
    // Only embed the subscription when the gate is on, so the hot-path query is
    // byte-identical to before when ENFORCE_SUBSCRIPTION_GATE is unset.
    const orgEmbed = subscriptionGateEnabled()
      ? "organizations(name, country, recording_consent_mode, business_state, recording_disclosure_text, subscriptions(status, trial_end, service_ended_at, current_period_end))"
      : "organizations(name, country, recording_consent_mode, business_state, recording_disclosure_text)";
    const { data: phone, error } = await supabase
      .from("phone_numbers")
      .select(`id, organization_id, assistant_id, ai_enabled, fallback_forward_number, user_phone_number, forwarding_status, source_type, ${orgEmbed}`)
      .eq("phone_number", calledNumber)
      .eq("is_active", true)
      .single();

    if (error || !phone) {
      if (error && error.code !== "PGRST116") {
        console.error("[AnswerMode] lookupPhoneNumber DB error:", {
          calledNumber, code: error.code, message: error.message,
        });
        // This is the prefetched hot path's fail-open source — a DB read
        // failure here cascades into isAiEnabled returning `true`, violating
        // any customer who has deliberately paused AI. Page on it.
        captureFailOpen(error, SENTRY_REASONS.FAIL_OPEN, calledNumber, "error", { callSid: opts.callSid });
      }
      return null;
    }
    return phone;
  } catch (err) {
    console.error("[AnswerMode] lookupPhoneNumber failed:", err.message);
    captureFailOpen(err, SENTRY_REASONS.FAIL_OPEN, calledNumber, "error", { callSid: opts.callSid });
    return null;
  }
}

/**
 * Check if AI answering is enabled for a phone number.
 * Fail-open: returns true if DB is unreachable (false negative > dropping calls).
 *
 * @param {string} calledNumber - E.164 phone number
 * @param {object} [prefetchedPhone] - Optional pre-fetched phone record from lookupPhoneNumber()
 * @param {object} [opts] - Optional context for observability
 * @param {string} [opts.callSid] - CallSid for Sentry triage
 */
async function isAiEnabled(calledNumber, prefetchedPhone, opts = {}) {
  try {
    // If pre-fetched data provided, use it directly
    if (prefetchedPhone !== undefined) {
      if (!prefetchedPhone) return true; // fail-open: no record found
      if (prefetchedPhone.ai_enabled === false) return false;
      // SCRUM-408: also gate on subscription status. Dormant unless
      // ENFORCE_SUBSCRIPTION_GATE=true; fail-open for missing/unknown/in-grace
      // subs. A blocked org returns false here and falls through the existing
      // kill-switch path to forwarding/voicemail (never a dropped call).
      const sub = getEmbeddedSubscription(prefetchedPhone);
      if (!isSubscriptionCallable(sub)) {
        // Distinct, greppable marker so a billing-gate diversion is
        // distinguishable from an owner-paused (ai_enabled=false) call in Loki
        // during and after the flag rollout. Includes the status so a wrong
        // block (bad Stripe mapping) is diagnosable.
        console.log("[AnswerMode] subscription-gate block — routing call to fallback/voicemail:", {
          organizationId: prefetchedPhone.organization_id,
          subscriptionStatus: sub && sub.status ? sub.status : null,
        });
        return false;
      }
      return true;
    }

    // Original standalone behavior (for backwards compat).
    // NOTE (SCRUM-408): the subscription gate is applied only in the prefetched
    // path above — this standalone query intentionally does not fetch the
    // subscription embed. The sole production caller (kill-switch) always
    // prefetches, so this branch is effectively legacy; a future direct caller
    // would bypass the billing gate (acceptable: fail-open) and should prefetch.
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("phone_numbers")
      .select("ai_enabled")
      .eq("phone_number", calledNumber)
      .eq("is_active", true)
      .single();
    if (error) {
      // PGRST116 = "no rows" — expected for unknown numbers
      if (error.code !== "PGRST116") {
        console.error("[AnswerMode] isAiEnabled DB error (fail-open):", {
          calledNumber, code: error.code, message: error.message,
        });
        // Real DB error → customer intent (paused AI) may be violated. Page on this.
        captureFailOpen(error, SENTRY_REASONS.FAIL_OPEN, calledNumber, "error", { callSid: opts.callSid });
      }
      return true; // fail-open
    }
    if (!data) return true; // fail-open
    return data.ai_enabled !== false;
  } catch (err) {
    console.error("[AnswerMode] isAiEnabled check failed (fail-open):", err.message);
    captureFailOpen(err, SENTRY_REASONS.FAIL_OPEN, calledNumber, "error", { callSid: opts.callSid });
    return true; // fail-open
  }
}

/**
 * Look up the answer mode for a phone number.
 * Returns { answerMode, ringFirstNumber, ringFirstTimeout } or null.
 *
 * @param {string} calledNumber - E.164 phone number
 * @param {object} [prefetchedPhone] - Optional pre-fetched phone record from lookupPhoneNumber()
 */
async function getAnswerMode(calledNumber, prefetchedPhone) {
  const supabase = getSupabase();

  let phone = prefetchedPhone;
  if (!phone) {
    // Standalone query (backwards compat)
    const { data, error: phoneError } = await supabase
      .from("phone_numbers")
      .select("assistant_id")
      .eq("phone_number", calledNumber)
      .eq("is_active", true)
      .eq("ai_enabled", true)
      .single();

    if (phoneError || !data) return null;
    phone = data;
  }

  if (!phone.assistant_id) return null;

  // When using prefetched data, check ai_enabled (standalone query already filters it)
  if (prefetchedPhone && phone.ai_enabled === false) return null;

  // Get assistant settings
  const { data: assistant, error: assistantError } = await supabase
    .from("assistants")
    .select("settings")
    .eq("id", phone.assistant_id)
    .single();

  if (assistantError || !assistant) return null;

  const settings = assistant.settings || {};
  if (settings.answerMode !== "ring_first") return null;

  const ringFirstNumber = settings.ringFirstNumber;
  if (!ringFirstNumber || !/^\+\d{7,15}$/.test(ringFirstNumber)) return null;

  const ringFirstTimeout = Math.max(5, Math.min(60, settings.ringFirstTimeout || 20));

  return { answerMode: "ring_first", ringFirstNumber, ringFirstTimeout };
}

/**
 * Look up organization, assistant, and phone number IDs for a called number.
 * Used to create call records for owner-answered ring-first calls AND for the
 * kill-switch fallback path, where "phone exists but no assistant assigned"
 * is a legitimate operational state (customer mid-onboarding, or deliberately
 * leaving AI off while a fallback handles calls).
 *
 * Returns { organizationId, assistantId, phoneNumberId, organizationName }.
 * `assistantId` is `null` when the phone has no assistant assigned — callers
 * (createCallRecord, notifyCallCompleted, deliverWebhooks, increment_call_usage)
 * all tolerate null today, and `calls.assistant_id` is nullable in the DB.
 *
 * Returns null only when the phone row itself cannot be found.
 *
 * @param {string} calledNumber - E.164 phone number
 * @param {object} [prefetchedPhone] - Optional pre-fetched phone record from lookupPhoneNumber()
 * @param {object} [opts] - Optional context for observability
 * @param {string} [opts.callSid] - CallSid for Sentry triage
 */
async function getPhoneNumberContext(calledNumber, prefetchedPhone, opts = {}) {
  if (prefetchedPhone) {
    return {
      organizationId: prefetchedPhone.organization_id,
      assistantId: prefetchedPhone.assistant_id || null,
      phoneNumberId: prefetchedPhone.id,
      organizationName: prefetchedPhone.organizations?.name || null,
    };
  }

  // Original standalone query
  const supabase = getSupabase();

  const { data: phone, error } = await supabase
    .from("phone_numbers")
    .select("id, organization_id, assistant_id, organizations(name)")
    .eq("phone_number", calledNumber)
    .eq("is_active", true)
    .single();

  if (error && error.code !== "PGRST116") {
    // Real DB error (not "no rows") — surface so we can tell silent skips
    // ("no record") apart from broken lookups.
    console.error("[AnswerMode] getPhoneNumberContext DB error:", {
      calledNumber, code: error.code, message: error.message,
    });
    captureFailOpen(error, SENTRY_REASONS.CONTEXT_LOOKUP_FAILED, calledNumber, "warning", { callSid: opts.callSid });
  }
  if (error || !phone) return null;

  return {
    organizationId: phone.organization_id,
    assistantId: phone.assistant_id || null,
    phoneNumberId: phone.id,
    organizationName: phone.organizations?.name || null,
  };
}

module.exports = {
  lookupPhoneNumber,
  isAiEnabled,
  getAnswerMode,
  getPhoneNumberContext,
  // SCRUM-408 — exported for unit tests / reuse.
  isSubscriptionCallable,
  getEmbeddedSubscription,
  subscriptionGateEnabled,
};
