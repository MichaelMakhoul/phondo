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

  it("/twiml gates demo-line calls by NUMBER-or-org (check → reject TwiML) as one unit", () => {
    // SCRUM-573: the gate must key on isDemoLineCall (published number OR demo
    // org) — keying on the org alone un-guards the line the moment the owner
    // points the number at a real org (Smile Hub).
    assert.match(
      src,
      /isDemoLineCall\(called, phoneRecord\)[^]{0,600}?checkDemoLineCall\(from\)[^]{0,600}?buildDemoLineRejectTwiml/
    );
  });

  it("the gate runs BEFORE any stream token is issued", () => {
    const gateIdx = src.indexOf("isDemoLineCall(called, phoneRecord)");
    const tokenIdx = src.indexOf("const token = issueStreamToken(called, from");
    assert.ok(gateIdx > 0, "gate must exist");
    assert.ok(tokenIdx > 0, "token issuance must exist");
    assert.ok(
      gateIdx < tokenIdx,
      "a rejected demo call must never be issued a stream token"
    );
  });

  it("the phone WS session gets the demo cap for demo-org OR demo-line calls, and the timer actually ends the call", () => {
    // Anchored through the close() call so a log-only timer callback (that
    // never ends the call) can't pass.
    assert.match(
      src,
      /organizationId === DEMO_ORG_ID \|\| isDemoLineNumber\(calledNumber\)[^]{0,600}?twilioWs\.close\(1000, "Demo max duration"\)[^]{0,300}?MAX_DEMO_CALL_DURATION_MS/
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
    // If the demo line's org ever drifted to ring_first answer mode, a gate
    // placed below that branch's early-return would silently un-gate calls.
    const gateIdx = src.indexOf("isDemoLineCall(called, phoneRecord)");
    const answerModeIdx = src.indexOf("getAnswerMode(called, phoneRecord)");
    assert.ok(gateIdx > 0, "gate must exist");
    assert.ok(answerModeIdx > 0, "ring-first branch must exist");
    assert.ok(gateIdx < answerModeIdx, "gate must run before ring-first");
  });

  it("the reject-TwiML voice lookup survives a null phone record (DB fail-open)", () => {
    // SCRUM-573 dropped the old invariant that phoneRecord is truthy inside
    // the gate (the line is gated by NUMBER even when lookup fails open to
    // null). Reverting this optional chain to `phoneRecord.organizations`
    // makes the over-quota reject path throw inside an async handler with no
    // try/catch — Twilio gets no response at all (dead air, not the polite
    // reject) exactly when the DB is down.
    assert.match(
      src,
      /buildDemoLineRejectTwiml\(getPollyVoice\(phoneRecord\?\.organizations\?\.country\)\)/
    );
  });

  it("the failed-transfer RECONNECT branch re-arms the demo cap", () => {
    // The reconnect path restores a saved session and never reaches the
    // normal start-branch cap block — without its own arming, a demo caller
    // whose transfer fails gets reconnected to an UNCAPPED paid session on
    // the public line. Newly reachable now that a real org (with transfers
    // possible) answers the line.
    assert.match(
      src,
      /session\.restoreFrom\(savedState\)[^]{0,600}?(organizationId === DEMO_ORG_ID \|\| isDemoLineNumber\(calledNumber\))[^]{0,700}?MAX_DEMO_CALL_DURATION_MS/
    );
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
