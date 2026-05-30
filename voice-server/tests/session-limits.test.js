const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DEMO_ORG_ID,
  MAX_TEST_CALL_DURATION_MS,
  MAX_DEMO_CALL_DURATION_MS,
  getMaxSessionDurationMs,
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
