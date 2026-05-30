const { test } = require("node:test");
const assert = require("node:assert/strict");
const { timingSafeEqualStr } = require("../lib/timing-safe");

// SCRUM-355: constant-time secret comparison that never throws.

test("equal strings compare true", () => {
  assert.equal(timingSafeEqualStr("s3cr3t-value", "s3cr3t-value"), true);
});

test("different same-length strings compare false", () => {
  assert.equal(timingSafeEqualStr("aaaaaa", "bbbbbb"), false);
});

test("different-length strings compare false (no throw)", () => {
  assert.equal(timingSafeEqualStr("short", "a-much-longer-secret"), false);
});

test("empty / null / undefined / non-string never match", () => {
  assert.equal(timingSafeEqualStr("", ""), false);
  assert.equal(timingSafeEqualStr("x", ""), false);
  assert.equal(timingSafeEqualStr(undefined, "x"), false);
  assert.equal(timingSafeEqualStr("x", undefined), false);
  assert.equal(timingSafeEqualStr(null, null), false);
  assert.equal(timingSafeEqualStr(123, 123), false);
});

test("a missing header (undefined) vs a real secret is false, never throws", () => {
  assert.doesNotThrow(() => timingSafeEqualStr(undefined, "INTERNAL_API_SECRET_value"));
  assert.equal(timingSafeEqualStr(undefined, "INTERNAL_API_SECRET_value"), false);
});
