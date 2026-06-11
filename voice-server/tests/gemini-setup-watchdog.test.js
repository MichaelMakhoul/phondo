const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-424 (finding #10): a stalled Gemini setup handshake must not strand
// the caller in silence. These tests cover the PURE pieces only —
// armSetupWatchdog (timing core) and resolveSetupTimeoutMs (override clamp).
// The session wiring (clear on setupComplete/error/close, the
// onSetupTimeout → onError fallback, post-watchdog event suppression)
// constructs a real WebSocket and is validated by the deferred real test
// call (see MANUAL-ACTIONS) plus review.

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
const { _test } = require("../services/gemini-live");
const { armSetupWatchdog, resolveSetupTimeoutMs, DEFAULT_SETUP_TIMEOUT_MS } = _test;

describe("armSetupWatchdog (SCRUM-424)", () => {
  it("fires onTimeout when setup never completes", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let fired = 0;
      armSetupWatchdog({
        timeoutMs: 10_000,
        isSetupComplete: () => false,
        onTimeout: () => fired++,
      });

      mock.timers.tick(9_999);
      assert.equal(fired, 0, "must not fire before the deadline");
      mock.timers.tick(1);
      assert.equal(fired, 1, "must fire exactly once at the deadline");
      mock.timers.tick(60_000);
      assert.equal(fired, 1, "one-shot — never fires again");
    } finally {
      mock.timers.reset();
    }
  });

  it("does NOT fire when setup completed before the deadline", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let fired = 0;
      let complete = false;
      armSetupWatchdog({
        timeoutMs: 10_000,
        isSetupComplete: () => complete,
        onTimeout: () => fired++,
      });

      complete = true; // setupComplete arrived
      mock.timers.tick(20_000);
      assert.equal(fired, 0, "completed setup must never time out");
    } finally {
      mock.timers.reset();
    }
  });

  it("clear() disarms the watchdog (error/close paths)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let fired = 0;
      const watchdog = armSetupWatchdog({
        timeoutMs: 10_000,
        isSetupComplete: () => false,
        onTimeout: () => fired++,
      });

      watchdog.clear();
      mock.timers.tick(20_000);
      assert.equal(fired, 0, "cleared watchdog must not fire");
    } finally {
      mock.timers.reset();
    }
  });

  it("default deadline is sane (long enough for slow setups, short enough for callers)", () => {
    assert.ok(DEFAULT_SETUP_TIMEOUT_MS >= 5_000 && DEFAULT_SETUP_TIMEOUT_MS <= 15_000);
  });
});

describe("resolveSetupTimeoutMs (SCRUM-424 review — misconfig cannot cause an outage)", () => {
  it("uses the default when nothing is configured", () => {
    assert.equal(resolveSetupTimeoutMs(undefined, undefined), DEFAULT_SETUP_TIMEOUT_MS);
    assert.equal(resolveSetupTimeoutMs(NaN, ""), DEFAULT_SETUP_TIMEOUT_MS);
    assert.equal(resolveSetupTimeoutMs(0, "0"), DEFAULT_SETUP_TIMEOUT_MS);
  });

  it("accepts sane overrides (config wins over env)", () => {
    assert.equal(resolveSetupTimeoutMs(5000, "8000"), 5000);
    assert.equal(resolveSetupTimeoutMs(undefined, "8000"), 8000);
  });

  it("rejects negative / sub-second values — a typo'd env var must not fire the watchdog before setup can complete", () => {
    // GEMINI_SETUP_TIMEOUT_MS=-1 or =10 (seconds instead of ms) would
    // otherwise kill EVERY inbound call with apology-and-hangup.
    assert.equal(resolveSetupTimeoutMs(-1, undefined), DEFAULT_SETUP_TIMEOUT_MS);
    assert.equal(resolveSetupTimeoutMs(undefined, "-1"), DEFAULT_SETUP_TIMEOUT_MS);
    assert.equal(resolveSetupTimeoutMs(10, undefined), DEFAULT_SETUP_TIMEOUT_MS);
    assert.equal(resolveSetupTimeoutMs(999, undefined), DEFAULT_SETUP_TIMEOUT_MS);
    assert.equal(resolveSetupTimeoutMs(1000, undefined), 1000); // floor inclusive
  });
});
