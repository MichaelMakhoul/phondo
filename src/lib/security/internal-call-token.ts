import crypto from "crypto";

/**
 * Per-call internal-API token (SCRUM-344, audit M2 — defense-in-depth).
 *
 * The internal tool-call / call-completed routes authenticate with a single
 * shared INTERNAL_API_SECRET and act on a body-supplied organizationId with no
 * per-tenant binding. This token lets the voice server bind each internal
 * request to the specific call it is handling: an HMAC over
 * {organizationId, assistantId, callId, exp}. The verifier checks the token's
 * claims match the request body, so a request cannot act on an org/assistant the
 * token was not issued for, and the short expiry bounds replay.
 *
 * The token is HMAC'd with INTERNAL_API_SECRET (the same secret the voice server
 * already holds), so this is layered hardening, not a new trust root: its full
 * value is realised once token-less requests are rejected (REQUIRE_INTERNAL_CALL_TOKEN),
 * after the signer is deployed everywhere. Mirrors the voice server's
 * outbound-token format so the two stay in lockstep.
 *
 * Signer: voice-server/lib/internal-call-token.js (must match this format).
 */

export interface InternalCallTokenClaims {
  organizationId?: string;
  assistantId?: string | null;
  callId?: string | null;
  exp?: number;
}

/**
 * Verify the HMAC + expiry of an internal-call token. Returns the decoded
 * claims, or null if the token is missing/malformed/forged/expired.
 */
export function verifyInternalCallToken(
  token: string | null | undefined,
  secret: string
): InternalCallTokenClaims | null {
  if (!token || !secret) return null;
  try {
    const [payloadB64, sig] = token.split(".");
    if (!payloadB64 || !sig) return null;

    const expected = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    // Length check first — timingSafeEqual throws on length mismatch.
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as InternalCallTokenClaims;
    if (claims.exp && Date.now() > claims.exp) return null;

    return claims;
  } catch {
    return null;
  }
}

export type CallTokenCheck =
  | { ok: true; claims: InternalCallTokenClaims | null; usedToken: boolean }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Decide whether to allow an internal request, given a (already secret-verified)
 * request and the body's tenant fields. Backward-compatible:
 *   - No X-Call-Token header → allowed via the legacy secret-only path UNLESS
 *     REQUIRE_INTERNAL_CALL_TOKEN is set (the post-rollout cutover flag).
 *   - Token present → must verify AND its claims must match the body
 *     (organizationId always; assistantId/callId when both sides provide them).
 *
 * This never weakens the existing secret gate — call it AFTER verifyInternalSecret.
 */
export function checkInternalCallToken(
  request: Request,
  body: { organizationId?: string; assistantId?: string | null; callId?: string | null }
): CallTokenCheck {
  const secret = process.env.INTERNAL_API_SECRET || "";
  const require = process.env.REQUIRE_INTERNAL_CALL_TOKEN === "true";
  const headerToken = request.headers.get("X-Call-Token");

  if (!headerToken) {
    if (require) {
      return { ok: false, status: 401, reason: "missing-call-token" };
    }
    // Legacy secret-only path (current behaviour) — unchanged.
    return { ok: true, claims: null, usedToken: false };
  }

  const claims = verifyInternalCallToken(headerToken, secret);
  if (!claims) {
    return { ok: false, status: 401, reason: "invalid-call-token" };
  }

  // Cross-check claims against the body. organizationId is the tenant boundary
  // and must always match. assistantId/callId are checked only when both the
  // token and the body carry them (some call-completed payloads omit assistantId).
  if (claims.organizationId && body.organizationId && claims.organizationId !== body.organizationId) {
    return { ok: false, status: 403, reason: "org-mismatch" };
  }
  if (claims.assistantId && body.assistantId && claims.assistantId !== body.assistantId) {
    return { ok: false, status: 403, reason: "assistant-mismatch" };
  }
  if (claims.callId && body.callId && claims.callId !== body.callId) {
    return { ok: false, status: 403, reason: "call-mismatch" };
  }

  return { ok: true, claims, usedToken: true };
}
