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

  test("SCRUM-375: per-call LANGUAGE LOCK + take-a-message fail-safe is wired into BOTH Gemini sites", () => {
    assert.ok(serverSrc.includes("buildLanguageLockDirective"), "buildLanguageLockDirective helper missing");
    // wired at both prompt-build sites (inbound + demo/test)
    const wired = (serverSrc.match(/geminiSystemPrompt \+= buildLanguageLockDirective\(session\.language\)/g) || []).length;
    assert.ok(wired >= 2, `expected the language lock wired at both Gemini sites (got ${wired})`);
    // the directive forbids drifting to an unused language and takes a message instead of guessing
    assert.ok(/do NOT assume an unrelated language/i.test(serverSrc), "spurious-language guard text missing");
    assert.ok(/schedule_callback to take their name/i.test(serverSrc), "take-a-message fail-safe text missing");
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

// SCRUM-547 regression test.
//
// A real call from a train: Gemini transcribed the caller's noise-garbled
// English first turn as ONE Russian word and the AI conducted the call in
// Russian, never recovering while the caller kept speaking English. A retry
// call captured the train announcement "Next stop is Seoul" as caller speech.
// Two prompt defects made a wrong first-turn detection permanent:
//  (a) "auto-detect from their first turn and conduct the ENTIRE call in that
//      language" (prompt-builder) locked whatever turn 1 sounded like, and
//  (b) the SCRUM-375 LANGUAGE LOCK said "stay in it for the WHOLE call",
//      blocking recovery once the guess was wrong.
// The fix gates switching on full-sentence directed evidence and mandates
// switching back when the caller clearly speaks a served language.
describe("SCRUM-547 — language switching is evidence-gated and always recoverable", () => {
  test("prompt-builder.js: switching requires full-sentence evidence, never fragments", () => {
    assert.ok(/FULL, clearly intelligible sentence/.test(promptBuilderSrc), "full-sentence evidence bar missing from prompt-builder");
    assert.ok(/NEVER change language because of one word/i.test(promptBuilderSrc), "single-word/fragment guard missing from prompt-builder");
  });

  test("prompt-builder.js: background voices are explicitly not the caller", () => {
    assert.ok(/are NOT the caller/i.test(promptBuilderSrc), "background-voice guard missing from prompt-builder");
  });

  test("prompt-builder.js: a wrong language guess is recoverable (no first-turn lock-in)", () => {
    assert.ok(/RECOVERY:/.test(promptBuilderSrc), "recovery rule missing from prompt-builder");
    assert.ok(
      !/Auto-detect the caller's language from their first turn and conduct the ENTIRE call/i.test(promptBuilderSrc),
      "sticky first-turn auto-detect wording is back — it locked a train caller into Russian (SCRUM-547)"
    );
  });

  test("server.js: LANGUAGE LOCK gates switching on evidence and mandates switch-back", () => {
    assert.ok(/A single word or fragment is NEVER enough evidence/i.test(serverSrc), "single-word evidence guard missing from LANGUAGE LOCK");
    assert.ok(/RECOVERY IS MANDATORY/.test(serverSrc), "mandatory switch-back missing from LANGUAGE LOCK");
    assert.ok(
      !/first clear turn and stay in it for the WHOLE call/i.test(serverSrc),
      "'stay in it for the WHOLE call' is back in the LANGUAGE LOCK — it blocked recovery from a wrong first-turn detection (SCRUM-547)"
    );
  });
});

// SCRUM-554 regression test.
//
// Real calls (train 2026-07-15, speakerphone demo 2026-07-16): Gemini's VAD at
// START_SENSITIVITY_HIGH opened "caller turns" on train announcements and
// background voices (transcribed as German/Japanese/Spanish on an English
// call) and interrupted the AI mid-sentence; a garbled Arabic language request
// never cleared the SCRUM-547 evidence bar, so the AI transferred instead of
// switching; and the legacy buildSystemPrompt path still carried the
// pre-SCRUM-547 "auto-detect from the first turn ... throughout the call"
// wording in two places. Pin all three fixes.
describe("SCRUM-554 — noise robustness: VAD onset, noisy-line protocol, language-request confirm", () => {
  const geminiSrc = fs.readFileSync(path.join(__dirname, "../services/gemini-live.js"), "utf8");

  test("gemini-live.js: VAD onset is LOW with prefix padding (background audio must not open turns)", () => {
    assert.ok(/startOfSpeechSensitivity:\s*"START_SENSITIVITY_LOW"/.test(geminiSrc), "onset sensitivity is not LOW");
    assert.ok(
      !/START_SENSITIVITY_HIGH/.test(geminiSrc),
      "START_SENSITIVITY_HIGH is back — train announcements and background voices will open caller turns and interrupt the AI (SCRUM-554)"
    );
    assert.ok(/prefixPaddingMs:\s*\d+/.test(geminiSrc), "prefixPaddingMs missing — short noise bursts commit a start of speech");
    // Quiet callers still need their turn ENDS protected (SCRUM-375).
    assert.ok(/endOfSpeechSensitivity:\s*"END_SENSITIVITY_LOW"/.test(geminiSrc), "end-of-speech sensitivity regressed from LOW");
  });

  test("prompt-builder.js: NOISY LINE PROTOCOL in BOTH prompt paths (structured + legacy)", () => {
    const occurrences = (promptBuilderSrc.match(/NOISY LINE PROTOCOL/g) || []).length;
    assert.ok(occurrences >= 2, `expected the noisy-line protocol in both prompt paths (got ${occurrences})`);
    assert.ok(/Respond ONLY to the primary caller/i.test(promptBuilderSrc), "primary-caller focus missing");
    assert.ok(/CONFIRM your interpretation before acting/i.test(promptBuilderSrc), "confirm-before-acting missing");
    assert.ok(/never book, cancel, or change anything from an unconfirmed guess/i.test(promptBuilderSrc), "unconfirmed-guess prohibition missing");
  });

  test("garbled-turn escalation: one re-ask, then a guided menu instead of an endless 'say again?' loop", () => {
    assert.ok(/go GUIDED|GUIDED MODE|offer the short menu/i.test(promptBuilderSrc), "guided-menu escalation missing");
  });

  test("language-request confirm fast path present in prompt-builder AND server LANGUAGE LOCK", () => {
    for (const [name, src] of [["prompt-builder.js", promptBuilderSrc], ["server.js", serverSrc]]) {
      assert.ok(
        /تحب تكمل بالعربي/.test(src),
        `${name}: bilingual language-confirm sample missing — a garbled 'can we speak Arabic' must trigger a confirm, not a transfer (SCRUM-554)`
      );
    }
    assert.ok(/yes in either language is full evidence/i.test(serverSrc), "yes-in-either-language evidence rule missing from LANGUAGE LOCK");
  });

  test("legacy buildSystemPrompt path: pre-547 sticky auto-detect wording is gone", () => {
    assert.ok(
      !/from their first turn and respond in the same language throughout/i.test(promptBuilderSrc),
      "legacy path still auto-detects language from the first turn and keeps it for the whole call (SCRUM-554)"
    );
    assert.ok(
      !/Auto-detect the caller's language/i.test(promptBuilderSrc),
      "an 'Auto-detect the caller's language' directive survives somewhere in prompt-builder (SCRUM-554)"
    );
  });
});

// SCRUM-508 regression test.
//
// A real lookup call ended prematurely: the AI asked "Is there anything else I
// can help you with?", the caller said "Yes" (meaning: yes, I need more), and
// the model read it as a goodbye cue and called end_call. Pin the prompt rule
// that a "yes"/"ok" to "anything else?" means CONTINUE, not hang up.
describe("SCRUM-508 — don't hang up on an affirmative reply to 'anything else?'", () => {
  test("prompt-builder.js: 'anything else?' is-not-a-goodbye rule present", () => {
    assert.ok(/IS NOT A GOODBYE/.test(promptBuilderSrc), "anything-else is-not-a-goodbye rule missing from prompt-builder");
    assert.ok(/never a cue to hang up/i.test(promptBuilderSrc), "never-end-on-yes wording missing from prompt-builder");
  });

  test("server.js: FINAL CRITICAL RULE restates don't-hang-up-on-yes for Gemini (freshest instruction)", () => {
    assert.ok(/DON'T HANG UP ON/i.test(serverSrc), "don't-hang-up-on-yes restatement missing from server.js FINAL CRITICAL RULE");
    // It must sit inside the inbound FINAL CRITICAL RULE block, after the greeting.
    assert.ok(serverSrc.includes('right after asking'), "'anything else?' qualifier missing from server.js restatement");
  });
});
