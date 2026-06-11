"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateOutboundTarget,
  outboundSmokeTestEnabled,
  checkOutboundRateLimit,
  _resetOutboundRateLimit,
} = require("../lib/outbound-guard");

test("outboundSmokeTestEnabled is OFF unless explicitly 'true'", () => {
  delete process.env.OUTBOUND_SMOKE_TEST_ENABLED;
  assert.equal(outboundSmokeTestEnabled(), false);
  process.env.OUTBOUND_SMOKE_TEST_ENABLED = "1";
  assert.equal(outboundSmokeTestEnabled(), false, "only the exact string 'true' enables it");
  process.env.OUTBOUND_SMOKE_TEST_ENABLED = "true";
  assert.equal(outboundSmokeTestEnabled(), true);
  delete process.env.OUTBOUND_SMOKE_TEST_ENABLED;
});

test("validateOutboundTarget: fail-closed when no allowlist is configured", () => {
  delete process.env.OUTBOUND_ALLOWED_NUMBERS;
  const r = validateOutboundTarget("+61412345678");
  assert.equal(r.ok, false);
  assert.match(r.error, /not configured/);
});

test("validateOutboundTarget: rejects non-E.164 even when allowlisted-looking", () => {
  process.env.OUTBOUND_ALLOWED_NUMBERS = "+61412345678";
  try {
    assert.equal(validateOutboundTarget("0412345678").ok, false, "national format rejected");
    assert.equal(validateOutboundTarget("+1 555 0100").ok, false, "spaces rejected");
    assert.equal(validateOutboundTarget("not-a-number").ok, false);
    assert.equal(validateOutboundTarget("").ok, false);
    assert.equal(validateOutboundTarget(undefined).ok, false);
    assert.equal(validateOutboundTarget(12345).ok, false, "non-string rejected");
  } finally {
    delete process.env.OUTBOUND_ALLOWED_NUMBERS;
  }
});

test("validateOutboundTarget: only allows E.164 numbers in the allowlist", () => {
  process.env.OUTBOUND_ALLOWED_NUMBERS = " +61412345678 , +14155550100 ";
  try {
    assert.equal(validateOutboundTarget("+61412345678").ok, true, "trimmed allowlist entry matches");
    assert.equal(validateOutboundTarget("+14155550100").ok, true);
    const blocked = validateOutboundTarget("+61499999999");
    assert.equal(blocked.ok, false, "E.164 but not allowlisted");
    assert.match(blocked.error, /allowlist/);
  } finally {
    delete process.env.OUTBOUND_ALLOWED_NUMBERS;
  }
});

test("checkOutboundRateLimit: bounds calls within the rolling window", () => {
  _resetOutboundRateLimit();
  process.env.OUTBOUND_RATE_MAX = "3";
  try {
    const t0 = 1_000_000;
    assert.equal(checkOutboundRateLimit(t0).ok, true);
    assert.equal(checkOutboundRateLimit(t0 + 1).ok, true);
    assert.equal(checkOutboundRateLimit(t0 + 2).ok, true);
    assert.equal(checkOutboundRateLimit(t0 + 3).ok, false, "4th within the window is blocked");
    // Past the 60s window, the bucket frees up again.
    assert.equal(checkOutboundRateLimit(t0 + 61_000).ok, true);
  } finally {
    delete process.env.OUTBOUND_RATE_MAX;
    _resetOutboundRateLimit();
  }
});
