// voice-server/tests/owner-auth.test.js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const oa = require("../lib/owner-auth");

// SCRUM-587 — pure PIN helpers (spec §1, §9). The scrypt vectors are the
// cross-PR contract with PR A's Settings API: same digest or no owner can log in.
const SALT = "00112233445566778899aabbccddeeff";
const HASH_1234 = "bd32905894891fff625cb7f496cbf8b7f9ef0cee823bd0aceda87857c65a77d9";
const HASH_90210777 = "32b3fbbd29d2f8c167eead354235f05ccd3e7c61f9f17d47931d459758741595";

describe("normalisePinInput", () => {
  it("prefers keyed digits over speech", () => {
    assert.equal(oa.normalisePinInput({ digits: "1234", speechResult: "9999" }), "1234");
  });
  it("turns spoken digits and number words into digits", () => {
    assert.equal(oa.normalisePinInput({ digits: "", speechResult: "1 2 3 4" }), "1234");
    assert.equal(oa.normalisePinInput({ speechResult: "one two three four" }), "1234");
    assert.equal(oa.normalisePinInput({ speechResult: "Nine, oh, two-one, zero." }), "90210");
  });
  it("drops words it does not know (wrong length is then a wrong attempt)", () => {
    assert.equal(oa.normalisePinInput({ speechResult: "my pin is twelve" }), "");
  });
  it("returns empty for nothing usable", () => {
    assert.equal(oa.normalisePinInput({}), "");
    assert.equal(oa.normalisePinInput({ digits: null, speechResult: "   " }), "");
    assert.equal(oa.normalisePinInput({ digits: "#*" }), "");
  });
});

describe("hashPin / verifyPin (PR A contract)", () => {
  it("matches PR A's known-answer vectors (salt is the hex STRING, not decoded bytes)", () => {
    assert.equal(oa.hashPin("1234", SALT), HASH_1234);
    assert.equal(oa.hashPin("90210777", SALT), HASH_90210777);
    assert.notEqual(crypto.scryptSync("1234", Buffer.from(SALT, "hex"), 32).toString("hex"), HASH_1234);
  });
  it("accepts the right PIN and rejects everything else", () => {
    assert.equal(oa.verifyPin({ pin: "1234", pinHash: HASH_1234, pinSalt: SALT }), true);
    assert.equal(oa.verifyPin({ pin: "1235", pinHash: HASH_1234, pinSalt: SALT }), false);
    assert.equal(oa.verifyPin({ pin: "1234", pinHash: HASH_1234, pinSalt: "ff" + SALT.slice(2) }), false);
    assert.equal(oa.verifyPin({ pin: "12a4", pinHash: HASH_1234, pinSalt: SALT }), false);
    assert.equal(oa.verifyPin({ pin: "", pinHash: HASH_1234, pinSalt: SALT }), false);
    assert.equal(oa.verifyPin({ pin: "1234", pinHash: "nothex", pinSalt: SALT }), false);
    assert.equal(oa.verifyPin({ pin: "1234", pinHash: null, pinSalt: SALT }), false);
  });
});

describe("verifyPin is constant-time (source pin — an === mutation is invisible to behaviour tests)", () => {
  it("compares digests with crypto.timingSafeEqual on equal-length Buffers", () => {
    const srcText = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "lib", "owner-auth.js"), "utf8");
    assert.match(srcText, /if \(stored\.length !== expected\.length\) return false;\s*return crypto\.timingSafeEqual\(stored, expected\);/);
  });
});

describe("pinLengthOf", () => {
  it("honours 4..8 and defaults to 4", () => {
    assert.equal(oa.pinLengthOf({ pin_length: 6 }), 6);
    assert.equal(oa.pinLengthOf({ pin_length: "7" }), 7);
    assert.equal(oa.pinLengthOf({ pin_length: 3 }), 4);
    assert.equal(oa.pinLengthOf({ pin_length: 9 }), 4);
    assert.equal(oa.pinLengthOf(null), 4);
  });
});

describe("getEmbeddedOwnerAccess", () => {
  it("tolerates object, one-element array and absence", () => {
    const row = { phone_e164: "+61400000001", enabled: true };
    assert.deepEqual(oa.getEmbeddedOwnerAccess({ organizations: { owner_access: row } }), row);
    assert.deepEqual(oa.getEmbeddedOwnerAccess({ organizations: { owner_access: [row] } }), row);
    assert.equal(oa.getEmbeddedOwnerAccess({ organizations: { owner_access: [] } }), null);
    assert.equal(oa.getEmbeddedOwnerAccess({ organizations: {} }), null);
    assert.equal(oa.getEmbeddedOwnerAccess(null), null);
  });
});

describe("isOwnerCall", () => {
  const access = { phone_e164: "+61400000001", enabled: true };
  it("needs the flag, an enabled row, no ForwardedFrom and an exact E.164 match", () => {
    assert.equal(oa.isOwnerCall({ from: "+61400000001", forwardedFrom: "", ownerAccess: access, enabled: true }), true);
    assert.equal(oa.isOwnerCall({ from: "+61400000001", forwardedFrom: undefined, ownerAccess: access, enabled: true }), true);
    assert.equal(oa.isOwnerCall({ from: "+61400000001", ownerAccess: access, enabled: false }), false);
    assert.equal(oa.isOwnerCall({ from: "+61400000001", ownerAccess: { ...access, enabled: false }, enabled: true }), false);
    assert.equal(oa.isOwnerCall({ from: "+61400000001", ownerAccess: null, enabled: true }), false);
    assert.equal(oa.isOwnerCall({ from: "+61400000001", forwardedFrom: "+61299990000", ownerAccess: access, enabled: true }), false);
    assert.equal(oa.isOwnerCall({ from: "+61400000002", ownerAccess: access, enabled: true }), false);
    assert.equal(oa.isOwnerCall({ from: "0400000001", ownerAccess: access, enabled: true }), false);
    assert.equal(oa.isOwnerCall({ from: "anonymous", ownerAccess: access, enabled: true }), false);
  });
});

describe("countPinAttempt (persisted lockout via check_rate_limit_bucket)", () => {
  function fakeSupabase(result) {
    const calls = [];
    return { calls, rpc: async (fn, args) => { calls.push({ fn, args }); if (result instanceof Error) throw result; return result; } };
  }
  it("calls the RPC with the owner-pin key, 15 min window and 5 attempts", async () => {
    const sb = fakeSupabase({ data: [{ count: 1, reset_time: "x" }], error: null });
    const r = await oa.countPinAttempt({ supabase: sb, organizationId: "org-1" });
    assert.deepEqual(sb.calls[0], { fn: "check_rate_limit_bucket", args: { p_key: "owner-pin:org-1", p_window_ms: 900000, p_max_requests: 5 } });
    assert.deepEqual(r, { locked: false, count: 1, reason: "ok" });
  });
  it("is exhausted once the post-increment count passes 5", async () => {
    assert.equal((await oa.countPinAttempt({ supabase: fakeSupabase({ data: [{ count: 5 }], error: null }), organizationId: "o" })).locked, false);
    const r = await oa.countPinAttempt({ supabase: fakeSupabase({ data: [{ count: 6 }], error: null }), organizationId: "o" });
    assert.deepEqual(r, { locked: true, count: 6, reason: "exhausted" });
  });
  it("tolerates a single-object RPC shape", async () => {
    const r = await oa.countPinAttempt({ supabase: fakeSupabase({ data: { count: 2 }, error: null }), organizationId: "o" });
    assert.equal(r.locked, false);
  });
  it("fails CLOSED on an RPC error, an empty result or a throw", async () => {
    const err = await oa.countPinAttempt({ supabase: fakeSupabase({ data: null, error: { message: "boom" } }), organizationId: "o" });
    assert.equal(err.locked, true); assert.equal(err.reason, "rpc-error"); assert.ok(err.error);
    const empty = await oa.countPinAttempt({ supabase: fakeSupabase({ data: [], error: null }), organizationId: "o" });
    assert.equal(empty.locked, true); assert.equal(empty.reason, "rpc-error");
    const thrown = await oa.countPinAttempt({ supabase: fakeSupabase(new Error("network")), organizationId: "o" });
    assert.equal(thrown.locked, true); assert.equal(thrown.reason, "rpc-error"); assert.equal(thrown.error.message, "network");
  });
});

describe("ownerAssistantEnabled", () => {
  it("is read at call time and only 'true' enables it", () => {
    const prev = process.env.OWNER_ASSISTANT_ENABLED;
    process.env.OWNER_ASSISTANT_ENABLED = "true"; assert.equal(oa.ownerAssistantEnabled(), true);
    process.env.OWNER_ASSISTANT_ENABLED = "1"; assert.equal(oa.ownerAssistantEnabled(), false);
    delete process.env.OWNER_ASSISTANT_ENABLED; assert.equal(oa.ownerAssistantEnabled(), false);
    if (prev !== undefined) process.env.OWNER_ASSISTANT_ENABLED = prev;
  });
});

// ─── Additions beyond the task-1 brief ──────────────────────────────────────
// Branches the brief's own tests leave unpinned (each would survive a mutation),
// plus the two hardening fixes found while self-reviewing the brief's module.

describe("exported lockout constants — beyond the brief", () => {
  it("pins the numbers the route handler and the persisted lockout share", () => {
    assert.equal(oa.OWNER_PIN_MAX_ATTEMPTS, 5);
    assert.equal(oa.OWNER_PIN_WINDOW_MS, 900000);
    assert.equal(oa.OWNER_PIN_MAX_PER_CALL, 3);
  });
});

describe("normalisePinInput — beyond the brief", () => {
  it("maps the homophones and mixed digit/word speech", () => {
    assert.equal(oa.normalisePinInput({ speechResult: "o to too for ate" }), "02248");
    assert.equal(oa.normalisePinInput({ speechResult: "5 6 seven EIGHT" }), "5678");
    assert.equal(oa.normalisePinInput({ speechResult: "1234" }), "1234");
  });
  it("is digits-only whatever was said: an inherited Object.prototype name is not a number word", () => {
    // NUMBER_WORDS["constructor"] is Object.prototype.constructor — a bare property
    // lookup would splice "function Object() { [native code] }" into the PIN string.
    assert.equal(oa.normalisePinInput({ speechResult: "constructor" }), "");
    assert.equal(oa.normalisePinInput({ speechResult: "one constructor two" }), "12");
  });
});

describe("verifyPin — beyond the brief", () => {
  const good = { pin: "1234", pinHash: HASH_1234, pinSalt: SALT };
  it("accepts an 8-digit PIN against its own vector", () => {
    assert.equal(oa.verifyPin({ pin: "90210777", pinHash: HASH_90210777, pinSalt: SALT }), true);
  });
  it("treats the stored hex digest as case-insensitive", () => {
    assert.equal(oa.verifyPin({ ...good, pinHash: HASH_1234.toUpperCase() }), true);
  });
  it("returns false (never throws) for malformed stored values", () => {
    assert.equal(oa.verifyPin({ ...good, pinHash: HASH_1234.slice(2) }), false); // 62 hex chars
    assert.equal(oa.verifyPin({ ...good, pinHash: HASH_1234 + "00" }), false); // 66 hex chars
    assert.equal(oa.verifyPin({ ...good, pinHash: 1234 }), false);
    assert.equal(oa.verifyPin({ ...good, pinHash: "" }), false);
    assert.equal(oa.verifyPin({ ...good, pinSalt: "" }), false);
    assert.equal(oa.verifyPin({ ...good, pinSalt: null }), false);
    assert.equal(oa.verifyPin({ ...good, pinSalt: undefined }), false);
    assert.equal(oa.verifyPin({ ...good, pinSalt: 123 }), false);
  });
  it("refuses a blank salt even against a digest that was made with one", () => {
    // scrypt accepts an empty salt, so only the explicit guard stands between a broken row and a match.
    assert.equal(oa.verifyPin({ pin: "1234", pinHash: oa.hashPin("1234", ""), pinSalt: "" }), false);
  });
  it("returns false for a PIN that is not a 4..8 digit string, even against its own valid digest", () => {
    // Each candidate is checked against the digest OF ITSELF, so only the shape rule can reject it.
    for (const pin of ["123", "123456789", "1234\n", " 1234", "12a4", "١٢٣٤"]) {
      assert.equal(oa.verifyPin({ pin, pinHash: oa.hashPin(pin, SALT), pinSalt: SALT }), false, `pin ${JSON.stringify(pin)}`);
    }
    // A number is not the normalised string, even though String(1234) would hash to the right digest.
    assert.equal(oa.verifyPin({ ...good, pin: 1234 }), false);
  });
});

describe("pinLengthOf — beyond the brief", () => {
  it("includes both ends of 4..8 and rejects non-integers", () => {
    assert.equal(oa.pinLengthOf({ pin_length: 4 }), 4);
    assert.equal(oa.pinLengthOf({ pin_length: 8 }), 8);
    assert.equal(oa.pinLengthOf({ pin_length: 5.5 }), 4);
    assert.equal(oa.pinLengthOf({ pin_length: "abc" }), 4);
    assert.equal(oa.pinLengthOf({}), 4);
    assert.equal(oa.pinLengthOf(undefined), 4);
  });
});

describe("isOwnerCall — beyond the brief", () => {
  const access = { phone_e164: "+61400000001", enabled: true };
  it("is strict about the flag, the row flag and a registered number", () => {
    assert.equal(oa.isOwnerCall({ from: "+61400000001", ownerAccess: access, enabled: "true" }), false);
    assert.equal(oa.isOwnerCall({ from: "+61400000001", ownerAccess: { ...access, enabled: "true" }, enabled: true }), false);
    assert.equal(oa.isOwnerCall({ from: "+61400000001", ownerAccess: { enabled: true }, enabled: true }), false);
    assert.equal(oa.isOwnerCall({ from: undefined, ownerAccess: { enabled: true }, enabled: true }), false);
  });
  it("never matches a withheld or blank caller ID, even against a corrupt registered number", () => {
    assert.equal(oa.isOwnerCall({ from: "", ownerAccess: { phone_e164: "", enabled: true }, enabled: true }), false);
    assert.equal(oa.isOwnerCall({ from: "anonymous", ownerAccess: { phone_e164: "anonymous", enabled: true }, enabled: true }), false);
  });
});

describe("countPinAttempt — beyond the brief", () => {
  function fakeSupabase(result) {
    return { rpc: async () => result };
  }
  it("fails CLOSED on a malformed count rather than reading it as 'not exhausted'", async () => {
    for (const count of [undefined, null, "6", NaN, Infinity, -Infinity]) {
      const r = await oa.countPinAttempt({ supabase: fakeSupabase({ data: [{ count }], error: null }), organizationId: "o" });
      assert.equal(r.locked, true, `count=${String(count)} must lock`);
      assert.equal(r.reason, "rpc-error", `count=${String(count)} is a malformed reply`);
    }
  });
  it("fails CLOSED when the client itself is unusable", async () => {
    const r = await oa.countPinAttempt({ supabase: undefined, organizationId: "o" });
    assert.equal(r.locked, true);
    assert.equal(r.reason, "rpc-error");
    assert.ok(r.error);
  });
  it("still honours the RPC error when data also arrives", async () => {
    const r = await oa.countPinAttempt({ supabase: fakeSupabase({ data: [{ count: 1 }], error: { message: "late" } }), organizationId: "o" });
    assert.equal(r.locked, true);
    assert.equal(r.reason, "rpc-error");
  });
});
