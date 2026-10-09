// voice-server/lib/owner-auth.js
"use strict";
/**
 * SCRUM-587 — owner-assistant PIN auth (spec §1, §9).
 *
 * Pure helpers (no I/O, NO logging — the PIN must never reach a log line) plus
 * the persisted lockout (countPinAttempt / recordPinFailure / resetPinAttempts),
 * which take the service-role Supabase client so the counters live in Postgres
 * (rate_limit_buckets) and survive a scale-to-zero restart.
 *
 * Digest contract with PR A (Settings API): scryptSync(pin, pin_salt, 32) with
 * Node defaults, where pin_salt is the 32-char hex STRING itself — never
 * Buffer.from(pin_salt, "hex"). Vectors pinned in tests/owner-auth.test.js.
 * verifyPin runs the same recipe through the async crypto.scrypt, so the
 * hashing stays on the libuv pool instead of the loop that relays call audio.
 *
 * Lockout. Caller ID is spoofable, so the PIN is the only secret and guessing is
 * capped twice, per org AND PIN generation (PR A rotates pin_salt on every PIN
 * save, so saving a new PIN starts both counters from zero):
 *  - 5 tries per 15 minutes. Every attempt counts BEFORE the PIN is checked, and
 *    a correct PIN clears it (resetPinAttempts), so the owner's own logins never
 *    use it up.
 *  - 10 wrong PINs per 24 hours. Only a PIN that FAILED the check counts
 *    (recordPinFailure), and a correct PIN never clears it, so the owner logging
 *    in cannot refill an attacker's budget. It clears only by time (24 hours
 *    after the first wrong PIN) or by saving a new PIN.
 * The 15 minute window alone would still allow 480 guesses a day.
 */
const crypto = require("crypto");

const OWNER_PIN_MAX_ATTEMPTS = 5;            // tries per org + PIN generation per 15 min (cleared by a correct PIN)
const OWNER_PIN_WINDOW_MS = 15 * 60 * 1000;
const OWNER_PIN_DAY_MAX_ATTEMPTS = 10;       // WRONG PINs per org + PIN generation per 24 h (never cleared by a correct PIN)
const OWNER_PIN_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const OWNER_PIN_MAX_PER_CALL = 3;            // Gather round-trips in ONE call
const PIN_LENGTH_MIN = 4;
const PIN_LENGTH_MAX = 8;
const SCRYPT_KEYLEN = 32;
const SALT_PREFIX_LENGTH = 8;                // chars of pin_salt that identify a PIN generation in a bucket key
const RATE_LIMIT_RPC = "check_rate_limit_bucket";
const RATE_LIMIT_TABLE = "rate_limit_buckets";
const E164 = /^\+\d{7,15}$/;

/** Twilio's numbers_and_commands model usually returns digits; be generous. */
const NUMBER_WORDS = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", to: "2", too: "2", three: "3",
  four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", ate: "8", nine: "9",
};

/** "double five" → 55, "triple oh" → 000: how Australians read a PIN aloud. */
const REPEAT_WORDS = { double: 2, triple: 3 };

/** Read at CALL time and never cached at module load, so every call sees the live env value. */
function ownerAssistantEnabled() {
  return process.env.OWNER_ASSISTANT_ENABLED === "true";
}

/**
 * One speech token → its digits ("" for a word that is not a number).
 * Own keys only: NUMBER_WORDS["constructor"] is Object.prototype.constructor,
 * which would splice "function Object() {…}" into the PIN string.
 * @param {string} tok
 * @returns {string}
 */
function tokenDigits(tok) {
  if (/^\d+$/.test(tok)) return tok;
  return Object.hasOwn(NUMBER_WORDS, tok) ? NUMBER_WORDS[tok] : "";
}

/**
 * Keyed digits win; otherwise map the speech result word-by-word. "double X" /
 * "triple X" repeat the single digit X; the multiplier applies to the very next
 * word only, so "double check one two" is "12" and a trailing "double" is
 * ignored. Other unknown words are dropped, so "my pin is twelve" becomes "" —
 * the caller treats a length mismatch as a wrong attempt (spec §1).
 * @param {{ digits?: unknown, speechResult?: unknown }} input
 * @returns {string}
 */
function normalisePinInput({ digits, speechResult } = {}) {
  const keyed = typeof digits === "string" ? digits.replace(/\D/g, "") : "";
  if (keyed) return keyed;
  if (typeof speechResult !== "string" || !speechResult.trim()) return "";
  let pin = "";
  let repeat = 1;
  for (const tok of speechResult.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (Object.hasOwn(REPEAT_WORDS, tok)) {
      repeat = REPEAT_WORDS[tok];
      continue;
    }
    const word = tokenDigits(tok);
    pin += word.length === 1 ? word.repeat(repeat) : word;
    repeat = 1;
  }
  return pin;
}

/** @param {{ pin_length?: unknown } | null | undefined} ownerAccess */
function pinLengthOf(ownerAccess) {
  const n = Number(ownerAccess && ownerAccess.pin_length);
  return Number.isInteger(n) && n >= PIN_LENGTH_MIN && n <= PIN_LENGTH_MAX ? n : PIN_LENGTH_MIN;
}

/**
 * Synchronous scrypt digest: the known-answer / test helper. Production
 * verification goes through verifyPin, which does not block the event loop.
 * @param {string} pin @param {string} salt @returns {string} hex digest
 */
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), SCRYPT_KEYLEN).toString("hex");
}

/**
 * The same recipe as hashPin, run on the libuv pool.
 * @param {string} pin @param {string} salt @returns {Promise<Buffer>}
 */
function scryptDigest(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), String(salt), SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Constant-time compare of equal-length digests. Any malformed input, or a
 * scrypt failure, is false. Async so scrypt stays off the event loop that
 * relays live call audio; never rejects.
 * @param {{ pin?: unknown, pinHash?: unknown, pinSalt?: unknown } | null | undefined} args
 * @returns {Promise<boolean>}
 */
async function verifyPin(args) {
  const { pin, pinHash, pinSalt } = args || {};
  if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) return false;
  if (typeof pinHash !== "string" || typeof pinSalt !== "string" || !pinHash || !pinSalt) return false;
  // Not redundant with the length check below: Buffer.from(x, "hex") silently drops trailing junk.
  if (!/^[0-9a-f]{64}$/i.test(pinHash)) return false;
  let expected;
  try {
    expected = await scryptDigest(pin, pinSalt);
  } catch {
    return false;
  }
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
 * Whatever went wrong, as an Error. A PostgREST error is a plain object
 * ({ code, message, details, hint }); it is wrapped with the original kept as
 * `cause` so the code and hint survive for triage.
 * @param {unknown} err
 * @param {string} fallback message used when `err` carries none
 * @returns {Error}
 */
function toError(err, fallback) {
  if (err instanceof Error) return err;
  const message = err && typeof err === "object" ? /** @type {any} */ (err).message : undefined;
  return new Error(typeof message === "string" && message ? message : fallback, { cause: err });
}

/**
 * The two lockout keys for ONE PIN generation: PR A rotates pin_salt on every
 * PIN save, so its first 8 chars start a fresh pair of buckets. Throws on an
 * organizationId or pinSalt that cannot name a bucket, so a bad call can never
 * build a shared "owner-pin:undefined" key.
 * @param {unknown} organizationId
 * @param {unknown} pinSalt
 * @returns {{ short: string, day: string }}
 */
function bucketKeys(organizationId, pinSalt) {
  if (typeof organizationId !== "string" || organizationId.trim() === "") {
    throw new Error("organizationId must be a non-empty string");
  }
  if (typeof pinSalt !== "string" || pinSalt.length < SALT_PREFIX_LENGTH) {
    throw new Error(`pinSalt must be a string of at least ${SALT_PREFIX_LENGTH} characters`);
  }
  const generation = `${organizationId}:${pinSalt.slice(0, SALT_PREFIX_LENGTH)}`;
  return { short: `owner-pin:${generation}`, day: `owner-pin-day:${generation}` };
}

/**
 * One atomic increment of a rate-limit bucket (the 15 minute tries or the 24 hour
 * wrong PINs); resolves to its post-increment count. Throws an Error on an RPC
 * error, no row, or a count that is not a finite number.
 * @param {{ rpc: Function }} supabase
 * @param {string} key @param {number} windowMs @param {number} maxRequests
 * @returns {Promise<number>}
 */
async function bumpBucket(supabase, key, windowMs, maxRequests) {
  const { data, error } = await supabase.rpc(RATE_LIMIT_RPC, { p_key: key, p_window_ms: windowMs, p_max_requests: maxRequests });
  if (error) throw toError(error, `${RATE_LIMIT_RPC} failed`);
  const row = Array.isArray(data) ? data[0] : data;
  // Finite, not just typeof "number": NaN > 5 is false and would read as "not exhausted".
  if (!row || !Number.isFinite(row.count)) throw new Error(`${RATE_LIMIT_RPC} returned no usable row`);
  return row.count;
}

/**
 * The wrong PINs on record in this PIN generation's 24 hour window. A READ: only
 * recordPinFailure counts. No row, or a window that has ended, is 0. Throws an
 * Error when the read fails or the row is unusable (a count that is not a finite
 * number, a reset_time that is not a date).
 * @param {{ from: Function }} supabase
 * @param {string} dayKey
 * @returns {Promise<number>}
 */
async function readDayFailures(supabase, dayKey) {
  const { data, error } = await supabase.from(RATE_LIMIT_TABLE).select("count, reset_time").eq("key", dayKey).maybeSingle();
  if (error) throw toError(error, `${RATE_LIMIT_TABLE} read failed`);
  if (!data) return 0;
  const windowEndsAt = typeof data.reset_time === "string" ? Date.parse(data.reset_time) : NaN;
  if (!Number.isFinite(data.count) || Number.isNaN(windowEndsAt)) throw new Error(`${RATE_LIMIT_TABLE} returned an unusable row`);
  return windowEndsAt <= Date.now() ? 0 : data.count;
}

/**
 * Gate ONE attempt, BEFORE the PIN is checked (a guessing caller burns the budget
 * even on a lucky final guess). In order: (1) bump the 15 minute bucket by RPC, 5
 * tries per window; (2) only if that one is not exhausted, READ the 24 hour row —
 * 10 wrong PINs per window. The 24 hour row is never incremented here (only
 * recordPinFailure does that, after a failed check), and a locked 15 minute
 * attempt never touches it at all. `count` is the 15 minute count when unlocked,
 * and the count of the window that locked otherwise (`window` says which).
 * Fail CLOSED: an RPC or read error, an empty result, an unusable count or row, a
 * throw, or a bad organizationId / pinSalt ⇒ locked with reason "rpc-error" so the
 * route handler can page it; `error` is always an Error.
 * @param {{ supabase?: { rpc: Function, from: Function }, organizationId?: unknown, pinSalt?: unknown } | null | undefined} args
 * @returns {Promise<{ locked: boolean, count?: number, reason: "ok"|"exhausted"|"rpc-error", window?: "15m"|"24h", error?: Error }>}
 */
async function countPinAttempt(args) {
  try {
    const { supabase, organizationId, pinSalt } = args || {};
    const keys = bucketKeys(organizationId, pinSalt);
    const count = await bumpBucket(supabase, keys.short, OWNER_PIN_WINDOW_MS, OWNER_PIN_MAX_ATTEMPTS);
    if (count > OWNER_PIN_MAX_ATTEMPTS) return { locked: true, reason: "exhausted", window: "15m", count };
    const wrongPins = await readDayFailures(supabase, keys.day);
    if (wrongPins >= OWNER_PIN_DAY_MAX_ATTEMPTS) return { locked: true, reason: "exhausted", window: "24h", count: wrongPins };
    return { locked: false, reason: "ok", count };
  } catch (err) {
    return { locked: true, reason: "rpc-error", error: toError(err, `${RATE_LIMIT_RPC} failed`) };
  }
}

/**
 * Record ONE wrong PIN on the 24 hour row (10 per window). Call it, and await it,
 * only after a PIN FAILED the check: nothing else ever increments that row, and a
 * correct PIN never clears it. Never throws; `ok: false` (with an Error) means the
 * failure was NOT recorded, so the caller should alert. `count` is the number of
 * wrong PINs on record after this one.
 * @param {{ supabase?: { rpc: Function }, organizationId?: unknown, pinSalt?: unknown } | null | undefined} args
 * @returns {Promise<{ ok: boolean, count?: number, error?: Error }>}
 */
async function recordPinFailure(args) {
  try {
    const { supabase, organizationId, pinSalt } = args || {};
    const keys = bucketKeys(organizationId, pinSalt);
    const count = await bumpBucket(supabase, keys.day, OWNER_PIN_DAY_WINDOW_MS, OWNER_PIN_DAY_MAX_ATTEMPTS);
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: toError(err, `${RATE_LIMIT_RPC} failed`) };
  }
}

/**
 * Clear the 15 minute window after a VERIFIED PIN, so the owner's own successes
 * never use up the 5 tries per 15 minutes. It deletes ONLY the 15 minute row and
 * NEVER touches the 24 hour row: wrong PINs stay counted toward the daily cap
 * however often the owner logs in. Never throws; the caller fires and forgets it,
 * so a failure costs one attempt of the 15 minute budget, never a call.
 * @param {{ supabase?: { from: Function }, organizationId?: unknown, pinSalt?: unknown } | null | undefined} args
 * @returns {Promise<{ ok: boolean, error?: Error }>}
 */
async function resetPinAttempts(args) {
  try {
    const { supabase, organizationId, pinSalt } = args || {};
    const keys = bucketKeys(organizationId, pinSalt);
    const { error } = await supabase.from(RATE_LIMIT_TABLE).delete().eq("key", keys.short);
    if (error) return { ok: false, error: toError(error, `${RATE_LIMIT_TABLE} delete failed`) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toError(err, `${RATE_LIMIT_TABLE} delete failed`) };
  }
}

module.exports = {
  OWNER_PIN_MAX_ATTEMPTS,
  OWNER_PIN_WINDOW_MS,
  OWNER_PIN_DAY_MAX_ATTEMPTS,
  OWNER_PIN_DAY_WINDOW_MS,
  OWNER_PIN_MAX_PER_CALL,
  ownerAssistantEnabled,
  normalisePinInput,
  pinLengthOf,
  hashPin,
  verifyPin,
  getEmbeddedOwnerAccess,
  isOwnerCall,
  countPinAttempt,
  recordPinFailure,
  resetPinAttempts,
};
