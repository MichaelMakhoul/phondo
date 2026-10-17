const { test } = require("node:test");
const assert = require("node:assert/strict");

// Hermetic: the module reads DEMO_MAX_CALL_MINUTES when it loads, so a developer's
// own setting must not reach the "3 minutes" tests below.
delete process.env.DEMO_MAX_CALL_MINUTES;

const {
  DEMO_ORG_ID,
  MAX_TEST_CALL_DURATION_MS,
  MAX_DEMO_CALL_DURATION_MS,
  getMaxSessionDurationMs,
  demoCallMinutes,
} = require("../lib/session-limits");

// SCRUM-363: the public demo gets a tighter session cap than authed test calls.

test("demo org gets the tighter demo cap (3 min)", () => {
  assert.equal(getMaxSessionDurationMs(DEMO_ORG_ID), MAX_DEMO_CALL_DURATION_MS);
  assert.equal(MAX_DEMO_CALL_DURATION_MS, 3 * 60 * 1000);
});

test("a normal (authenticated) org gets the standard test cap (5 min)", () => {
  assert.equal(getMaxSessionDurationMs("11111111-1111-4111-8111-111111111111"), MAX_TEST_CALL_DURATION_MS);
  assert.equal(MAX_TEST_CALL_DURATION_MS, 5 * 60 * 1000);
});

test("the demo cap is strictly shorter than the standard cap", () => {
  assert.ok(MAX_DEMO_CALL_DURATION_MS < MAX_TEST_CALL_DURATION_MS);
});

test("null/undefined org falls back to the standard (non-demo) cap", () => {
  assert.equal(getMaxSessionDurationMs(null), MAX_TEST_CALL_DURATION_MS);
  assert.equal(getMaxSessionDurationMs(undefined), MAX_TEST_CALL_DURATION_MS);
});

test("DEMO_MAX_CALL_MINUTES: unset or blank keeps 3 minutes", () => {
  assert.equal(demoCallMinutes(undefined), 3);
  assert.equal(demoCallMinutes("  "), 3);
});

test("DEMO_MAX_CALL_MINUTES: a whole number from 1 to 15 is used", () => {
  assert.equal(demoCallMinutes("8"), 8);
  assert.equal(demoCallMinutes(" 15 "), 15);
  assert.equal(demoCallMinutes("1"), 1);
});

test("DEMO_MAX_CALL_MINUTES: a bad value warns and keeps 3 minutes", () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    for (const bad of ["0", "16", "7.5", "ten", "-3", "[60]"]) assert.equal(demoCallMinutes(bad), 3, bad);
  } finally {
    console.warn = orig;
  }
  assert.equal(warned.length, 6);
  assert.match(warned[0], /^\[DemoLine\] DEMO_MAX_CALL_MINUTES "0" is not a whole number from 1 to 15 — using 3 min$/);
  assert.ok(!warned[5].includes("[60]"));
});

test("DEMO_MAX_CALL_MINUTES is read when the module loads (the Fly secret sets it; a restart applies it)", () => {
  const modulePath = require.resolve("../lib/session-limits");
  const previous = process.env.DEMO_MAX_CALL_MINUTES;
  try {
    process.env.DEMO_MAX_CALL_MINUTES = "8";
    delete require.cache[modulePath];
    const fresh = require("../lib/session-limits");
    assert.equal(fresh.MAX_DEMO_CALL_DURATION_MS, 8 * 60 * 1000);
    assert.equal(fresh.getMaxSessionDurationMs(fresh.DEMO_ORG_ID), 8 * 60 * 1000);
  } finally {
    if (previous === undefined) delete process.env.DEMO_MAX_CALL_MINUTES;
    else process.env.DEMO_MAX_CALL_MINUTES = previous;
    delete require.cache[modulePath];
  }
});
