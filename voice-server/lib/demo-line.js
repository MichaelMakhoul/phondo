/**
 * SCRUM-571: guards for the public tap-to-call demo line.
 *
 * A real Twilio number points at the public demo org so prospects can ring
 * the AI like a customer would. That makes /twiml an UNAUTHENTICATED spend
 * surface — every accepted call opens a paid Gemini Live session — so the
 * demo org's phone path gets the rate limits the browser demo already has
 * via its token route (10/IP/hr in Next.js): a per-caller cap and a global
 * rolling-day cap, enforced BEFORE a stream token is issued. The matching
 * per-session duration ceiling reuses MAX_DEMO_CALL_DURATION_MS from
 * session-limits.js and is wired at the Twilio WS site in server.js.
 *
 * In-memory on purpose: the voice server runs as a single Fly machine, and a
 * restart resetting the counters only fails OPEN into the caps again — the
 * blast radius of losing state is "a caller gets a few extra demo calls",
 * never "a customer call is dropped".
 */

const { DEMO_ORG_ID } = require("./session-limits");

const DEMO_LINE_PER_CALLER_LIMIT = 3; // calls per caller per rolling hour
const DEMO_LINE_PER_CALLER_WINDOW_MS = 60 * 60 * 1000;
const DEMO_LINE_GLOBAL_DAILY_LIMIT = 30; // calls across ALL callers per rolling day
const DEMO_LINE_GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, number[]>} accepted-call timestamps per caller */
let callerLog = new Map();
/** @type {number[]} accepted-call timestamps across all callers */
let globalLog = [];

/**
 * Whether a lookupPhoneNumber() record belongs to the public demo org.
 * @param {{ organization_id?: string } | null | undefined} phoneRecord
 * @returns {boolean}
 */
function isDemoOrgPhone(phoneRecord) {
  return !!phoneRecord && phoneRecord.organization_id === DEMO_ORG_ID;
}

/**
 * Rate-gate one inbound demo-line call. Only ACCEPTED calls consume quota —
 * a rejected caller redialing must not burn the global budget.
 *
 * Withheld caller ids (null/empty From) all share one "anonymous" bucket so
 * CLIR can't bypass the per-caller cap.
 *
 * @param {string | null | undefined} callerPhone - Twilio `From` (E.164), if presented
 * @param {number} [now] - injectable clock for tests
 * @returns {{ allowed: boolean, reason?: "caller-cap" | "global-cap" }} reason is set iff allowed is false
 */
function checkDemoLineCall(callerPhone, now = Date.now()) {
  const caller = callerPhone || "anonymous";

  // Prune expired entries (and empty caller buckets, so the map can't grow
  // unboundedly across a long process lifetime).
  globalLog = globalLog.filter((t) => now - t < DEMO_LINE_GLOBAL_WINDOW_MS);
  for (const [key, stamps] of callerLog) {
    const fresh = stamps.filter((t) => now - t < DEMO_LINE_PER_CALLER_WINDOW_MS);
    if (fresh.length === 0) callerLog.delete(key);
    else callerLog.set(key, fresh);
  }

  if (globalLog.length >= DEMO_LINE_GLOBAL_DAILY_LIMIT) {
    return { allowed: false, reason: "global-cap" };
  }
  const stamps = callerLog.get(caller) || [];
  if (stamps.length >= DEMO_LINE_PER_CALLER_LIMIT) {
    return { allowed: false, reason: "caller-cap" };
  }

  stamps.push(now);
  callerLog.set(caller, stamps);
  globalLog.push(now);
  return { allowed: true };
}

/**
 * Polite rejection TwiML for an over-limit demo call. Static copy only —
 * never opens a stream, so a rejected call costs one Twilio-minute rounding,
 * not a Gemini session.
 * @param {string} pollyVoice - from getPollyVoice(country); fixed vocabulary, safe to interpolate
 * @returns {string}
 */
function buildDemoLineRejectTwiml(pollyVoice) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${pollyVoice}">Thanks for calling the Phondo demo line. The demo has reached its call limit for now. Please try again a little later, or visit phondo dot A I to talk to the demo in your browser. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

/** Test-only: clear all rate-limit state. */
function resetDemoLineState() {
  callerLog = new Map();
  globalLog = [];
}

module.exports = {
  isDemoOrgPhone,
  checkDemoLineCall,
  buildDemoLineRejectTwiml,
  resetDemoLineState,
  DEMO_LINE_PER_CALLER_LIMIT,
  DEMO_LINE_PER_CALLER_WINDOW_MS,
  DEMO_LINE_GLOBAL_DAILY_LIMIT,
  DEMO_LINE_GLOBAL_WINDOW_MS,
};
