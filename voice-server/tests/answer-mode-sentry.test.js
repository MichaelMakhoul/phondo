const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// Mock supabase to control the per-test response. Each test sets the
// next single() return value via mockPhoneResult.
let mockPhoneResult = { data: null, error: null };
let mockSingleThrows = null; // when set, single() rejects with this error

const mockSupabase = {
  from: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      single: () => {
        if (mockSingleThrows) return Promise.reject(mockSingleThrows);
        return Promise.resolve(mockPhoneResult);
      },
    };
    return chain;
  },
};

// Override the supabase module BEFORE requiring answer-mode
const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { getSupabase: () => mockSupabase },
};

const { lookupPhoneNumber, isAiEnabled, getPhoneNumberContext } = require("../lib/answer-mode");

/**
 * Capture all console.error calls during fn(). The structured-log Sentry
 * shim writes [ALERT:<level>] [<service>] <message> | k=v ... lines to
 * console.error — that's the signal we assert on.
 */
async function captureAlerts(fn) {
  const lines = [];
  const origError = console.error;
  console.error = (...args) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = origError;
  }
  return lines.filter((l) => l.startsWith("[ALERT:"));
}

describe("answer-mode Sentry wiring", () => {
  beforeEach(() => {
    mockPhoneResult = { data: null, error: null };
    mockSingleThrows = null;
  });

  describe("lookupPhoneNumber", () => {
    it("captures fail-open at error level when DB returns a non-PGRST116 error", async () => {
      mockPhoneResult = { data: null, error: { code: "57P01", message: "admin shutdown" } };
      let result;
      const alerts = await captureAlerts(async () => {
        result = await lookupPhoneNumber("+61299999999");
      });
      assert.equal(result, null, "fail-open: lookup returns null");
      const alert = alerts.find((l) => l.includes("reason=fail-open"));
      assert.ok(alert, `expected a [ALERT:...] reason=fail-open line, got: ${alerts.join("\n")}`);
      assert.ok(alert.startsWith("[ALERT:error]"), `expected error level, got: ${alert}`);
      assert.ok(alert.includes("service=voice-server"), "should tag service");
      // Phone number must be masked. Use a regex with word boundary on the
      // closing 3 digits so a partial-mask regression (e.g. +612***999) trips
      // the assertion instead of passing as a substring match.
      assert.match(alert, /calledMasked=\+61\*\*\*999(\s|$)/, `expected exact masked phone, got: ${alert}`);
      assert.ok(!alert.includes("+61299999999"), "raw phone must NOT appear");
    });

    it("includes callSid from opts in the Sentry event", async () => {
      mockPhoneResult = { data: null, error: { code: "57P01", message: "admin shutdown" } };
      const alerts = await captureAlerts(async () => {
        await lookupPhoneNumber("+61299999999", { callSid: "CA_TEST_123" });
      });
      const alert = alerts.find((l) => l.includes("reason=fail-open"));
      assert.ok(alert, `expected fail-open alert, got: ${alerts.join("\n")}`);
      assert.ok(alert.includes("callSid=CA_TEST_123"), `expected callSid extra, got: ${alert}`);
    });

    it("does NOT capture when DB returns PGRST116 (no rows — expected for unknown numbers)", async () => {
      mockPhoneResult = { data: null, error: { code: "PGRST116", message: "no rows" } };
      const alerts = await captureAlerts(async () => {
        await lookupPhoneNumber("+61299999999");
      });
      assert.equal(alerts.length, 0, "PGRST116 must not fire Sentry");
    });

    it("captures fail-open when the supabase client itself throws", async () => {
      mockSingleThrows = new Error("connection refused");
      let result;
      const alerts = await captureAlerts(async () => {
        result = await lookupPhoneNumber("+61299999999");
      });
      assert.equal(result, null);
      const alert = alerts.find((l) => l.includes("reason=fail-open"));
      assert.ok(alert, `expected fail-open alert, got: ${alerts.join("\n")}`);
      assert.ok(alert.startsWith("[ALERT:error]"));
      assert.ok(alert.includes("connection refused"));
    });
  });

  describe("isAiEnabled (standalone path)", () => {
    it("returns fail-open=true and captures Sentry when DB throws", async () => {
      mockSingleThrows = new Error("network down");
      let result;
      const alerts = await captureAlerts(async () => {
        // Pass undefined → forces standalone DB query path
        result = await isAiEnabled("+61299999999", undefined);
      });
      assert.equal(result, true, "must fail-open to true");
      const alert = alerts.find((l) => l.includes("reason=fail-open"));
      assert.ok(alert, `expected fail-open alert, got: ${alerts.join("\n")}`);
      assert.ok(alert.startsWith("[ALERT:error]"));
    });

    it("captures fail-open at error level when DB returns non-PGRST116 error", async () => {
      mockPhoneResult = { data: null, error: { code: "42501", message: "permission denied" } };
      let result;
      const alerts = await captureAlerts(async () => {
        result = await isAiEnabled("+61299999999", undefined);
      });
      assert.equal(result, true, "fail-open");
      const alert = alerts.find((l) => l.includes("reason=fail-open"));
      assert.ok(alert, `expected fail-open alert, got: ${alerts.join("\n")}`);
      assert.ok(alert.startsWith("[ALERT:error]"));
    });

    it("prefetched-null does not capture (lookup already captured at its layer)", async () => {
      // When called with prefetchedPhone=null, isAiEnabled returns true (fail-open)
      // but does not re-capture; the upstream lookupPhoneNumber is the source.
      const alerts = await captureAlerts(async () => {
        const result = await isAiEnabled("+61299999999", null);
        assert.equal(result, true);
      });
      assert.equal(alerts.length, 0, "isAiEnabled must not double-report when prefetched");
    });
  });

  describe("getPhoneNumberContext", () => {
    it("captures context-lookup-failed when DB errors on standalone query", async () => {
      mockPhoneResult = { data: null, error: { code: "57P01", message: "admin shutdown" } };
      let result;
      const alerts = await captureAlerts(async () => {
        result = await getPhoneNumberContext("+61299999999");
      });
      assert.equal(result, null);
      const alert = alerts.find((l) => l.includes("reason=context-lookup-failed"));
      assert.ok(alert, `expected context-lookup-failed alert, got: ${alerts.join("\n")}`);
      assert.ok(alert.startsWith("[ALERT:warning]"));
    });

    it("does NOT capture on PGRST116 (no rows)", async () => {
      mockPhoneResult = { data: null, error: { code: "PGRST116", message: "no rows" } };
      const alerts = await captureAlerts(async () => {
        await getPhoneNumberContext("+61299999999");
      });
      assert.equal(alerts.length, 0);
    });
  });

  /**
   * SCRUM-274 contract test. The /twiml and /texml route handlers in
   * server.js wrap `getAnswerMode` in a try/catch that, on error, falls
   * through to AI-first answering. Before this PR that catch was console.error
   * only — a silent customer-intent violation (ring-first → AI-first). The
   * handlers now also emit a Sentry warning with `reason=ring-first-degraded`.
   *
   * server.js route handlers aren't directly unit-testable (no harness yet —
   * tracked by SCRUM-273), so this test exercises the structured-log Sentry
   * shim with the same tag/level/extras tuple the handlers use, locking in
   * the alert line shape that Grafana alert rules will match on.
   */
  describe("ring-first degradation Sentry pattern (SCRUM-274)", () => {
    const { Sentry } = require("../lib/sentry");
    const { maskPhone } = require("../lib/mask-phone");

    function emitRingFirstDegraded({ err, called, callSid, provider }) {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        scope.setTag("reason", "ring-first-degraded");
        scope.setLevel("warning");
        scope.setExtras({
          calledMasked: maskPhone(called),
          callSid,
          provider,
        });
        Sentry.captureException(err);
      });
    }

    it("Twilio path emits [ALERT:warning] reason=ring-first-degraded with masked phone + callSid + provider", async () => {
      const alerts = await captureAlerts(async () => {
        emitRingFirstDegraded({
          err: new Error("assistants table unreachable"),
          called: "+61299999999",
          callSid: "CA_TWILIO_TEST",
          provider: "twilio",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=ring-first-degraded"));
      assert.ok(alert, `expected ring-first-degraded alert, got: ${alerts.join("\n")}`);
      assert.ok(alert.startsWith("[ALERT:warning]"), `expected warning level, got: ${alert}`);
      assert.ok(alert.includes("service=voice-server"));
      assert.ok(alert.includes("provider=twilio"));
      assert.ok(alert.includes("callSid=CA_TWILIO_TEST"));
      assert.match(alert, /calledMasked=\+61\*\*\*999(\s|$)/);
      assert.ok(alert.includes("assistants table unreachable"));
      // Raw phone must NOT appear
      assert.ok(!alert.includes("+61299999999"));
    });

    it("Telnyx path emits the same shape with provider=telnyx (full parity with Twilio assertions)", async () => {
      const alerts = await captureAlerts(async () => {
        emitRingFirstDegraded({
          err: new Error("assistants table unreachable"),
          called: "+14155551234",
          callSid: "TL_TELNYX_TEST",
          provider: "telnyx",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=ring-first-degraded"));
      assert.ok(alert, `expected ring-first-degraded alert, got: ${alerts.join("\n")}`);
      assert.ok(alert.startsWith("[ALERT:warning]"), `expected warning level, got: ${alert}`);
      assert.ok(alert.includes("service=voice-server"));
      assert.ok(alert.includes("provider=telnyx"));
      assert.ok(alert.includes("callSid=TL_TELNYX_TEST"));
      assert.match(alert, /calledMasked=\+14\*\*\*234(\s|$)/);
      assert.ok(alert.includes("assistants table unreachable"));
      // Raw caller-side / called-side PII must NOT appear under any pattern.
      // The handler intentionally only sets `calledMasked`; this lock-in test
      // catches any future regression that adds `from`/`callerPhone`/`to`/the
      // raw called number to extras.
      assert.ok(!alert.includes("+14155551234"), "raw called number must NOT appear");
    });

    it("tolerates a null callSid (early /twiml throw before reqCallSid was meaningful)", async () => {
      const alerts = await captureAlerts(async () => {
        emitRingFirstDegraded({
          err: new Error("oops"),
          called: "+61412345678",
          callSid: null,
          provider: "twilio",
        });
      });
      const alert = alerts.find((l) => l.includes("reason=ring-first-degraded"));
      assert.ok(alert);
      // formatExtras filters null values out of the line entirely
      assert.ok(!alert.includes("callSid=null"), "null callSid should not be emitted");
    });
  });
});
