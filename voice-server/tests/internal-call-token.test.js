const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { signInternalCallToken, TOKEN_TTL_MS } = require("../lib/internal-call-token");

// SCRUM-344: the voice-server signer must produce a token the Next.js verifier
// accepts — base64url(JSON(payload)).hex(hmacSha256(payloadB64, secret)) — with
// the call context as claims and a short expiry.

const SECRET = "test-internal-secret";

function decode(token) {
  const [b64, sig] = token.split(".");
  const expectedSig = crypto.createHmac("sha256", SECRET).update(b64).digest("hex");
  return { payload: JSON.parse(Buffer.from(b64, "base64url").toString()), sig, expectedSig };
}

test("signs a token with matching HMAC and the call-context claims", () => {
  const now = 1_000_000;
  const token = signInternalCallToken(
    { organizationId: "org-1", assistantId: "asst-1", callId: "call-1" },
    SECRET,
    now
  );
  const { payload, sig, expectedSig } = decode(token);
  assert.equal(sig, expectedSig, "HMAC must verify against the payload + secret");
  assert.equal(payload.organizationId, "org-1");
  assert.equal(payload.assistantId, "asst-1");
  assert.equal(payload.callId, "call-1");
  assert.equal(payload.exp, now + TOKEN_TTL_MS);
});

test("normalises missing assistantId/callId to null (call-completed payloads)", () => {
  const token = signInternalCallToken({ organizationId: "org-1" }, SECRET, 0);
  const { payload } = decode(token);
  assert.equal(payload.assistantId, null);
  assert.equal(payload.callId, null);
});

test("returns null when no secret is configured (caller falls back to legacy)", () => {
  assert.equal(signInternalCallToken({ organizationId: "org-1" }, ""), null);
  assert.equal(signInternalCallToken({ organizationId: "org-1" }, undefined), null);
});

test("a tampered payload no longer matches the original signature", () => {
  const token = signInternalCallToken({ organizationId: "org-1", callId: "call-1" }, SECRET, 0);
  const [, sig] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ organizationId: "victim", callId: "call-1", exp: 9_999_999_999_999 })).toString("base64url");
  const forgedExpectedSig = crypto.createHmac("sha256", SECRET).update(forgedPayload).digest("hex");
  assert.notEqual(sig, forgedExpectedSig, "swapping the org must invalidate the signature");
});
