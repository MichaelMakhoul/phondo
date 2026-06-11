"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildReturningCallerHint } = require("../lib/caller-history");

test("buildReturningCallerHint: non-returning callers get no hint", () => {
  assert.equal(buildReturningCallerHint(), "");
  assert.equal(buildReturningCallerHint({}), "");
  assert.equal(buildReturningCallerHint({ pastApptCount: 0, totalCalls: 0 }), "");
});

test("buildReturningCallerHint: returning when there is any PRIOR call or appointment", () => {
  // totalCalls is prior calls only (the current call isn't logged yet at
  // prompt-build time), so a single prior call is a returning caller.
  assert.notEqual(buildReturningCallerHint({ pastApptCount: 0, totalCalls: 1 }), "");
  assert.notEqual(buildReturningCallerHint({ pastApptCount: 1, totalCalls: 0 }), "");
  assert.notEqual(buildReturningCallerHint({ pastApptCount: 0, totalCalls: 2 }), "");
});

test("buildReturningCallerHint: discloses NO PII and tells the AI to verify (SCRUM-414)", () => {
  const hint = buildReturningCallerHint({ pastApptCount: 3, totalCalls: 5 });
  // It must instruct the AI not to volunteer identity-specific info.
  assert.match(hint, /do NOT state any name/i);
  assert.match(hint, /verify/i);
  assert.match(hint, /spoof/i);
  // Regression guard: it must NOT leak a name, counts, or appointment dates.
  assert.doesNotMatch(hint, /name on file/i);
  assert.doesNotMatch(hint, /most recent appointment/i);
  assert.doesNotMatch(hint, /\bprevious appointment/i);
  // No interpolated count values (e.g. "3 previous", "5 previous").
  assert.doesNotMatch(hint, /\d+\s+previous/i);
});
