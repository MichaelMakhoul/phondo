"use strict";

const { Sentry } = require("./sentry");
const { SENTRY_REASONS, setReasonTag } = require("./sentry-reasons");

/**
 * SCRUM-192: page unhappy calls — the semantic-failure half of
 * call-quality alerting. Crash/error rules only see technical failures;
 * a call that connected fine but left the caller angry or unserved is
 * invisible without this. Extras are safe enums/ids only (no PII —
 * summary/transcript stay out; successEvaluation and sentiment are
 * allowlisted at the parse site in services/post-call-analysis.js).
 *
 * Shared by BOTH call-completion paths — cleanupSession (server.js) and
 * finishTransferredCall (lib/pending-transfers.js). Transfer-terminated
 * calls are disproportionately the unhappiest (dead-ended dials, TTL
 * expiries) and must not be exempt. The third analysis site,
 * services/conversationrelay.js, is the eval-only ConversationRelay
 * pipeline behind TEST_PIPELINE_OVERRIDES — deliberately not wired.
 *
 * "partial" successEvaluation deliberately does NOT page: the analysis
 * prompt defines it as attempted-but-not-completed, which includes
 * benign caller-declined / slot-taken endings — paging those would
 * drown the rule at any volume.
 *
 * @param {object|null} analysis - result of analyzeCallTranscript
 * @param {{ callSid?: string, organizationId?: string, durationSeconds?: number, transferOutcome?: string }} context
 * @returns {boolean} whether the call was flagged (emit attempted)
 */
function maybeEmitUnhappyCall(analysis, { callSid, organizationId, durationSeconds, transferOutcome } = {}) {
  if (!analysis) return false;
  if (!(analysis.successEvaluation === "unsuccessful" || analysis.sentiment === "negative")) {
    return false;
  }
  try {
    Sentry.withScope((scope) => {
      scope.setTag("service", "voice-server");
      setReasonTag(scope, SENTRY_REASONS.UNHAPPY_CALL);
      scope.setLevel("warning");
      scope.setExtras({
        callSid,
        organizationId,
        successEvaluation: analysis.successEvaluation,
        sentiment: analysis.sentiment,
        durationSeconds,
        transferOutcome,
      });
      Sentry.captureMessage("Unhappy call flagged by post-call analysis (SCRUM-192)", "warning");
    });
  } catch (sentryErr) {
    console.error(
      "[UnhappyCall] Sentry capture failed (suppressed):",
      sentryErr && sentryErr.message ? sentryErr.message : String(sentryErr),
    );
  }
  return true;
}

module.exports = { maybeEmitUnhappyCall };
