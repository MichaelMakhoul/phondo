// voice-server/lib/stream-token.js
"use strict";
/**
 * The opaque auth token on <Stream><Parameter name="auth_token">. server.js
 * issues it with the TwiML (issueStreamToken) and consumes it once at the
 * stream `start` event (consumeStreamToken). The call's metadata, including
 * SCRUM-587 owner mode, lives server-side in pendingTokens under the token;
 * the token itself carries nothing a client could assert.
 *
 * Format: `${ts}.${nonce}.${hmacSha256(secret, `${ts}.${nonce}`)}`.
 * SCRUM-587: the 16-byte random nonce is what keeps tokens apart. The old
 * format, `${ts}.${hmac(ts)}`, gave two calls answered in the same millisecond
 * the SAME token, so the second pendingTokens.set overwrote the first entry and
 * one call's stream consumed the other's metadata. With owner mode in the entry,
 * a concurrent customer call could have consumed the owner's session.
 */
const crypto = require("crypto");

const NONCE_BYTES = 16;

/**
 * @param {string} secret
 * @param {string} ts
 * @param {string} nonce
 * @returns {string} hex HMAC-SHA256 over `${ts}.${nonce}`
 */
function macOf(secret, ts, nonce) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${nonce}`).digest("hex");
}

/**
 * A fresh stream token.
 * @param {string} secret
 * @param {{ now?: () => number, randomBytes?: (size: number) => Buffer }} [opts] injectable for tests
 * @returns {string}
 */
function mintStreamToken(secret, { now = Date.now, randomBytes = crypto.randomBytes } = {}) {
  const ts = String(now());
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  return `${ts}.${nonce}.${macOf(secret, ts, nonce)}`;
}

/**
 * True only for a three-part token whose MAC matches its timestamp and nonce
 * (constant-time compare). Anything else is false: not a string, the
 * pre-SCRUM-587 two-part format, extra parts, a wrong MAC. No separate format
 * check: the MAC covers every byte of the timestamp and the nonce.
 * @param {string} secret
 * @param {unknown} token
 * @returns {boolean}
 */
function verifyStreamToken(secret, token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [ts, nonce, mac] = parts;
  const given = Buffer.from(mac);
  const expected = Buffer.from(macOf(secret, ts, nonce));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * SCRUM-587: the phone record as stored with a stream token, without
 * organizations.owner_access (the owner's PIN hash and salt, which
 * lookupPhoneNumber embeds while OWNER_ASSISTANT_ENABLED is on). pendingTokens
 * hands the record on to loadCallContext, the ConversationRelay path and the
 * session; none of them needs the PIN material, and keeping it out of the
 * token entry keeps it out of every object built or logged from there.
 * Never mutates the input (the /twiml handler still reads it). A record with
 * no owner_access key (every record while the flag is off) comes back as the
 * same object, so it is stored exactly as before.
 * @param {any} phoneRecord
 * @returns {any}
 */
function withoutOwnerAccess(phoneRecord) {
  const org = phoneRecord && phoneRecord.organizations;
  if (!org || typeof org !== "object" || !Object.hasOwn(org, "owner_access")) return phoneRecord;
  const organizations = { ...org };
  delete organizations.owner_access;
  return { ...phoneRecord, organizations };
}

module.exports = { mintStreamToken, verifyStreamToken, withoutOwnerAccess };
