const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  isDemoOrgPhone,
  isDemoLineNumber,
  isDemoLineCall,
  checkDemoLineCall,
  resetDemoLineState,
  buildDemoLineRejectTwiml,
  DEMO_LINE_PER_CALLER_LIMIT,
  DEMO_LINE_PER_CALLER_WINDOW_MS,
  DEMO_LINE_GLOBAL_DAILY_LIMIT,
  DEMO_LINE_GLOBAL_WINDOW_MS,
} = require("../lib/demo-line");
const { DEMO_ORG_ID } = require("../lib/session-limits");

// The published demo line (default of DEMO_LINE_NUMBERS). SCRUM-573: the owner
// points this number at a REAL org (Smile Hub Dental — richer prompt than the
// seeded demo assistant), so guards must key on the number itself, not only
// the demo org.
const LINE = "+61238205672";

/**
 * SCRUM-571: the tap-to-call demo line points a real Twilio number at the
 * public demo org, which makes /twiml an unauthenticated spend surface —
 * every accepted call opens a paid Gemini Live session. These guards are the
 * phone-path equivalent of the browser demo's token rate limit (10/IP/hr in
 * the Next.js token route): a per-caller cap, a global rolling-day cap, and
 * (wired in server.js) the same 3-minute session ceiling as /ws/test.
 */

const T0 = 1_800_000_000_000; // fixed epoch base — tests pass `now` explicitly

describe("SCRUM-571: isDemoOrgPhone", () => {
  it("is true only for a phone record owned by the demo org", () => {
    assert.equal(isDemoOrgPhone({ organization_id: DEMO_ORG_ID }), true);
    assert.equal(isDemoOrgPhone({ organization_id: "11111111-2222-4333-a444-555555555555" }), false);
  });

  it("is null/undefined-safe (missing record → not a demo call)", () => {
    assert.equal(isDemoOrgPhone(null), false);
    assert.equal(isDemoOrgPhone(undefined), false);
    assert.equal(isDemoOrgPhone({}), false);
  });
});

describe("SCRUM-573: isDemoLineNumber / isDemoLineCall — guards follow the NUMBER", () => {
  it("the published demo line number is recognized by default (no env needed)", () => {
    assert.equal(isDemoLineNumber(LINE), true);
    assert.equal(isDemoLineNumber("+61257015064"), false); // a customer number
    assert.equal(isDemoLineNumber(null), false);
    assert.equal(isDemoLineNumber(undefined), false);
    assert.equal(isDemoLineNumber(""), false);
  });

  it("a call TO the line is gated regardless of which org the number points at", () => {
    const smileHubRecord = { organization_id: "35cc7464-e4c5-4924-bf39-f5f939824825" };
    assert.equal(isDemoLineCall(LINE, smileHubRecord), true);
  });

  it("a call to a demo-org number is gated even if it isn't the published line", () => {
    assert.equal(isDemoLineCall("+61200000000", { organization_id: DEMO_ORG_ID }), true);
  });

  it("a customer call to a customer number is NEVER gated", () => {
    const customerRecord = { organization_id: "ea3d12cd-797a-4c7d-aef5-3afde5c0ab41" };
    assert.equal(isDemoLineCall("+61257015064", customerRecord), false);
  });

  it("the line stays gated even when the phone record is null (DB fail-open path)", () => {
    // lookupPhoneNumber fails open to AI-answers on DB errors — the rate gate
    // keyed on the called number must survive that, or an outage would turn
    // the public line into an unlimited spend surface.
    assert.equal(isDemoLineCall(LINE, null), true);
  });

  it("a customer call stays UN-gated when the phone record is null (fail-open must not gate the fleet)", () => {
    // Inverse of the line+null case: during a DB outage every lookup returns
    // null. A fail-closed edit (e.g. `|| !phoneRecord`) would put ALL customer
    // calls behind the shared 30/day global demo budget and the 3-minute cap —
    // a fleet-wide outage. Fail-open means customer calls stay uncapped.
    assert.equal(isDemoLineCall("+61257015064", null), false);
    assert.equal(isDemoLineCall("+61257015064", undefined), false);
    assert.equal(isDemoLineCall(null, null), false);
  });
});

describe("SCRUM-573: DEMO_LINE_NUMBERS env parsing (fresh process — module-load state)", () => {
  const { execFileSync } = require("node:child_process");

  it("a custom env set REPLACES the default, trims whitespace, splits on commas", () => {
    // Parsed once at module load, so this runs in a child process instead of
    // fighting the require cache. Guards the owner's number-rotation path: a
    // dropped trim, a renamed env var, or the default surviving a replace all
    // fail silently into an un-guarded public spend surface.
    const out = execFileSync(
      process.execPath,
      ["-e", `
        const { isDemoLineNumber } = require(${JSON.stringify(require.resolve("../lib/demo-line"))});
        console.log(JSON.stringify([
          isDemoLineNumber("+61299999999"),
          isDemoLineNumber("+61288888888"),
          isDemoLineNumber("+61238205672"),
        ]));
      `],
      { env: { ...process.env, DEMO_LINE_NUMBERS: "+61299999999, +61288888888 ," } }
    ).toString().trim();
    // Boot may log guard lines before the payload — the assertion reads the
    // LAST stdout line. [custom #1, custom #2 (had spaces), default gone]
    assert.deepEqual(JSON.parse(out.split("\n").pop()), [true, true, false]);
  });
});

describe("SCRUM-571: checkDemoLineCall — per-caller cap", () => {
  beforeEach(() => resetDemoLineState());

  it("allows the first N calls from one caller, rejects call N+1 with caller-cap", () => {
    for (let i = 0; i < DEMO_LINE_PER_CALLER_LIMIT; i++) {
      assert.equal(checkDemoLineCall("+61400000001", T0 + i).allowed, true, `call ${i + 1} should pass`);
    }
    const rejected = checkDemoLineCall("+61400000001", T0 + 10);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.reason, "caller-cap");
  });

  it("a different caller is unaffected by another caller's cap", () => {
    for (let i = 0; i < DEMO_LINE_PER_CALLER_LIMIT; i++) {
      checkDemoLineCall("+61400000001", T0 + i);
    }
    assert.equal(checkDemoLineCall("+61400000002", T0 + 20).allowed, true);
  });

  it("the cap is a rolling window — expiry re-allows the caller", () => {
    for (let i = 0; i < DEMO_LINE_PER_CALLER_LIMIT; i++) {
      checkDemoLineCall("+61400000001", T0 + i);
    }
    assert.equal(checkDemoLineCall("+61400000001", T0 + 10).allowed, false);
    const afterWindow = T0 + DEMO_LINE_PER_CALLER_WINDOW_MS + 1_000;
    assert.equal(checkDemoLineCall("+61400000001", afterWindow).allowed, true);
  });

  it("withheld caller ids share ONE anonymous bucket (no cap bypass via CLIR)", () => {
    // null, undefined, and empty string must all count against the same
    // bucket — otherwise withholding caller id makes the per-caller cap free.
    assert.equal(checkDemoLineCall(null, T0).allowed, true);
    assert.equal(checkDemoLineCall(undefined, T0 + 1).allowed, true);
    assert.equal(checkDemoLineCall("", T0 + 2).allowed, true);
    const rejected = checkDemoLineCall("anonymous", T0 + 3);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.reason, "caller-cap");
  });
});

describe("SCRUM-571: checkDemoLineCall — global rolling-day cap", () => {
  beforeEach(() => resetDemoLineState());

  it("rejects with global-cap once the daily total is hit, regardless of caller", () => {
    for (let i = 0; i < DEMO_LINE_GLOBAL_DAILY_LIMIT; i++) {
      const r = checkDemoLineCall(`+6140000${String(1000 + i)}`, T0 + i);
      assert.equal(r.allowed, true, `distinct caller ${i + 1} should pass`);
    }
    const rejected = checkDemoLineCall("+61400009999", T0 + 100_000);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.reason, "global-cap");
  });

  it("rejected calls do not consume quota", () => {
    // Fill ONE caller past their cap; the two rejections must not count
    // toward the global limit, so 27 further distinct callers still fit.
    for (let i = 0; i < DEMO_LINE_PER_CALLER_LIMIT; i++) {
      checkDemoLineCall("+61400000001", T0 + i);
    }
    checkDemoLineCall("+61400000001", T0 + 10); // rejected
    checkDemoLineCall("+61400000001", T0 + 11); // rejected
    const remaining = DEMO_LINE_GLOBAL_DAILY_LIMIT - DEMO_LINE_PER_CALLER_LIMIT;
    for (let i = 0; i < remaining; i++) {
      const r = checkDemoLineCall(`+6140000${String(2000 + i)}`, T0 + 20 + i);
      assert.equal(r.allowed, true, `caller ${i + 1}/${remaining} should still fit under the global cap`);
    }
    assert.equal(checkDemoLineCall("+61400008888", T0 + 500).allowed, false);
  });

  it("the global cap is a rolling DAY — outlives the caller window, frees after 24h", () => {
    for (let i = 0; i < DEMO_LINE_GLOBAL_DAILY_LIMIT; i++) {
      assert.equal(checkDemoLineCall(`+6140000${String(1000 + i)}`, T0 + i).allowed, true);
    }
    // 2h later: every caller bucket has expired (1h window), but the global
    // budget must still be spent — caller pruning must not free global quota.
    // (A window-constant swap to the 1h caller window would turn 30/day into
    // ~720 paid Gemini sessions/day and pass every other test.)
    const midDay = checkDemoLineCall("+61400009999", T0 + 2 * 60 * 60 * 1000);
    assert.equal(midDay.allowed, false);
    assert.equal(midDay.reason, "global-cap");
    // Past the 24h window the demo line must come back — a permanent lifetime
    // cap would silently kill the demo line until the next redeploy.
    assert.equal(
      checkDemoLineCall("+61400009999", T0 + DEMO_LINE_GLOBAL_WINDOW_MS + 1000).allowed,
      true
    );
  });
});

describe("SCRUM-571: buildDemoLineRejectTwiml", () => {
  it("is a complete polite TwiML: Say with the given voice, then Hangup — never a stream", () => {
    const xml = buildDemoLineRejectTwiml("Polly.Nicole");
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<Say voice="Polly\.Nicole">[^<]+<\/Say>/);
    assert.match(xml, /<Hangup\/>/);
    assert.ok(!xml.includes("<Connect"), "reject TwiML must never open a stream");
    assert.ok(!xml.includes("<Stream"), "reject TwiML must never open a stream");
  });
});
