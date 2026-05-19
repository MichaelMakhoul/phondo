// SCRUM-294 regression test.
//
// A real customer test on 2026-05-19 found the AI argued with a caller who
// said "Can you transfer me to a human?" — instead of calling transfer_call,
// the AI said "I can help with most things... is there something specific you
// need, or would you still prefer to speak with a person?" The caller hung
// up. We lose the lead, we lose trust.
//
// The fix added imperative language to both the classic OpenAI prompt
// (voice-server/lib/prompt-builder.js) and the Gemini Live system prompt
// (voice-server/server.js). This test pins that wording so it can't regress
// silently.

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

// Each file must contain the imperative "MUST" wording — exact substring
// guarantees the model can't be told "use it when caller asks" (the
// previous, too-soft phrasing that the LLM rationalised away).
const MUST_OBEY_FRAGMENT = "TRANSFERS — MUST OBEY";

// Verbs the AI must NOT use to push back on a transfer request, anywhere
// near the transfer rule (we don't want it to argue or redirect).
// The MUST-OBEY blocks themselves quote these phrases as "do NOT say X" so
// we strip those blocks before scanning — otherwise the test trips on its
// own guardrail wording. Same pattern as SCRUM-282's guard-strip approach.
//
// `keep the refusal` is a SCRUM-294 follow-up addition: the legacy
// buildSystemPrompt path used to say "keep the refusal SHORT" before this
// PR, which directly told the model to refuse rather than transfer. The
// pattern stays in this list permanently so the wording can never come
// back via a copy-paste from an old prompt template.
const FORBIDDEN_NEAR_TRANSFER = [
  /would you still prefer to speak/i,
  /can I help (?:you )?(?:with )?(?:that|something)/i,
  /keep the refusal/i,
  /preemptive(?:ly)? refus/i,
];

function stripMustObeyBlocks(src) {
  // Remove lines that contain the TRANSFERS — MUST OBEY block specifically,
  // plus any block-comment lines that explain past bad behaviour — those
  // legitimately quote the forbidden phrasings to instruct the model what
  // NOT to say. We anchor on "TRANSFERS — MUST OBEY" rather than the
  // generic "MUST OBEY" so future emphatic rules in other domains (e.g.
  // "BOOKING — MUST OBEY") don't accidentally get stripped along with them.
  return src
    .split("\n")
    .filter((line) => !/TRANSFERS — MUST OBEY|arguing back|SCRUM-294/i.test(line))
    .join("\n");
}

// Variants of transfer requests the prompts SHOULD recognise. The prompts
// don't have to enumerate every variant verbatim, but several should appear
// near "MUST OBEY" so the model sees concrete examples.
const REQUIRED_INTENT_EXAMPLES = [
  /speak to a human/i,
  /transfer me/i,
  /talk to (?:someone|a person)/i,
];

describe("SCRUM-294 — AI must honour explicit transfer requests", () => {
  test("voice-server/lib/prompt-builder.js: contains MUST-OBEY transfer block", () => {
    assert.ok(
      promptBuilderSrc.includes(MUST_OBEY_FRAGMENT),
      `prompt-builder.js missing "${MUST_OBEY_FRAGMENT}" — the imperative transfer instruction was removed or weakened`
    );
  });

  test("voice-server/lib/prompt-builder.js: enumerates common intent variants", () => {
    // Find the MUST OBEY block and check it includes example phrasings.
    const idx = promptBuilderSrc.indexOf(MUST_OBEY_FRAGMENT);
    assert.ok(idx >= 0, "MUST OBEY block not found");
    const block = promptBuilderSrc.slice(idx, idx + 2000);
    for (const re of REQUIRED_INTENT_EXAMPLES) {
      assert.ok(
        re.test(block),
        `prompt-builder.js MUST OBEY block missing intent example matching ${re}`
      );
    }
  });

  test("voice-server/server.js: Gemini Live prompt contains MUST-OBEY transfer block", () => {
    // The Gemini Live prompt is built dynamically — assert the string literal
    // is in the source. (At least one occurrence; there are two prompt-build
    // sites — both should have it.)
    const occurrences = serverSrc.split(MUST_OBEY_FRAGMENT).length - 1;
    assert.ok(
      occurrences >= 2,
      `server.js: expected MUST-OBEY transfer block in BOTH Gemini Live prompt sites (got ${occurrences})`
    );
  });

  test("voice-server/server.js: Gemini Live prompt enumerates intent variants", () => {
    const idx = serverSrc.indexOf(MUST_OBEY_FRAGMENT);
    assert.ok(idx >= 0);
    const block = serverSrc.slice(idx, idx + 2000);
    for (const re of REQUIRED_INTENT_EXAMPLES) {
      assert.ok(
        re.test(block),
        `server.js MUST OBEY block missing intent example matching ${re}`
      );
    }
  });

  test("voice-server/lib/prompt-builder.js: no soft-deflection wording outside MUST-OBEY block", () => {
    // The previous prompt said "Use it when a caller requests..." which the
    // LLM treated as suggestive rather than mandatory. The new prompt must
    // not contain any phrase that could be interpreted as "first try to
    // handle it yourself." Strip the MUST-OBEY block before scanning so we
    // don't trip on the explicit "Do NOT say X" instructions inside it.
    const stripped = stripMustObeyBlocks(promptBuilderSrc);
    for (const re of FORBIDDEN_NEAR_TRANSFER) {
      assert.equal(
        stripped.match(re),
        null,
        `prompt-builder.js contains forbidden soft-deflection wording matching ${re}`
      );
    }
  });

  test("voice-server/server.js: no soft-deflection wording outside Gemini Live MUST-OBEY block", () => {
    const stripped = stripMustObeyBlocks(serverSrc);
    for (const re of FORBIDDEN_NEAR_TRANSFER) {
      assert.equal(
        stripped.match(re),
        null,
        `server.js contains forbidden soft-deflection wording matching ${re}`
      );
    }
  });
});
