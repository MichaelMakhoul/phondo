// voice-server/tests/server-owner-pin-signature.test.js
"use strict";
// SCRUM-587 — /twiml/owner-pin is the first Twilio action URL in this server that carries a
// query string (?attempt=N, the per-call try counter), and server-owner-pin-wiring.test.js
// stubs validateTwilioSignature. This runs the REAL validator from server.js on exactly that
// URL shape: by hand (HMAC-SHA1 over PUBLIC_URL + originalUrl + the sorted params), and
// cross-checked against the `twilio` SDK's own signer.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const twilio = require("twilio");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const start = src.indexOf("function validateTwilioSignature(req) {");
const end = src.indexOf("const pendingTokens = new Map();", start);
assert.ok(start > 0 && end > start, "server.js markers moved");
const PUBLIC_URL = "https://voice.example";
const WS_SECRET = "test-twilio-auth-token";
// Evaluates this repo's own checked-in server.js text (the idiom of server-owner-pin-wiring.test.js).
const validateTwilioSignature = new Function("PUBLIC_URL", "WS_SECRET", "crypto", `${src.slice(start, end)}\nreturn validateTwilioSignature;`)(PUBLIC_URL, WS_SECRET, crypto);

const body = { Called: "+61255550000", From: "+61400000001", CallSid: "CA1", Digits: "482615" };
/** Twilio's recipe, written out: base64 HMAC-SHA1(auth token, URL + each param name+value in name order). */
const byHand = (url, params) => crypto.createHmac("sha1", WS_SECRET)
  .update(Buffer.from(url + Object.keys(params).sort().map((k) => k + params[k]).join(""), "utf-8"))
  .digest("base64");
const signedReq = (originalUrl, signature, params = body) => ({ headers: { "x-twilio-signature": signature }, originalUrl, body: params });
const req = (originalUrl, signedUrl, params = body) => signedReq(originalUrl, twilio.getExpectedTwilioSignature(WS_SECRET, signedUrl, params), params);

describe("SCRUM-587: the real validateTwilioSignature on the owner-PIN action URL", () => {
  it("by hand: a signature over PUBLIC_URL + '/twiml/owner-pin?attempt=2' + the sorted params verifies; the same signature on the query-less URL does not", () => {
    const signature = byHand(`${PUBLIC_URL}/twiml/owner-pin?attempt=2`, body);
    assert.equal(validateTwilioSignature(signedReq("/twiml/owner-pin?attempt=2", signature)), true);
    assert.equal(validateTwilioSignature(signedReq("/twiml/owner-pin", signature)), false, "the query string is part of what is signed");
    assert.equal(validateTwilioSignature(signedReq("/twiml/owner-pin?attempt=2", byHand(`${PUBLIC_URL}/twiml/owner-pin`, body))), false, "signed without the query");
  });
  it("matches the twilio SDK's signer for /twiml/owner-pin?attempt=N (query string included)", () => {
    for (const n of [1, 2, 3]) {
      assert.equal(twilio.getExpectedTwilioSignature(WS_SECRET, `${PUBLIC_URL}/twiml/owner-pin?attempt=${n}`, body), byHand(`${PUBLIC_URL}/twiml/owner-pin?attempt=${n}`, body), `recipe parity, attempt=${n}`);
      assert.equal(validateTwilioSignature(req(`/twiml/owner-pin?attempt=${n}`, `${PUBLIC_URL}/twiml/owner-pin?attempt=${n}`)), true, `attempt=${n}`);
    }
  });
  it("rejects a replay with a different attempt counter, an altered body, a bare-path signature or no signature at all", () => {
    assert.equal(validateTwilioSignature(req("/twiml/owner-pin?attempt=1", `${PUBLIC_URL}/twiml/owner-pin?attempt=2`)), false, "attempt rewritten");
    assert.equal(validateTwilioSignature({ ...req("/twiml/owner-pin?attempt=2", `${PUBLIC_URL}/twiml/owner-pin?attempt=2`), body: { ...body, Digits: "000000" } }), false, "Digits rewritten");
    assert.equal(validateTwilioSignature(req("/twiml/owner-pin?attempt=2", `${PUBLIC_URL}/twiml/owner-pin`)), false, "signed without the query");
    assert.equal(validateTwilioSignature({ headers: {}, originalUrl: "/twiml/owner-pin?attempt=1", body }), false, "no signature header");
  });
});
