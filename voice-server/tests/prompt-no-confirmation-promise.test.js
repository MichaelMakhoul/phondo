// SCRUM-282 regression test.
//
// Pre-launch, SMS is disabled (gated on ABN) and caller-side email is not
// built. The AI must NOT promise callers a confirmation text/email/message
// because none is ever delivered — promising and not delivering erodes
// trust and is borderline misleading conduct under the Spam Act 2003.
//
// This file asserts the promise wording is absent from every prompt path
// (classic OpenAI via prompt-builder.js AND Gemini Live via server.js) and
// that the explicit guard sentence is present. If anyone re-adds the
// promise wording, these tests fail loudly.
//
// When SMS / caller-email is wired in future, the promise should come back
// CONDITIONALLY (driven by an org flag passed into the prompt builder) and
// these tests should be updated to reflect the conditional path.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const promptBuilderSrc = fs.readFileSync(
  path.join(__dirname, "../lib/prompt-builder.js"),
  "utf8"
);
const serverSrc = fs.readFileSync(
  path.join(__dirname, "../server.js"),
  "utf8"
);

// Wording variants the LLM might be TOLD to say (promise phrasing).
// Patterns are specific to instruction-to-promise phrasing — the guard
// sentence ("NEVER promise a confirmation text...") is the legitimate
// use of these words and is explicitly allowed. To avoid the test
// flagging its own guard, we strip lines containing "NEVER promise"
// before scanning.
const PROMISE_PATTERNS = [
  /you['’]ll (?:also )?receive a confirmation/i,
  /you['’]ll receive (?:a |an )?(?:text|sms|message|email)/i,
  /you will receive (?:a |an )?confirmation (?:text|sms|message|email)/i,
  /tell the caller they will receive (?:a |an )?confirmation/i,
  /expect (?:a |an )?(?:text|sms|message|email|confirmation)/i,
  /we['’]ll (?:send|text|message|email) you/i,
  /will (?:send|text|message|email) you (?:a |an )?(?:text|sms|message|email|confirmation)/i,
];

function stripGuardLines(src) {
  // Remove any line containing the "NEVER promise" guard so it doesn't
  // count as a false positive when matching forbidden promise wording.
  return src
    .split("\n")
    .filter((line) => !/NEVER promise/i.test(line))
    .join("\n");
}

// What MUST be present.
const GUARD_PATTERNS = [
  /NEVER promise a confirmation text/i,
];

describe("SCRUM-282 — AI must not promise notifications callers don't receive", () => {
  test("voice-server/lib/prompt-builder.js: no promise wording (guard-stripped)", () => {
    const stripped = stripGuardLines(promptBuilderSrc);
    for (const re of PROMISE_PATTERNS) {
      const match = stripped.match(re);
      assert.equal(
        match,
        null,
        `prompt-builder.js contains forbidden promise wording matching ${re}: "${match?.[0]}"`
      );
    }
  });

  test("voice-server/lib/prompt-builder.js: guard sentence present", () => {
    for (const re of GUARD_PATTERNS) {
      assert.ok(
        re.test(promptBuilderSrc),
        `prompt-builder.js missing required guard matching ${re}`
      );
    }
  });

  test("voice-server/server.js: Gemini Live system prompt has no promise wording (guard-stripped)", () => {
    const stripped = stripGuardLines(serverSrc);
    for (const re of PROMISE_PATTERNS) {
      const match = stripped.match(re);
      assert.equal(
        match,
        null,
        `server.js contains forbidden promise wording matching ${re}: "${match?.[0]}"`
      );
    }
  });

  test("voice-server/server.js: Gemini Live system prompt has explicit guard", () => {
    for (const re of GUARD_PATTERNS) {
      assert.ok(
        re.test(serverSrc),
        `server.js missing required guard matching ${re}`
      );
    }
  });
});
