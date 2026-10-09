// voice-server/lib/route-handlers/owner-pin.js
"use strict";
/**
 * SCRUM-587 — the owner PIN <Gather> and its Twilio action, POST /twiml/owner-pin
 * (spec §1 call flow, §8 error handling, §9 security). This is the security gate
 * of the owner assistant: it decides whether a call from the owner's registered
 * mobile gets the owner session or the receptionist.
 *
 * Same shape as kill-switch.js: pure TwiML builders plus a handler that takes a
 * dependency bundle, so every outcome is unit-testable without live env.
 *
 * Why Twilio collects the PIN here, BEFORE <Connect><Stream>: the Gemini prompt
 * and tools are fixed at session setup, and recording starts at the stream
 * `start` event, so the digits never reach the recording, the Gemini transcript,
 * the OpenAI analysis or the Deepgram re-transcription. NOTHING in this file
 * logs, pages, stamps or echoes req.body.Digits / req.body.SpeechResult or the
 * PIN read from them (pinned by tests/route-handlers/owner-pin.test.js and
 * tests/server-owner-pin-wiring.test.js).
 *
 * The route MUST sit behind validateTwilioSignature (server.js): isOwnerCall
 * trusts ForwardedFrom, and the per-call attempt counter rides on the action URL
 * as ?attempt=N, which Twilio signs together with the rest of the URL.
 *
 * A PIN entry of the right length is counted in BOTH persisted lockout windows
 * BEFORE it is checked, so a lucky guess made while locked still fails. A
 * wrong-length entry can never match, so it only uses up one of the call's three
 * tries and is not counted. Owner mode fails closed: every fault ends in the
 * receptionist (or a hang-up when there is no org to answer for), never in the
 * owner session.
 */
const ownerAuth = require("../owner-auth");

const SAY_PROMPT = "Hi, enter or say your PIN. Or stay on the line for the receptionist.";
const SAY_RETRY = "That's not right, try again.";
const SAY_CONTINUE = "Continuing as a normal call.";
const HANGUP_TWIML = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup/>\n</Response>`;

/** How long a verified owner's call waits for their first name before the greeting goes without it. */
const OWNER_NAME_TIMEOUT_MS = 1500;
const NAME_TIMED_OUT = Symbol("owner name lookup timed out");

/** @param {string|null|undefined} country ISO-3166-1 alpha-2 */
function gatherLanguageFor(country) {
  return String(country || "").toUpperCase() === "AU" ? "en-AU" : "en-US";
}

/**
 * The per-call attempt from the signed action URL's ?attempt=N: a decimal string
 * in 1..OWNER_PIN_MAX_PER_CALL. Anything else (no query, a repeated key that the
 * query parser turns into an array, a number out of range) is attempt 1.
 * @param {unknown} raw
 * @returns {number}
 */
function parseAttempt(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 1;
  const n = Number(raw);
  return n >= 1 && n <= ownerAuth.OWNER_PIN_MAX_PER_CALL ? n : 1;
}

/**
 * The spec's <Gather>. The prompt sits inside it, so a keypad entry interrupts
 * it. speechTimeout must be a positive integer whenever speechModel is set
 * (Twilio rule). actionOnEmptyResult makes Twilio post the action even when the
 * caller says or keys nothing: the "stay on the line for the receptionist" path.
 * @param {{ publicUrl: string, pollyVoice: string, pinLength: number, attempt: number, retry: boolean, language: string, escapeXml: (s: string) => string }} o
 * @returns {string}
 */
function buildOwnerPinGatherTwiml({ publicUrl, pollyVoice, pinLength, attempt, retry, language, escapeXml }) {
  const action = `${publicUrl}/twiml/owner-pin?attempt=${attempt}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf speech" numDigits="${escapeXml(String(pinLength))}" speechModel="numbers_and_commands" speechTimeout="2" timeout="6" language="${escapeXml(language)}" hints="0,1,2,3,4,5,6,7,8,9" actionOnEmptyResult="true" action="${escapeXml(action)}" method="POST">
    <Say voice="${escapeXml(pollyVoice)}">${escapeXml(retry ? SAY_RETRY : SAY_PROMPT)}</Say>
  </Gather>
</Response>`;
}

/**
 * The same <Connect><Stream> /twiml emits (server.js), optionally after one <Say>
 * ("Continuing as a normal call."). Recording is started by the WebSocket handler
 * through the REST API, as for every call; nothing to add here.
 * @param {{ wsUrl: string, token: string, escapeXml: (s: string) => string, sayFirst?: { voice: string, text: string } | null }} o
 * @returns {string}
 */
function buildConnectStreamTwiml({ wsUrl, token, escapeXml, sayFirst = null }) {
  const say = sayFirst ? `\n  <Say voice="${escapeXml(sayFirst.voice)}">${escapeXml(sayFirst.text)}</Say>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>${say}
  <Connect>
    <Stream url="${escapeXml(wsUrl)}">
      <Parameter name="auth_token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`;
}

/**
 * A failure's message for a log line: the message only. Never the object (a
 * PostgREST error carries details, and an Error's cause may be one) and never a
 * non-Error value turned into a string.
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  const message = err && typeof err === "object" ? /** @type {{ message?: unknown }} */ (err).message : undefined;
  return typeof message === "string" && message ? message : "unknown error";
}

/**
 * Page through the Sentry shim. Extras are ids only: never the PIN, the caller's
 * number or the owner_access row.
 * @param {any} Sentry
 * @param {unknown} err
 * @param {Record<string, unknown>} extras
 */
function page(Sentry, err, extras) {
  try {
    Sentry.withScope((/** @type {any} */ scope) => {
      scope.setTag("service", "owner_pin");
      scope.setLevel("error");
      scope.setExtras(extras);
      Sentry.captureException(err instanceof Error ? err : new Error(messageOf(err)));
    });
  } catch (sentryErr) {
    console.error("[OwnerPin] Sentry capture failed (suppressed):", messageOf(sentryErr));
  }
}

/**
 * After a VERIFIED PIN, without delaying the TwiML (neither write can reject or
 * throw out of here):
 *  - clear the 15-minute lockout window, so the owner's own logins never use it
 *    up. A failure pages: one that keeps failing would lock the owner out after
 *    five good calls in 15 minutes. The 24-hour window is never cleared.
 *  - stamp owner_access.last_verified_at (written only here; PR A never does).
 * @param {{ supabase: any, Sentry: any, organizationId: string, pinSalt: string, callSid: string|null }} o
 */
function afterVerifiedPin({ supabase, Sentry, organizationId, pinSalt, callSid }) {
  Promise.resolve()
    .then(() => ownerAuth.resetPinAttempts({ supabase, organizationId, pinSalt }))
    .then((result) => {
      if (result && result.ok === true) return;
      const err = result && result.error;
      console.error(`[ALERT:error] [OwnerPin] resetPinAttempts failed: the 15-minute PIN window was not cleared (org=${organizationId}, callSid=${callSid}):`, messageOf(err));
      page(Sentry, err, { callSid, organizationId, stage: "reset" });
    })
    .catch((err) => console.error(`[OwnerPin] resetPinAttempts follow-up failed (suppressed, callSid=${callSid}):`, messageOf(err)));

  Promise.resolve()
    .then(() => supabase.from("owner_access").update({ last_verified_at: new Date().toISOString() }).eq("organization_id", organizationId))
    .then((result) => {
      if (result && result.error) console.warn(`[OwnerPin] last_verified_at update failed (non-fatal, callSid=${callSid}):`, messageOf(result.error));
    })
    .catch((err) => console.warn(`[OwnerPin] last_verified_at update failed (non-fatal, callSid=${callSid}):`, messageOf(err)));
}

/**
 * The owner's first name for the greeting, or null. Raced against
 * OWNER_NAME_TIMEOUT_MS: Twilio is waiting on this webhook, so a stalled
 * Supabase request costs the greeting its name, never the call.
 * @param {(organizationId: string) => Promise<string|null>} loadOwnerFirstName
 * @param {string} organizationId
 * @param {string|null} callSid
 * @returns {Promise<string|null>}
 */
async function ownerFirstNameWithin(loadOwnerFirstName, organizationId, callSid) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(NAME_TIMED_OUT), OWNER_NAME_TIMEOUT_MS);
  });
  try {
    const name = await Promise.race([Promise.resolve().then(() => loadOwnerFirstName(organizationId)), timedOut]);
    if (name === NAME_TIMED_OUT) {
      console.warn(`[OwnerPin] Owner name lookup took over ${OWNER_NAME_TIMEOUT_MS} ms; greeting without a name (callSid=${callSid})`);
      return null;
    }
    return typeof name === "string" && name ? name : null;
  } catch (err) {
    console.warn(`[OwnerPin] Owner name lookup failed (non-fatal, callSid=${callSid}):`, messageOf(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /twiml/owner-pin (Twilio-signed by the server.js route). Outcomes (spec §1):
 *   no phone record ⇒ <Hangup/> (§8: no org to answer for)
 *   caller no longer the owner, or the flag is off ⇒ the receptionist, stamped "failed"
 *   no input ⇒ the receptionist, unstamped
 *   wrong length, or a wrong PIN ⇒ re-Gather while tries remain, else
 *     "Continuing as a normal call." ⇒ the receptionist, stamped "failed"
 *   lockout (either window, or the lockout check failing) ⇒
 *     "Continuing as a normal call." ⇒ the receptionist, stamped "locked"
 *   right PIN ⇒ the owner stream: { ownerMode: true, ownerAuth: "verified", ownerFirstName }
 * Always sends exactly one TwiML response and never rejects: a fault falls back
 * to the receptionist, or to a hang-up when no phone record was loaded.
 *
 * @param {{ body?: Record<string, any>, query?: Record<string, any> }} req
 * @param {{ type: (t: string) => any, send: (b: string) => any }} res
 * @param {{ deps: { lookupPhoneNumber: Function, supabase: any, loadOwnerFirstName: (organizationId: string) => Promise<string|null>, issueStreamToken: Function, Sentry: any, maskPhone: (phone: string) => string, escapeXml: (s: string) => string, getPollyVoice: (country: string|null|undefined) => string, publicUrl: string, wsUrl: string } }} opts
 * @returns {Promise<void>}
 */
async function handleOwnerPin(req, res, { deps }) {
  const { lookupPhoneNumber, supabase, loadOwnerFirstName, issueStreamToken, Sentry, maskPhone, escapeXml, getPollyVoice, publicUrl, wsUrl } = deps;
  const body = (req && req.body) || {};
  const called = typeof body.Called === "string" ? body.Called : "";
  const from = typeof body.From === "string" ? body.From : "";
  const callSid = typeof body.CallSid === "string" && body.CallSid ? body.CallSid : null;
  const attempt = parseAttempt(req && req.query ? req.query.attempt : undefined);

  let sent = false;
  /** @param {string} twiml */
  const send = (twiml) => {
    res.type("text/xml").send(twiml);
    sent = true;
  };
  /** @type {any} */
  let phoneRecord = null;
  /** @type {string|null} */
  let organizationId = null;
  /** @type {string|null} */
  let pollyVoice = null;
  /**
   * The receptionist: a customer stream, never owner mode.
   * @param {{ ownerAuth?: "locked"|"failed" }} extra
   * @param {string} [sayText]
   */
  const receptionist = (extra, sayText) =>
    send(buildConnectStreamTwiml({
      wsUrl,
      token: issueStreamToken(called, from, undefined, phoneRecord, extra),
      escapeXml,
      sayFirst: sayText && pollyVoice ? { voice: pollyVoice, text: sayText } : null,
    }));

  try {
    phoneRecord = await lookupPhoneNumber(called, { callSid });
    if (!phoneRecord) {
      console.error(`[OwnerPin] No phone record for ${called} at the PIN action (callSid=${callSid}); hanging up`);
      return send(HANGUP_TWIML);
    }
    organizationId = phoneRecord.organization_id;
    const country = phoneRecord.organizations && phoneRecord.organizations.country;
    pollyVoice = getPollyVoice(country);

    const access = ownerAuth.getEmbeddedOwnerAccess(phoneRecord);
    if (!ownerAuth.isOwnerCall({ from, forwardedFrom: body.ForwardedFrom, ownerAccess: access, enabled: ownerAuth.ownerAssistantEnabled() })) {
      // The row was removed or disabled, or the flag flipped, between the
      // Gather and its action: fail toward the receptionist, never owner mode.
      console.warn(`[OwnerPin] Caller no longer matches owner access (from=${maskPhone(from)}, callSid=${callSid}); continuing as a customer call`);
      return receptionist({ ownerAuth: "failed" });
    }

    const pinLength = ownerAuth.pinLengthOf(access);
    const pin = ownerAuth.normalisePinInput({ digits: body.Digits, speechResult: body.SpeechResult });
    if (pin === "") {
      console.log(`[OwnerPin] No PIN entered (attempt ${attempt}, callSid=${callSid}); continuing as a customer call`);
      return receptionist({});
    }

    /** A wrong try: gather again while the call has tries left, else the receptionist. @param {string} what */
    const wrongTry = (what) => {
      if (attempt < ownerAuth.OWNER_PIN_MAX_PER_CALL) {
        console.log(`[OwnerPin] ${what} (attempt ${attempt}/${ownerAuth.OWNER_PIN_MAX_PER_CALL}); gathering again (callSid=${callSid})`);
        return send(buildOwnerPinGatherTwiml({ publicUrl, pollyVoice, pinLength, attempt: attempt + 1, retry: true, language: gatherLanguageFor(country), escapeXml }));
      }
      console.warn(`[OwnerPin] ${what} on the last attempt; continuing as a customer call (callSid=${callSid})`);
      return receptionist({ ownerAuth: "failed" }, SAY_CONTINUE);
    };

    // A wrong-length entry can never match, so it is not counted in the
    // persisted windows: it only uses up one of this call's tries.
    if (pin.length !== pinLength) return wrongTry("PIN entry of the wrong length");

    // Counted BEFORE it is checked, in both windows (spec §1, Task 1 rulings).
    // Anything but an explicit "not locked" is locked: an RPC fault fails CLOSED.
    const bucket = await ownerAuth.countPinAttempt({ supabase, organizationId, pinSalt: access.pin_salt });
    if (!bucket || bucket.locked !== false) {
      if (!bucket || bucket.reason !== "exhausted") {
        console.error(`[ALERT:error] [OwnerPin] PIN lockout check (check_rate_limit_bucket) failed; failing CLOSED, treated as locked (org=${organizationId}, callSid=${callSid}):`, messageOf(bucket && bucket.error));
        page(Sentry, bucket && bucket.error, { callSid, organizationId, stage: "count" });
      }
      console.warn(`[OwnerPin] PIN locked (${bucket ? bucket.reason : "no result"}, window=${(bucket && bucket.window) || "n/a"}, count=${(bucket && bucket.count) ?? "n/a"}); continuing as a customer call (callSid=${callSid})`);
      return receptionist({ ownerAuth: "locked" }, SAY_CONTINUE);
    }

    // verifyPin is async and resolves to a boolean; only `true` is a match, so a
    // pending Promise (a dropped await) can never pass for one.
    const ok = pin.length === pinLength && (await ownerAuth.verifyPin({ pin, pinHash: access.pin_hash, pinSalt: access.pin_salt }));
    if (ok !== true) return wrongTry("Wrong PIN");

    afterVerifiedPin({ supabase, Sentry, organizationId, pinSalt: access.pin_salt, callSid });
    const ownerFirstName = await ownerFirstNameWithin(loadOwnerFirstName, organizationId, callSid);
    const token = issueStreamToken(called, from, undefined, phoneRecord, { ownerMode: true, ownerAuth: "verified", ownerFirstName });
    console.log(`[OwnerPin] Verified the owner of org=${organizationId} (callSid=${callSid}); starting the owner session`);
    return send(buildConnectStreamTwiml({ wsUrl, token, escapeXml }));
  } catch (err) {
    // Nothing above should throw. If something does, Twilio is still owed TwiML:
    // the receptionist when the org is known, else a hang-up. Never owner mode.
    console.error(`[ALERT:error] [OwnerPin] PIN action failed; answering as a customer call, or hanging up if that fails too (org=${organizationId}, callSid=${callSid}):`, messageOf(err));
    page(Sentry, err, { callSid, organizationId, stage: "handler" });
    if (sent) return;
    try {
      if (!phoneRecord) throw new Error("no phone record to continue the call with");
      receptionist({ ownerAuth: "failed" }, SAY_CONTINUE);
    } catch (fallbackErr) {
      console.error(`[OwnerPin] Could not continue as a customer call; hanging up (callSid=${callSid}):`, messageOf(fallbackErr));
      try {
        send(HANGUP_TWIML);
      } catch (sendErr) {
        console.error(`[OwnerPin] Could not send any TwiML (callSid=${callSid}):`, messageOf(sendErr));
      }
    }
  }
}

module.exports = {
  handleOwnerPin,
  buildOwnerPinGatherTwiml,
  buildConnectStreamTwiml,
  gatherLanguageFor,
  parseAttempt,
  HANGUP_TWIML,
  SAY_PROMPT,
  SAY_RETRY,
  SAY_CONTINUE,
};
