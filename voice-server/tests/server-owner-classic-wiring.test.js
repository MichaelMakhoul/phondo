"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// SCRUM-618: OWNER_PIPELINE=classic carries the owner assistant on Claude. The bubble's
// classic turn is run for real in server-owner-web-wiring.test.js; these pin the rest of
// the wiring — the phone line's classic owner turn (dormant behind its flags, fixed alike),
// the owner's settings at both session starts, English recognition, and the boot checks.

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const slice = (from, to) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `marker not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `end marker not found: ${to}`);
  return src.slice(a, b);
};
const phoneTurn = slice("async function handleUserSpeech(", "async function hangUpAfterEndCall(");
const phoneCatch = phoneTurn.slice(phoneTurn.lastIndexOf("  } catch (err) {"));

describe("the phone line's classic owner turn (SCRUM-618)", () => {
  it("the turn's last owner tool and its filler are declared before the try, so the catch can reach them", () => {
    const tryAt = phoneTurn.indexOf("\n  try {");
    assert.ok(phoneTurn.indexOf("let lastOwnerTool = null;") < tryAt);
    assert.ok(phoneTurn.indexOf("let turnFiller = null;") < tryAt);
    assert.equal((phoneTurn.match(/let lastOwnerTool = null;/g) || []).length, 1, "one declaration — not shadowed inside the try");
    assert.match(phoneTurn, /\}, 1500\);\n\s*turnFiller = fillerTimer;/);
  });

  it("a failed turn first clears 'One moment.' — it would cut the apology off and play into silence", () => {
    assert.match(phoneCatch, /^ {2}\} catch \(err\) \{\n\s*if \(turnFiller\) clearTimeout\(turnFiller\);/);
  });

  it("the second failed owner turn in a row ends the call, said as a problem and paged; an answered turn resets the streak", () => {
    assert.match(phoneCatch, /if \(session\.ownerMode && !fastTurn && \+\+session\.ownerTurnFailureStreak >= 2\) \{\n\s*session\.callFailed = true;\n\s*console\.error\(`\[ALERT:error\] \[OwnerPin\] owner call ended: \$\{session\.ownerTurnFailureStreak\} turns failed in a row/);
    // Silent lens (round 2): the tool's words first (SF5), and the hang-up outside the TTS try (a failed line still ends the call).
    assert.match(phoneCatch, /const line = lastOwnerTool \? `\$\{ownerToolLoopReply\(session, lastOwnerTool\)\} \$\{OWNER_PHONE_PROBLEM_LINE\}` : OWNER_PHONE_PROBLEM_LINE;/);
    assert.match(phoneCatch, /playedUntil \+= await sendTTS\(session, twilioWs, line, undefined, NOT_A_REPLY\);\n\s*\} catch \(ttsErr\) \{\n[^\n]*\n\s*\}\n\s*await hangUpAfterEndCall\(session, twilioWs, playedUntil, "owner-turns-failed"\); \/\/ never throws\n\s*return;/);
    assert.match(phoneTurn, /if \(session\.ownerMode\) session\.ownerTurnFailureStreak = 0; \/\/ SCRUM-618: a turn that answered ends a failure streak\n {2}\} catch \(err\) \{/);
  });

  it("after an owner tool ran, the apology is the tool's own words, never 'could you repeat that?' (SF5)", () => {
    assert.match(phoneCatch, /const apology = session\.ownerMode && lastOwnerTool \? ownerToolLoopReply\(session, lastOwnerTool\) : getErrorMsg\(callLanguage\(session\), "troubleRepeat"\);/);
  });

  it("hangUpAfterEndCall stamps the reason it's given (the end_call tool's by default)", () => {
    assert.match(src, /async function hangUpAfterEndCall\(session, twilioWs, playbackEndsAt, reason = "end_call_tool"\) \{\n[^\n]*\n[^\n]*\n\s*session\.endedReason = reason;/);
  });
});

describe("owner sessions: settings, English, and the boot checks (SCRUM-618)", () => {
  it("the owner's settings apply at both starts — the phone line once its voice is set, the bubble once owner mode is on", () => {
    assert.match(src, /session\.deepgramVoice = getDeepgramVoice\(context\.assistant\.voiceId\);\n\s*if \(session\.ownerMode\) applyOwnerSessionSettings\(session\); \/\/ SCRUM-618/);
    assert.match(src, /session\.ownerMode = true;\n\s*session\.ownerAuth = "verified";\n\s*applyOwnerSessionSettings\(session\); \/\/ SCRUM-618/);
  });

  it("the settings: the whole conversation in context, and an English voice whatever the receptionist's", () => {
    const fn = slice("function applyOwnerSessionSettings(session) {", "\n}\n");
    const apply = new Function("FAST_MAX_MESSAGES", "ENGLISH_FALLBACK_VOICE", `${fn}\n}\nreturn applyOwnerSessionSettings;`)(201, "aura-2-theia-en");
    const es = { deepgramVoice: "aura-2-selena-es", maxMessages: 21, language: "es" };
    apply(es);
    assert.deepEqual(es, { deepgramVoice: "aura-2-theia-en", maxMessages: 201, language: "en" });
    const en = { deepgramVoice: "aura-2-thalia-en", maxMessages: 21, language: "en" };
    apply(en);
    assert.deepEqual(en, { deepgramVoice: "aura-2-thalia-en", maxMessages: 201, language: "en" });
  });

  it("speech recognition is English for owners on both classic paths, the receptionist's language otherwise", () => {
    assert.equal((src.match(/language: session\??\.ownerMode \? "en" : session\.language, \/\/ SCRUM-618/g) || []).length, 2);
  });

  it("boot: classic's Claude needs the gateway's key, and the owner pipeline is logged (a fallback pages there)", () => {
    // Code + silent lenses (round 2): never a boot requirement — a gateway typo would crash-loop every line. Paged instead.
    assert.match(src, /const llmKeyEnv = LLM_PROVIDER === "anthropic" \? null : LLM_KEY_MAP\[LLM_PROVIDER\] \|\| "ANTHROPIC_API_KEY";\nconst REQUIRED_ENV = \[\n\s*"DEEPGRAM_API_KEY",\n\s*\.\.\.\(llmKeyEnv \? \[llmKeyEnv\] : \[\]\),/);
    assert.match(src, /const classicClaudeProblem = LLM_PROVIDER === "anthropic" \? gatewayProblem\(\) : null;\n\s*if \(classicClaudeProblem\) console\.error\(`\[ALERT:error\] \[Boot\] the classic pipeline's Claude can't run: \$\{classicClaudeProblem\}`\);/);
    assert.match(src, /const ownerPipelineAtBoot = resolveOwnerPipeline\(\);\n\s*console\.log\(`Owner pipeline: \$\{ownerPipelineAtBoot\}/);
  });

  it("the bubble's classic recognition offers each transcript to the barge-in check before a final starts a turn", () => {
    const stt = slice('language: session?.ownerMode ? "en" : session.language', "onUtteranceEnd:");
    assert.ok(stt.indexOf("ownerWebBargeIn(session, ws, transcript)") < stt.indexOf("if (!isFinal) return;"));
  });
});
