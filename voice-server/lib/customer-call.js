// voice-server/lib/customer-call.js
"use strict";
/**
 * SCRUM-598 — the AI's call to a customer, placed on the business owner's request
 * from an owner-assistant session (spec: docs/superpowers/specs/2026-10-26-owner-
 * assistant-everywhere-design.md, "PR 2"). The owner asked for it in their own
 * words: "call the client ... confirm the appointment or cancel it", "call them and
 * get another time, or call them and cancel".
 *
 * This module decides WHETHER a call may be placed (checkCustomerCall), places it
 * (placeCustomerCall), answers Twilio's TwiML fetch once the call is picked up
 * (handleCustomerCallTwiml) and finishes the calls nobody talked on
 * (handleCustomerCallStatus). server.js wires the routes and runs the /ws/audio
 * notify session itself, like any other phone call.
 *
 * Every check fails closed: an unreadable row, a booking in the wrong state, a
 * number that isn't the booking's own, all mean "no call". The request must name an
 * owner session of the same org, so a call can only ever follow an owner's yes.
 * Everything is injected (supabase, twilio, clock, secret) so each outcome is
 * unit-tested without live services. Nothing here logs a customer's name or number.
 */
const crypto = require("crypto");

/** What a call is about. cancelled/moved follow an owner change; confirm/find_new_time are owner_call_customer. */
const NOTIFY_PURPOSES = Object.freeze(["cancelled", "moved", "confirm", "find_new_time"]);
/** calls.metadata.call_type of a customer call placed by the assistant. */
const CUSTOMER_NOTIFY_CALL_TYPE = "customer_notify";
/** What the assistant may record about the call (record_call_outcome). */
const CALL_OUTCOMES = Object.freeze(["confirmed", "rebooked", "declined", "will_call_back", "wrong_person", "do_not_call", "other"]);

/** Calls only between 8:00 and 20:00 in the org's timezone (the hour the call is placed). */
const CALLING_START_HOUR = 8;
const CALLING_END_HOUR = 20;
const DEFAULT_TZ = "Australia/Sydney";
/** Caps over the last 24 hours. */
const ORG_CALLS_PER_DAY = 20;
const NUMBER_CALLS_PER_DAY = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The TwiML and status URLs carry the token: ringing + AMD + a 5-minute call fit well inside. */
const TOKEN_TTL_MS = 15 * 60 * 1000;
const RING_TIMEOUT_SECONDS = 25;
/** Twilio's TimeLimit: the call is cut at 5 minutes whatever happens on it. */
const CALL_TIME_LIMIT_SECONDS = 300;
/** Process-wide backstop against a runaway loop: placements per window, all orgs together. */
const PLACEMENTS_PER_WINDOW = 30;
const PLACEMENT_WINDOW_MS = 10 * 60 * 1000;

const ACTIVE_STATUSES = new Set(["confirmed", "pending"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** AU numbers we may ring: geographic (02/03/07/08) and mobile (04), in E.164. */
const AU_DIALABLE_RE = /^\+61[23478]\d{8}$/;
const AMD_VOICEMAIL = new Set(["machine_end_beep", "machine_end_silence", "machine_end_other"]);
const AMD_CONVERSATION = new Set(["human", "unknown"]);
/** Twilio's terminal call statuses (StatusCallbackEvent "completed" fires once with one of them). */
const TERMINAL_TWILIO_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
const HANGUP_TWIML = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup/>\n</Response>`;

/**
 * Why a call can't be placed. Next.js turns each into the owner's spoken reason
 * (src/lib/owner-assistant/customer-call.ts) — keep the two lists in step.
 * @typedef {"calls_disabled"|"pipeline_unavailable"|"invalid_request"|"not_owner_session"|"demo_org"|"not_found"|"wrong_state"|"number_mismatch"|"not_au"|"outside_hours"|"no_caller_number"|"org_cap"|"number_cap"|"already_called"|"do_not_call"|"check_failed"|"busy"|"place_failed"} CallBlockReason
 */

/**
 * @typedef {object} CustomerCallRequest
 * @property {string} organizationId
 * @property {string} appointmentId - the booking the call is about: the cancelled one, the NEW leg of a move, or the booking to confirm / move
 * @property {string} purpose - one of NOTIFY_PURPOSES
 * @property {string} phone - the customer's number in E.164, as Next.js normalised it
 * @property {string} requestedByCallId - the owner session (calls.id) the request came from
 * @property {string|null} [ownerNote] - find_new_time only: the owner's guidance on times ("next week, mornings")
 */

/**
 * @typedef {object} CustomerCallPlan
 * @property {string} organizationId
 * @property {string} orgName
 * @property {string} timezone
 * @property {string} purpose
 * @property {string} phone
 * @property {string} requestedByCallId
 * @property {string|null} ownerNote
 * @property {{ id: string, status: string, start_time: string }} appointment
 * @property {{ id: string, phone_number: string, assistant_id: string }} fromNumber
 */

/** @typedef {{ ok: true, plan: CustomerCallPlan } | { ok: false, reason: CallBlockReason }} CheckResult */

/**
 * @typedef {object} CheckDeps
 * @property {any} supabase - service-role client
 * @property {Record<string, string|undefined>} [env]
 * @property {() => number} [now]
 * @property {() => boolean} pipelineAvailable - true when a Gemini Live session can be opened
 * @property {string} demoOrgId
 */

/** @param {Record<string, string|undefined>} [env] */
function isCustomerCallsEnabled(env = process.env) {
  return env.OWNER_CUSTOMER_CALLS_ENABLED === "true";
}

/**
 * The org-local hour (0-23). A zone Intl can't use falls back to Sydney (the
 * product's AU default), never to the server's UTC.
 * @param {number} nowMs
 * @param {string|null|undefined} timeZone
 * @returns {number}
 */
function localHour(nowMs, timeZone) {
  const hourIn = (/** @type {string} */ zone) => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
    return Number(parts.find((p) => p.type === "hour")?.value);
  };
  try {
    return hourIn(timeZone || DEFAULT_TZ);
  } catch {
    return hourIn(DEFAULT_TZ);
  }
}

/**
 * @param {number} nowMs
 * @param {string|null|undefined} timeZone
 */
function withinCallingHours(nowMs, timeZone) {
  const h = localHour(nowMs, timeZone);
  return Number.isInteger(h) && h >= CALLING_START_HOUR && h < CALLING_END_HOUR;
}

/** @param {unknown} v */
function digitsOf(v) {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

/**
 * The number Next.js normalised is the booking's own: the last 9 digits agree
 * ("+61412345678" and a stored "0412 345 678" both end 412345678). Without this,
 * a caller of the endpoint could ring any number under a real booking's name.
 * @param {string} e164
 * @param {unknown} stored
 */
function matchesBookingPhone(e164, stored) {
  const a = digitsOf(e164);
  const b = digitsOf(stored);
  if (a.length < 9 || b.length < 9) return false;
  return a.slice(-9) === b.slice(-9);
}

/** @param {string} b64 @param {string} secret */
function macOf(b64, secret) {
  // "cc." separates this MAC from every other use of INTERNAL_API_SECRET.
  return crypto.createHmac("sha256", secret).update(`cc.${b64}`).digest("base64url");
}

/**
 * The token on the TwiML and status URLs: ids only (a URL shows up in Twilio's
 * logs, so never a name or number), signed and short-lived.
 * @param {{ callId: string, organizationId: string, appointmentId: string, purpose: string, requestedByCallId: string, phoneNumberId: string }} data
 * @param {string} secret
 * @param {{ now?: () => number }} [opts]
 */
function mintCustomerCallToken(data, secret, { now = Date.now } = {}) {
  const payload = {
    v: 1,
    callId: data.callId,
    organizationId: data.organizationId,
    appointmentId: data.appointmentId,
    purpose: data.purpose,
    requestedByCallId: data.requestedByCallId,
    phoneNumberId: data.phoneNumberId,
    exp: now() + TOKEN_TTL_MS,
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${macOf(b64, secret)}`;
}

/**
 * @typedef {{ v: 1, callId: string, organizationId: string, appointmentId: string, purpose: string, requestedByCallId: string, phoneNumberId: string, exp: number }} CustomerCallToken
 */

/**
 * The token's payload, or null when it is malformed, tampered with, expired or
 * not shaped like one of ours. Constant-time MAC compare.
 * @param {unknown} token
 * @param {string|undefined} secret
 * @param {{ now?: () => number }} [opts]
 * @returns {CustomerCallToken|null}
 */
function verifyCustomerCallToken(token, secret, { now = Date.now } = {}) {
  if (typeof token !== "string" || typeof secret !== "string" || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [b64, mac] = parts;
  const given = Buffer.from(mac);
  const expected = Buffer.from(macOf(b64, secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || payload.v !== 1) return null;
  if (typeof payload.exp !== "number" || now() > payload.exp) return null;
  for (const key of ["callId", "organizationId", "appointmentId", "requestedByCallId", "phoneNumberId"]) {
    if (typeof payload[key] !== "string" || !UUID_RE.test(payload[key])) return null;
  }
  if (!NOTIFY_PURPOSES.includes(payload.purpose)) return null;
  return /** @type {CustomerCallToken} */ (payload);
}

/**
 * @param {CallBlockReason} reason
 * @returns {{ ok: false, reason: CallBlockReason }}
 */
function blocked(reason) {
  return { ok: false, reason };
}

/**
 * Whether the booking is in the state the purpose needs, at this phase. A cancel's
 * read-back happens BEFORE the cancel (the booking is still live) and its call
 * after it; every other purpose is about a live booking.
 * @param {string} purpose
 * @param {"check"|"place"} phase
 * @param {string} status
 */
function stateFits(purpose, phase, status) {
  if (purpose === "cancelled" && phase === "place") return status === "cancelled";
  return ACTIVE_STATUSES.has(status);
}

/**
 * Every condition for placing a call, in the spec's order. "check" is the owner's
 * read-back (is "call" an option?); "place" re-checks all of it at the moment of
 * dialling. Never throws: a query error is check_failed.
 * @param {CustomerCallRequest} req
 * @param {"check"|"place"} phase
 * @param {CheckDeps} deps
 * @returns {Promise<CheckResult>}
 */
async function checkCustomerCall(req, phase, deps) {
  const env = deps.env || process.env;
  const nowMs = (deps.now || Date.now)();
  if (!isCustomerCallsEnabled(env)) return blocked("calls_disabled");
  if (!deps.pipelineAvailable()) return blocked("pipeline_unavailable");
  if (
    !req ||
    typeof req.organizationId !== "string" || !UUID_RE.test(req.organizationId) ||
    typeof req.appointmentId !== "string" || !UUID_RE.test(req.appointmentId) ||
    typeof req.requestedByCallId !== "string" || !UUID_RE.test(req.requestedByCallId) ||
    !NOTIFY_PURPOSES.includes(req.purpose) ||
    typeof req.phone !== "string"
  ) {
    return blocked("invalid_request");
  }
  if (req.organizationId === deps.demoOrgId) return blocked("demo_org");
  if (!AU_DIALABLE_RE.test(req.phone)) return blocked("not_au");

  const supabase = deps.supabase;
  try {
    // 1. Only ever on an owner's request: the session must be this org's owner call.
    const { data: ownerCall, error: ownerErr } = await supabase
      .from("calls")
      .select("id, metadata")
      .eq("id", req.requestedByCallId)
      .eq("organization_id", req.organizationId)
      .maybeSingle();
    if (ownerErr) return blocked("check_failed");
    if (!ownerCall || ownerCall.metadata?.call_type !== "owner") return blocked("not_owner_session");

    // 2. The org: Australian, with a zone for the calling hours.
    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .select("id, name, timezone, country")
      .eq("id", req.organizationId)
      .maybeSingle();
    if (orgErr) return blocked("check_failed");
    if (!org) return blocked("not_found");
    if (String(org.country || "").toUpperCase() !== "AU") return blocked("not_au");

    // 3. The booking: the org's, in the state the purpose needs, still ahead, and
    // the number being rung is its own.
    const { data: appt, error: apptErr } = await supabase
      .from("appointments")
      .select("id, status, start_time, attendee_phone")
      .eq("id", req.appointmentId)
      .eq("organization_id", req.organizationId)
      .maybeSingle();
    if (apptErr) return blocked("check_failed");
    if (!appt) return blocked("not_found");
    const startMs = Date.parse(appt.start_time);
    if (!stateFits(req.purpose, phase, appt.status) || !Number.isFinite(startMs) || startMs <= nowMs) {
      return blocked("wrong_state");
    }
    if (!matchesBookingPhone(req.phone, appt.attendee_phone)) return blocked("number_mismatch");

    // 4. Calling hours, org-local.
    if (!withinCallingHours(nowMs, org.timezone)) return blocked("outside_hours");

    // 5. A Phondo number to ring from — the caller ID, so calling back reaches the
    // receptionist. Same conditions loadCallContext needs to run the session.
    const { data: numbers, error: numErr } = await supabase
      .from("phone_numbers")
      .select("id, phone_number, assistant_id")
      .eq("organization_id", req.organizationId)
      .eq("is_active", true)
      .eq("ai_enabled", true)
      .eq("telephony_provider", "twilio")
      .is("released_at", null)
      .not("assistant_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(1);
    if (numErr) return blocked("check_failed");
    const fromNumber = Array.isArray(numbers) ? numbers[0] : null;
    if (!fromNumber || typeof fromNumber.phone_number !== "string" || !fromNumber.assistant_id) {
      return blocked("no_caller_number");
    }

    // 6. Caps over the last 24 hours, and no second call about the same thing.
    // A call that never got through (no answer, busy, failed) doesn't stop a retry.
    const since = new Date(nowMs - DAY_MS).toISOString();
    const { data: recent, error: recentErr } = await supabase
      .from("calls")
      .select("id, caller_phone, status, outcome, metadata")
      .eq("organization_id", req.organizationId)
      .eq("metadata->>call_type", CUSTOMER_NOTIFY_CALL_TYPE)
      .gte("created_at", since)
      .limit(ORG_CALLS_PER_DAY + 1);
    if (recentErr || !Array.isArray(recent)) return blocked("check_failed");
    if (recent.length >= ORG_CALLS_PER_DAY) return blocked("org_cap");
    const toThisNumber = recent.filter((c) => c.caller_phone === req.phone);
    if (toThisNumber.length >= NUMBER_CALLS_PER_DAY) return blocked("number_cap");
    const aboutThis = recent.some(
      (c) =>
        c.metadata?.notify?.appointment_id === req.appointmentId &&
        c.metadata?.notify?.purpose === req.purpose &&
        (["queued", "ringing", "in-progress"].includes(c.status) || c.outcome === "answered" || c.outcome === "voicemail")
    );
    if (aboutThis) return blocked("already_called");

    // 7. Never a number that asked not to be called again (any time, this org).
    const { data: dnc, error: dncErr } = await supabase
      .from("calls")
      .select("id")
      .eq("organization_id", req.organizationId)
      .eq("caller_phone", req.phone)
      .eq("metadata->>call_type", CUSTOMER_NOTIFY_CALL_TYPE)
      .eq("metadata->notify->>outcome", "do_not_call")
      .limit(1);
    if (dncErr || !Array.isArray(dnc)) return blocked("check_failed");
    if (dnc.length > 0) return blocked("do_not_call");

    return {
      ok: true,
      plan: {
        organizationId: req.organizationId,
        orgName: typeof org.name === "string" ? org.name : "",
        timezone: org.timezone || DEFAULT_TZ,
        purpose: req.purpose,
        phone: req.phone,
        requestedByCallId: req.requestedByCallId,
        ownerNote: req.purpose === "find_new_time" ? ownerNoteOf(req.ownerNote) : null,
        appointment: { id: appt.id, status: appt.status, start_time: appt.start_time },
        fromNumber: { id: fromNumber.id, phone_number: fromNumber.phone_number, assistant_id: fromNumber.assistant_id },
      },
    };
  } catch (err) {
    console.error("[CustomerCall] check threw:", err instanceof Error ? err.message : String(err));
    return blocked("check_failed");
  }
}

const OWNER_NOTE_MAX = 160;

/**
 * The owner's note as one capped line, or null. It reaches the call's prompt
 * (lib/notify-call-prompt.js flattens it again where it is used).
 * @param {unknown} v
 * @returns {string|null}
 */
function ownerNoteOf(v) {
  if (typeof v !== "string") return null;
  const note = v.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, OWNER_NOTE_MAX).trim();
  return note || null;
}

/** The calls.metadata a customer call starts with (completeCallRecord re-sends it at the end). */
function initialMetadata(/** @type {CustomerCallPlan} */ plan) {
  return {
    voice_provider: "self_hosted",
    call_type: CUSTOMER_NOTIFY_CALL_TYPE,
    notify: {
      purpose: plan.purpose,
      appointment_id: plan.appointment.id,
      requested_by_call_id: plan.requestedByCallId,
      ...(plan.ownerNote ? { owner_note: plan.ownerNote } : {}),
    },
  };
}

// Process-wide placement guards: one placement in flight per booking + purpose (two
// parallel tool calls must not both pass the "already called" check), and a backstop
// window across all orgs.
const inFlight = new Set();
/** @type {number[]} */
const recentPlacements = [];

/** @param {number} nowMs */
function placementWindowFull(nowMs) {
  while (recentPlacements.length && nowMs - recentPlacements[0] > PLACEMENT_WINDOW_MS) recentPlacements.shift();
  return recentPlacements.length >= PLACEMENTS_PER_WINDOW;
}

/**
 * @typedef {object} PlaceDeps
 * @property {{ createCall: (params: Record<string, unknown>) => Promise<{ sid?: string }|null|undefined>, cancelCall: (sid: string) => Promise<unknown> }} twilio
 * @property {string} publicUrl
 * @property {string} secret
 * @property {() => string} [randomUUID]
 */

/**
 * Re-check everything, then ring. The call row is written right after Twilio
 * accepts the call (its id is minted first so the token can carry it); if the row
 * can't be written the call is cancelled before anyone answers it, so no call ever
 * runs without a record.
 * @param {CustomerCallRequest} req
 * @param {CheckDeps & PlaceDeps} deps
 * @returns {Promise<{ placed: true, callId: string, callSid: string } | { placed: false, reason: CallBlockReason }>}
 */
async function placeCustomerCall(req, deps) {
  const nowMs = (deps.now || Date.now)();
  const key = `${req?.organizationId}:${req?.appointmentId}:${req?.purpose}`;
  if (inFlight.has(key)) return { placed: false, reason: "already_called" };
  if (placementWindowFull(nowMs)) {
    console.error(`[ALERT:error] [CustomerCall] placement backstop hit (${PLACEMENTS_PER_WINDOW} calls in ${PLACEMENT_WINDOW_MS / 60000} min) — refusing`);
    return { placed: false, reason: "busy" };
  }
  inFlight.add(key);
  try {
    const checked = await checkCustomerCall(req, "place", deps);
    if (checked.ok === false) return { placed: false, reason: /** @type {{ ok: false, reason: CallBlockReason }} */ (checked).reason };
    const plan = checked.plan;
    if (!deps.publicUrl || !deps.secret) return { placed: false, reason: "place_failed" };

    const callId = (deps.randomUUID || crypto.randomUUID)();
    const token = mintCustomerCallToken(
      {
        callId,
        organizationId: plan.organizationId,
        appointmentId: plan.appointment.id,
        purpose: plan.purpose,
        requestedByCallId: plan.requestedByCallId,
        phoneNumberId: plan.fromNumber.id,
      },
      deps.secret,
      { now: deps.now }
    );

    let sid = null;
    try {
      const created = await deps.twilio.createCall({
        to: plan.phone,
        from: plan.fromNumber.phone_number,
        url: `${deps.publicUrl}/twiml/customer-call/${token}`,
        method: "POST",
        statusCallback: `${deps.publicUrl}/twiml/customer-call-status/${token}`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["completed"],
        machineDetection: "DetectMessageEnd",
        timeout: RING_TIMEOUT_SECONDS,
        timeLimit: CALL_TIME_LIMIT_SECONDS,
      });
      sid = created && typeof created.sid === "string" ? created.sid : null;
    } catch (err) {
      console.error(`[ALERT:error] [CustomerCall] Twilio refused the call (org=${plan.organizationId}):`, err instanceof Error ? err.message : String(err));
      return { placed: false, reason: "place_failed" };
    }
    if (!sid) {
      console.error(`[ALERT:error] [CustomerCall] Twilio returned no call sid (org=${plan.organizationId})`);
      return { placed: false, reason: "place_failed" };
    }
    recentPlacements.push(nowMs);

    const { error: insertErr } = await deps.supabase.from("calls").insert({
      id: callId,
      organization_id: plan.organizationId,
      assistant_id: plan.fromNumber.assistant_id,
      phone_number_id: plan.fromNumber.id,
      vapi_call_id: `sh_${sid}`,
      caller_phone: plan.phone,
      direction: "outbound",
      status: "queued",
      metadata: initialMetadata(plan),
    });
    if (insertErr) {
      console.error(`[ALERT:error] [CustomerCall] call row not written — cancelling the call (org=${plan.organizationId}, sid=${sid}):`, insertErr.message);
      try {
        await deps.twilio.cancelCall(sid);
      } catch (cancelErr) {
        console.error(`[ALERT:error] [CustomerCall] could not cancel call ${sid} after the row failed — it may ring with no record:`, cancelErr instanceof Error ? cancelErr.message : String(cancelErr));
      }
      return { placed: false, reason: "place_failed" };
    }
    console.log(`[CustomerCall] placed call=${callId} sid=${sid} purpose=${plan.purpose} org=${plan.organizationId}`);
    return { placed: true, callId, callSid: sid };
  } finally {
    inFlight.delete(key);
  }
}

/** Test hook: forget the in-flight keys and the backstop window. */
function resetPlacementGuards() {
  inFlight.clear();
  recentPlacements.length = 0;
}

/**
 * The notify context the /ws/audio session runs with (carried server-side in the
 * stream token, never in a client parameter).
 * @typedef {object} NotifyContext
 * @property {string} callId
 * @property {string} organizationId
 * @property {string} appointmentId
 * @property {string} purpose
 * @property {string} requestedByCallId
 * @property {"conversation"|"voicemail"} mode
 * @property {string} answeredBy
 * @property {string|null} [ownerNote] - set by the session once its briefing has loaded, so the row keeps it
 */

/**
 * @typedef {object} TwimlDeps
 * @property {any} supabase
 * @property {string|undefined} secret
 * @property {Record<string, string|undefined>} [env]
 * @property {() => number} [now]
 * @property {(calledNumber: string, callerPhone: string, reconnectCallSid: undefined, phoneRecord: null, extra: { notify: NotifyContext }) => string} issueStreamToken
 * @property {string} wsUrl
 * @property {(s: string) => string} escapeXml
 */

/**
 * Twilio fetches this once the call is picked up (after answering-machine
 * detection). A person (or a result AMD can't call) gets the conversation; the end
 * of a voicemail greeting gets the voicemail; anything else is hung up. The route
 * sits behind validateTwilioSignature; the token binds the fetch to the call row it
 * was minted for (the CallSid must be that row's). The flag is read again, so
 * switching it off stops even a call that is already ringing.
 * @param {{ params?: Record<string, string>, body?: Record<string, string> }} req
 * @param {TwimlDeps} deps
 * @returns {Promise<string>} TwiML
 */
async function handleCustomerCallTwiml(req, deps) {
  const token = verifyCustomerCallToken(req.params?.token, deps.secret, { now: deps.now });
  if (!token) {
    console.warn("[CustomerCall] TwiML refused — invalid or expired token");
    return HANGUP_TWIML;
  }
  if (!isCustomerCallsEnabled(deps.env || process.env)) {
    console.warn(`[CustomerCall] TwiML refused — calls switched off (call=${token.callId})`);
    return HANGUP_TWIML;
  }
  const body = req.body || {};
  const answeredBy = typeof body.AnsweredBy === "string" && body.AnsweredBy ? body.AnsweredBy : "unknown";
  try {
    const { data: row, error } = await deps.supabase
      .from("calls")
      .select("id, vapi_call_id, caller_phone, metadata")
      .eq("id", token.callId)
      .eq("organization_id", token.organizationId)
      .maybeSingle();
    if (error || !row || row.vapi_call_id !== `sh_${body.CallSid}` || typeof row.caller_phone !== "string") {
      console.error(`[CustomerCall] TwiML refused — no matching call row (call=${token.callId}, error=${error?.message || "none"})`);
      return HANGUP_TWIML;
    }
    /** @type {"conversation"|"voicemail"|null} */
    let mode = null;
    if (AMD_CONVERSATION.has(answeredBy)) mode = "conversation";
    else if (AMD_VOICEMAIL.has(answeredBy)) mode = "voicemail";
    if (!mode) {
      console.log(`[CustomerCall] answered by ${answeredBy} — hanging up (call=${token.callId})`);
      await stampNotify(deps.supabase, row, { answered_by: answeredBy });
      return HANGUP_TWIML;
    }
    const { data: number, error: numErr } = await deps.supabase
      .from("phone_numbers")
      .select("id, phone_number")
      .eq("id", token.phoneNumberId)
      .eq("organization_id", token.organizationId)
      .eq("is_active", true)
      .maybeSingle();
    if (numErr || !number || typeof number.phone_number !== "string") {
      console.error(`[CustomerCall] TwiML refused — the org's number is gone (call=${token.callId})`);
      return HANGUP_TWIML;
    }
    const streamToken = deps.issueStreamToken(number.phone_number, row.caller_phone, undefined, null, {
      notify: {
        callId: token.callId,
        organizationId: token.organizationId,
        appointmentId: token.appointmentId,
        purpose: token.purpose,
        requestedByCallId: token.requestedByCallId,
        mode,
        answeredBy,
      },
    });
    console.log(`[CustomerCall] answered by ${answeredBy} → ${mode} (call=${token.callId})`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${deps.escapeXml(deps.wsUrl)}">
      <Parameter name="auth_token" value="${deps.escapeXml(streamToken)}" />
    </Stream>
  </Connect>
</Response>`;
  } catch (err) {
    console.error(`[CustomerCall] TwiML failed (call=${token.callId}):`, err instanceof Error ? err.message : String(err));
    return HANGUP_TWIML;
  }
}

/**
 * Merge extra fields into a call row's metadata.notify, keeping everything else.
 * Best-effort: a failed stamp is logged and the call goes on.
 * @param {any} supabase
 * @param {{ id: string, metadata?: any }} row
 * @param {Record<string, unknown>} fields
 */
async function stampNotify(supabase, row, fields) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const { error } = await supabase
    .from("calls")
    .update({ metadata: { ...metadata, notify: { ...(metadata.notify || {}), ...fields } } })
    .eq("id", row.id);
  if (error) console.warn(`[CustomerCall] could not stamp call ${row.id}:`, error.message);
}

/**
 * The stream started: the row goes in-progress and notes how the call was answered.
 * Only a still-queued row moves (a status callback that finished it first wins).
 * The start time comes back so the session can re-send it at the end
 * (completeCallRecord replaces metadata whole).
 * @param {any} supabase
 * @param {NotifyContext} notify
 * @param {() => number} [now]
 * @returns {Promise<{ marked: boolean, startedAt: string }>}
 */
async function markCustomerCallStarted(supabase, notify, now = Date.now) {
  const startedAt = new Date(now()).toISOString();
  try {
    const { data, error } = await supabase
      .from("calls")
      .update({
        status: "in-progress",
        started_at: startedAt,
        metadata: {
          voice_provider: "self_hosted",
          call_type: CUSTOMER_NOTIFY_CALL_TYPE,
          notify: notifyMetadata(notify, { stream_started_at: startedAt }),
        },
      })
      .eq("id", notify.callId)
      .eq("organization_id", notify.organizationId)
      .eq("status", "queued")
      .select("id");
    if (error) {
      console.error(`[CustomerCall] could not mark call ${notify.callId} started:`, error.message);
      return { marked: false, startedAt };
    }
    return { marked: Array.isArray(data) && data.length > 0, startedAt };
  } catch (err) {
    console.error(`[CustomerCall] marking call ${notify.callId} started threw:`, err instanceof Error ? err.message : String(err));
    return { marked: false, startedAt };
  }
}

/**
 * What the notify session needs to say, read fresh and org-scoped when the call is
 * picked up: the name and time on the booking, the time a move came from, and the
 * owner's note (find_new_time). null when the booking can't be read: the session
 * can't give news it doesn't have, so it ends the call.
 * @param {any} supabase
 * @param {NotifyContext} notify
 * @returns {Promise<{ customerName: string|null, startTime: string, previousStartTime: string|null, ownerNote: string|null }|null>}
 */
async function loadNotifyBriefing(supabase, notify) {
  try {
    const { data: appt, error } = await supabase
      .from("appointments")
      .select("id, attendee_name, start_time, rescheduled_from_id")
      .eq("id", notify.appointmentId)
      .eq("organization_id", notify.organizationId)
      .maybeSingle();
    if (error || !appt || typeof appt.start_time !== "string") {
      console.error(`[CustomerCall] briefing: booking unreadable (call=${notify.callId}, error=${error?.message || "none"})`);
      return null;
    }
    let previousStartTime = null;
    if (notify.purpose === "moved" && appt.rescheduled_from_id) {
      const { data: prev, error: prevErr } = await supabase
        .from("appointments")
        .select("start_time")
        .eq("id", appt.rescheduled_from_id)
        .eq("organization_id", notify.organizationId)
        .maybeSingle();
      // The old time is a nicety ("moved from X"): without it the news is still right.
      if (prevErr) console.warn(`[CustomerCall] briefing: previous leg unreadable (call=${notify.callId}):`, prevErr.message);
      previousStartTime = !prevErr && typeof prev?.start_time === "string" ? prev.start_time : null;
    }
    let ownerNote = null;
    if (notify.purpose === "find_new_time") {
      const { data: row, error: rowErr } = await supabase
        .from("calls")
        .select("metadata")
        .eq("id", notify.callId)
        .eq("organization_id", notify.organizationId)
        .maybeSingle();
      if (rowErr) console.warn(`[CustomerCall] briefing: owner note unreadable (call=${notify.callId}):`, rowErr.message);
      ownerNote = rowErr ? null : ownerNoteOf(row?.metadata?.notify?.owner_note);
    }
    return {
      customerName: typeof appt.attendee_name === "string" ? appt.attendee_name : null,
      startTime: appt.start_time,
      previousStartTime,
      ownerNote,
    };
  } catch (err) {
    console.error(`[CustomerCall] briefing threw (call=${notify.callId}):`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * metadata.notify for a call whose session ran: the request's ids, how it was
 * answered, and whatever the session adds (outcome, note, the voicemail text).
 * @param {NotifyContext} notify
 * @param {Record<string, unknown>} [extra]
 */
function notifyMetadata(notify, extra = {}) {
  return {
    purpose: notify.purpose,
    appointment_id: notify.appointmentId,
    requested_by_call_id: notify.requestedByCallId,
    ...(notify.ownerNote ? { owner_note: notify.ownerNote } : {}),
    mode: notify.mode,
    answered_by: notify.answeredBy,
    ...extra,
  };
}

/**
 * call-completed's status for a call nobody talked on.
 * @param {string} twilioStatus
 * @returns {{ rowStatus: "completed"|"busy"|"no-answer"|"failed", webhookStatus: "completed"|"missed"|"failed" }}
 */
function finalStatusFor(twilioStatus) {
  switch (twilioStatus) {
    case "busy":
      return { rowStatus: "busy", webhookStatus: "missed" };
    case "no-answer":
      return { rowStatus: "no-answer", webhookStatus: "missed" };
    case "completed":
      // Picked up, but the call ended before the assistant spoke (or AMD hung up a fax).
      return { rowStatus: "completed", webhookStatus: "missed" };
    default:
      return { rowStatus: "failed", webhookStatus: "failed" };
  }
}

/**
 * @typedef {object} StatusDeps
 * @property {any} supabase
 * @property {string|undefined} secret
 * @property {() => number} [now]
 * @property {(callSid: string) => boolean} hasLiveSession - a notify session for this CallSid is running in this process
 * @property {(payload: Record<string, unknown>) => Promise<unknown>} notifyCallCompleted
 */

/**
 * Twilio's end-of-call callback. A call whose session ran is finished by that
 * session's cleanup (with the transcript and summary); this finishes the rest:
 *  - never streamed (no answer, busy, failed, picked up and dropped): from Twilio's status;
 *  - streamed, but no session is live here any more (the process restarted mid-call):
 *    finished as cut off, so the owner still hears how it went.
 * Each finish is a conditional update on the row's status, so a session's own
 * cleanup and this callback can never both finish a call. Never throws.
 * @param {{ params?: Record<string, string>, body?: Record<string, string> }} req
 * @param {StatusDeps} deps
 * @returns {Promise<{ finalized: boolean, reason: string }>}
 */
async function handleCustomerCallStatus(req, deps) {
  const token = verifyCustomerCallToken(req.params?.token, deps.secret, { now: deps.now });
  if (!token) return { finalized: false, reason: "invalid_token" };
  const body = req.body || {};
  const twilioStatus = String(body.CallStatus || "");
  if (!TERMINAL_TWILIO_STATUSES.has(twilioStatus)) return { finalized: false, reason: "not_terminal" };
  try {
    const { data: row, error } = await deps.supabase
      .from("calls")
      .select("id, organization_id, assistant_id, vapi_call_id, caller_phone, status, metadata")
      .eq("id", token.callId)
      .eq("organization_id", token.organizationId)
      .maybeSingle();
    if (error) {
      console.error(`[CustomerCall] status: row unreadable (call=${token.callId}):`, error.message);
      return { finalized: false, reason: "row_unreadable" };
    }
    if (!row) return { finalized: false, reason: "no_row" };
    if (row.vapi_call_id !== `sh_${body.CallSid}`) return { finalized: false, reason: "sid_mismatch" };
    if (typeof body.CallSid === "string" && deps.hasLiveSession(body.CallSid)) {
      return { finalized: false, reason: "live_session" };
    }

    const durationSeconds = Math.max(0, Math.round(Number(body.CallDuration) || 0));
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const answeredBy = typeof body.AnsweredBy === "string" && body.AnsweredBy ? body.AnsweredBy : metadata.notify?.answered_by;
    let rowStatus;
    let webhookStatus;
    let endedReason;
    let fromStatus;
    let notifyExtra;
    if (row.status === "queued" || row.status === "ringing") {
      ({ rowStatus, webhookStatus } = finalStatusFor(twilioStatus));
      endedReason = `customer-call-${twilioStatus}`;
      fromStatus = row.status;
      notifyExtra = { twilio_status: twilioStatus, ...(answeredBy ? { answered_by: answeredBy } : {}) };
    } else if (row.status === "in-progress") {
      // The session that streamed it is gone from this process: a restart mid-call.
      rowStatus = "completed";
      webhookStatus = "completed";
      endedReason = "customer-call-cut-off";
      fromStatus = "in-progress";
      notifyExtra = { twilio_status: twilioStatus, cut_off: true };
    } else {
      return { finalized: false, reason: "already_finished" };
    }

    const { data: updated, error: updErr } = await deps.supabase
      .from("calls")
      .update({
        status: rowStatus,
        ended_at: new Date((deps.now || Date.now)()).toISOString(),
        duration_seconds: durationSeconds,
        metadata: { ...metadata, notify: { ...(metadata.notify || {}), ...notifyExtra } },
      })
      .eq("id", row.id)
      .eq("status", fromStatus)
      .select("id");
    if (updErr) {
      console.error(`[ALERT:error] [CustomerCall] could not finish call ${row.id} — the owner gets no outcome email:`, updErr.message);
      return { finalized: false, reason: "update_failed" };
    }
    if (!Array.isArray(updated) || updated.length === 0) return { finalized: false, reason: "raced" };

    await deps.notifyCallCompleted({
      callId: row.id,
      organizationId: row.organization_id,
      assistantId: row.assistant_id,
      callerPhone: row.caller_phone,
      status: webhookStatus,
      durationSeconds,
      transcript: "",
      endedReason,
      callType: CUSTOMER_NOTIFY_CALL_TYPE,
    });
    console.log(`[CustomerCall] finished call=${row.id} twilio=${twilioStatus} → ${rowStatus}`);
    return { finalized: true, reason: endedReason };
  } catch (err) {
    console.error(`[CustomerCall] status handling threw (call=${token.callId}):`, err instanceof Error ? err.message : String(err));
    return { finalized: false, reason: "threw" };
  }
}

/** @param {unknown} v */
function isNotifyPurpose(v) {
  return typeof v === "string" && NOTIFY_PURPOSES.includes(v);
}

module.exports = {
  NOTIFY_PURPOSES,
  CUSTOMER_NOTIFY_CALL_TYPE,
  CALL_OUTCOMES,
  CALLING_START_HOUR,
  CALLING_END_HOUR,
  ORG_CALLS_PER_DAY,
  NUMBER_CALLS_PER_DAY,
  TOKEN_TTL_MS,
  RING_TIMEOUT_SECONDS,
  CALL_TIME_LIMIT_SECONDS,
  PLACEMENTS_PER_WINDOW,
  HANGUP_TWIML,
  isCustomerCallsEnabled,
  isNotifyPurpose,
  withinCallingHours,
  matchesBookingPhone,
  mintCustomerCallToken,
  verifyCustomerCallToken,
  checkCustomerCall,
  placeCustomerCall,
  resetPlacementGuards,
  handleCustomerCallTwiml,
  markCustomerCallStarted,
  loadNotifyBriefing,
  notifyMetadata,
  finalStatusFor,
  handleCustomerCallStatus,
};
