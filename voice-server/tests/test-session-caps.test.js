const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getTestClientIp, createTestSessionCaps } = require("../lib/test-session-caps");

// ── getTestClientIp ──────────────────────────────────────────────────────────

test("getTestClientIp prefers Fly-Client-IP (authoritative)", () => {
  const req = {
    headers: { "fly-client-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    socket: { remoteAddress: "10.0.0.1" },
  };
  assert.equal(getTestClientIp(req), "203.0.113.7");
});

test("getTestClientIp falls back to last XFF hop when Fly header absent", () => {
  const req = { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, socket: {} };
  assert.equal(getTestClientIp(req), "5.6.7.8");
});

test("getTestClientIp falls back to socket then 'unknown'", () => {
  assert.equal(getTestClientIp({ headers: {}, socket: { remoteAddress: "9.9.9.9" } }), "9.9.9.9");
  assert.equal(getTestClientIp({ headers: {} }), "unknown");
});

// ── createTestSessionCaps ────────────────────────────────────────────────────

test("single-use: a second reserve with the same jti is rejected", () => {
  const caps = createTestSessionCaps({ maxGlobal: 50, maxPerIp: 3 });
  assert.deepEqual(caps.tryReserve("jti-A", "ip1"), { ok: true, reason: null });
  assert.deepEqual(caps.tryReserve("jti-A", "ip2"), { ok: false, reason: "jti-reuse" });
});

test("per-IP cap: 4th concurrent session from one IP is rejected", () => {
  const caps = createTestSessionCaps({ maxGlobal: 50, maxPerIp: 3 });
  assert.ok(caps.tryReserve("j1", "ip1").ok);
  assert.ok(caps.tryReserve("j2", "ip1").ok);
  assert.ok(caps.tryReserve("j3", "ip1").ok);
  assert.deepEqual(caps.tryReserve("j4", "ip1"), { ok: false, reason: "per-ip" });
  // A different IP is unaffected.
  assert.ok(caps.tryReserve("j5", "ip2").ok);
});

test("global cap: rejected once the global ceiling is hit, across IPs", () => {
  const caps = createTestSessionCaps({ maxGlobal: 2, maxPerIp: 5 });
  assert.ok(caps.tryReserve("j1", "ipA").ok);
  assert.ok(caps.tryReserve("j2", "ipB").ok);
  assert.deepEqual(caps.tryReserve("j3", "ipC"), { ok: false, reason: "global" });
});

test("release frees the slot for the same jti and IP", () => {
  const caps = createTestSessionCaps({ maxGlobal: 50, maxPerIp: 1 });
  assert.ok(caps.tryReserve("j1", "ip1").ok);
  assert.deepEqual(caps.tryReserve("j2", "ip1"), { ok: false, reason: "per-ip" });
  caps.release("j1", "ip1");
  assert.deepEqual(caps.stats(), { global: 0, ips: 0, jtis: 0 });
  // jti is reusable only after release (single-use is concurrency, not lifetime)
  assert.ok(caps.tryReserve("j1", "ip1").ok);
});

test("per-IP map key is deleted at zero (no leak of empty buckets)", () => {
  const caps = createTestSessionCaps({ maxGlobal: 50, maxPerIp: 3 });
  caps.tryReserve("j1", "ip1");
  caps.release("j1", "ip1");
  assert.equal(caps.stats().ips, 0);
});

test("global count floors at 0 on an over-release", () => {
  const caps = createTestSessionCaps({ maxGlobal: 50, maxPerIp: 3 });
  caps.tryReserve("j1", "ip1");
  caps.release("j1", "ip1");
  caps.release("j1", "ip1"); // stray double release (caller normally guards)
  assert.equal(caps.stats().global, 0);
});

test("backward-compat: a token without a jti is bounded only by IP/global caps", () => {
  const caps = createTestSessionCaps({ maxGlobal: 50, maxPerIp: 2 });
  // No jti → single-use check is skipped; multiple no-jti reserves allowed up to per-IP.
  assert.ok(caps.tryReserve(undefined, "ip1").ok);
  assert.ok(caps.tryReserve(undefined, "ip1").ok);
  assert.deepEqual(caps.tryReserve(undefined, "ip1"), { ok: false, reason: "per-ip" });
});
