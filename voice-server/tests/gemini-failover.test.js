const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createSessionWithFailover, isFailoverEnabled } = require("../services/gemini-failover");

/**
 * A controllable fake session. `cbs` is what the wrapper handed the factory —
 * firing them simulates the provider's lifecycle events.
 */
function makeFakeSession(name) {
  const calls = { audio: [], text: [], closed: 0 };
  let cbs = null;
  const factory = (config, callbacks) => {
    cbs = callbacks;
    factory.config = config;
    factory.built += 1;
    return {
      sendAudio: (a) => calls.audio.push(a),
      sendText: (t) => calls.text.push(t),
      getTranscripts: () => ({ input: `${name}-in`, output: `${name}-out` }),
      close: () => {
        calls.closed += 1;
      },
      readyState: 1,
    };
  };
  factory.built = 0;
  factory.fire = (event, ...args) => cbs[event]?.(...args);
  factory.has = (event) => typeof cbs?.[event] === "function";
  factory.calls = calls;
  return factory;
}

/** Call-site callbacks with invocation recording. */
function makeSiteCallbacks() {
  const seen = { errors: [], setupTimeouts: [], closes: [], setupCompletes: 0 };
  return {
    seen,
    onError: (err) => seen.errors.push(err),
    onSetupTimeout: (err) => seen.setupTimeouts.push(err),
    onClose: (code, reason) => seen.closes.push({ code, reason }),
    onSetupComplete: () => {
      seen.setupCompletes += 1;
    },
  };
}

function build(overrides = {}) {
  const primary = makeFakeSession("gemini");
  const fallback = makeFakeSession("openai");
  const site = makeSiteCallbacks();
  const failovers = [];
  const handle = createSessionWithFailover(
    primary,
    {
      fallbackFactory: fallback,
      enabled: true,
      onFailover: (reason, err) => failovers.push({ reason, err }),
      ...overrides,
    },
    { systemPrompt: "prompt", tools: [] },
    site
  );
  return { primary, fallback, site, handle, failovers };
}

describe("createSessionWithFailover — the window (SCRUM-535)", () => {
  it("no failover when the primary completes setup; later errors belong to the call site", () => {
    const { primary, fallback, site, handle, failovers } = build();
    primary.fire("onSetupComplete");
    primary.fire("onError", new Error("mid-call blip"));
    assert.equal(fallback.built, 0);
    assert.equal(failovers.length, 0);
    assert.equal(site.seen.errors[0].message, "mid-call blip");
    assert.equal(site.seen.setupCompletes, 1, "setup-complete must pass through to the call site");
    assert.equal(handle.failedOver, false);
  });

  it("a post-setup close reaches the call site untouched", () => {
    const { primary, site } = build();
    primary.fire("onSetupComplete");
    primary.fire("onClose", 1000, "end_call");
    assert.deepEqual(site.seen.closes, [{ code: 1000, reason: "end_call" }]);
  });

  it("setup timeout fails over: fallback gets the SAME config, onFailover fires once", () => {
    const { primary, fallback, handle, failovers, site } = build();
    primary.fire("onSetupTimeout", new Error("stalled"));
    assert.equal(fallback.built, 1);
    assert.equal(fallback.config.systemPrompt, "prompt");
    assert.deepEqual(failovers.map((f) => f.reason), ["setup-timeout"]);
    assert.equal(handle.failedOver, true);
    assert.equal(primary.calls.closed, 1, "the abandoned primary must be closed");
    // Nothing surfaced as an error — the call goes on.
    assert.equal(site.seen.errors.length, 0);
    assert.equal(site.seen.setupTimeouts.length, 0);
  });

  it("a PRE-setup error fails over instead of reaching the call site", () => {
    const { primary, fallback, site, failovers } = build();
    primary.fire("onError", new Error("ws refused"));
    assert.equal(fallback.built, 1);
    assert.equal(site.seen.errors.length, 0);
    assert.equal(failovers[0].reason, "error-before-setup");
  });

  it("a PRE-setup close (the 1007 case) fails over, and that close never reaches the call site", () => {
    const { primary, fallback, site } = build();
    primary.fire("onClose", 1007, "invalid setup");
    assert.equal(fallback.built, 1);
    assert.deepEqual(site.seen.closes, []);
  });

  it("the abandoned primary's dying close event is swallowed after failover", () => {
    const { primary, fallback, site } = build();
    primary.fire("onError", new Error("ws refused")); // → failover
    primary.fire("onClose", 1006, ""); // the socket we closed reports in
    assert.deepEqual(site.seen.closes, [], "the primary's post-failover close must not reach teardown");
    // But the FALLBACK's close is the live session's — it must flow.
    fallback.fire("onClose", 1000, "end_call");
    assert.deepEqual(site.seen.closes, [{ code: 1000, reason: "end_call" }]);
  });

  it("a LATE setupComplete from the abandoned primary cannot reopen event forwarding", () => {
    // The race: Gemini finally answers at 10.001s — the ack was in flight
    // when the watchdog fired. If it flipped primarySetupDone, the abandoned
    // primary's dying close would flow to teardown and kill the healthy
    // fallback call.
    const { primary, fallback, site } = build();
    primary.fire("onSetupTimeout", new Error("stalled"));
    primary.fire("onSetupComplete"); // the late, in-flight ack
    assert.equal(site.seen.setupCompletes, 0, "a late ack must not reach the call site");
    primary.fire("onClose", 1000, "setup-timeout");
    assert.deepEqual(site.seen.closes, [], "the abandoned primary's close must stay swallowed");
    fallback.fire("onClose", 1000, "end_call");
    assert.deepEqual(site.seen.closes, [{ code: 1000, reason: "end_call" }]);
  });

  it("a stray SECOND error from the abandoned primary is swallowed, not fed to teardown", () => {
    const { primary, fallback, site } = build();
    primary.fire("onError", new Error("ws refused")); // → failover
    primary.fire("onError", new Error("socket hang up")); // the dying socket again
    assert.equal(fallback.built, 1);
    assert.deepEqual(site.seen.errors, [], "the call-site onError would close the rescued call");
  });

  it("a throwing onFailover does not unwind into the primary's event handler — the fallback still serves", () => {
    const primary = makeFakeSession("gemini");
    const fallback = makeFakeSession("openai");
    const site = makeSiteCallbacks();
    const handle = createSessionWithFailover(
      primary,
      {
        fallbackFactory: fallback,
        enabled: true,
        onFailover: () => {
          // Telemetry must never be able to take the call (or, unwound to the
          // top of a ws event handler, the whole process) down with it.
          throw new Error("sentry exploded");
        },
      },
      { systemPrompt: "prompt", tools: [] },
      site
    );
    assert.doesNotThrow(() => primary.fire("onSetupTimeout", new Error("stalled")));
    assert.equal(fallback.built, 1);
    assert.equal(handle.failedOver, true);
    handle.sendAudio("a1");
    assert.deepEqual(fallback.calls.audio, ["a1"]);
  });

  it("audio and text route to the fallback after failover; transcripts come from it too", () => {
    const { primary, fallback, handle } = build();
    handle.sendAudio("a1");
    primary.fire("onSetupTimeout", new Error("stalled"));
    handle.sendAudio("a2");
    handle.sendText("nudge");
    assert.deepEqual(primary.calls.audio, ["a1"]);
    assert.deepEqual(fallback.calls.audio, ["a2"]);
    assert.deepEqual(fallback.calls.text, ["nudge"]);
    assert.equal(handle.getTranscripts().input, "openai-in");
  });
});

describe("createSessionWithFailover — refusals and degradation", () => {
  it("disabled: setup timeout degrades to the call site's onSetupTimeout, exactly as today", () => {
    const { primary, fallback, site, failovers } = build({ enabled: false });
    primary.fire("onSetupTimeout", new Error("stalled"));
    assert.equal(fallback.built, 0);
    assert.equal(failovers.length, 0);
    assert.equal(site.seen.setupTimeouts[0].message, "stalled");
  });

  it("canFailover=false (Twilio already gone): no failover, original paths run", () => {
    const { primary, fallback, site } = build({ canFailover: () => false });
    primary.fire("onError", new Error("ws refused"));
    assert.equal(fallback.built, 0);
    assert.equal(site.seen.errors[0].message, "ws refused");
  });

  it("fallback factory throwing is NOT a failover: original error surfaces, one-shot is spent", () => {
    const throwingFactory = () => {
      throw new Error("OPENAI_API_KEY is required");
    };
    const { primary, site, failovers, handle } = build({ fallbackFactory: throwingFactory });
    primary.fire("onSetupTimeout", new Error("stalled"));
    assert.equal(failovers.length, 0, "a fallback that never existed must not be recorded as a failover");
    assert.equal(site.seen.setupTimeouts[0].message, "stalled");
    assert.equal(handle.failedOver, false);
    // The one shot is spent — a second pre-setup event must not retry the build.
    primary.fire("onError", new Error("second event"));
    assert.equal(site.seen.errors[0].message, "second event");
    // And with no fallback session in play, the primary's close must still
    // reach teardown — it is the only thing that ends the call.
    primary.fire("onClose", 1006, "");
    assert.equal(site.seen.closes.length, 1);
  });

  it("the fallback failing setup degrades to the plain error path — never a second failover", () => {
    const { primary, fallback, site } = build();
    primary.fire("onSetupTimeout", new Error("gemini stalled"));
    assert.equal(fallback.built, 1);
    fallback.fire("onSetupTimeout", new Error("openai stalled too"));
    // Routed to onSetupTimeout (the apology path), not swallowed, not retried.
    assert.equal(site.seen.setupTimeouts[0].message, "openai stalled too");
    assert.equal(fallback.built, 1);
  });

  it("failover fires at most once per call even with a cascade of pre-setup events", () => {
    const { primary, fallback, failovers } = build();
    primary.fire("onError", new Error("first"));
    primary.fire("onSetupTimeout", new Error("second"));
    primary.fire("onClose", 1006, "third");
    assert.equal(fallback.built, 1);
    assert.equal(failovers.length, 1);
  });

  it("tolerates a fallback session without sendText", () => {
    const bare = (config, callbacks) => {
      bare.built = (bare.built || 0) + 1;
      void callbacks;
      return {
        sendAudio: () => {},
        getTranscripts: () => ({ input: "", output: "" }),
        close: () => {},
        readyState: 1,
      };
    };
    const { primary, handle } = build({ fallbackFactory: bare });
    primary.fire("onSetupTimeout", new Error("stalled"));
    assert.doesNotThrow(() => handle.sendText("nudge"));
  });
});

describe("isFailoverEnabled (the kill switch)", () => {
  it("defaults ON when the fallback key exists — outages do not wait for opt-in", () => {
    assert.equal(isFailoverEnabled(undefined, true), true);
    assert.equal(isFailoverEnabled("", true), true);
    assert.equal(isFailoverEnabled("on", true), true);
  });

  it("every documented off-spelling disables it", () => {
    for (const v of ["off", "OFF", "false", "0", "disabled", " off "]) {
      assert.equal(isFailoverEnabled(v, true), false, v);
    }
  });

  it("fails CLOSED without a fallback API key, whatever the env says", () => {
    assert.equal(isFailoverEnabled("on", false), false);
    assert.equal(isFailoverEnabled(undefined, false), false);
  });
});
