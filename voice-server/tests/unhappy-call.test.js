const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * SCRUM-192 — unit tests for the shared unhappy-call pager
 * (lib/unhappy-call.js), exercised through the REAL Sentry shim so the
 * [ALERT:warning] line shape the Grafana rule matches (reason=unhappy-call
 * in line content) is what's asserted, not a mock's echo.
 */

const { maybeEmitUnhappyCall } = require("../lib/unhappy-call");

let lines;
let origWarn;
let origError;

beforeEach(() => {
  lines = [];
  origWarn = console.warn;
  origError = console.error;
  const capture = (...args) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.warn = capture;
  console.error = capture;
});

afterEach(() => {
  console.warn = origWarn;
  console.error = origError;
});

const CONTEXT = { callSid: "CA_UC_1", organizationId: "org-uc-1", durationSeconds: 33 };

describe("maybeEmitUnhappyCall (SCRUM-192)", () => {
  it("pages on successEvaluation=unsuccessful — [ALERT:warning] line carries the Grafana match token", () => {
    const flagged = maybeEmitUnhappyCall(
      { successEvaluation: "unsuccessful", sentiment: "neutral" },
      CONTEXT,
    );
    assert.equal(flagged, true);
    const alert = lines.find((l) => l.startsWith("[ALERT:warning]"));
    assert.ok(alert, `expected an [ALERT:warning] line, got: ${lines.join("\n")}`);
    // The exact token the Grafana rule greps for — this is the contract.
    assert.match(alert, /\breason=unhappy-call(?=\s|$|\|)/);
    assert.match(alert, /\bcallSid=CA_UC_1\b/);
    assert.match(alert, /\borganizationId=org-uc-1\b/);
    assert.match(alert, /\bsuccessEvaluation=unsuccessful\b/);
    assert.match(alert, /\bdurationSeconds=33\b/);
  });

  it("pages on sentiment=negative alone (a completed-but-angry call)", () => {
    const flagged = maybeEmitUnhappyCall(
      { successEvaluation: "successful", sentiment: "negative" },
      CONTEXT,
    );
    assert.equal(flagged, true);
    const alert = lines.find((l) => l.includes("reason=unhappy-call"));
    assert.ok(alert);
    assert.match(alert, /\bsentiment=negative\b/);
  });

  it("includes transferOutcome when the transfer path provides it", () => {
    maybeEmitUnhappyCall(
      { successEvaluation: "unsuccessful", sentiment: null },
      { ...CONTEXT, transferOutcome: "unknown_timeout" },
    );
    const alert = lines.find((l) => l.includes("reason=unhappy-call"));
    assert.match(alert, /\btransferOutcome=unknown_timeout\b/);
  });

  it("does NOT page partial/positive — benign endings must not drown the rule", () => {
    const flagged = maybeEmitUnhappyCall(
      { successEvaluation: "partial", sentiment: "positive" },
      CONTEXT,
    );
    assert.equal(flagged, false);
    assert.equal(lines.length, 0);
  });

  it("does NOT page successful/neutral", () => {
    assert.equal(
      maybeEmitUnhappyCall({ successEvaluation: "successful", sentiment: "neutral" }, CONTEXT),
      false,
    );
    assert.equal(lines.length, 0);
  });

  it("null analysis (analysis failed or skipped) is a no-op, not a crash", () => {
    assert.equal(maybeEmitUnhappyCall(null, CONTEXT), false);
    assert.equal(lines.length, 0);
  });

  it("missing context fields don't crash — the shim drops null/undefined extras", () => {
    const flagged = maybeEmitUnhappyCall({ successEvaluation: "unsuccessful", sentiment: null }, {});
    assert.equal(flagged, true);
    const alert = lines.find((l) => l.includes("reason=unhappy-call"));
    assert.ok(alert);
    assert.doesNotMatch(alert, /callSid=/);
  });
});
