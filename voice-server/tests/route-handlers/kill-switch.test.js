const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * SCRUM-287 — Handler-level tests for the kill-switch route handlers.
 *
 * SCRUM-273 added contract tests that exercise the Sentry shim
 * directly, but couldn't prove that the handlers ACTUALLY call Sentry
 * on the right error path. This file plugs that gap by unit-testing
 * the extracted handlers in `voice-server/lib/route-handlers/
 * kill-switch.js` with mocked deps, asserting both:
 *   (1) the correct response is sent (TwiML body, status code),
 *   (2) Sentry.captureException fires with the right scope tags AND
 *       extras whenever a documented failure mode is triggered.
 *
 * Each of the 5 distinct `reason` codes that previously lived in
 * server.js is exercised through at least one branch here:
 *   - log-failed (createCallRecord throws)
 *   - fail-open (isAiEnabled throws)
 *   - fallback-finalise-failed (lookup + complete stages)
 *   - voicemail-greeting-lookup-failed (lookupPhoneNumber throws in
 *     fallback-status handler)
 *
 * `ring-first-degraded` remains in server.js (the ring-first branch
 * was not extracted in Wave 1) — its contract tests live in
 * voice-server/tests/server-sentry-sites.test.js and
 * voice-server/tests/answer-mode-sentry.test.js.
 */

const killSwitch = require("../../lib/route-handlers/kill-switch");

// ──────────────────────────────────────────────────────────────────────────
// Test helpers — mock deps + mock req/res
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a Sentry mock that captures every withScope call's tags +
 * extras + level so tests can assert per-tag, not just "captureException
 * happened".
 */
function makeSentryMock() {
  const captures = [];
  const Sentry = {
    withScope(fn) {
      const scope = {
        _tags: {},
        _extras: {},
        _level: null,
        setTag(k, v) { this._tags[k] = v; },
        setExtras(obj) { Object.assign(this._extras, obj); },
        setLevel(l) { this._level = l; },
      };
      Sentry._activeScope = scope;
      try {
        fn(scope);
      } finally {
        Sentry._activeScope = null;
      }
    },
    _activeScope: null,
    captureException(err) {
      const scope = Sentry._activeScope || { _tags: {}, _extras: {}, _level: null };
      captures.push({
        err,
        tags: { ...scope._tags },
        extras: { ...scope._extras },
        level: scope._level,
      });
    },
  };
  return { Sentry, captures };
}

/** Fake Express res with .type/.send/.status chainable. */
function makeRes() {
  const state = { type: null, body: null, status: 200, headers: {} };
  const res = {
    type(t) { state.type = t; return res; },
    send(b) { state.body = b; return res; },
    status(s) { state.status = s; return res; },
    headers(h) { Object.assign(state.headers, h); return res; },
    _state: state,
  };
  return res;
}

/** Build a Supabase mock for the finaliseFallbackDial path. */
function makeSupabaseMock({ findResult = { data: { id: "call-id", organization_id: "org-1" }, error: null } } = {}) {
  return {
    from() { return this; },
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return findResult; },
  };
}

/** Reasonable default deps. Tests override individual fields. */
function makeDeps(overrides = {}) {
  const { Sentry, captures } = makeSentryMock();
  return {
    captures, // exposed for assertions
    deps: {
      Sentry,
      supabase: makeSupabaseMock(),
      isAiEnabled: async () => true, // AI enabled by default
      lookupPhoneNumber: async () => ({ organizations: { country: "US" } }),
      getPhoneNumberContext: async () => ({
        organizationId: "org-1",
        organizationName: "Test Org",
        assistantId: "ast-1",
        phoneNumberId: "pn-1",
      }),
      createCallRecord: async () => "call-uuid-1",
      completeCallRecord: async () => undefined,
      // Mirror the real maskPhone in voice-server/lib/mask-phone.js so
      // PII assertions in tests match production output byte-for-byte.
      maskPhone: (p) => {
        if (!p) return "unknown";
        if (p.length < 6) return "***";
        return p.slice(0, 3) + "***" + p.slice(-3);
      },
      // Mirror the real escapeXml in server.js byte-for-byte, including
      // the apostrophe rule. The String() wrapper is intentionally
      // omitted so a future test that passes null/undefined gets the
      // same throw as production would.
      escapeXml: (s) =>
        s.replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&apos;"),
      buildFallbackDisclosureSay: () => `  <Say>This call may be recorded.</Say>\n`,
      getPollyVoice: () => "Polly.Joanna",
      publicUrl: "https://voice.test",
      e164Regex: /^\+[1-9]\d{7,14}$/,
      // SCRUM-212: mirrors server.js makeKillSwitchDeps — the Next.js
      // webhook that downloads voicemail recordings into Supabase.
      recordingStatusCallbackUrl: "https://app.test/api/webhooks/twilio-recording-done",
      ...overrides,
    },
  };
}

const baseOpts = {
  called: "+61299999999",
  from: "+61412345678",
  reqCallSid: "CA_TEST_SID",
  phoneRecord: {
    fallback_forward_number: "+61400000000",
    organizations: { country: "AU" },
  },
};

// ──────────────────────────────────────────────────────────────────────────
// handleAiDisabledBranch
// ──────────────────────────────────────────────────────────────────────────

describe("kill-switch.handleAiDisabledBranch", () => {
  describe("when AI is enabled (kill switch OFF)", () => {
    let captures, deps;
    beforeEach(() => {
      ({ captures, deps } = makeDeps({ isAiEnabled: async () => true }));
    });

    it("returns false and does NOT send a response (caller continues to AI)", async () => {
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "twilio",
        deps,
      });
      assert.equal(result, false);
      assert.equal(res._state.body, null);
      assert.equal(captures.length, 0);
    });
  });

  describe("when AI is disabled WITH fallback number configured", () => {
    let captures, deps;
    beforeEach(() => {
      ({ captures, deps } = makeDeps({ isAiEnabled: async () => false }));
    });

    it("(twilio) sends Dial TwiML with the org's fallback action URL", async () => {
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "twilio",
        deps,
      });
      assert.equal(result, true);
      assert.equal(res._state.type, "text/xml");
      assert.match(res._state.body, /<Dial /);
      // Twilio: action URL is /twiml/ai-disabled-fallback-status
      assert.match(res._state.body, /\/twiml\/ai-disabled-fallback-status/);
      // Twilio: callerId is the inbound `from`
      assert.match(res._state.body, /callerId="\+61412345678"/);
      // Fallback number itself must appear inside Dial body
      assert.match(res._state.body, /\+61400000000/);
      // Recording-disclosure must be in the response (TCPA / wiretap law).
      // A regression that dropped the disclosure would still pass the
      // happy-path assertions above; lock the Say block in explicitly.
      assert.match(res._state.body, /This call may be recorded/);
      // No Sentry on the happy path
      assert.equal(captures.length, 0);
    });

    it("(telnyx) sends Dial TeXML with telnyx-specific callerId and action URL", async () => {
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "telnyx",
        deps,
      });
      assert.equal(result, true);
      // Telnyx callerId = called (org's Telnyx number), NOT the inbound from
      assert.match(res._state.body, /callerId="\+61299999999"/);
      assert.match(res._state.body, /\/texml\/ai-disabled-fallback-status/);
      // The inbound from must NOT be the callerId
      assert.ok(
        !res._state.body.match(/callerId="\+61412345678"/),
        "telnyx must not use inbound from as callerId",
      );
    });

    it("rejects a malformed fallback number (defense-in-depth, twilio)", async () => {
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        phoneRecord: { fallback_forward_number: "not-a-number", organizations: { country: "AU" } },
        provider: "twilio",
        deps,
      });
      assert.equal(result, true);
      // Should treat malformed fallback as if no fallback → voicemail TwiML
      assert.match(res._state.body, /<Record /);
      assert.ok(!res._state.body.match(/<Dial /), "must not Dial on malformed fallback");
    });

    it("rejects a malformed fallback number (defense-in-depth, telnyx)", async () => {
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        phoneRecord: { fallback_forward_number: "<script>", organizations: { country: "AU" } },
        provider: "telnyx",
        deps,
      });
      assert.equal(result, true);
      // Same defense-in-depth applies on Telnyx — must drop to voicemail.
      assert.match(res._state.body, /<Record /);
      assert.ok(!res._state.body.match(/<Dial /), "must not Dial on malformed fallback");
      // Defense-in-depth also covers the XML side: the malformed value
      // must NOT leak unescaped into the body (the regex caught above
      // wouldn't appear in <Record>).
      assert.ok(!res._state.body.includes("<script>"), "raw malformed value must not leak");
    });

    it("when getPhoneNumberContext returns null (org missing), still emits the fallback Dial with no business name", async () => {
      // SCRUM-287 review: previously untested branch. Production path is
      // `if (ctx) {...}` skipping createCallRecord, then the response
      // builders defensively handle businessName=null.
      const { captures: nullCaptures, deps: nullDeps } = makeDeps({
        isAiEnabled: async () => false,
        getPhoneNumberContext: async () => null,
      });
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "twilio",
        deps: nullDeps,
      });
      assert.equal(result, true);
      assert.match(res._state.body, /<Dial /);
      // No Sentry — ctx=null is a known-acceptable state.
      assert.equal(nullCaptures.length, 0);
    });

    it("when getPhoneNumberContext returns null AND no fallback, voicemail uses generic greeting (no business name)", async () => {
      const { deps: nullDeps } = makeDeps({
        isAiEnabled: async () => false,
        getPhoneNumberContext: async () => null,
      });
      const res = makeRes();
      await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        phoneRecord: { fallback_forward_number: "", organizations: { country: "AU" } },
        provider: "twilio",
        deps: nullDeps,
      });
      // Generic greeting without business name
      assert.match(res._state.body, /Thank you for calling\./);
      assert.ok(
        !res._state.body.includes("Test Org"),
        "must not include business name when ctx is null",
      );
    });
  });

  describe("when AI is disabled WITHOUT fallback configured (voicemail path)", () => {
    let captures, deps;
    beforeEach(() => {
      ({ captures, deps } = makeDeps({ isAiEnabled: async () => false }));
    });

    it("(twilio) sends voicemail TwiML with the twilio recording-done action", async () => {
      const res = makeRes();
      await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        phoneRecord: { fallback_forward_number: "", organizations: { country: "AU" } },
        provider: "twilio",
        deps,
      });
      assert.match(res._state.body, /<Record /);
      assert.match(res._state.body, /\/twiml\/ai-disabled-recording-done/);
      // Greeting includes the business name from getPhoneNumberContext
      assert.match(res._state.body, /Test Org/);
      // SCRUM-212: the <Record> must carry the status-callback attributes so
      // Twilio pushes the finished recording into the Supabase pipeline. The
      // exact event list matters — "failed"/"absent" surface broken
      // recordings in call metadata instead of silently vanishing.
      assert.match(
        res._state.body,
        /recordingStatusCallback="https:\/\/app\.test\/api\/webhooks\/twilio-recording-done" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed failed absent"/,
      );
      assert.equal(captures.length, 0);
    });

    it("(twilio) recordingStatusCallbackUrl unset (no APP_PUBLIC_URL) — degrades to legacy <Record> without status-callback attributes", async () => {
      ({ captures, deps } = makeDeps({
        isAiEnabled: async () => false,
        recordingStatusCallbackUrl: null,
      }));
      const res = makeRes();
      await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        phoneRecord: { fallback_forward_number: "", organizations: { country: "AU" } },
        provider: "twilio",
        deps,
      });
      assert.match(res._state.body, /<Record /);
      assert.doesNotMatch(res._state.body, /recordingStatusCallback/);
      assert.equal(captures.length, 0);
    });

    it("(telnyx) sends voicemail TeXML with the telnyx legacy recording-done action — and NO recordingStatusCallback (Next.js webhook validates Twilio signatures; a Telnyx POST would 403)", async () => {
      const res = makeRes();
      await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        phoneRecord: { fallback_forward_number: null, organizations: { country: "AU" } },
        provider: "telnyx",
        deps,
      });
      assert.match(res._state.body, /\/texml\/recording-done/);
      assert.doesNotMatch(res._state.body, /recordingStatusCallback/);
    });
  });

  describe("log-failed: createCallRecord throws inside the AI-disabled branch", () => {
    it("(twilio) Sentry-pages with reason=log-failed, provider=twilio, level=warning — AND still sends the fallback TwiML", async () => {
      const { captures, deps } = makeDeps({
        isAiEnabled: async () => false,
        createCallRecord: async () => {
          throw new Error("createCallRecord schema drift");
        },
      });
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "twilio",
        deps,
      });
      // The log failure does NOT cause us to drop the call — TwiML must
      // still be sent.
      assert.equal(result, true);
      assert.match(res._state.body, /<Dial /);
      // Sentry must have fired with the right tags + extras.
      assert.equal(captures.length, 1);
      const cap = captures[0];
      assert.equal(cap.tags.service, "voice-server");
      assert.equal(cap.tags.reason, "log-failed");
      assert.equal(cap.level, "warning");
      assert.equal(cap.extras.provider, "twilio");
      assert.equal(cap.extras.orgId, "org-1");
      assert.match(cap.extras.calledMasked, /\+61\*\*\*999/);
      // PII: raw phone must NOT appear in extras
      assert.ok(!JSON.stringify(cap.extras).includes("+61299999999"), "raw phone leaked");
    });

    it("(telnyx) Sentry-pages with provider=telnyx", async () => {
      const { captures, deps } = makeDeps({
        isAiEnabled: async () => false,
        createCallRecord: async () => {
          throw new Error("createCallRecord schema drift");
        },
      });
      const res = makeRes();
      await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "telnyx",
        deps,
      });
      assert.equal(captures.length, 1);
      assert.equal(captures[0].tags.reason, "log-failed");
      assert.equal(captures[0].extras.provider, "telnyx");
    });

    it("getPhoneNumberContext throw is ALSO routed to the log-failed Sentry path", async () => {
      // Because the catch wraps both getPhoneNumberContext AND
      // createCallRecord, any of them throwing should produce the same
      // Sentry alert shape.
      const { captures, deps } = makeDeps({
        isAiEnabled: async () => false,
        getPhoneNumberContext: async () => {
          throw new Error("ctx lookup failed");
        },
      });
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "twilio",
        deps,
      });
      assert.equal(result, true); // still emits TwiML
      assert.equal(captures.length, 1);
      assert.equal(captures[0].tags.reason, "log-failed");
    });
  });

  describe("fail-open: isAiEnabled throws (outer catch)", () => {
    it("(twilio) Sentry-pages with reason=fail-open, level=ERROR, stage=killswitch-handler — and returns false so AI answers", async () => {
      const { captures, deps } = makeDeps({
        isAiEnabled: async () => {
          throw new Error("escapeXml threw on bizarre input");
        },
      });
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "twilio",
        deps,
      });
      // Fail-open: AI should still answer.
      assert.equal(result, false);
      // No response was sent by the handler — caller will continue.
      assert.equal(res._state.body, null);
      // Sentry must have fired at ERROR level (NOT warning — this is a
      // customer-intent violation, more severe than log-failed).
      assert.equal(captures.length, 1);
      const cap = captures[0];
      assert.equal(cap.tags.reason, "fail-open");
      assert.equal(cap.level, "error");
      assert.equal(cap.extras.stage, "killswitch-handler");
      assert.equal(cap.extras.provider, "twilio");
    });

    it("(telnyx) Sentry-pages with provider=telnyx and level=error", async () => {
      const { captures, deps } = makeDeps({
        isAiEnabled: async () => {
          throw new Error("kaboom");
        },
      });
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "telnyx",
        deps,
      });
      assert.equal(result, false);
      assert.equal(captures.length, 1);
      assert.equal(captures[0].tags.reason, "fail-open");
      assert.equal(captures[0].level, "error");
      assert.equal(captures[0].extras.provider, "telnyx");
    });

    it("tolerates Sentry shim defect (withScope throws) — does NOT crash the limiter", async () => {
      const { captures: _unused, deps } = makeDeps({
        isAiEnabled: async () => {
          throw new Error("inner");
        },
      });
      // Force Sentry.withScope to throw — simulates a permanent shim defect.
      deps.Sentry = {
        withScope() {
          throw new Error("sentry shim broken");
        },
        captureException() {},
      };
      const res = makeRes();
      // Must not throw — the handler swallows Sentry-side defects so
      // the cron / route can still serve the request.
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "twilio",
        deps,
      });
      assert.equal(result, false);
      void _unused;
    });
  });

  describe("Sentry shim-defect resilience at EVERY capture site", () => {
    // Each of the 4 try/catch (sentryErr) wrappers in kill-switch.js
    // was meant to make a Sentry shim regression visible in console
    // logs rather than crashing the route. Verify each one survives
    // a `withScope`-that-throws.

    function makeBrokenSentry() {
      return {
        withScope() {
          throw new Error("sentry transport down");
        },
        captureException() {
          throw new Error("sentry transport down");
        },
      };
    }

    it("log-failed catch swallows Sentry shim throw — handler still emits TwiML", async () => {
      const { deps } = makeDeps({
        isAiEnabled: async () => false,
        createCallRecord: async () => {
          throw new Error("log inner");
        },
      });
      deps.Sentry = makeBrokenSentry();
      const res = makeRes();
      const result = await killSwitch.handleAiDisabledBranch(makeReq(), res, {
        ...baseOpts,
        provider: "twilio",
        deps,
      });
      assert.equal(result, true);
      assert.match(res._state.body, /<Dial /);
    });

    it("finaliseFallbackDial lookup catch swallows Sentry shim throw", async () => {
      const { deps } = makeDeps();
      deps.supabase = makeSupabaseMock({
        findResult: { data: null, error: { code: "57P01", message: "down" } },
      });
      deps.Sentry = makeBrokenSentry();
      // Must not throw — caller (server.js route handler) cannot
      // recover from an exception out of this function.
      await killSwitch.finaliseFallbackDial("CA", "no-answer", 0, "twilio", deps);
    });

    it("finaliseFallbackDial complete catch swallows Sentry shim throw", async () => {
      const { deps } = makeDeps();
      deps.completeCallRecord = async () => {
        throw new Error("complete inner");
      };
      deps.Sentry = makeBrokenSentry();
      await killSwitch.finaliseFallbackDial("CA", "completed", 45, "telnyx", deps);
    });

    it("voicemail-greeting-lookup catch swallows Sentry shim throw — handler still emits voicemail", async () => {
      const { deps } = makeDeps();
      deps.lookupPhoneNumber = async () => {
        throw new Error("lookup inner");
      };
      deps.Sentry = makeBrokenSentry();
      const req = makeReq({
        CallSid: "CA",
        DialCallStatus: "no-answer",
        DialCallDuration: "0",
        Called: "+61299999999",
      });
      const res = makeRes();
      await killSwitch.handleAiDisabledFallbackStatus(req, res, { provider: "twilio", deps });
      // The handler must still produce a voicemail response despite
      // the dual failure (lookup + Sentry).
      assert.match(res._state.body, /<Record /);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// finaliseFallbackDial
// ──────────────────────────────────────────────────────────────────────────

describe("kill-switch.finaliseFallbackDial", () => {
  it("happy path: looks up the call and calls completeCallRecord with the right outcome (transferred)", async () => {
    const { captures, deps } = makeDeps();
    const completed = [];
    deps.completeCallRecord = async (id, body) => {
      completed.push({ id, body });
    };
    await killSwitch.finaliseFallbackDial("CA_TEST", "completed", 45, "twilio", deps);
    assert.equal(captures.length, 0); // no Sentry on happy path
    assert.equal(completed.length, 1);
    assert.equal(completed[0].id, "call-id");
    assert.equal(completed[0].body.outcome, "transferred");
    assert.equal(completed[0].body.answeredBy, "owner");
    assert.equal(completed[0].body.durationSeconds, 45);
  });

  it("when dialStatus !== completed → outcome=voicemail (no answeredBy)", async () => {
    const { deps } = makeDeps();
    const completed = [];
    deps.completeCallRecord = async (id, body) => completed.push({ id, body });
    await killSwitch.finaliseFallbackDial("CA_TEST", "no-answer", 0, "twilio", deps);
    assert.equal(completed[0].body.outcome, "voicemail");
    assert.equal(completed[0].body.answeredBy, undefined);
  });

  it("lookup error: Sentry-pages with reason=fallback-finalise-failed + stage=lookup", async () => {
    const { captures, deps } = makeDeps();
    deps.supabase = makeSupabaseMock({
      findResult: { data: null, error: { code: "57P01", message: "admin shutdown" } },
    });
    await killSwitch.finaliseFallbackDial("CA_TEST", "no-answer", 0, "twilio", deps);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].tags.reason, "fallback-finalise-failed");
    assert.equal(captures[0].tags.service, "voice-server");
    assert.equal(captures[0].level, "warning");
    assert.equal(captures[0].extras.stage, "lookup");
    assert.equal(captures[0].extras.provider, "twilio");
  });

  it("complete error: Sentry-pages with stage=complete + callId + orgId for triage", async () => {
    const { captures, deps } = makeDeps();
    deps.completeCallRecord = async () => {
      throw new Error("completeCallRecord failed");
    };
    await killSwitch.finaliseFallbackDial("CA_TEST", "completed", 45, "telnyx", deps);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].tags.reason, "fallback-finalise-failed");
    assert.equal(captures[0].extras.stage, "complete");
    assert.equal(captures[0].extras.callId, "call-id");
    assert.equal(captures[0].extras.orgId, "org-1");
    assert.equal(captures[0].extras.provider, "telnyx");
  });

  it("no callRow found: returns early without paging Sentry (different from a true error)", async () => {
    const { captures, deps } = makeDeps();
    deps.supabase = makeSupabaseMock({ findResult: { data: null, error: null } });
    await killSwitch.finaliseFallbackDial("CA_TEST", "no-answer", 0, "twilio", deps);
    // Missing row is a known-acceptable state (kill-switch may have
    // skipped createCallRecord for organisation_id=NULL), so don't
    // page on-call.
    assert.equal(captures.length, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// handleAiDisabledFallbackStatus
// ──────────────────────────────────────────────────────────────────────────

describe("kill-switch.handleAiDisabledFallbackStatus", () => {
  it("completed dial: returns Hangup TwiML and updates the call record (transferred)", async () => {
    const { captures, deps } = makeDeps();
    const completed = [];
    deps.completeCallRecord = async (id, body) => completed.push({ id, body });
    const req = makeReq({
      CallSid: "CA_TEST",
      DialCallStatus: "completed",
      DialCallDuration: "45",
      Called: "+61299999999",
    });
    const res = makeRes();
    await killSwitch.handleAiDisabledFallbackStatus(req, res, { provider: "twilio", deps });
    assert.match(res._state.body, /<Hangup\s*\/>/);
    assert.equal(completed[0].body.outcome, "transferred");
    assert.equal(captures.length, 0);
  });

  it("no-answer dial: returns voicemail TwiML + Record action", async () => {
    const { captures, deps } = makeDeps();
    const req = makeReq({
      CallSid: "CA_TEST",
      DialCallStatus: "no-answer",
      DialCallDuration: "0",
      Called: "+61299999999",
    });
    const res = makeRes();
    await killSwitch.handleAiDisabledFallbackStatus(req, res, { provider: "twilio", deps });
    assert.match(res._state.body, /<Record /);
    assert.match(res._state.body, /\/twiml\/ai-disabled-recording-done/);
    // SCRUM-212: this entry path builds the same <Record> — the recording
    // must reach Supabase from here too, not only from the direct
    // AI-disabled voicemail branch.
    assert.match(
      res._state.body,
      /recordingStatusCallback="https:\/\/app\.test\/api\/webhooks\/twilio-recording-done"/,
    );
    // Greeting should include the business name
    assert.match(res._state.body, /Test Org/);
    assert.equal(captures.length, 0);
  });

  it("voicemail-greeting-lookup-failed: Sentry-pages when lookupPhoneNumber throws (twilio)", async () => {
    const { captures, deps } = makeDeps();
    deps.lookupPhoneNumber = async () => {
      throw new Error("supabase unreachable");
    };
    const req = makeReq({
      CallSid: "CA_TEST",
      DialCallStatus: "no-answer",
      DialCallDuration: "0",
      Called: "+61299999999",
    });
    const res = makeRes();
    await killSwitch.handleAiDisabledFallbackStatus(req, res, { provider: "twilio", deps });
    assert.equal(captures.length, 1);
    assert.equal(captures[0].tags.reason, "voicemail-greeting-lookup-failed");
    assert.equal(captures[0].tags.service, "voice-server");
    assert.equal(captures[0].level, "warning");
    assert.equal(captures[0].extras.provider, "twilio");
    // PII masked
    assert.match(captures[0].extras.calledMasked, /\+61\*\*\*999/);
    // The handler still emits a voicemail response (graceful fallback)
    assert.match(res._state.body, /<Record /);
  });

  it("voicemail-greeting-lookup-failed: Sentry-pages with provider=telnyx", async () => {
    const { captures, deps } = makeDeps();
    deps.lookupPhoneNumber = async () => {
      throw new Error("supabase unreachable");
    };
    const req = makeReq({
      CallSid: "CA_TEST",
      DialCallStatus: "no-answer",
      DialCallDuration: "0",
      Called: "+61299999999",
    });
    const res = makeRes();
    await killSwitch.handleAiDisabledFallbackStatus(req, res, { provider: "telnyx", deps });
    assert.equal(captures.length, 1);
    assert.equal(captures[0].extras.provider, "telnyx");
    assert.match(res._state.body, /\/texml\/recording-done/);
    // SCRUM-212: Telnyx must never get the Twilio status-callback attributes.
    assert.doesNotMatch(res._state.body, /recordingStatusCallback/);
  });

  it("(telnyx) accepts both Called and To params (older Telnyx payload shape)", async () => {
    const { captures, deps } = makeDeps();
    const req = makeReq({
      CallSid: "CA_TEST",
      DialCallStatus: "no-answer",
      DialCallDuration: "0",
      // Older Telnyx payloads use `To` instead of `Called`
      To: "+61299999999",
    });
    const res = makeRes();
    await killSwitch.handleAiDisabledFallbackStatus(req, res, { provider: "telnyx", deps });
    // Should still produce a voicemail response — the `To` was resolved.
    assert.match(res._state.body, /<Record /);
    assert.equal(captures.length, 0); // happy path
  });
});

// ──────────────────────────────────────────────────────────────────────────
// handleVoicemailRecordingDone (SCRUM-212)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Supabase mock capturing the update chain. The real builder is thenable,
 * so the mock resolves `{ error }` when awaited at any point in the chain —
 * a handler that drops `.is()` still resolves, but the captured calls
 * expose it.
 */
function makeUpdateCaptureSupabase({ error = null, throwOnUpdate = false } = {}) {
  const calls = { table: null, update: null, eq: null, is: null };
  const chain = {
    update(values) {
      if (throwOnUpdate) throw new Error("supabase unreachable");
      calls.update = values;
      return chain;
    },
    eq(col, val) { calls.eq = [col, val]; return chain; },
    is(col, val) { calls.is = [col, val]; return chain; },
    then(resolve) { resolve({ error }); },
  };
  return { from(t) { calls.table = t; return chain; }, _calls: calls };
}

describe("kill-switch.handleVoicemailRecordingDone", () => {
  const GOODBYE = /<Say voice="Polly\.Joanna">Thank you for your message\. Goodbye\.<\/Say>[\s\S]*<Hangup\/>/;

  it("writes the raw URL as fallback — guarded so it never clobbers a Supabase-stored recording", async () => {
    const supabase = makeUpdateCaptureSupabase();
    const { deps } = makeDeps({ supabase });
    const res = makeRes();
    await killSwitch.handleVoicemailRecordingDone(
      makeReq({ RecordingUrl: "https://api.twilio.com/rec/RE123", CallSid: "CA_VM_1" }),
      res,
      { deps },
    );
    assert.equal(supabase._calls.table, "calls");
    assert.deepEqual(supabase._calls.update, { recording_url: "https://api.twilio.com/rec/RE123" });
    assert.deepEqual(supabase._calls.eq, ["vapi_call_id", "sh_CA_VM_1"]);
    // The guard: recordingStatusCallback ordering isn't guaranteed, so the
    // raw-URL write must be scoped to rows the storage pipeline hasn't
    // migrated yet.
    assert.deepEqual(supabase._calls.is, ["recording_storage_path", null]);
    assert.equal(res._state.type, "text/xml");
    assert.match(res._state.body, GOODBYE);
  });

  it("missing RecordingUrl: skips the write but still returns the goodbye TwiML", async () => {
    const supabase = makeUpdateCaptureSupabase();
    const { deps } = makeDeps({ supabase });
    const res = makeRes();
    await killSwitch.handleVoicemailRecordingDone(makeReq({ CallSid: "CA_VM_2" }), res, { deps });
    assert.equal(supabase._calls.update, null);
    assert.match(res._state.body, GOODBYE);
  });

  it("DB error result: non-fatal — caller still gets the goodbye TwiML", async () => {
    const supabase = makeUpdateCaptureSupabase({ error: { code: "57014", message: "timeout" } });
    const { deps } = makeDeps({ supabase });
    const res = makeRes();
    await killSwitch.handleVoicemailRecordingDone(
      makeReq({ RecordingUrl: "https://api.twilio.com/rec/RE124", CallSid: "CA_VM_3" }),
      res,
      { deps },
    );
    assert.match(res._state.body, GOODBYE);
  });

  it("supabase throws synchronously: non-fatal — caller still gets the goodbye TwiML", async () => {
    const supabase = makeUpdateCaptureSupabase({ throwOnUpdate: true });
    const { deps } = makeDeps({ supabase });
    const res = makeRes();
    await killSwitch.handleVoicemailRecordingDone(
      makeReq({ RecordingUrl: "https://api.twilio.com/rec/RE125", CallSid: "CA_VM_4" }),
      res,
      { deps },
    );
    assert.match(res._state.body, GOODBYE);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────

function makeReq(body = {}) {
  return { body };
}
