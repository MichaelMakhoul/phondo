/**
 * Build the recording-consent disclosure `<Say>` snippet for a kill-switch
 * fallback `<Dial>`. Used by both `/twiml` (Twilio) and `/texml` (Telnyx)
 * handlers so the legal disclosure logic lives in exactly one place.
 *
 * Returns an empty string when the helper determines no disclosure is
 * required for the caller/org pair — the surrounding Dial XML embeds the
 * return value directly, so an empty string keeps the original behaviour.
 *
 * Defensive design (compliance-critical path):
 *   - Wrapped in try/catch so a downstream defect (regex bug, exotic
 *     business name, etc.) cannot bubble up into the surrounding kill-switch
 *     handler. If the helper bubbled, the outer fail-open catch in server.js
 *     would route the caller to AI — defeating the customer's paused-AI
 *     intent. Better to skip disclosure (compliance miss, alertable) than
 *     to silently re-enable AI on a paused org.
 *   - Sentry-pages BOTH for `disclosure-build-failed` (helper threw) and
 *     `disclosure-org-missing` (phoneRecord present but no organizations
 *     row joined — stale row / RLS edge case). Without these, a compliance
 *     gap would be silent in production.
 *   - Sentry calls are themselves try/catch'd so a shim defect cannot crash
 *     the helper.
 *
 * The disclosure text is escaped via the caller's escapeXml() to avoid
 * a separate copy of the XML-escape logic in this module.
 */

const { requiresRecordingDisclosureHybrid, getRecordingDisclosureText } = require("./recording-consent");
const { Sentry } = require("./sentry");

function safeCapture(fn) {
  try {
    fn();
  } catch (sentryErr) {
    console.error("[FallbackDialConsent] Sentry capture failed (suppressed):", sentryErr.message);
  }
}

/**
 * @param {object} args
 * @param {object|null} args.phoneRecord - The lookupPhoneNumber() result.
 *   Joined `organizations` row must include country, business_state,
 *   recording_consent_mode, recording_disclosure_text, name.
 * @param {string} args.callerPhone - E.164 caller number for state inference.
 * @param {(s: string) => string} args.escapeXml - XML escape function from the route handler.
 * @param {string|null} [args.callSid] - Optional callSid for Sentry triage.
 * @returns {string} `"  <Say voice=\"Polly.Joanna\">…</Say>\n"` or `""`.
 */
function buildFallbackDisclosureSay({ phoneRecord, callerPhone, escapeXml, callSid = null }) {
  try {
    const org = phoneRecord?.organizations;
    if (!org) {
      // No org context → can't determine jurisdiction. Skipping silently
      // would be a compliance hole in two-party consent jurisdictions, so
      // we Sentry-page and proceed with empty disclosure. The Dial itself
      // still happens (the caller is not dropped).
      safeCapture(() => {
        Sentry.withScope((scope) => {
          scope.setTag("service", "voice-server");
          scope.setTag("reason", "disclosure-org-missing");
          scope.setLevel("warning");
          scope.setExtras({ callSid });
          Sentry.captureMessage(
            "Kill-switch fallback Dial: missing org context — disclosure SKIPPED",
            "warning",
          );
        });
      });
      return "";
    }

    const country = org.country || "US";
    const consent = requiresRecordingDisclosureHybrid(
      country,
      org.business_state || null,
      org.recording_consent_mode || "auto",
      callerPhone,
    );
    if (!consent.required) return "";

    const text = getRecordingDisclosureText(
      country,
      org.recording_disclosure_text,
      org.name,
    );
    return `  <Say voice="Polly.Joanna">${escapeXml(text)}</Say>\n`;
  } catch (err) {
    console.error("[FallbackDialConsent] Failed to build disclosure (skipping):", err.message);
    safeCapture(() => {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        scope.setTag("reason", "disclosure-build-failed");
        scope.setLevel("warning");
        scope.setExtras({ callSid });
        Sentry.captureException(err);
      });
    });
    return "";
  }
}

module.exports = { buildFallbackDisclosureSay };
