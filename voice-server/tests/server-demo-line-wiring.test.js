const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * SCRUM-571 — source-pin tests for the demo-line wiring (same idiom as
 * server-reschedule-ledger-wiring.test.js: the handlers live inside a
 * 4000-line monolith that can't be required without live env).
 *
 * What these guard against: the public demo number makes /twiml an
 * unauthenticated spend surface. Dropping the /twiml gate silently removes
 * the ONLY rate limit on the phone path (the browser demo's 10/IP/hr token
 * limit never sees phone calls), and dropping the WS cap lets one caller
 * hold a paid Gemini session open indefinitely on the demo org.
 */

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

describe("SCRUM-571: demo-line wiring", () => {
  it("server.js imports the demo-line guards", () => {
    assert.match(src, /require\("\.\/lib\/demo-line"\)/);
  });

  it("/twiml gates demo-org calls (check → reject TwiML) as one unit", () => {
    assert.match(
      src,
      /isDemoOrgPhone\(phoneRecord\)[^]{0,600}?checkDemoLineCall\(from\)[^]{0,600}?buildDemoLineRejectTwiml/
    );
  });

  it("the gate runs BEFORE any stream token is issued", () => {
    const gateIdx = src.indexOf("isDemoOrgPhone(phoneRecord)");
    const tokenIdx = src.indexOf("const token = issueStreamToken(called, from");
    assert.ok(gateIdx > 0, "gate must exist");
    assert.ok(tokenIdx > 0, "token issuance must exist");
    assert.ok(
      gateIdx < tokenIdx,
      "a rejected demo call must never be issued a stream token"
    );
  });

  it("the phone WS session gets the demo cap, keyed on DEMO_ORG_ID, and the timer actually ends the call", () => {
    // Anchored through the close() call so a log-only timer callback (that
    // never ends the call) can't pass.
    assert.match(
      src,
      /organizationId === DEMO_ORG_ID[^]{0,600}?twilioWs\.close\(1000, "Demo max duration"\)[^]{0,300}?MAX_DEMO_CALL_DURATION_MS/
    );
  });

  it("the demo cap timer is cleared IN THE CLOSE HANDLER, not somewhere else", () => {
    // `(code, reason)` disambiguates from the ping-interval close listener. A
    // clearTimeout moved into the timer's own callback would leave the timer
    // armed against every naturally-ended demo call.
    assert.match(
      src,
      /twilioWs\.on\("close", \(code, reason\) => \{[^]{0,400}?clearTimeout\(demoLineTimer\)/
    );
  });

  it("the gate also runs before the ring-first answerMode branch", () => {
    // If the demo org's answer mode ever drifted to ring_first, a gate placed
    // below that branch's early-return would silently un-gate those calls.
    const gateIdx = src.indexOf("isDemoOrgPhone(phoneRecord)");
    const answerModeIdx = src.indexOf("getAnswerMode(called, phoneRecord)");
    assert.ok(answerModeIdx > 0, "ring-first branch must exist");
    assert.ok(gateIdx < answerModeIdx, "gate must run before ring-first");
  });

  it("a capped call records demo-max-duration, not caller-hangup", () => {
    // cleanupSession defaults endedReason to "caller-hangup" — without this,
    // every 3-minute cutoff is misattributed to the prospect, and "did they
    // hang up or did we cut them off?" is exactly the demo-funnel question.
    assert.match(
      src,
      /session\.endedReason = "demo-max-duration"[^]{0,300}?twilioWs\.close\(1000, "Demo max duration"\)/
    );
  });
});
