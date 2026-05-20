const { getSupabase } = require("./supabase");
const { Sentry } = require("./sentry");
const { maskPhone } = require("./mask-phone");
const { SENTRY_REASONS, setReasonTag } = require("./sentry-reasons");

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
    const { data: phone, error } = await supabase
      .from("phone_numbers")
      .select("id, organization_id, assistant_id, ai_enabled, fallback_forward_number, user_phone_number, forwarding_status, source_type, organizations(name, country, recording_consent_mode, business_state, recording_disclosure_text)")
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
      return prefetchedPhone.ai_enabled !== false;
    }

    // Original standalone behavior (for backwards compat)
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

module.exports = { lookupPhoneNumber, isAiEnabled, getAnswerMode, getPhoneNumberContext };
