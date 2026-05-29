import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { verifyInternalCallToken, checkInternalCallToken } from "../internal-call-token";

// SCRUM-344: per-call internal-API token. The verifier must accept a correctly
// signed, unexpired token whose claims match the body, reject forged/expired
// ones, and stay backward-compatible (no token → legacy path unless required).

const SECRET = "test-internal-secret";

/** Build a token exactly as the voice-server signer does (must stay in lockstep). */
function makeToken(claims: Record<string, unknown>, secret = SECRET) {
  const b64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(b64).digest("hex");
  return `${b64}.${sig}`;
}

function reqWith(token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["X-Call-Token"] = token;
  return new Request("https://app.phondo.ai/api/internal/tool-call", { method: "POST", headers });
}

const ORG = "11111111-1111-4111-8111-111111111111";
const ASSISTANT = "22222222-2222-4222-8222-222222222222";
const CALL = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = SECRET;
  delete process.env.REQUIRE_INTERNAL_CALL_TOKEN;
});
afterEach(() => {
  delete process.env.REQUIRE_INTERNAL_CALL_TOKEN;
});

describe("verifyInternalCallToken", () => {
  it("accepts a correctly signed, unexpired token", () => {
    const t = makeToken({ organizationId: ORG, assistantId: ASSISTANT, callId: CALL, exp: Date.now() + 60_000 });
    expect(verifyInternalCallToken(t, SECRET)?.organizationId).toBe(ORG);
  });
  it("rejects a forged signature", () => {
    const t = makeToken({ organizationId: ORG, exp: Date.now() + 60_000 }, "wrong-secret");
    expect(verifyInternalCallToken(t, SECRET)).toBeNull();
  });
  it("rejects an expired token", () => {
    const t = makeToken({ organizationId: ORG, exp: Date.now() - 1 });
    expect(verifyInternalCallToken(t, SECRET)).toBeNull();
  });
  it("rejects malformed / empty / no-secret", () => {
    expect(verifyInternalCallToken("not-a-token", SECRET)).toBeNull();
    expect(verifyInternalCallToken("", SECRET)).toBeNull();
    expect(verifyInternalCallToken(makeToken({ organizationId: ORG }), "")).toBeNull();
  });
});

describe("checkInternalCallToken — backward compatibility", () => {
  it("allows a token-less request via the legacy path (default)", () => {
    const res = checkInternalCallToken(reqWith(), { organizationId: ORG });
    expect(res).toMatchObject({ ok: true, usedToken: false });
  });
  it("rejects a token-less request once REQUIRE_INTERNAL_CALL_TOKEN is set", () => {
    process.env.REQUIRE_INTERNAL_CALL_TOKEN = "true";
    const res = checkInternalCallToken(reqWith(), { organizationId: ORG });
    expect(res).toEqual({ ok: false, status: 401, reason: "missing-call-token" });
  });
});

describe("checkInternalCallToken — token present", () => {
  it("allows when claims match the body", () => {
    const t = makeToken({ organizationId: ORG, assistantId: ASSISTANT, callId: CALL, exp: Date.now() + 60_000 });
    const res = checkInternalCallToken(reqWith(t), { organizationId: ORG, assistantId: ASSISTANT, callId: CALL });
    expect(res).toMatchObject({ ok: true, usedToken: true });
  });
  it("401s an invalid token even when the body looks fine", () => {
    const t = makeToken({ organizationId: ORG, exp: Date.now() + 60_000 }, "attacker-secret");
    const res = checkInternalCallToken(reqWith(t), { organizationId: ORG });
    expect(res).toEqual({ ok: false, status: 401, reason: "invalid-call-token" });
  });
  it("403s on an org mismatch (cross-tenant attempt)", () => {
    const t = makeToken({ organizationId: ORG, exp: Date.now() + 60_000 });
    const res = checkInternalCallToken(reqWith(t), { organizationId: "99999999-9999-4999-8999-999999999999" });
    expect(res).toEqual({ ok: false, status: 403, reason: "org-mismatch" });
  });
  it("403s on an assistant mismatch", () => {
    const t = makeToken({ organizationId: ORG, assistantId: ASSISTANT, exp: Date.now() + 60_000 });
    const res = checkInternalCallToken(reqWith(t), { organizationId: ORG, assistantId: "different" });
    expect(res).toEqual({ ok: false, status: 403, reason: "assistant-mismatch" });
  });
  it("403s on a callId mismatch", () => {
    const t = makeToken({ organizationId: ORG, callId: CALL, exp: Date.now() + 60_000 });
    const res = checkInternalCallToken(reqWith(t), { organizationId: ORG, callId: "different" });
    expect(res).toEqual({ ok: false, status: 403, reason: "call-mismatch" });
  });
  it("allows when the token omits assistantId/callId (call-completed payloads can)", () => {
    const t = makeToken({ organizationId: ORG, assistantId: null, callId: null, exp: Date.now() + 60_000 });
    const res = checkInternalCallToken(reqWith(t), { organizationId: ORG, assistantId: ASSISTANT, callId: CALL });
    expect(res).toMatchObject({ ok: true, usedToken: true });
  });
});
