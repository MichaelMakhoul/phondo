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

// The two lockout buckets are keyed by org + the first 8 chars of pin_salt (one PIN generation).
const KEY_15M = "owner-pin:org-1:00112233";
const KEY_24H = "owner-pin-day:org-1:00112233";
const ARGS = { organizationId: "org-1", pinSalt: SALT };

const bucketRow = (count) => ({ data: [{ count, reset_time: "2026-10-09T00:00:00Z" }], error: null });
// Different answers for the 15 minute and the 24 hour bucket.
const perBucket = ({ short, day }) => (args) => (args.p_key.startsWith("owner-pin-day:") ? day : short);

// A fake service-role client that records every interaction and never touches a network.
//   rpc(args, n)            result of the n-th check_rate_limit_bucket call
//   del({ column, value })  result of from(table).delete().eq(column, value)
// An Error as a result is thrown instead, like a network failure. `fromCalls` lists every table the
// client was asked for: countPinAttempt must leave it empty (it has no select() to offer either).
function fakeClient({ rpc = () => bucketRow(1), del = () => ({ error: null }) } = {}) {
  const rpcCalls = [];
  const fromCalls = [];
  const deletes = [];
  const settle = (result) => {
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    rpcCalls,
    fromCalls,
    deletes,
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      return settle(rpc(args, rpcCalls.length));
    },
    from: (table) => {
      fromCalls.push(table);
      return {
        delete: () => ({
          eq: async (column, value) => {
            deletes.push({ table, column, value });
            return settle(del({ column, value }));
          },
        }),
      };
    },
  };
}

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
  it("accepts the right PIN and rejects everything else", async () => {
    assert.equal(await oa.verifyPin({ pin: "1234", pinHash: HASH_1234, pinSalt: SALT }), true);
    assert.equal(await oa.verifyPin({ pin: "1235", pinHash: HASH_1234, pinSalt: SALT }), false);
    assert.equal(await oa.verifyPin({ pin: "1234", pinHash: HASH_1234, pinSalt: "ff" + SALT.slice(2) }), false);
    assert.equal(await oa.verifyPin({ pin: "12a4", pinHash: HASH_1234, pinSalt: SALT }), false);
    assert.equal(await oa.verifyPin({ pin: "", pinHash: HASH_1234, pinSalt: SALT }), false);
    assert.equal(await oa.verifyPin({ pin: "1234", pinHash: "nothex", pinSalt: SALT }), false);
    assert.equal(await oa.verifyPin({ pin: "1234", pinHash: null, pinSalt: SALT }), false);
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

// Fix round 3: BOTH windows are atomic RPC increments, made inside countPinAttempt BEFORE the PIN is
// checked. The 15 minute one is cleared by a correct PIN; the 24 hour one counts every attempt, right or
// wrong, and nothing but time (or a new pin_salt) clears it. There is no read-then-write step to race.
describe("countPinAttempt (persisted lockout)", () => {
  it("bumps the 15 minute bucket and then the 24 hour bucket, both by RPC, and touches no table", async () => {
    const sb = fakeClient();
    const r = await oa.countPinAttempt({ supabase: sb, ...ARGS });
    assert.deepEqual(sb.rpcCalls, [
      { fn: "check_rate_limit_bucket", args: { p_key: KEY_15M, p_window_ms: 900000, p_max_requests: 5 } },
      { fn: "check_rate_limit_bucket", args: { p_key: KEY_24H, p_window_ms: 86400000, p_max_requests: 20 } },
    ]);
    assert.deepEqual(sb.fromCalls, []);
    assert.deepEqual(r, { locked: false, reason: "ok", count: 1 });
  });
  it("awaits both increments, one after the other, before it resolves — so both are counted before any PIN is checked", async () => {
    const order = [];
    const sb = fakeClient({
      rpc: async (args) => {
        order.push(`start ${args.p_key}`);
        await new Promise((resolve) => setImmediate(resolve));
        order.push(`end ${args.p_key}`);
        return bucketRow(1);
      },
    });
    await oa.countPinAttempt({ supabase: sb, ...ARGS });
    order.push("resolved: the route may now check the PIN");
    assert.deepEqual(order, [`start ${KEY_15M}`, `end ${KEY_15M}`, `start ${KEY_24H}`, `end ${KEY_24H}`, "resolved: the route may now check the PIN"]);
  });
  it("reports the 15 minute count when it is not locked", async () => {
    const r = await oa.countPinAttempt({ supabase: fakeClient({ rpc: perBucket({ short: bucketRow(3), day: bucketRow(7) }) }), ...ARGS });
    assert.deepEqual(r, { locked: false, reason: "ok", count: 3 });
  });
  it("is exhausted once the post-increment 15 minute count passes 5, and then leaves the 24 hour bucket alone", async () => {
    const at5 = fakeClient({ rpc: () => bucketRow(5) });
    assert.equal((await oa.countPinAttempt({ supabase: at5, ...ARGS })).locked, false);
    assert.equal(at5.rpcCalls.length, 2);
    const at6 = fakeClient({ rpc: () => bucketRow(6) });
    const r = await oa.countPinAttempt({ supabase: at6, ...ARGS });
    assert.deepEqual(r, { locked: true, reason: "exhausted", window: "15m", count: 6 });
    assert.deepEqual(at6.rpcCalls.map((c) => c.args.p_key), [KEY_15M]);
  });
  it("is exhausted once the post-increment 24 hour count passes 20", async () => {
    for (const [dayCount, locked] of [[1, false], [19, false], [20, false], [21, true], [22, true]]) {
      const sb = fakeClient({ rpc: perBucket({ short: bucketRow(2), day: bucketRow(dayCount) }) });
      const r = await oa.countPinAttempt({ supabase: sb, ...ARGS });
      assert.deepEqual(r, locked ? { locked: true, reason: "exhausted", window: "24h", count: dayCount } : { locked: false, reason: "ok", count: 2 }, `day count ${dayCount}`);
      assert.equal(sb.rpcCalls.length, 2, `day count ${dayCount}`);
    }
  });
  it("tolerates a single-object RPC shape", async () => {
    const r = await oa.countPinAttempt({ supabase: fakeClient({ rpc: () => ({ data: { count: 2 }, error: null }) }), ...ARGS });
    assert.deepEqual(r, { locked: false, reason: "ok", count: 2 });
  });
  it("keys both buckets by PIN generation: a new pin_salt starts fresh ones, only its first 8 chars count", async () => {
    const rotated = fakeClient();
    await oa.countPinAttempt({ supabase: rotated, organizationId: "org-1", pinSalt: "ffeeddcc" + SALT.slice(8) });
    assert.deepEqual(rotated.rpcCalls.map((c) => c.args.p_key), ["owner-pin:org-1:ffeeddcc", "owner-pin-day:org-1:ffeeddcc"]);
    const sameGeneration = fakeClient();
    await oa.countPinAttempt({ supabase: sameGeneration, organizationId: "org-1", pinSalt: "00112233" + "f".repeat(24) });
    assert.deepEqual(sameGeneration.rpcCalls.map((c) => c.args.p_key), [KEY_15M, KEY_24H]);
    const otherOrg = fakeClient();
    await oa.countPinAttempt({ supabase: otherOrg, organizationId: "org-2", pinSalt: SALT });
    assert.deepEqual(otherOrg.rpcCalls.map((c) => c.args.p_key), ["owner-pin:org-2:00112233", "owner-pin-day:org-2:00112233"]);
  });
  it("fails CLOSED on an RPC error, an empty result or a throw — on either call", async () => {
    const boom = { data: null, error: { message: "boom", code: "42501" } };
    const noRows = { data: [], error: null };
    const noData = { data: null, error: null };
    for (const [name, rpc, rpcCalls] of [
      ["15m rpc error", () => boom, 1],
      ["15m empty array", () => noRows, 1],
      ["15m null data", () => noData, 1],
      ["15m throw", () => new Error("network"), 1],
      ["24h rpc error", perBucket({ short: bucketRow(1), day: boom }), 2],
      ["24h empty array", perBucket({ short: bucketRow(1), day: noRows }), 2],
      ["24h null data", perBucket({ short: bucketRow(1), day: noData }), 2],
      ["24h throw", perBucket({ short: bucketRow(1), day: new Error("network") }), 2],
    ]) {
      const sb = fakeClient({ rpc });
      const r = await oa.countPinAttempt({ supabase: sb, ...ARGS });
      assert.equal(r.locked, true, name);
      assert.equal(r.reason, "rpc-error", name);
      assert.ok(r.error instanceof Error, name);
      assert.equal(sb.rpcCalls.length, rpcCalls, name);
    }
  });
  it("fails CLOSED on a count that is not a finite number — on either call", async () => {
    for (const count of [undefined, null, "6", NaN, Infinity, -Infinity]) {
      for (const bucket of ["short", "day"]) {
        const answers = { short: bucketRow(1), day: bucketRow(1), [bucket]: bucketRow(count) };
        const r = await oa.countPinAttempt({ supabase: fakeClient({ rpc: perBucket(answers) }), ...ARGS });
        assert.equal(r.locked, true, `${bucket} count=${String(count)} must lock`);
        assert.equal(r.reason, "rpc-error", `${bucket} count=${String(count)} is a malformed reply`);
      }
    }
  });
  it("still honours the RPC error when data also arrives", async () => {
    const r = await oa.countPinAttempt({ supabase: fakeClient({ rpc: () => ({ data: [{ count: 1 }], error: { message: "late" } }) }), ...ARGS });
    assert.equal(r.locked, true);
    assert.equal(r.reason, "rpc-error");
  });
  it("needs nothing but rpc: a client that offers no table access at all works", async () => {
    const rpcOnly = { rpc: async () => bucketRow(1) };
    assert.deepEqual(await oa.countPinAttempt({ supabase: rpcOnly, ...ARGS }), { locked: false, reason: "ok", count: 1 });
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
// plus the hardening fixes found while self-reviewing, plus fix rounds 1 to 3.

describe("exported lockout constants — beyond the brief", () => {
  it("pins the numbers the route handler and the persisted lockout share", () => {
    assert.equal(oa.OWNER_PIN_MAX_ATTEMPTS, 5);
    assert.equal(oa.OWNER_PIN_WINDOW_MS, 900000);
    assert.equal(oa.OWNER_PIN_DAY_MAX_ATTEMPTS, 20);
    assert.equal(oa.OWNER_PIN_DAY_WINDOW_MS, 86400000);
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
    assert.equal(oa.normalisePinInput({ speechResult: "double constructor five" }), "5");
  });
});

// Fix round 1 (R7): Australians say "double five" and "triple oh".
describe("normalisePinInput — double / triple", () => {
  it("expands 'double X' and 'triple X' to repeated digits", () => {
    assert.equal(oa.normalisePinInput({ speechResult: "one double five two" }), "1552");
    assert.equal(oa.normalisePinInput({ speechResult: "triple seven one" }), "7771");
    assert.equal(oa.normalisePinInput({ speechResult: "double oh seven" }), "007");
  });
  it("takes a numeral or a homophone after it, in any case and punctuation", () => {
    assert.equal(oa.normalisePinInput({ speechResult: "Double 5, two" }), "552");
    assert.equal(oa.normalisePinInput({ speechResult: "TRIPLE-nine one" }), "9991");
    assert.equal(oa.normalisePinInput({ speechResult: "double to" }), "22");
    assert.equal(oa.normalisePinInput({ speechResult: "triple oh" }), "000");
  });
  it("ignores a trailing double/triple that has no digit after it", () => {
    assert.equal(oa.normalisePinInput({ speechResult: "one two double" }), "12");
    assert.equal(oa.normalisePinInput({ speechResult: "one two three triple" }), "123");
    assert.equal(oa.normalisePinInput({ speechResult: "double" }), "");
  });
  it("applies to the very next word only: it is spent after one digit and a filler word cancels it", () => {
    assert.equal(oa.normalisePinInput({ speechResult: "double five two" }), "552");
    assert.equal(oa.normalisePinInput({ speechResult: "double triple five" }), "555");
    assert.equal(oa.normalisePinInput({ speechResult: "double pin five" }), "5");
    assert.equal(oa.normalisePinInput({ speechResult: "let me double check one two three four" }), "1234");
  });
  it("only doubles a single digit: a multi-digit numeral is left as it was said", () => {
    assert.equal(oa.normalisePinInput({ speechResult: "double 55" }), "55");
  });
  it("still lets keyed digits win over a spoken double", () => {
    assert.equal(oa.normalisePinInput({ digits: "1234", speechResult: "double five" }), "1234");
  });
});

describe("verifyPin — beyond the brief", () => {
  const good = { pin: "1234", pinHash: HASH_1234, pinSalt: SALT };
  it("accepts an 8-digit PIN against its own vector", async () => {
    assert.equal(await oa.verifyPin({ pin: "90210777", pinHash: HASH_90210777, pinSalt: SALT }), true);
  });
  it("treats the stored hex digest as case-insensitive", async () => {
    assert.equal(await oa.verifyPin({ ...good, pinHash: HASH_1234.toUpperCase() }), true);
  });
  it("returns false (never throws) for malformed stored values", async () => {
    assert.equal(await oa.verifyPin({ ...good, pinHash: HASH_1234.slice(2) }), false); // 62 hex chars
    assert.equal(await oa.verifyPin({ ...good, pinHash: HASH_1234 + "00" }), false); // 66 hex chars
    assert.equal(await oa.verifyPin({ ...good, pinHash: 1234 }), false);
    assert.equal(await oa.verifyPin({ ...good, pinHash: "" }), false);
    assert.equal(await oa.verifyPin({ ...good, pinSalt: "" }), false);
    assert.equal(await oa.verifyPin({ ...good, pinSalt: null }), false);
    assert.equal(await oa.verifyPin({ ...good, pinSalt: undefined }), false);
    assert.equal(await oa.verifyPin({ ...good, pinSalt: 123 }), false);
  });
  // Fix round 1 (R6): Buffer.from(x, "hex") silently drops trailing junk, so the explicit
  // 64-hex-char guard is the ONLY thing standing between a damaged pin_hash and a match.
  it("rejects a stored digest with trailing or leading junk that Buffer.from(…, 'hex') would ignore", async () => {
    assert.equal(Buffer.from(HASH_1234 + "zz", "hex").equals(Buffer.from(HASH_1234, "hex")), true, "premise: hex decoding ignores trailing junk");
    for (const [label, pinHash] of [
      ["trailing newline", HASH_1234 + "\n"],
      ["trailing zz", HASH_1234 + "zz"],
      ["trailing space", HASH_1234 + " "],
      ["leading space", " " + HASH_1234],
    ]) {
      assert.equal(await oa.verifyPin({ ...good, pinHash }), false, label);
    }
  });
  it("refuses a blank salt even against a digest that was made with one", async () => {
    // scrypt accepts an empty salt, so only the explicit guard stands between a broken row and a match.
    assert.equal(await oa.verifyPin({ pin: "1234", pinHash: oa.hashPin("1234", ""), pinSalt: "" }), false);
  });
  it("returns false for a PIN that is not a 4..8 digit string, even against its own valid digest", async () => {
    // Each candidate is checked against the digest OF ITSELF, so only the shape rule can reject it.
    for (const pin of ["123", "123456789", "1234\n", " 1234", "12a4", "١٢٣٤"]) {
      assert.equal(await oa.verifyPin({ pin, pinHash: oa.hashPin(pin, SALT), pinSalt: SALT }), false, `pin ${JSON.stringify(pin)}`);
    }
    // A number is not the normalised string, even though String(1234) would hash to the right digest.
    assert.equal(await oa.verifyPin({ ...good, pin: 1234 }), false);
  });
  it("answers concurrent checks independently", async () => {
    const [right, wrong] = await Promise.all([oa.verifyPin(good), oa.verifyPin({ ...good, pin: "4321" })]);
    assert.equal(right, true);
    assert.equal(wrong, false);
  });
});

// Fix round 1 (R3): scrypt must run on the libuv pool, not on the loop that relays live call audio.
describe("verifyPin — async, off the event loop", () => {
  const good = { pin: "1234", pinHash: HASH_1234, pinSalt: SALT };
  it("is still pending after one event-loop turn (a synchronous scrypt would already have settled)", async () => {
    let settled = false;
    const pending = oa.verifyPin(good);
    assert.ok(pending instanceof Promise);
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "verifyPin finished within one event-loop turn, so scrypt ran on the event loop");
    assert.equal(await pending, true);
  });
  it("resolves false, never rejects, when scrypt itself fails", async () => {
    const original = crypto.scrypt;
    try {
      crypto.scrypt = (_pin, _salt, _keylen, callback) => callback(new Error("scrypt failed"));
      assert.equal(await oa.verifyPin(good), false);
      crypto.scrypt = () => { throw new Error("scrypt threw"); };
      assert.equal(await oa.verifyPin(good), false);
    } finally {
      crypto.scrypt = original;
    }
  });
  it("resolves false, never rejects, when called without arguments", async () => {
    assert.equal(await oa.verifyPin(), false);
    assert.equal(await oa.verifyPin(null), false);
  });
  it("keeps hashPin synchronous (the known-answer helper)", () => {
    assert.equal(typeof oa.hashPin("1234", SALT), "string");
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

// Fix round 1 (R4, R5): arguments are validated before any key is built, and every returned error is an Error.
describe("countPinAttempt — arguments and errors", () => {
  it("fails CLOSED, with no RPC at all, when the PIN generation is unknown (pinSalt not a string of 8+ chars)", async () => {
    for (const pinSalt of [undefined, null, "", "abcdefg", 12345678, ["00112233"]]) {
      const sb = fakeClient();
      const r = await oa.countPinAttempt({ supabase: sb, organizationId: "org-1", pinSalt });
      assert.equal(r.locked, true, String(pinSalt));
      assert.equal(r.reason, "rpc-error", String(pinSalt));
      assert.ok(r.error instanceof Error, String(pinSalt));
      assert.equal(sb.rpcCalls.length, 0, String(pinSalt));
    }
    const exactlyEight = fakeClient();
    assert.equal((await oa.countPinAttempt({ supabase: exactlyEight, organizationId: "org-1", pinSalt: "abcdefgh" })).locked, false);
    assert.deepEqual(exactlyEight.rpcCalls.map((c) => c.args.p_key), ["owner-pin:org-1:abcdefgh", "owner-pin-day:org-1:abcdefgh"]);
  });
  it("fails CLOSED, with no RPC, when organizationId is not a non-empty string — never an 'owner-pin:undefined' key", async () => {
    for (const organizationId of [undefined, null, "", "   ", 42, {}]) {
      const sb = fakeClient();
      const r = await oa.countPinAttempt({ supabase: sb, organizationId, pinSalt: SALT });
      assert.equal(r.locked, true, String(organizationId));
      assert.equal(r.reason, "rpc-error", String(organizationId));
      assert.ok(r.error instanceof Error, String(organizationId));
      assert.equal(sb.rpcCalls.length, 0, String(organizationId));
    }
  });
  it("fails CLOSED when the client itself is unusable or no arguments are given", async () => {
    for (const args of [{ supabase: undefined, ...ARGS }, { supabase: {}, ...ARGS }, undefined, null]) {
      const r = await oa.countPinAttempt(args);
      assert.equal(r.locked, true);
      assert.equal(r.reason, "rpc-error");
      assert.ok(r.error instanceof Error);
    }
    // A missing argument object is reported as the missing id, not as a destructuring TypeError.
    for (const args of [undefined, null]) {
      assert.match((await oa.countPinAttempt(args)).error.message, /organizationId/);
    }
  });
  it("wraps a PostgREST error object in an Error that keeps the original as its cause, on either call", async () => {
    const pg = { code: "42501", message: "permission denied for function check_rate_limit_bucket", details: null, hint: null };
    const on15m = await oa.countPinAttempt({ supabase: fakeClient({ rpc: () => ({ data: null, error: pg }) }), ...ARGS });
    assert.ok(on15m.error instanceof Error);
    assert.equal(on15m.error.message, pg.message);
    assert.equal(on15m.error.cause, pg);
    const on24h = await oa.countPinAttempt({ supabase: fakeClient({ rpc: perBucket({ short: bucketRow(1), day: { data: null, error: pg } }) }), ...ARGS });
    assert.ok(on24h.error instanceof Error);
    assert.equal(on24h.error.message, pg.message);
    assert.equal(on24h.error.cause, pg);
  });
  it("hands a thrown Error back as itself on either call, and gives a message-less error object a message", async () => {
    const thrown = new Error("network");
    assert.equal((await oa.countPinAttempt({ supabase: fakeClient({ rpc: () => thrown }), ...ARGS })).error, thrown);
    assert.equal((await oa.countPinAttempt({ supabase: fakeClient({ rpc: perBucket({ short: bucketRow(1), day: thrown }) }), ...ARGS })).error, thrown);
    const bare = { code: "XX000" };
    const m = await oa.countPinAttempt({ supabase: fakeClient({ rpc: () => ({ data: null, error: bare }) }), ...ARGS });
    assert.ok(m.error instanceof Error);
    assert.ok(m.error.message.length > 0);
    assert.equal(m.error.cause, bare);
  });
});

// A correct PIN clears the 15 minute window ONLY. The 24 hour bucket is never touched here, so tries stay
// counted toward the daily cap however often the owner logs in.
describe("resetPinAttempts", () => {
  it("deletes exactly the 15 minute row of this org + PIN generation, and never the 24 hour row", async () => {
    const sb = fakeClient();
    const r = await oa.resetPinAttempts({ supabase: sb, ...ARGS });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(sb.deletes, [{ table: "rate_limit_buckets", column: "key", value: KEY_15M }]);
    assert.deepEqual(sb.rpcCalls, []);
  });
  it("targets the very key countPinAttempt increments first", async () => {
    const counted = fakeClient();
    await oa.countPinAttempt({ supabase: counted, organizationId: "org-9", pinSalt: SALT });
    const sb = fakeClient();
    await oa.resetPinAttempts({ supabase: sb, organizationId: "org-9", pinSalt: SALT });
    assert.deepEqual(sb.deletes.map((d) => d.value), [counted.rpcCalls[0].args.p_key]);
  });
  it("reports ok:false with an Error (the PostgREST error as its cause) when the delete is rejected", async () => {
    const pg = { code: "42501", message: "permission denied for table rate_limit_buckets", details: null, hint: null };
    const r = await oa.resetPinAttempts({ supabase: fakeClient({ del: () => ({ error: pg }) }), ...ARGS });
    assert.equal(r.ok, false);
    assert.ok(r.error instanceof Error);
    assert.equal(r.error.message, pg.message);
    assert.equal(r.error.cause, pg);
  });
  it("never throws: a thrown delete comes back as ok:false with that same Error", async () => {
    const thrown = new Error("network");
    const r = await oa.resetPinAttempts({ supabase: fakeClient({ del: () => thrown }), ...ARGS });
    assert.deepEqual(r, { ok: false, error: thrown });
  });
  it("never throws on an unusable client or no arguments", async () => {
    for (const args of [{ supabase: undefined, ...ARGS }, { supabase: {}, ...ARGS }, undefined, null]) {
      const r = await oa.resetPinAttempts(args);
      assert.equal(r.ok, false);
      assert.ok(r.error instanceof Error);
    }
    for (const args of [undefined, null]) {
      assert.match((await oa.resetPinAttempts(args)).error.message, /organizationId/);
    }
  });
  it("makes no delete at all for a bad organizationId or pinSalt", async () => {
    const bad = [
      { organizationId: undefined, pinSalt: SALT },
      { organizationId: "", pinSalt: SALT },
      { organizationId: "   ", pinSalt: SALT },
      { organizationId: 42, pinSalt: SALT },
      { organizationId: "org-1", pinSalt: undefined },
      { organizationId: "org-1", pinSalt: "" },
      { organizationId: "org-1", pinSalt: "abcdefg" },
      { organizationId: "org-1", pinSalt: 12345678 },
    ];
    for (const args of bad) {
      const sb = fakeClient();
      const r = await oa.resetPinAttempts({ supabase: sb, ...args });
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.ok(r.error instanceof Error, JSON.stringify(args));
      assert.equal(sb.deletes.length, 0, JSON.stringify(args));
    }
  });
});

// The fakes above prove each call in isolation. This replays whole sequences of PIN entries against an
// in-memory table with the RPC's atomic upsert semantics (real clock, real windows), the way the route
// will drive the functions: count the entry -> check the PIN -> a correct PIN clears the 15 minute window.
describe("the two windows together", () => {
  function memoryBuckets() {
    const rows = new Map(); // key -> { count, resetMs }
    const writes = []; // every mutation, in order: { op: "bump" | "delete", key }
    return {
      rows,
      writes,
      async rpc(fn, { p_key, p_window_ms }) {
        assert.equal(fn, "check_rate_limit_bucket");
        const now = Date.now();
        const row = rows.get(p_key);
        const next = !row || row.resetMs < now ? { count: 1, resetMs: now + p_window_ms } : { count: row.count + 1, resetMs: row.resetMs };
        rows.set(p_key, next);
        writes.push({ op: "bump", key: p_key });
        return { data: [{ count: next.count, reset_time: new Date(next.resetMs).toISOString() }], error: null };
      },
      from(table) {
        assert.equal(table, "rate_limit_buckets");
        return {
          delete: () => ({
            eq: async (_column, key) => {
              rows.delete(key);
              writes.push({ op: "delete", key });
              return { error: null };
            },
          }),
        };
      },
    };
  }
  async function enterPin(db, { correct }) {
    const gate = await oa.countPinAttempt({ supabase: db, ...ARGS });
    if (!gate.locked && correct) await oa.resetPinAttempts({ supabase: db, ...ARGS });
    return gate;
  }

  it("allows 5 tries per 15 minutes and locks the 6th, right or wrong, without spending the daily budget on it", async () => {
    const db = memoryBuckets();
    for (let i = 1; i <= 5; i++) assert.equal((await enterPin(db, { correct: false })).locked, false, `try ${i}`);
    assert.deepEqual(await enterPin(db, { correct: false }), { locked: true, reason: "exhausted", window: "15m", count: 6 });
    assert.equal(db.rows.get(KEY_24H).count, 5, "the locked 6th try was not counted against the day");
  });
  it("lets a correct PIN clear the 15 minute window and nothing else", async () => {
    const db = memoryBuckets();
    for (let i = 0; i < 4; i++) await enterPin(db, { correct: false });
    assert.equal(db.rows.get(KEY_15M).count, 4);
    assert.equal((await enterPin(db, { correct: true })).locked, false);
    assert.equal(db.rows.has(KEY_15M), false, "cleared by the correct PIN");
    assert.equal(db.rows.get(KEY_24H).count, 5, "the login is one of today's 20 tries");
  });
  it("caps tries at 20 per 24 hours, right or wrong, however often a correct PIN clears the 15 minute window", async () => {
    const db = memoryBuckets();
    for (let round = 1; round <= 4; round++) {
      for (let i = 1; i <= 4; i++) assert.equal((await enterPin(db, { correct: false })).locked, false, `round ${round} wrong PIN ${i}`);
      // The owner logs in between the attacker's bursts: this clears the 15 minute window, as it should.
      assert.equal((await enterPin(db, { correct: true })).locked, false, `round ${round} login`);
    }
    assert.equal(db.rows.get(KEY_24H).count, 20);
    assert.deepEqual(await enterPin(db, { correct: false }), { locked: true, reason: "exhausted", window: "24h", count: 21 });
    assert.equal(db.writes.some((w) => w.op === "delete" && w.key === KEY_24H), false, "nothing ever cleared the 24 hour bucket");
    // The owner is locked out too, until the window ends or a new PIN (a new pin_salt) is saved.
    assert.equal((await enterPin(db, { correct: true })).window, "24h");
    assert.equal((await oa.countPinAttempt({ supabase: db, organizationId: "org-1", pinSalt: "ffeeddcc" + SALT.slice(8) })).locked, false);
  });
  it("counts successes against the daily budget too, and a reset never gives it back", async () => {
    const db = memoryBuckets();
    for (let i = 1; i <= 20; i++) assert.equal((await enterPin(db, { correct: true })).locked, false, `login ${i}`);
    assert.equal(db.rows.has(KEY_15M), false, "each login cleared the 15 minute window");
    assert.equal(db.rows.get(KEY_24H).count, 20, "...and used one of today's 20 tries");
    assert.deepEqual(await enterPin(db, { correct: true }), { locked: true, reason: "exhausted", window: "24h", count: 21 });
    assert.equal(db.writes.some((w) => w.op === "delete" && w.key === KEY_24H), false);
  });
  it("lets parallel attempts through no more than 5 at a time and no more than 20 a day", async () => {
    const burst = memoryBuckets();
    const results = await Promise.all(Array.from({ length: 12 }, () => oa.countPinAttempt({ supabase: burst, ...ARGS })));
    assert.equal(results.filter((r) => !r.locked).length, 5, "12 parallel attempts, 5 let through");
    const day = memoryBuckets();
    let allowed = 0;
    for (let round = 0; round < 8; round++) {
      const bursts = await Promise.all(Array.from({ length: 5 }, () => oa.countPinAttempt({ supabase: day, ...ARGS })));
      allowed += bursts.filter((r) => !r.locked).length;
      await oa.resetPinAttempts({ supabase: day, ...ARGS }); // a correct PIN clears the 15 minute window between bursts
    }
    assert.equal(allowed, 20, "8 bursts of 5 in parallel, exactly 20 let through");
  });
  it("lets the 24 hour window end by time alone, after which the next entry starts a fresh one", async () => {
    const db = memoryBuckets();
    db.rows.set(KEY_24H, { count: 20, resetMs: Date.now() + 3600000 });
    assert.equal((await enterPin(db, { correct: false })).window, "24h");
    db.rows.set(KEY_24H, { count: 21, resetMs: Date.now() - 1000 });
    assert.equal((await enterPin(db, { correct: false })).locked, false);
    assert.equal(db.rows.get(KEY_24H).count, 1, "a new window started at 1");
  });
});

// The fakes can only prove what we asked of them. These run the REAL supabase-js builders against a
// stubbed fetch (no network) to pin the requests that would reach PostgREST.
describe("against the real supabase-js client with a stubbed fetch", () => {
  const { createClient } = require("@supabase/supabase-js");
  function stubbedClient(respond) {
    const requests = [];
    const client = createClient("https://stub.supabase.test", "service-role-stub", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (url, init = {}) => {
          const request = { url: new URL(String(url)), method: init.method, body: init.body ? String(init.body) : null };
          requests.push(request);
          return respond(request, requests.length);
        },
      },
    });
    return { client, requests };
  }
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const denied = (what) => ({ code: "42501", message: `permission denied for ${what}`, details: null, hint: null });
  const row = (count) => [{ count, reset_time: "2026-10-10T00:15:00+00:00" }];

  it("countPinAttempt POSTs the 15 minute RPC, then the 24 hour RPC — and nothing else", async () => {
    const { client, requests } = stubbedClient((_req, n) => json(200, row(n === 1 ? 2 : 7)));
    const r = await oa.countPinAttempt({ supabase: client, ...ARGS });
    assert.deepEqual(r, { locked: false, reason: "ok", count: 2 });
    assert.deepEqual(requests.map((q) => `${q.method} ${q.url.pathname}`), Array(2).fill("POST /rest/v1/rpc/check_rate_limit_bucket"));
    assert.deepEqual(requests.map((q) => JSON.parse(q.body)), [
      { p_key: KEY_15M, p_window_ms: 900000, p_max_requests: 5 },
      { p_key: KEY_24H, p_window_ms: 86400000, p_max_requests: 20 },
    ]);
  });
  it("countPinAttempt locks on a 24 hour count of 21, and not on 20", async () => {
    const at = (dayCount) => stubbedClient((_req, n) => json(200, row(n === 1 ? 1 : dayCount))).client;
    assert.deepEqual(await oa.countPinAttempt({ supabase: at(20), ...ARGS }), { locked: false, reason: "ok", count: 1 });
    assert.deepEqual(await oa.countPinAttempt({ supabase: at(21), ...ARGS }), { locked: true, reason: "exhausted", window: "24h", count: 21 });
  });
  it("countPinAttempt turns a PostgREST permission error on either RPC into a locked Error", async () => {
    const first = stubbedClient(() => json(403, denied("function check_rate_limit_bucket")));
    const a = await oa.countPinAttempt({ supabase: first.client, ...ARGS });
    assert.equal(a.locked, true);
    assert.equal(a.reason, "rpc-error");
    assert.ok(a.error instanceof Error);
    assert.match(a.error.message, /permission denied/);
    assert.equal(first.requests.length, 1, "no 24 hour bump after a failed 15 minute bump");
    const second = stubbedClient((_req, n) => (n === 1 ? json(200, row(1)) : json(403, denied("function check_rate_limit_bucket"))));
    const b = await oa.countPinAttempt({ supabase: second.client, ...ARGS });
    assert.equal(b.locked, true);
    assert.equal(b.reason, "rpc-error");
    assert.ok(b.error instanceof Error);
  });
  it("resetPinAttempts sends ONE DELETE on rate_limit_buckets for the 15 minute key only — nothing names the day key", async () => {
    const { client, requests } = stubbedClient(() => new Response(null, { status: 204 }));
    const r = await oa.resetPinAttempts({ supabase: client, ...ARGS });
    assert.deepEqual(r, { ok: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "DELETE");
    assert.equal(requests[0].url.pathname, "/rest/v1/rate_limit_buckets");
    assert.equal(requests[0].url.searchParams.get("key"), `eq.${KEY_15M}`);
    assert.equal(decodeURIComponent(requests[0].url.search).includes("owner-pin-day"), false);
  });
  it("resetPinAttempts turns a rejected DELETE into ok:false with an Error", async () => {
    const { client } = stubbedClient(() => json(403, denied("table rate_limit_buckets")));
    const r = await oa.resetPinAttempts({ supabase: client, ...ARGS });
    assert.equal(r.ok, false);
    assert.ok(r.error instanceof Error);
    assert.match(r.error.message, /permission denied/);
  });
});

// Fix round 3: counting is two atomic RPCs and nothing else. A table read before the PIN check would be a
// check-then-act step that parallel calls can pass together; a follow-up write after a failed check would
// leave a guess uncounted whenever it failed or was skipped.
describe("the lockout has no read-then-write step", () => {
  const srcText = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "lib", "owner-auth.js"), "utf8");
  it("countPinAttempt makes RPC calls only: no .from( / .select( / .maybeSingle( in it", () => {
    const body = srcText.match(/async function countPinAttempt\(args\) \{[\s\S]*?\n\}\n/);
    assert.ok(body, "countPinAttempt not found in the source");
    assert.doesNotMatch(body[0], /\.from\(|\.select\(|\.maybeSingle\(/);
    assert.match(body[0], /bumpBucket\(supabase, keys\.short,[\s\S]*bumpBucket\(supabase, keys\.day,/);
  });
  it("the module reads no table at all: its only .from( is resetPinAttempts' delete of the 15 minute key", () => {
    assert.doesNotMatch(srcText, /\.select\(|\.maybeSingle\(/);
    assert.equal((srcText.match(/(?<!Buffer)\.from\(/g) || []).length, 1); // Buffer.from is not a table
    assert.match(srcText, /\.from\(RATE_LIMIT_TABLE\)\.delete\(\)\.eq\("key", keys\.short\)/);
  });
  it("no longer exports a failure-recording path", () => {
    assert.equal("recordPinFailure" in oa, false);
    assert.deepEqual(Object.keys(oa).filter((name) => /record|read/i.test(name)), []);
  });
});

// Fix round 1 (R8): the PIN must never reach a log line, so the module stays silent.
describe("owner-auth.js stays silent", () => {
  it("contains no console call", () => {
    const srcText = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "lib", "owner-auth.js"), "utf8");
    assert.doesNotMatch(srcText, /\bconsole\s*\./);
  });
});
