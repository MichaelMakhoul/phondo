/**
 * Per-call internal-API token (SCRUM-344, audit M2 — defense-in-depth).
 *
 * Binds each internal tool-call / call-completed request to the specific call the
 * voice server is handling: an HMAC over {organizationId, assistantId, callId,
 * exp}, signed with INTERNAL_API_SECRET. The Next.js verifier
 * (src/lib/security/internal-call-token.ts) checks the HMAC + expiry and that the
 * claims match the request body, so a request can't act on an org/assistant the
 * token wasn't issued for, and the short expiry bounds replay.
 *
 * Format MUST match the verifier: `base64url(JSON(payload)).hex(hmacSha256)`.
 * Same shape as voice-server/services/outbound-caller.js token, kept separate so
 * the internal-API concern is independently unit-testable.
 */

const crypto = require("crypto");

const TOKEN_TTL_MS = 120_000; // 2 minutes — an internal call round-trips in seconds.

/**
 * @param {{organizationId?: string, assistantId?: string|null, callId?: string|null}} data
 * @param {string} secret  INTERNAL_API_SECRET
 * @param {number} [nowMs] injectable clock for tests
 * @returns {string|null} signed token, or null if no secret (caller falls back to legacy)
 */
function signInternalCallToken(data, secret, nowMs) {
  if (!secret) return null;
  const payload = {
    organizationId: data.organizationId,
    assistantId: data.assistantId ?? null,
    callId: data.callId ?? null,
    exp: (typeof nowMs === "number" ? nowMs : Date.now()) + TOKEN_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  return `${payloadB64}.${sig}`;
}

module.exports = { signInternalCallToken, TOKEN_TTL_MS };
