// voice-server/lib/owner-auth.js
"use strict";
/**
 * SCRUM-587 — owner-assistant PIN auth (spec §1, §9).
 *
 * Pure helpers (no I/O, NO logging — the PIN must never reach a log line) plus
 * countPinAttempt, which takes the service-role Supabase client so the lockout
 * lives in Postgres (rate_limit_buckets) and survives a scale-to-zero restart.
 *
 * Digest contract with PR A (Settings API): scryptSync(pin, pin_salt, 32) with
 * Node defaults, where pin_salt is the 32-char hex STRING itself — never
 * Buffer.from(pin_salt, "hex"). Vectors pinned in tests/owner-auth.test.js.
 */
const crypto = require("crypto");

const OWNER_PIN_MAX_ATTEMPTS = 5;            // per org per window (persisted)
const OWNER_PIN_WINDOW_MS = 15 * 60 * 1000;
const OWNER_PIN_MAX_PER_CALL = 3;            // Gather round-trips in ONE call
const PIN_LENGTH_MIN = 4;
const PIN_LENGTH_MAX = 8;
const E164 = /^\+\d{7,15}$/;

/** Twilio's numbers_and_commands model usually returns digits; be generous. */
const NUMBER_WORDS = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", to: "2", too: "2", three: "3",
  four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", ate: "8", nine: "9",
};

/** Read at CALL time so the Fly secret can be flipped without a restart. */
function ownerAssistantEnabled() {
  return process.env.OWNER_ASSISTANT_ENABLED === "true";
}

/**
 * Keyed digits win; otherwise map the speech result word-by-word. Unknown
 * words are dropped, so "my pin is twelve" becomes "" — the caller treats a
 * length mismatch as a wrong attempt (spec §1).
 * @param {{ digits?: unknown, speechResult?: unknown }} input
 * @returns {string}
 */
function normalisePinInput({ digits, speechResult } = {}) {
  const keyed = typeof digits === "string" ? digits.replace(/\D/g, "") : "";
  if (keyed) return keyed;
  if (typeof speechResult !== "string" || !speechResult.trim()) return "";
  return speechResult
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((tok) => {
      if (/^\d+$/.test(tok)) return tok;
      // Own keys only: NUMBER_WORDS["constructor"] is Object.prototype.constructor,
      // which would splice "function Object() {…}" into the PIN string.
      return Object.hasOwn(NUMBER_WORDS, tok) ? NUMBER_WORDS[tok] : "";
    })
    .join("");
}

/** @param {{ pin_length?: unknown } | null | undefined} ownerAccess */
function pinLengthOf(ownerAccess) {
  const n = Number(ownerAccess && ownerAccess.pin_length);
  return Number.isInteger(n) && n >= PIN_LENGTH_MIN && n <= PIN_LENGTH_MAX ? n : PIN_LENGTH_MIN;
}

/** @param {string} pin @param {string} salt @returns {string} hex digest */
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), 32).toString("hex");
}

/**
 * Constant-time compare of equal-length digests; any malformed input is false.
 * @param {{ pin: unknown, pinHash: unknown, pinSalt: unknown }} args
 */
function verifyPin({ pin, pinHash, pinSalt }) {
  if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) return false;
  if (typeof pinHash !== "string" || typeof pinSalt !== "string" || !pinHash || !pinSalt) return false;
  if (!/^[0-9a-f]{64}$/i.test(pinHash)) return false;
  const expected = Buffer.from(hashPin(pin, pinSalt), "hex");
  const stored = Buffer.from(pinHash, "hex");
  if (stored.length !== expected.length) return false;
  return crypto.timingSafeEqual(stored, expected);
}

/**
 * The owner_access row embedded under organizations by lookupPhoneNumber.
 * PostgREST returns an object for the UNIQUE FK, but tolerate an array too
 * (same defence as getEmbeddedSubscription in answer-mode.js).
 * @param {any} phoneRecord
 * @returns {{ phone_e164?: string, pin_hash?: string, pin_salt?: string, pin_length?: number, enabled?: boolean } | null}
 */
function getEmbeddedOwnerAccess(phoneRecord) {
  const oa = phoneRecord && phoneRecord.organizations && phoneRecord.organizations.owner_access;
  if (!oa) return null;
  return Array.isArray(oa) ? oa[0] || null : oa;
}

/**
 * Exact E.164 compare of Twilio `From` with the registered mobile.
 * `ForwardedFrom` present ⇒ a forwarded customer call, never the owner.
 * @param {{ from: unknown, forwardedFrom?: unknown, ownerAccess: any, enabled: boolean }} args
 */
function isOwnerCall({ from, forwardedFrom, ownerAccess, enabled }) {
  if (enabled !== true) return false;
  if (!ownerAccess || ownerAccess.enabled !== true) return false;
  if (typeof forwardedFrom === "string" && forwardedFrom.trim() !== "") return false;
  if (typeof from !== "string" || !E164.test(from)) return false;
  return from === ownerAccess.phone_e164;
}

/**
 * Count ONE attempt (before verifying — a guessing caller burns the window
 * even on a lucky final guess). Fail CLOSED: RPC error / empty result / a
 * count that is not a finite number / throw ⇒ locked, with reason "rpc-error"
 * so the route handler can page it. `error` is whatever the client gave us
 * (a PostgREST error object keeps its code/hint for triage), not always an Error.
 * @param {{ supabase: { rpc: Function }, organizationId: string }} args
 * @returns {Promise<{ locked: boolean, count?: number, reason: "ok"|"exhausted"|"rpc-error", error?: any }>}
 */
async function countPinAttempt({ supabase, organizationId }) {
  try {
    const { data, error } = await supabase.rpc("check_rate_limit_bucket", {
      p_key: `owner-pin:${organizationId}`,
      p_window_ms: OWNER_PIN_WINDOW_MS,
      p_max_requests: OWNER_PIN_MAX_ATTEMPTS,
    });
    const row = Array.isArray(data) ? data[0] : data;
    // Finite, not just typeof "number": NaN > 5 is false and would read as "not exhausted".
    if (error || !row || !Number.isFinite(row.count)) {
      return { locked: true, reason: "rpc-error", error: error || new Error("check_rate_limit_bucket returned no usable row") };
    }
    const exhausted = row.count > OWNER_PIN_MAX_ATTEMPTS;
    return { locked: exhausted, count: row.count, reason: exhausted ? "exhausted" : "ok" };
  } catch (err) {
    return { locked: true, reason: "rpc-error", error: err };
  }
}

module.exports = {
  OWNER_PIN_MAX_ATTEMPTS,
  OWNER_PIN_WINDOW_MS,
  OWNER_PIN_MAX_PER_CALL,
  ownerAssistantEnabled,
  normalisePinInput,
  pinLengthOf,
  hashPin,
  verifyPin,
  getEmbeddedOwnerAccess,
  isOwnerCall,
  countPinAttempt,
};
