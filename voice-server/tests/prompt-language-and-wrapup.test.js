// SCRUM-368 regression test.
//
// A real Arabic test call surfaced two prompt-level defects:
//  (D) the AI spoke English canned phrases ("let me connect you") mid-Arabic
//      call, because the prompt baked in English-quoted filler/closing examples
//      and fed English tool-result strings back to the model.
//  (wrap-up) the AI ended the call cordially with NO booking, because nothing
//      forbade ending after an abandoned booking (SCRUM-227 only blocks false
//      success claims).
//
// These fixes are prompt wording, so we pin them here against silent regression.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const promptBuilderSrc = fs.readFileSync(path.join(__dirname, "../lib/prompt-builder.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");

describe("SCRUM-368 — stay in the caller's language + don't end on an incomplete booking", () => {
  test("prompt-builder.js: LANGUAGE rule mandates ALL utterances in the caller's language", () => {
    assert.ok(promptBuilderSrc.includes("LANGUAGE — ABSOLUTE RULE"), "LANGUAGE — ABSOLUTE RULE fragment missing");
    assert.ok(/EVERY utterance must be in the caller's language/i.test(promptBuilderSrc), "all-utterances mandate missing");
    // The model must be told to translate English tool-result messages, not parrot them.
    assert.ok(/TRANSLATE it into the caller's language/i.test(promptBuilderSrc), "tool-result translation directive missing");
  });

  test("prompt-builder.js: incomplete-booking wrap-up rule present", () => {
    assert.ok(promptBuilderSrc.includes("INCOMPLETE BOOKING — NEVER END AS IF DONE"), "incomplete-booking wrap-up rule missing");
  });

  test("server.js: Gemini prompt restates language + incomplete-booking rules (freshest instruction)", () => {
    assert.ok(serverSrc.includes("INCOMPLETE BOOKING:"), "server.js FINAL CRITICAL RULE missing incomplete-booking restatement");
    // Both Gemini prompt sites (inbound + demo/test) carry a language guardrail.
    const langOccurrences = (serverSrc.match(/conduct the ENTIRE call in the caller's language/gi) || []).length;
    assert.ok(langOccurrences >= 2, `expected the language guardrail in both Gemini sites (got ${langOccurrences})`);
  });

  test("no bare English filler example survives without an 'in the caller's language' qualifier", () => {
    // The known parroted phrases must always be presented as samples to
    // translate, never as the literal phrase to speak. Each occurrence of the
    // canonical filler must sit on a line that also says "caller's language".
    for (const src of [promptBuilderSrc, serverSrc]) {
      for (const line of src.split("\n")) {
        // Exclude the localized FILLER_MESSAGES/ERROR_MESSAGES data maps (used by
        // the classic TTS pipeline) — object-literal entries like `booking: "..."`
        // whose English values are legitimate per-language strings.
        if (/^\s*[a-zA-Z_]+:\s*["'`]/.test(line)) continue;
        // Skip lines that quote the phrase as something NOT to say (guard wording).
        if (/ESCAPE HATCH|never say|do NOT say|Forbidden phrasings/i.test(line)) continue;
        // Filler-only phrases (not success-claim phrases like "you're all set",
        // which legitimately appear in anti-hallucination guard lists).
        if (/let me connect you|let me book that for you|let me do that for you|let me check that/i.test(line)) {
          assert.ok(
            /caller's language/i.test(line),
            `English filler example not marked as caller's-language sample: ${line.trim().slice(0, 120)}`
          );
        }
      }
    }
  });
});
