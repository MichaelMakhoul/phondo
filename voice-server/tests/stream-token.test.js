// voice-server/tests/stream-token.test.js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { mintStreamToken, verifyStreamToken, withoutOwnerAccess } = require("../lib/stream-token");

// SCRUM-587 — the /ws/audio stream token. With owner mode stored under the
// token in pendingTokens, two tokens minted in the same millisecond must never
// be equal: the second pendingTokens.set would overwrite the first entry and a
// concurrent customer call could consume the owner's session. The wiring of
// these helpers into server.js is covered functionally in
// server-owner-pin-wiring.test.js.
const SECRET = "test-ws-secret";
const T = 1_760_000_000_123;
const frozen = () => T;

describe("SCRUM-587: mintStreamToken", () => {
  it("is `${ts}.${nonce}.${mac}`: a decimal ms timestamp, a 16-byte hex nonce and a SHA-256 hex MAC", () => {
    const token = mintStreamToken(SECRET, { now: frozen });
    const parts = token.split(".");
    assert.equal(parts.length, 3, token);
    assert.equal(parts[0], String(T));
    assert.match(parts[1], /^[0-9a-f]{32}$/);
    assert.match(parts[2], /^[0-9a-f]{64}$/);
  });

  it("two tokens minted in the same millisecond differ (the nonce, with the real CSPRNG)", () => {
    const a = mintStreamToken(SECRET, { now: frozen });
    const b = mintStreamToken(SECRET, { now: frozen });
    assert.equal(a.split(".")[0], b.split(".")[0], "precondition: same millisecond");
    assert.notEqual(a, b);
    assert.ok(verifyStreamToken(SECRET, a) && verifyStreamToken(SECRET, b), "both must verify");
  });

  it("draws 16 random bytes per token, and the nonce is the token's only source of uniqueness", () => {
    const sizes = [];
    const fixed = (n) => {
      sizes.push(n);
      return Buffer.alloc(n, 7);
    };
    const a = mintStreamToken(SECRET, { now: frozen, randomBytes: fixed });
    const b = mintStreamToken(SECRET, { now: frozen, randomBytes: fixed });
    assert.deepEqual(sizes, [16, 16]);
    assert.equal(a, b, "same ms + same nonce bytes ⇒ same token, so the random nonce is what keeps tokens apart");
    assert.equal(a.split(".")[1], "07".repeat(16));
  });

  it("MACs ts AND nonce with the secret (HMAC-SHA256 over `${ts}.${nonce}`)", () => {
    const token = mintStreamToken(SECRET, { now: frozen });
    const [ts, nonce, mac] = token.split(".");
    const expected = crypto.createHmac("sha256", SECRET).update(`${ts}.${nonce}`).digest("hex");
    assert.equal(mac, expected);
  });
});

describe("SCRUM-587: verifyStreamToken", () => {
  it("accepts a token it minted", () => {
    assert.equal(verifyStreamToken(SECRET, mintStreamToken(SECRET)), true);
  });

  it("rejects a token minted with another secret", () => {
    assert.equal(verifyStreamToken(SECRET, mintStreamToken("another-secret")), false);
  });

  it("binds the nonce: two same-ms tokens with their nonces swapped both fail", () => {
    const [ts, n1, m1] = mintStreamToken(SECRET, { now: frozen }).split(".");
    const [, n2, m2] = mintStreamToken(SECRET, { now: frozen }).split(".");
    assert.notEqual(n1, n2);
    assert.equal(verifyStreamToken(SECRET, `${ts}.${n2}.${m1}`), false);
    assert.equal(verifyStreamToken(SECRET, `${ts}.${n1}.${m2}`), false);
  });

  it("rejects a tampered timestamp or MAC", () => {
    const [ts, nonce, mac] = mintStreamToken(SECRET, { now: frozen }).split(".");
    assert.equal(verifyStreamToken(SECRET, `${Number(ts) + 1}.${nonce}.${mac}`), false);
    const flipped = (mac[0] === "a" ? "b" : "a") + mac.slice(1);
    assert.equal(verifyStreamToken(SECRET, `${ts}.${nonce}.${flipped}`), false);
    assert.equal(verifyStreamToken(SECRET, `${ts}.${nonce}.${mac.slice(0, 63)}`), false, "short MAC");
    assert.equal(verifyStreamToken(SECRET, `${ts}.${nonce}.${mac}0`), false, "long MAC");
  });

  it("rejects the pre-SCRUM-587 two-part format, even with a valid MAC over ts", () => {
    const ts = String(T);
    const legacy = `${ts}.${crypto.createHmac("sha256", SECRET).update(ts).digest("hex")}`;
    assert.equal(verifyStreamToken(SECRET, legacy), false);
  });

  it("rejects malformed input without throwing", () => {
    const token = mintStreamToken(SECRET, { now: frozen });
    const [ts, nonce, mac] = token.split(".");
    for (const bad of [
      undefined, null, 42, {}, [], "", ".", "..", "a.b.c",
      `${token}.extra`,
      `x${ts}.${nonce}.${mac}`,
      `${ts}.${nonce.toUpperCase()}.${mac}`,
      `${ts}.${nonce.slice(2)}.${mac}`,
      `.${nonce}.${mac}`,
      `${ts}..${mac}`,
      `${ts}.${nonce}.`,
    ]) {
      assert.equal(verifyStreamToken(SECRET, bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("SCRUM-587: withoutOwnerAccess", () => {
  const ownerRecord = () => ({
    id: "p1",
    organization_id: "org-1",
    ai_enabled: true,
    organizations: {
      name: "Copperline",
      country: "AU",
      recording_consent_mode: "auto",
      owner_access: { phone_e164: "+61400000001", pin_hash: "ab".repeat(32), pin_salt: "cd".repeat(16), pin_length: 4, enabled: true },
    },
  });

  it("drops organizations.owner_access and keeps every other field", () => {
    const record = ownerRecord();
    const stripped = withoutOwnerAccess(record);
    assert.equal(Object.hasOwn(stripped.organizations, "owner_access"), false);
    const { owner_access: _drop, ...orgRest } = ownerRecord().organizations;
    const { organizations: _org, ...topRest } = ownerRecord();
    assert.deepEqual(stripped.organizations, orgRest);
    assert.deepEqual({ ...stripped, organizations: undefined }, { ...topRest, organizations: undefined });
    assert.doesNotMatch(JSON.stringify(stripped), /pin_hash|pin_salt|abab|cdcd/);
  });

  it("never mutates its input (the /twiml handler still reads the original)", () => {
    const record = ownerRecord();
    const org = record.organizations;
    const stripped = withoutOwnerAccess(record);
    assert.deepEqual(record, ownerRecord(), "input unchanged");
    assert.equal(record.organizations, org, "input's organizations object not replaced");
    assert.notEqual(stripped, record);
    assert.notEqual(stripped.organizations, org);
  });

  it("strips the key even when the embed came back null or as an array", () => {
    for (const value of [null, [], [ownerRecord().organizations.owner_access]]) {
      const record = ownerRecord();
      record.organizations.owner_access = value;
      assert.equal(Object.hasOwn(withoutOwnerAccess(record).organizations, "owner_access"), false);
    }
  });

  it("returns the SAME record when there is nothing to strip (a flag-off record is stored exactly as before)", () => {
    const record = ownerRecord();
    delete record.organizations.owner_access;
    assert.equal(withoutOwnerAccess(record), record);
    const noOrg = { id: "p2", organization_id: "org-2" };
    assert.equal(withoutOwnerAccess(noOrg), noOrg);
    const nullOrg = { id: "p3", organizations: null };
    assert.equal(withoutOwnerAccess(nullOrg), nullOrg);
  });

  it("passes null and undefined through (lookup miss, transfer-reconnect tokens)", () => {
    assert.equal(withoutOwnerAccess(null), null);
    assert.equal(withoutOwnerAccess(undefined), undefined);
  });
});
