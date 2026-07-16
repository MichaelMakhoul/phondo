const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * SCRUM-273 — Contract tests for the structured-log Sentry sites in
 * voice-server/server.js. Grafana Loki alert rules match on the exact
 * `[ALERT:<level>] [<service>] <message> | k=v ...` shape produced by
 * lib/sentry.js, so a regression in tag naming, level, or extras would
 * break the alerts silently in production.
 *
 * The 10 sites in server.js share 5 distinct `reason` codes. For each
 * code we exercise the shim with the exact tag/level/extras tuple the
 * corresponding handler uses, capture the alert line, and lock in:
 *   - the [ALERT:level] prefix (severity routing)
 *   - the reason/service/provider/stage tags
 *   - the contextual extras (callSid/orgId/dialStatus/duration/calledMasked)
 *   - PII redaction (raw phone numbers must never appear)
 *
 * To catch divergence between these helpers and the production code (e.g.
 * a reason typo like `fail-open` → `fail_open`), the bottom of the file
 * also greps server.js itself and asserts the union of `setTag("reason",
 * "...")` literals exactly matches the REASONS list this file knows about.
 * That introspection test is the bridge between contract and production —
 * tighten it (or extract handlers per SCRUM-287) when the time comes.
 *
 * Pair-coverage: `voice-server/tests/answer-mode-sentry.test.js` covers
 * the 4 sites inside `lib/answer-mode.js` (same shim, different module).
 */

const { Sentry } = require("../lib/sentry");
const { maskPhone } = require("../lib/mask-phone");

const SERVER_JS_PATH = path.join(__dirname, "..", "server.js");

/**
 * Capture [ALERT:...] lines emitted while fn() runs. lib/sentry.js's
 * captureException always writes to console.error regardless of level;
 * captureMessage routes by level (warning → console.warn). All 10 sites
 * in scope use captureException, but we intercept both channels so this
 * file keeps working if any site is later changed to captureMessage.
 */
async function captureAlerts(fn) {
  const lines = [];
  const origError = console.error;
  const origWarn = console.warn;
  const capture = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (line.startsWith("[ALERT:")) lines.push(line);
  };
  console.error = capture;
  console.warn = capture;
  try {
    await fn();
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
  return lines;
}

/**
 * Pull the [ALERT:<level>] prefix from a captured line so tests can
 * verify the actual severity routing rather than trusting a hand-written
 * map. Returns null if the line is malformed.
 */
function extractLevel(alert) {
  const m = /^\[ALERT:([a-z]+)\]/.exec(alert);
  return m ? m[1] : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Site shape helpers — these mirror the exact arguments each server.js
// handler passes to Sentry. Anchored by the function/section they live in
// (line numbers shift; function names don't) so future readers can find
// the production site without a grep cycle. If a handler is renamed/
// edited, update the helper here in lockstep — and the introspection
// test at the bottom of this file will catch reason-code drift.
// ──────────────────────────────────────────────────────────────────────────

/** /twiml AI-disabled call-logging catch (Twilio kill-switch handler). */
function emitTwimlLogFailed({ err, called, callSid, orgId }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "log-failed");
    scope.setLevel("warning");
    scope.setExtras({
      calledMasked: maskPhone(called),
      callSid,
      orgId,
      provider: "twilio",
    });
    Sentry.captureException(err);
  });
}

/** /texml AI-disabled call-logging catch (Telnyx kill-switch handler). */
function emitTexmlLogFailed({ err, called, callSid, orgId }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "log-failed");
    scope.setLevel("warning");
    scope.setExtras({
      calledMasked: maskPhone(called),
      callSid,
      orgId,
      provider: "telnyx",
    });
    Sentry.captureException(err);
  });
}

/** /twiml outer fail-open (kill-switch handler threw, customer intent violated). */
function emitTwimlFailOpenOuter({ err, called, reqCallSid }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "fail-open");
    scope.setLevel("error");
    scope.setExtras({
      calledMasked: maskPhone(called),
      callSid: reqCallSid,
      provider: "twilio",
      stage: "killswitch-handler",
    });
    Sentry.captureException(err);
  });
}

/** /texml outer fail-open. */
function emitTexmlFailOpenOuter({ err, called, reqCallSid }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "fail-open");
    scope.setLevel("error");
    scope.setExtras({
      calledMasked: maskPhone(called),
      callSid: reqCallSid,
      provider: "telnyx",
      stage: "killswitch-handler",
    });
    Sentry.captureException(err);
  });
}

/** /twiml + /texml ring-first-degraded (getAnswerMode threw). */
function emitRingFirstDegraded({ err, called, reqCallSid, provider }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "ring-first-degraded");
    scope.setLevel("warning");
    scope.setExtras({
      calledMasked: maskPhone(called),
      callSid: reqCallSid,
      provider,
    });
    Sentry.captureException(err);
  });
}

/** finaliseFallbackDial lookup failure (calls-table read failed). */
function emitFallbackFinaliseLookup({ err, callSid, dialStatus, durationSeconds, provider }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "fallback-finalise-failed");
    scope.setLevel("warning");
    scope.setExtras({ callSid, dialStatus, durationSeconds, stage: "lookup", provider });
    Sentry.captureException(err);
  });
}

/** finaliseFallbackDial completeCallRecord failure (write-back failed). */
function emitFallbackFinaliseComplete({
  err,
  callSid,
  dialStatus,
  durationSeconds,
  callId,
  orgId,
  provider,
}) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "fallback-finalise-failed");
    scope.setLevel("warning");
    scope.setExtras({
      callSid,
      dialStatus,
      durationSeconds,
      stage: "complete",
      callId,
      orgId,
      provider,
    });
    Sentry.captureException(err);
  });
}

/** /twiml + /texml voicemail-greeting-lookup-failed (call_greetings read failed). */
function emitVoicemailGreetingLookupFailed({ err, callSid, called, provider }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "voicemail-greeting-lookup-failed");
    scope.setLevel("warning");
    scope.setExtras({ callSid, calledMasked: maskPhone(called), provider });
    Sentry.captureException(err);
  });
}

/** SCRUM-212: voicemail raw-URL fallback write failed (kill-switch
 *  handleVoicemailRecordingDone). Level=error — this is the safety net
 *  behind the Supabase storage pipeline and Twilio won't retry. */
function emitVoicemailRecordingSaveFailed({ err, callSid }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "voicemail-recording-save-failed");
    scope.setLevel("error");
    scope.setExtras({ callSid });
    Sentry.captureException(err);
  });
}

/** SCRUM-192: post-call analysis flagged an unhappy call (semantic
 *  failure, not a system error). NOTE: this is the file's only
 *  captureMessage site — the shim must still merge scope tags into the
 *  line or the reason= token (and the Grafana rule) silently dies. */
function emitUnhappyCall({ callSid, organizationId, successEvaluation, sentiment, durationSeconds }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "unhappy-call");
    scope.setLevel("warning");
    scope.setExtras({ callSid, organizationId, successEvaluation, sentiment, durationSeconds });
    Sentry.captureMessage("Unhappy call flagged by post-call analysis (SCRUM-192)", "warning");
  });
}

/** SCRUM-550: Deepgram re-transcription of the recording failed/degraded.
 *  Warning — the dashboard keeps Gemini's original transcript, so no data is
 *  lost (unlike a broken core path). Its own Grafana rule matches
 *  reason=retranscribe-failed. Lives in lib/route-handlers/retranscribe.js. */
function emitRetranscribeFailed({ callId }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "retranscribe-failed");
    scope.setLevel("warning");
    scope.setExtras({ callId });
    Sentry.captureMessage("retranscribe failed (SCRUM-550)", "warning");
  });
}

/** SCRUM-552: the retranscribe calls-row lookup was REJECTED by PostgREST
 *  (bad column / unresolvable embed, e.g. 42703). Systemic — the feature is
 *  dead for EVERY call, which previously camouflaged as per-call "not found"
 *  warnings. Error level: needs a human, not a threshold. Lives in
 *  lib/route-handlers/retranscribe.js (pageLookupRejected). */
function emitRetranscribeLookupRejected({ callId }) {
  Sentry.withScope((scope) => {
    scope.setTag("service", "voice-server");
    scope.setTag("reason", "retranscribe-lookup-rejected");
    scope.setLevel("error");
    scope.setExtras({ callId });
    Sentry.captureMessage("retranscribe lookup REJECTED (SCRUM-552)", "error");
  });
}

/**
 * The canonical reason→level taxonomy this test file asserts. Verified
 * against server.js by the introspection test below — keep these in sync
 * with the production handlers (or the bottom suite will fail).
 */
const REASON_LEVELS = Object.freeze({
  "log-failed": "warning",
  "fail-open": "error",
  "ring-first-degraded": "warning",
  "fallback-finalise-failed": "warning",
  "voicemail-greeting-lookup-failed": "warning",
  "voicemail-recording-save-failed": "error",
  "unhappy-call": "warning",
  "retranscribe-failed": "warning",
  "retranscribe-lookup-rejected": "error",
});
const REASONS = Object.freeze(Object.keys(REASON_LEVELS));

// ──────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Word-boundary-anchored key=value check. Plain substring assertions
 * (`alert.includes("provider=twilio")`) match dangerous suffixes like
 * `provider=twiliox`, so every k=v assertion below uses this helper. The
 * value can be a string or number; the boundary on the right is either
 * whitespace, `|`, or end-of-string.
 */
function assertKv(alert, key, value, msg) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${key}=${escaped}(?=\\s|$|\\|)`);
  assert.match(alert, re, msg || `expected ${key}=${value} in: ${alert}`);
}

/**
 * Assert the raw phone never leaks (regardless of how PII masking is
 * implemented). Should be called whenever a raw phone is passed into a
 * helper.
 */
function assertNoRawPhone(alert, rawPhone) {
  assert.ok(
    !alert.includes(rawPhone),
    `raw phone ${rawPhone} must not appear in alert: ${alert}`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("server.js Sentry sites — contract tests (SCRUM-273)", () => {
  describe("reason=log-failed (kill-switch call-logging catch)", () => {
    it("Twilio path emits [ALERT:warning] with provider=twilio, orgId, callSid, calledMasked", async () => {
      const alerts = await captureAlerts(async () => {
        emitTwimlLogFailed({
          err: new Error("createCallRecord schema drift"),
          called: "+61299999999",
          callSid: "CA_TEST_LOG_FAIL",
          orgId: "org-abc",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=log-failed"));
      assert.ok(alert, `expected log-failed alert, got: ${alerts.join("\n")}`);
      assert.equal(extractLevel(alert), "warning");
      assertKv(alert, "service", "voice-server");
      assertKv(alert, "reason", "log-failed");
      assertKv(alert, "provider", "twilio");
      assertKv(alert, "callSid", "CA_TEST_LOG_FAIL");
      assertKv(alert, "orgId", "org-abc");
      assert.match(alert, /calledMasked=\+61\*\*\*999(\s|$|\|)/);
      assert.ok(alert.includes("createCallRecord schema drift"));
      assertNoRawPhone(alert, "+61299999999");
    });

    it("Telnyx path mirrors with provider=telnyx", async () => {
      const alerts = await captureAlerts(async () => {
        emitTexmlLogFailed({
          err: new Error("createCallRecord schema drift"),
          called: "+14155551234",
          callSid: "TL_TEST_LOG_FAIL",
          orgId: "org-def",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=log-failed"));
      assert.ok(alert);
      assert.equal(extractLevel(alert), "warning");
      assertKv(alert, "provider", "telnyx");
      assertKv(alert, "callSid", "TL_TEST_LOG_FAIL");
      assertKv(alert, "orgId", "org-def");
      assertNoRawPhone(alert, "+14155551234");
    });
  });

  describe("reason=fail-open (outer kill-switch handler threw)", () => {
    it("Twilio path emits at ERROR level (customer intent violation, not warning)", async () => {
      const alerts = await captureAlerts(async () => {
        emitTwimlFailOpenOuter({
          err: new Error("escapeXml threw on bizarre input"),
          called: "+61299999999",
          reqCallSid: "CA_TEST_FAIL_OPEN",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=fail-open"));
      assert.ok(alert);
      // CRITICAL: must be `error`. Grafana routes by level — demoting to
      // warning would lose pager fidelity for kill-switch fail-opens.
      assert.equal(
        extractLevel(alert),
        "error",
        `expected ERROR level for kill-switch fail-open, got: ${alert}`,
      );
      assertKv(alert, "reason", "fail-open");
      assertKv(alert, "stage", "killswitch-handler");
      assertKv(alert, "provider", "twilio");
      assertNoRawPhone(alert, "+61299999999");
    });

    it("Telnyx mirror has provider=telnyx (otherwise identical)", async () => {
      const alerts = await captureAlerts(async () => {
        emitTexmlFailOpenOuter({
          err: new Error("escapeXml threw on bizarre input"),
          called: "+14155551234",
          reqCallSid: "TL_TEST_FAIL_OPEN",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=fail-open"));
      assert.ok(alert);
      assert.equal(extractLevel(alert), "error");
      assertKv(alert, "provider", "telnyx");
      assertKv(alert, "stage", "killswitch-handler");
      assertNoRawPhone(alert, "+14155551234");
    });

    it("tolerates null reqCallSid (early /twiml throw before CallSid parsed)", async () => {
      const alerts = await captureAlerts(async () => {
        emitTwimlFailOpenOuter({
          err: new Error("oops"),
          called: "+61299999999",
          reqCallSid: null,
        });
      });
      const alert = alerts.find((l) => l.includes("reason=fail-open"));
      assert.ok(alert);
      // shim's formatExtras filters null values out cleanly
      assert.ok(!alert.includes("callSid=null"), "null callSid should not be emitted");
      // Other extras must still survive so triage isn't blinded.
      assertKv(alert, "provider", "twilio");
      assertKv(alert, "stage", "killswitch-handler");
      assert.match(alert, /calledMasked=\+61\*\*\*999(\s|$|\|)/);
      assertNoRawPhone(alert, "+61299999999");
    });
  });

  describe("reason=ring-first-degraded (getAnswerMode threw)", () => {
    it("Twilio path emits at WARNING (less severe than fail-open)", async () => {
      const alerts = await captureAlerts(async () => {
        emitRingFirstDegraded({
          err: new Error("assistants table unreachable"),
          called: "+61412345678",
          reqCallSid: "CA_TEST_RING_DEGRADED",
          provider: "twilio",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=ring-first-degraded"));
      assert.ok(alert);
      // Intentionally WARNING — ring-first degradation is a UX-level intent
      // violation, not a kill-switch safety violation. Don't conflate with
      // fail-open level=error.
      assert.equal(extractLevel(alert), "warning");
      assertKv(alert, "provider", "twilio");
      assertKv(alert, "callSid", "CA_TEST_RING_DEGRADED");
      assertNoRawPhone(alert, "+61412345678");
    });

    it("Telnyx mirror has provider=telnyx", async () => {
      const alerts = await captureAlerts(async () => {
        emitRingFirstDegraded({
          err: new Error("assistants table unreachable"),
          called: "+14155551234",
          reqCallSid: "TL_TEST_RING_DEGRADED",
          provider: "telnyx",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=ring-first-degraded"));
      assert.ok(alert);
      assert.equal(extractLevel(alert), "warning");
      assertKv(alert, "provider", "telnyx");
      assertNoRawPhone(alert, "+14155551234");
    });
  });

  describe("reason=fallback-finalise-failed (finaliseFallbackDial errors)", () => {
    it("lookup stage emits with stage=lookup and provider", async () => {
      const alerts = await captureAlerts(async () => {
        emitFallbackFinaliseLookup({
          err: new Error("calls table unreachable"),
          callSid: "CA_TEST_FF_LOOKUP",
          dialStatus: "no-answer",
          durationSeconds: 0,
          provider: "twilio",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=fallback-finalise-failed"));
      assert.ok(alert);
      assert.equal(extractLevel(alert), "warning");
      assertKv(alert, "stage", "lookup");
      assertKv(alert, "provider", "twilio");
      assertKv(alert, "callSid", "CA_TEST_FF_LOOKUP");
      assertKv(alert, "dialStatus", "no-answer");
      assertKv(alert, "durationSeconds", 0);
    });

    it("complete stage emits with stage=complete + callId + orgId for triage", async () => {
      const alerts = await captureAlerts(async () => {
        emitFallbackFinaliseComplete({
          err: new Error("completeCallRecord failed"),
          callSid: "CA_TEST_FF_COMPLETE",
          dialStatus: "completed",
          durationSeconds: 45,
          callId: "call-uuid-123",
          orgId: "org-xyz",
          provider: "telnyx",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=fallback-finalise-failed"));
      assert.ok(alert);
      assert.equal(extractLevel(alert), "warning");
      assertKv(alert, "stage", "complete");
      assertKv(alert, "callId", "call-uuid-123");
      assertKv(alert, "orgId", "org-xyz");
      assertKv(alert, "provider", "telnyx");
      assertKv(alert, "dialStatus", "completed");
      assertKv(alert, "durationSeconds", 45);
    });

    it("lookup and complete share `reason` but differ on `stage` — Grafana alerts can drill in", async () => {
      const alerts = await captureAlerts(async () => {
        emitFallbackFinaliseLookup({
          err: new Error("lookup"),
          callSid: "CA_LOOKUP",
          dialStatus: "no-answer",
          durationSeconds: 0,
          provider: "twilio",
        });
        emitFallbackFinaliseComplete({
          err: new Error("complete"),
          callSid: "CA_COMPLETE",
          dialStatus: "completed",
          durationSeconds: 10,
          callId: "c-1",
          orgId: "o-1",
          provider: "twilio",
        });
      });
      assert.equal(alerts.length, 2, "expected 2 alert lines");
      const lookupAlert = alerts.find((l) => l.includes("stage=lookup"));
      const completeAlert = alerts.find((l) => l.includes("stage=complete"));
      assert.ok(lookupAlert);
      assert.ok(completeAlert);
      assertKv(lookupAlert, "reason", "fallback-finalise-failed");
      assertKv(completeAlert, "reason", "fallback-finalise-failed");
    });
  });

  describe("reason=voicemail-greeting-lookup-failed", () => {
    it("Twilio path emits [ALERT:warning] with the right tags", async () => {
      const alerts = await captureAlerts(async () => {
        emitVoicemailGreetingLookupFailed({
          err: new Error("supabase unreachable"),
          callSid: "CA_TEST_VOICEMAIL_LOOKUP",
          called: "+61299999999",
          provider: "twilio",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=voicemail-greeting-lookup-failed"));
      assert.ok(alert);
      assert.equal(extractLevel(alert), "warning");
      assertKv(alert, "provider", "twilio");
      assertKv(alert, "callSid", "CA_TEST_VOICEMAIL_LOOKUP");
      assert.match(alert, /calledMasked=\+61\*\*\*999(\s|$|\|)/);
      assertNoRawPhone(alert, "+61299999999");
    });

    it("Telnyx mirror has provider=telnyx", async () => {
      const alerts = await captureAlerts(async () => {
        emitVoicemailGreetingLookupFailed({
          err: new Error("supabase unreachable"),
          callSid: "TL_TEST_VOICEMAIL_LOOKUP",
          called: "+14155551234",
          provider: "telnyx",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=voicemail-greeting-lookup-failed"));
      assert.ok(alert);
      assert.equal(extractLevel(alert), "warning");
      assertKv(alert, "provider", "telnyx");
      assertNoRawPhone(alert, "+14155551234");
    });
  });

  describe("Severity routing (verified by emitting via helpers, not a hand-written map)", () => {
    it("each helper produces the level its REASON_LEVELS entry claims", async () => {
      // This is the runtime cross-check: actually emit through each helper
      // and assert the captured [ALERT:level] prefix matches REASON_LEVELS.
      // A level demotion in any helper (or future regression) trips here.
      const probes = {
        "log-failed": () =>
          emitTwimlLogFailed({
            err: new Error("x"),
            called: "+61299999999",
            callSid: "p1",
            orgId: "p1",
          }),
        "fail-open": () =>
          emitTwimlFailOpenOuter({
            err: new Error("x"),
            called: "+61299999999",
            reqCallSid: "p2",
          }),
        "ring-first-degraded": () =>
          emitRingFirstDegraded({
            err: new Error("x"),
            called: "+61299999999",
            reqCallSid: "p3",
            provider: "twilio",
          }),
        "fallback-finalise-failed": () =>
          emitFallbackFinaliseLookup({
            err: new Error("x"),
            callSid: "p4",
            dialStatus: "no-answer",
            durationSeconds: 0,
            provider: "twilio",
          }),
        "voicemail-greeting-lookup-failed": () =>
          emitVoicemailGreetingLookupFailed({
            err: new Error("x"),
            callSid: "p5",
            called: "+61299999999",
            provider: "twilio",
          }),
        "voicemail-recording-save-failed": () =>
          emitVoicemailRecordingSaveFailed({
            err: new Error("x"),
            callSid: "p6",
          }),
        "unhappy-call": () =>
          emitUnhappyCall({
            callSid: "p7",
            organizationId: "org-p7",
            successEvaluation: "unsuccessful",
            sentiment: "negative",
            durationSeconds: 42,
          }),
        "retranscribe-failed": () => emitRetranscribeFailed({ callId: "p8" }),
        "retranscribe-lookup-rejected": () => emitRetranscribeLookupRejected({ callId: "p9" }),
      };
      // Every REASON must have a probe — surfacing missing coverage instead
      // of silently skipping.
      assert.deepEqual(
        Object.keys(probes).sort(),
        [...REASONS].sort(),
        "every REASON needs a probe in this test",
      );
      for (const reason of REASONS) {
        const alerts = await captureAlerts(async () => probes[reason]());
        const alert = alerts.find((l) => l.includes(`reason=${reason}`));
        assert.ok(alert, `probe for ${reason} produced no alert`);
        assert.equal(
          extractLevel(alert),
          REASON_LEVELS[reason],
          `${reason} should emit at level ${REASON_LEVELS[reason]}, got: ${alert}`,
        );
      }
    });

    it("exactly three reasons use level=error — others are warning", () => {
      // fail-open: customer intent (AI paused) silently violated.
      // voicemail-recording-save-failed (SCRUM-212): the safety-net write
      // behind the Supabase recording pipeline failed and Twilio won't
      // retry — the caller's message may exist only in Twilio's console.
      // retranscribe-lookup-rejected (SCRUM-552): a PostgREST-rejected
      // lookup (bad column/embed) kills re-transcription for EVERY call —
      // systemic, not per-call noise.
      const errorReasons = REASONS.filter((r) => REASON_LEVELS[r] === "error");
      assert.deepEqual(errorReasons, [
        "fail-open",
        "voicemail-recording-save-failed",
        "retranscribe-lookup-rejected",
      ]);
    });
  });

  describe("Production introspection (catches divergence between this file and server.js)", () => {
    // These tests read the production sources and grep for the actual
    // setTag("reason", "...") literals. A typo in production — say,
    // `fail-open` becoming `fail_open` — will trip the union check
    // below even though every other test in this file uses the
    // hand-maintained helpers. Without this safety net the contract
    // tests would happily report green while production was broken.
    //
    // SCRUM-287: the kill-switch handlers (log-failed, fail-open,
    // fallback-finalise-failed, voicemail-greeting-lookup-failed) were
    // extracted into `voice-server/lib/route-handlers/kill-switch.js`,
    // so we now grep BOTH server.js and the extracted module. The
    // `ring-first-degraded` reason still lives in server.js (the
    // ring-first branch is out of scope for the Wave 1 extraction).
    //
    // SCRUM-297: production now uses `setReasonTag(scope, SENTRY_REASONS.X)`
    // instead of inline `scope.setTag("reason", "literal")`. The scanner
    // below recognises BOTH patterns and resolves constant names to
    // their wire values via the live `sentry-reasons` module, so the
    // assertion below still compares wire values (the spec the Grafana
    // alert rules match on).
    const serverSource = fs.readFileSync(SERVER_JS_PATH, "utf8");
    const unhappySource = fs.readFileSync(path.join(__dirname, "..", "lib", "unhappy-call.js"), "utf8");
    const pendingTransfersSource = fs.readFileSync(path.join(__dirname, "..", "lib", "pending-transfers.js"), "utf8");
    const KILL_SWITCH_PATH = path.join(__dirname, "..", "lib", "route-handlers", "kill-switch.js");
    const killSwitchSource = fs.readFileSync(KILL_SWITCH_PATH, "utf8");
    // SCRUM-550: retranscribe.js is a NEW reason-site file — enumerate it here
    // or its capture site (and reason) is invisible to the census/union check.
    const retranscribeSource = fs.readFileSync(
      path.join(__dirname, "..", "lib", "route-handlers", "retranscribe.js"),
      "utf8",
    );
    const productionSources = [serverSource, killSwitchSource, unhappySource, retranscribeSource];
    const { SENTRY_REASONS } = require("../lib/sentry-reasons");

    /**
     * Resolve a `setReasonTag(scope, SENTRY_REASONS.X)` site to its
     * wire-format value. Returns null when the constant name doesn't
     * exist in `SENTRY_REASONS` — surfaces the typo loudly when the
     * dedup-by-value pass would otherwise hide it as undefined.
     */
    const resolveConstant = (name) =>
      Object.prototype.hasOwnProperty.call(SENTRY_REASONS, name)
        ? SENTRY_REASONS[name]
        : null;

    /** Count BOTH inline literal AND setReasonTag() patterns. The
     *  scope-identifier match is `\w+` (not literal "scope") so that
     *  a future site using `Sentry.withScope((s) => setReasonTag(s, ...))`
     *  is still counted — SCRUM-297 review surfaced the original
     *  hardcoded `scope,` as a future-fragility hazard. */
    const countReasonSites = (src) => {
      const inline = (src.match(/\w+\.setTag\("reason",/g) || []).length;
      const helper = (src.match(/setReasonTag\(\s*\w+\s*,/g) || []).length;
      return inline + helper;
    };

    /** Distinct `reason` wire values found across all production sources. */
    const productionReasons = (() => {
      const found = new Set();
      const inlineRe = /\w+\.setTag\("reason",\s*"([^"]+)"\)/g;
      const helperRe = /setReasonTag\(\s*\w+\s*,\s*SENTRY_REASONS\.([A-Z0-9_]+)\s*\)/g;
      for (const src of productionSources) {
        for (const match of src.matchAll(inlineRe)) {
          found.add(match[1]);
        }
        for (const match of src.matchAll(helperRe)) {
          const value = resolveConstant(match[1]);
          assert.ok(
            value,
            `setReasonTag(scope, SENTRY_REASONS.${match[1]}) references a constant that doesn't exist in sentry-reasons.js`,
          );
          found.add(value);
        }
      }
      return [...found].sort();
    })();

    it("server.js + kill-switch.js use EXACTLY the REASONS this file knows about (catches typos & unknown adds)", () => {
      assert.deepEqual(
        productionReasons,
        [...REASONS].sort(),
        "production reason set drifted from this file — add a helper for any new reason or fix the typo",
      );
    });

    it("production contains 11 reason-tagged call sites (6 kill-switch + 2 server + 1 unhappy-call + 2 retranscribe)", () => {
      // SCRUM-287 consolidated provider mirrors: log-failed, fail-open,
      // and voicemail-greeting-lookup-failed each fire from ONE site
      // that parameterizes provider (twilio|telnyx). fallback-finalise-
      // failed has 2 sites (lookup + complete stages, distinguished by
      // the `stage` extra). ring-first-degraded has 2 sites in
      // server.js (twilio + telnyx mirrors, not yet extracted).
      // SCRUM-212 added voicemail-recording-save-failed (1 site in
      // handleVoicemailRecordingDone, shared by both failure branches).
      // SCRUM-192 added unhappy-call — extracted to lib/unhappy-call.js
      // because it fires from TWO completion paths (cleanupSession +
      // finishTransferredCall). NOTE: countReasonSites only sees the
      // files enumerated here — a reason site added in a NEW file must
      // also be added to productionSources + this census or it is
      // invisible to the reason-union check forever.
      const serverCount = countReasonSites(serverSource);
      const killSwitchCount = countReasonSites(killSwitchSource);
      const unhappyCount = countReasonSites(unhappySource);
      const retranscribeCount = countReasonSites(retranscribeSource);
      assert.equal(
        serverCount,
        2,
        `expected 2 reason-tagged sites in server.js (ring-first-degraded twilio + telnyx), found ${serverCount}`,
      );
      assert.equal(
        killSwitchCount,
        6,
        `expected 6 reason-tagged sites in kill-switch.js, found ${killSwitchCount}`,
      );
      assert.equal(
        unhappyCount,
        1,
        `expected 1 reason-tagged site in lib/unhappy-call.js, found ${unhappyCount}`,
      );
      assert.equal(
        retranscribeCount,
        2,
        `expected 2 reason-tagged sites in lib/route-handlers/retranscribe.js (page + pageLookupRejected), found ${retranscribeCount}`,
      );
      assert.equal(
        serverCount + killSwitchCount + unhappyCount + retranscribeCount,
        11,
        `expected 11 reason-tagged Sentry sites total — update this test deliberately when sites are added/removed`,
      );
    });

    it("SCRUM-192: the unhappy-call page is gated on unsuccessful OR negative — and no other condition", () => {
      // Source-pin on the helper: widening the trigger (e.g. adding
      // "partial") or narrowing it (dropping sentiment) must be a
      // deliberate edit of this test.
      assert.match(
        unhappySource,
        /if \(!\(analysis\.successEvaluation === "unsuccessful" \|\| analysis\.sentiment === "negative"\)\) \{/,
      );
    });

    it("SCRUM-192: BOTH call-completion paths are wired to the unhappy-call pager", () => {
      // The transfer-completion path (pending-transfers.js) handles every
      // call that ends in a transfer attempt — disproportionately the
      // unhappiest calls. A refactor that drops either wiring silently
      // exempts a whole completion path from call-quality alerting.
      assert.match(serverSource, /maybeEmitUnhappyCall\(analysis, \{/);
      assert.match(pendingTransfersSource, /maybeEmitUnhappyCall\(analysis, \{/);
      // ...and the transfer path must report which outcome dead-ended.
      assert.match(pendingTransfersSource, /transferOutcome: outcome,/);
    });
  });
});
