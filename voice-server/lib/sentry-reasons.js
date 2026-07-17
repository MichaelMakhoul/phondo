/**
 * Stable error IDs for voice-server Sentry / Grafana alert routing.
 *
 * Mirror of `src/lib/security/error-ids.ts` from the Next.js side.
 * The two projects are separate npm packages (the voice-server is its
 * own Node deploy on Fly.io) so they can't share a module — keep this
 * file in sync manually when a reason crosses the boundary.
 *
 * Sentry events carry a `reason` tag whose value Grafana / Loki alert
 * rules match on. Routing the strings through a constant means a typo
 * or rename trips the build (via the JSDoc type + Object.freeze) and
 * the value of the constant is a stable contract between the code and
 * the alert config.
 *
 * Add new constants here when you introduce a new Sentry reason in
 * the voice-server. Don't inline strings at capture sites — use
 * `setReasonTag(scope, reason)` below.
 *
 * Casing convention (SCRUM-297):
 *   - NEW reasons use kebab-case (`my-thing-failed`).
 *   - LEGACY snake_case wire formats (`user_phone_equals_phondo`) are
 *     preserved to keep existing Grafana rules matching. Renaming is
 *     a flag-day operation (code + alert rules in the same window).
 */

/** @typedef {(typeof SENTRY_REASONS)[keyof typeof SENTRY_REASONS]} SentryReason */

const SENTRY_REASONS = Object.freeze({
  // ─── answer-mode fail-open (SCRUM-78 batch) ─────────────────────────
  /** AI-enabled check fell back to "AI answers" because of a DB fault.
   *  Customer intent (AI paused) silently violated — page LOUDLY. */
  FAIL_OPEN: "fail-open",
  /** loadCallContext failed — call still routes but with degraded
   *  context (defaults instead of org-specific config). */
  CONTEXT_LOOKUP_FAILED: "context-lookup-failed",

  // ─── kill-switch route handler (SCRUM-198) ──────────────────────────
  /** Failed to write a kill-switch decision log row. The route still
   *  completes; this signals the audit trail is incomplete. */
  LOG_FAILED: "log-failed",
  /** Finalising the fallback dial path (Twilio call SID update, etc.)
   *  threw after the call was already in-flight. */
  FALLBACK_FINALISE_FAILED: "fallback-finalise-failed",
  /** Could not load the org-specific voicemail greeting; the route
   *  fell back to the generic message. */
  VOICEMAIL_GREETING_LOOKUP_FAILED: "voicemail-greeting-lookup-failed",
  /** SCRUM-212: the voicemail raw-URL fallback write failed. This write
   *  is the safety net behind the Supabase storage pipeline — if it
   *  fails while the pipeline is also unreachable, the caller's message
   *  exists only in Twilio's console with no dashboard pointer. Pages at
   *  error level: Twilio does not retry the <Record> action callback. */
  VOICEMAIL_RECORDING_SAVE_FAILED: "voicemail-recording-save-failed",

  // ─── server.js + answer-mode ring-first (SCRUM-260) ─────────────────
  /** Ring-first answer mode degraded to AI-answers because the user's
   *  configured number couldn't be reached. */
  RING_FIRST_DEGRADED: "ring-first-degraded",

  // ─── post-call quality (SCRUM-192) ──────────────────────────────────
  /** Post-call analysis judged the call unhappy — successEvaluation
   *  "unsuccessful" or sentiment "negative". Not a system error: this is
   *  the semantic-failure half of call-quality alerting (a confused AI,
   *  an angry caller) that crash/error rules can't see. Warning level;
   *  its own Grafana rule matches reason=unhappy-call. Raise the rule's
   *  threshold when call volume makes per-call emails noisy. */
  UNHAPPY_CALL: "unhappy-call",

  // ─── post-call re-transcription (SCRUM-550) ─────────────────────────
  /** Deepgram re-transcription of the call recording failed or degraded
   *  (missing key, download error, STT error, empty result). Not fatal:
   *  the dashboard keeps Gemini's original transcript. Warning level.
   *  Its own Grafana rule matches reason=retranscribe-failed. */
  RETRANSCRIBE_FAILED: "retranscribe-failed",
  /** SCRUM-552: the calls-row lookup was REJECTED by PostgREST (bad
   *  column / unresolvable embed — code 42703/PGRST200-class), not merely
   *  empty. One of these means the feature is dead for EVERY call — the
   *  exact failure that shipped camouflaged as per-call "not found"
   *  warnings. Error level: it needs a human, not a threshold. */
  RETRANSCRIBE_LOOKUP_REJECTED: "retranscribe-lookup-rejected",
  /** SCRUM-553: a content-loss guard KEPT Gemini's transcript (gross length
   *  drop, judge verdict, or fail-closed on a garble-signature call). The
   *  guard WORKING is not the feature FAILING — separate reason so the
   *  retranscribe-failed alert stays a broken-feature signal, and guard hits
   *  form their own reviewable queue. Warning level. */
  RETRANSCRIBE_CONTENT_LOSS: "retranscribe-content-loss",

  // ─── booking-state monitor (SCRUM-559) ──────────────────────────────
  /** The post-call analysis says the caller left believing an appointment
   *  from THIS call exists, but the tool log shows zero net live bookings
   *  (e.g. booked then cancelled with no re-book). The caller is owed an
   *  appointment that does not exist — page LOUDLY. */
  BOOKING_STATE_MISMATCH: "booking-state-mismatch",

  // ─── fallback-dial-consent (recording disclosure) ───────────────────
  /** Recording disclosure can't render because the org row was missing
   *  from the lookup result. */
  DISCLOSURE_ORG_MISSING: "disclosure-org-missing",
  /** Recording disclosure text builder threw (template error, missing
   *  variable, etc.) — call proceeds without disclosure. */
  DISCLOSURE_BUILD_FAILED: "disclosure-build-failed",

  // ─── tool executor (SCRUM-297, legacy snake_case wire format) ───────
  /** Caller's phone number equals the assistant's own phone — the
   *  customer would have called themselves. Preserved as snake_case
   *  to keep any Grafana rule already matching this string working. */
  USER_PHONE_EQUALS_PHONDO: "user_phone_equals_phondo",
});

/**
 * Sentinel used when `setReasonTag` is called with a non-string
 * argument. SCRUM-313 added a `jsconfig.json` + a `tsc --checkJs` CI
 * step, and SCRUM-317 finished burning down the `@ts-nocheck` baseline,
 * so a STATIC `SENTRY_REASONS.TYPO` is now a build error everywhere.
 * This sentinel remains as defense-in-depth for what checkJs can't catch
 * — a reason built from a runtime variable, or one that resolves to
 * `undefined` via a logic bug: without it the structured-log shim at
 * `lib/sentry.js` filters `undefined` out of `formatExtras` entirely and
 * the `reason=` token never appears in the alert line, so the matching
 * Grafana rule silently never fires. The sentinel produces a
 * loud-but-wrong alert (a developer sees `reason=invalid-reason-passed`
 * and chases the bug) instead.
 */
const INVALID_REASON_SENTINEL = "invalid-reason-passed";

/**
 * Set the `reason` tag on a Sentry scope using a typed constant.
 *
 * Use this at any site that builds its own Sentry scope. The JSDoc
 * type narrows the second arg to a value of `SENTRY_REASONS`, so
 * editors flag a typo and a rename in `SENTRY_REASONS` propagates.
 *
 * SCRUM-313: the JSDoc `@param {SentryReason}` is CI-enforced via
 * `tsc --checkJs`, and SCRUM-317 burned down the last `@ts-nocheck`
 * file, so a STATIC typo here fails the build everywhere. The runtime
 * guard below remains as defense-in-depth for non-static reasons (a
 * value built at runtime, or one resolving to `undefined` via a logic
 * bug) — where a typo would otherwise produce `undefined` and the
 * structured-log shim would strip it from the alert line.
 *
 * For sites that DON'T need to attach additional scope tags / extras,
 * prefer wrapping the whole capture in a higher-level helper (e.g.
 * `captureFailOpen` in `answer-mode.js`) that already takes a typed
 * reason argument.
 *
 * @param {import("@sentry/node").Scope} scope
 * @param {SentryReason} reason
 */
function setReasonTag(scope, reason) {
  if (typeof reason !== "string" || reason.length === 0) {
    // Caller bug — log loudly for Loki grep, then emit a fallback
    // sentinel so the alert event still has SOMETHING to match.
    console.error(
      "[setReasonTag] reason is not a non-empty string (typo or missing constant):",
      reason,
    );
    scope.setTag("reason", INVALID_REASON_SENTINEL);
    return;
  }
  scope.setTag("reason", reason);
}

module.exports = { SENTRY_REASONS, setReasonTag, INVALID_REASON_SENTINEL };
