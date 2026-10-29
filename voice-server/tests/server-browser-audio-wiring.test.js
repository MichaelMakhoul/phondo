// SCRUM-619: the owner's bubble isn't a phone line. These run the real server.js text: the
// page asks for wideband, the bubble's classic session gets it (announced before any audio),
// every browser TTS call and the hold loop speak it, and what the bubble shows and says of a
// reply has no markdown.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BROWSER_WIDEBAND, audioFormatMessage, browserTtsOptions } = require("../lib/browser-audio");
const { generateHoldAudio } = require("../lib/hold-audio");
const { CallSession } = require("../call-session");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function sliceOf(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}

const handler = sliceOf('testWss.on("connection", (ws, req) => {', "async function handleTestUserSpeech(session, ws, transcript) {");
const classic = sliceOf("// ── Classic pipeline (Deepgram STT + OpenAI + Deepgram TTS) ──", "async function handleTestUserSpeech(session, ws, transcript) {");
const turn = sliceOf("async function handleTestUserSpeech(session, ws, transcript) {", "// Warm the Gemini Live path on boot");

describe("/ws/test: wideband only when the page asks, only for the owner's bubble (source)", () => {
  it("the page's ask is read from the socket URL, next to its token", () => {
    assert.match(
      handler,
      /const token = url\.searchParams\.get\("token"\);\s*const tokenData = verifyTestCallToken\(token\);\s*(\/\/[^\n]*\n\s*)*const pagePlaysWideband = url\.searchParams\.get\("playback"\) === BROWSER_WIDEBAND\.encoding;/
    );
  });

  it("classic: an owner session on a page that asked gets wideband from the Sydney host, announced before any audio", () => {
    const block = /if \(session\.ownerMode && pagePlaysWideband\) \{\s*session\.browserAudio = BROWSER_WIDEBAND;\s*session\.ttsHost = FAST_DEEPGRAM_HOST;\s*if \(ws\.readyState === WebSocket\.OPEN\) ws\.send\(audioFormatMessage\(BROWSER_WIDEBAND\)\);\s*console\.log\(`\[OwnerWeb\] Wideband audio: [^\n]*\(callSid=\$\{session\.callSid\}\)`\);\s*\}/;
    assert.match(classic, block);
    const at = classic.search(block);
    for (const later of ["openDeepgramStream(", "synthesizeForBrowser(session, disclosureText", "synthesizeForBrowser(session, greeting"]) {
      assert.ok(classic.indexOf(later) > at, `the format is set before ${later}`);
    }
    assert.equal((handler.match(/session\.browserAudio = /g) || []).length, 1, "nowhere else (Gemini's audio stays mulaw)");
  });

  it("every browser TTS call speaks the session's format through synthesizeForBrowser: setup, the reply, the goodbye, the loop's last words", () => {
    const helper = sliceOf("async function synthesizeForBrowser(session, text) {", "\n}\n");
    const rest = (classic + turn).replace(helper, "");
    assert.ok((rest.match(/await synthesizeForBrowser\(session, /g) || []).length >= 6);
    assert.equal((rest.match(/synthesizeSpeech\(/g) || []).length, 0, "no browser speech bypasses the session's format and host fallback");
    assert.match(helper, /const options = browserTtsOptions\(session\);[^\n]*\n\s*try \{\s*return await synthesizeSpeech\(DEEPGRAM_API_KEY, text, options\);/);
    assert.equal((helper.match(/synthesizeSpeech\(DEEPGRAM_API_KEY, text, browserTtsOptions\(session\)\)/g) || []).length, 1, "the retry, in the format the page was told");
  });

  it("the format is announced in exactly one place — the classic owner block (Gemini and customer audio stay mulaw)", () => {
    assert.equal((handler.match(/audioFormatMessage\(/g) || []).length, 1);
  });

  it("a page that couldn't play the announced format is reported once — fixed text, nothing the page sent — and the session is stored as failed", () => {
    assert.match(handler, /const pagePlaysWideband = [^\n]*\n\s*let pageReportedUnplayable = false;/);
    assert.match(
      handler,
      /\} else if \(msg\.type === "client_error" && msg\.reason === "unplayable_audio_format" && !pageReportedUnplayable\) \{\s*(\/\/[^\n]*\n\s*)*pageReportedUnplayable = true;\s*if \(session\) session\.callFailed = true;\s*console\.error\(`\[ALERT:error\] \[TestCall\] The page couldn't play the announced audio format \(callSid=\$\{session\?\.callSid\}, org=\$\{organizationId\}, owner=\$\{Boolean\(session\?\.ownerMode\)\}\)`\);\s*\}/
    );
  });

  it("the goodbye waits for its audio at the session's own rate", () => {
    assert.match(turn, /const graceMs = Math\.min\(15_000, browserAudioMs\(session, turnAudioBytes\) \+ 500\);/);
  });
});

/** The real synthesizeForBrowser over a stubbed synthesizeSpeech. */
function makeSynthesizeForBrowser(synthesizeSpeech, errors = []) {
  const code = sliceOf("async function synthesizeForBrowser(session, text) {", "\n}\n") + "\n}\n";
  const scope = {
    synthesizeSpeech,
    DEEPGRAM_API_KEY: "k",
    browserTtsOptions,
    console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) },
  };
  const params = Object.keys(scope);
  return new Function(...params, `${code}\nreturn synthesizeForBrowser;`)(...params.map((p) => scope[p]));
}

describe("/ws/test classic setup (run for real)", () => {
  /** Runs the real classic setup: the format decision, STT, disclosure, greeting. */
  async function runClassicSetup({ owner, pageAsked }) {
    const session = new CallSession(owner ? "web_owner_1" : "test_1");
    session.ownerMode = owner;
    session.deepgramVoice = "aura-2-theia-en";
    const events = []; // everything the page receives, in order
    const ws = { readyState: 1, send: (x) => events.push(Buffer.isBuffer(x) ? { audio: x.length } : JSON.parse(x)) };
    const tts = [];
    const synthesizeSpeech = async (key, text, options) => { tts.push({ text, options }); return Buffer.alloc(options?.encoding === "linear16" ? 4800 : 800); };
    const scope = {
      session, ws, pagePlaysWideband: pageAsked,
      BROWSER_WIDEBAND, FAST_DEEPGRAM_HOST: "api.au.deepgram.com", WebSocket: { OPEN: 1 }, audioFormatMessage,
      DEEPGRAM_API_KEY: "k",
      synthesizeForBrowser: makeSynthesizeForBrowser(synthesizeSpeech),
      openDeepgramStream: () => ({ close() {} }),
      context: { organization: { country: "AU", businessState: "NSW", recordingConsentMode: "auto", recording_disclosure_text: null, name: "Copperline", industry: "home_services" }, assistant: {} },
      requiresRecordingDisclosureHybrid: () => ({ required: !owner, callerState: "NSW", reason: "all-party" }),
      getRecordingDisclosureText: () => "This call is recorded.",
      ownerWebPrompt: owner ? { greeting: "Hi Dave, what do you need?" } : null,
      getGreeting: () => "Thanks for calling Copperline!",
      isAfterHours: false, afterHoursConfig: null,
      detectExpectedInput: () => "general",
      ownerWebBargeIn: () => false, forgetOwnerReadBacks: () => {}, logTranscript: () => {}, noteOwnerSpeech: () => {},
      handleTestUserSpeech: async () => {}, cleaningUp: false, OWNER_WEB_PROBLEM_MESSAGE: "<problem>",
      console: { log() {}, warn() {}, error() {} },
    };
    const code = sliceOf('console.log("[TestClassic] Using classic pipeline for test call");', "} // end classic pipeline else block");
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const params = Object.keys(scope);
    await new AsyncFunction(...params, code)(...params.map((p) => scope[p]));
    return { session, events, tts };
  }
  const WIDEBAND_OPTIONS = { voice: "aura-2-theia-en", host: "api.au.deepgram.com", encoding: "linear16", sampleRate: 24000, boost: false };

  it("the owner's bubble on a page that asked: audio_format is the first thing the page gets, then wideband greeting audio", async () => {
    const { session, events, tts } = await runClassicSetup({ owner: true, pageAsked: true });
    assert.deepEqual(events[0], { type: "audio_format", encoding: "linear16", sampleRate: 24000 });
    assert.ok(events.findIndex((ev) => "audio" in ev) > 0, "audio only after the announcement");
    assert.equal(events.filter((ev) => ev.type === "audio_format").length, 1);
    assert.deepEqual(tts.map((t) => t.options), [WIDEBAND_OPTIONS], "the greeting is wideband from the Sydney host");
    assert.equal(session.browserAudio, BROWSER_WIDEBAND);
  });

  it("the owner's bubble on a page that didn't ask: no announcement, the phone's format", async () => {
    const { session, events, tts } = await runClassicSetup({ owner: true, pageAsked: false });
    assert.ok(!events.some((ev) => ev.type === "audio_format"));
    assert.deepEqual(tts.map((t) => t.options), [{ voice: "aura-2-theia-en" }]);
    assert.equal(session.browserAudio, null);
    assert.equal(session.ttsHost, null);
  });

  it("a customer's test call on a page that asked: no announcement; disclosure and greeting in the phone's format", async () => {
    const { session, events, tts } = await runClassicSetup({ owner: false, pageAsked: true });
    assert.ok(!events.some((ev) => ev.type === "audio_format"));
    assert.deepEqual(tts.map((t) => t.options), [{ voice: "aura-2-theia-en" }, { voice: "aura-2-theia-en" }]);
    assert.equal(session.browserAudio, null);
  });

  it("only playback=linear16 is an ask (the real line, on real URLs)", () => {
    const line = sliceOf("const pagePlaysWideband = ", "\n");
    const asks = (query) => new Function("url", "BROWSER_WIDEBAND", `${line}\nreturn pagePlaysWideband;`)(new URL(`http://h/ws/test?token=t${query}`), BROWSER_WIDEBAND);
    assert.equal(asks("&playback=linear16"), true);
    for (const q of ["", "&playback=mulaw", "&playback=", "&playback=LINEAR16"]) assert.equal(asks(q), false, q);
  });
});

describe("synthesizeForBrowser: the bubble's host failing once moves the session to the default host (run for real)", () => {
  const wideband = () => Object.assign(new CallSession("web_owner_1"), { ownerMode: true, deepgramVoice: "aura-2-theia-en", browserAudio: BROWSER_WIDEBAND, ttsHost: "api.au.deepgram.com", organizationId: "org-1" });

  it("a failure on the Sydney host: said again on the default host in the same format, paged once with the session", async () => {
    const calls = [];
    const errors = [];
    const speak = makeSynthesizeForBrowser(async (key, text, options) => {
      calls.push(options);
      if (options.host) throw new Error("Deepgram TTS error 503: unavailable");
      return Buffer.alloc(10);
    }, errors);
    const s = wideband();
    assert.equal((await speak(s, "Hi.")).length, 10);
    assert.deepEqual(calls, [
      { voice: "aura-2-theia-en", host: "api.au.deepgram.com", encoding: "linear16", sampleRate: 24000, boost: false },
      { voice: "aura-2-theia-en", encoding: "linear16", sampleRate: 24000, boost: false },
    ]);
    assert.equal(s.ttsHost, null, "the rest of the session uses the default host");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\[ALERT:error\] \[OwnerWeb\] Speech failed on api\.au\.deepgram\.com .*callSid=web_owner_1, org=org-1\): Deepgram TTS error 503/);
    await speak(s, "Again.");
    assert.equal(calls.length, 3, "later sentences go straight to the default host");
    assert.equal(errors.length, 1, "paged once");
  });

  it("the default host failing too: the error goes to the caller (the turn's own handling), and the one page says the owner hears nothing", async () => {
    const errors = [];
    let calls = 0; // a third call would succeed: a second retry (or a loop) fails here at once
    const speak = makeSynthesizeForBrowser(async (key, text, options) => { if (++calls > 2) return Buffer.alloc(10); throw new Error(options.host ? "Deepgram TTS error 503" : "Deepgram TTS error 500"); }, errors);
    await assert.rejects(speak(wideband(), "Hi."), /Deepgram TTS error 500/);
    assert.equal(calls, 2, "one retry on the default host, never two");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\[ALERT:error\] \[OwnerWeb\] Speech failed on api\.au\.deepgram\.com and on the default host — the owner hears nothing \(callSid=web_owner_1, org=org-1\): Deepgram TTS error 503 \/ Deepgram TTS error 500$/);
  });

  it("two requests already on their way to Sydney when it fails: both are said again on the default host, one page", async () => {
    const calls = [];
    const errors = [];
    const speak = makeSynthesizeForBrowser(async (key, text, options) => {
      calls.push([text, options.host || "default"]);
      if (!options.host) return Buffer.alloc(text.length);
      await new Promise((r) => setTimeout(r, text === "A." ? 5 : 15)); // A fails first, B while A is retried
      throw new Error("Deepgram TTS error 504: timeout");
    }, errors);
    const s = wideband();
    const [a, b] = await Promise.all([speak(s, "A."), speak(s, "B, longer.")]);
    assert.equal(a.length, 2);
    assert.equal(b.length, 10, "the second sentence isn't lost");
    assert.deepEqual(calls.filter((c) => c[1] === "default").map((c) => c[0]).sort(), ["A.", "B, longer."]);
    assert.equal(errors.length, 1, "one page for the session");
  });

  it("a session with no host of its own (the phone's format) isn't retried", async () => {
    const calls = [];
    const errors = [];
    const speak = makeSynthesizeForBrowser(async (key, text, options) => { calls.push(options); throw new Error("Deepgram TTS error 500"); }, errors);
    await assert.rejects(speak({ deepgramVoice: "aura-2-theia-en" }, "Hi."), /500/);
    assert.equal(calls.length, 1);
    assert.equal(errors.length, 0);
  });
});

describe("startHoldAudio: the hold loop in the browser's format (run for real)", () => {
  const code = sliceOf("function startHoldAudio(session, ws, mode) {", "\n}\n") + "\n}\n";
  function run(session, mode, errors = []) {
    const sent = [];
    const chunked = [];
    const ws = { readyState: 1, send: (x) => sent.push(x) };
    const scope = {
      generateHoldAudio,
      chunkAudioForTwilio: (buf) => { chunked.push(buf.length); return ["c1"]; },
      WebSocket: { OPEN: 1 },
      setTimeout: () => 0, // one round of the loop is enough
      clearTimeout: () => {},
      sendClear: () => true, // stop() flushes a phone call's queued hold audio
      console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) },
    };
    const params = Object.keys(scope);
    const { startHoldAudio } = new Function(...params, `${code}\nreturn { startHoldAudio };`)(...params.map((p) => scope[p]));
    startHoldAudio(session, ws, mode).stop();
    return { sent, chunked };
  }

  it("a wideband bubble: two seconds of 24 kHz PCM", () => {
    const { sent } = run({ holdPreset: "neutral", browserAudio: BROWSER_WIDEBAND }, "browser");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 2000 * 48);
  });

  it("a browser that wasn't told wideband: the phone's mulaw, as before", () => {
    const { sent } = run({ holdPreset: "neutral" }, "browser");
    assert.equal(sent[0].length, 16_000);
  });

  it("hold audio that can't be made never takes the turn down: no sound, one alert, a stop that works", () => {
    const errors = [];
    const { sent } = run({ holdPreset: "neutral", browserAudio: { encoding: "linear16", sampleRate: 24000.5 }, callSid: "web_owner_1" }, "browser", errors);
    assert.equal(sent.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\[ALERT:error\] \[HoldAudio\] No hold audio for this turn \(callSid=web_owner_1\): generateHoldAudio: linear16 needs a whole-number sampleRate$/);
  });

  it("a phone call is always mulaw, whatever is on the session", () => {
    const { chunked } = run({ holdPreset: "neutral", browserAudio: BROWSER_WIDEBAND, streamSid: "MZ1" }, "twilio");
    assert.deepEqual(chunked, [16_000]);
  });
});

describe("what the bubble shows and says of a reply (run for real)", () => {
  const helpers =
    sliceOf("function stripMarkdown(text) {", "\n}\n") + "\n}\n" +
    sliceOf("function spellLettersForTts(text) {", "\n}\n") + "\n}\n" +
    sliceOf("function testSpeechText(session, text) {", "// Warm the Gemini Live path on boot");
  const { testSpeechText, testShownText } = new Function(`${helpers}\nreturn { testSpeechText, testShownText };`)();
  const owner = { ownerMode: true };

  it("the markdown list the owner saw (28 Oct): words only, line breaks kept", () => {
    const reply =
      "Here's what I can't do from this assistant:\n\n- **Choose who does a job.** The diary assigns that.\n- **Bulk changes**, like moving a whole day at once.";
    assert.equal(
      testShownText(owner, reply),
      "Here's what I can't do from this assistant:\n\nChoose who does a job. The diary assigns that.\nBulk changes, like moving a whole day at once."
    );
  });

  it("a bold split across two streamed sentences leaves no asterisk to read out", () => {
    assert.equal(testSpeechText(owner, "**Choose who does a job."), "Choose who does a job.");
    assert.equal(testSpeechText(owner, "** The diary assigns that."), "The diary assigns that.");
    assert.equal(testSpeechText(owner, "**"), "", "nothing left to say: no audio");
    assert.equal(testSpeechText(owner, "*** Tomorrow is full."), "Tomorrow is full.", "a bold-italic split leaves no asterisk either");
    assert.equal(testShownText(owner, "Choose ** who does it."), "Choose who does it.", "and no double space where it was");
  });

  it("a single asterisk stays: a gate code in a customer's note (\"*4521#\") is shown and said as written", () => {
    assert.equal(testShownText(owner, "The gate code is *4521#."), "The gate code is *4521#.");
    // Known, kept on purpose: two single asterisks pair as emphasis (stripMarkdown, shared
    // with the phone line). Changing that is a decision, not an accident.
    assert.equal(testShownText(owner, "Gate *4521#, key safe *77#."), "Gate 4521#, key safe 77#.");
  });

  it("speech is still spelled as on the phone line", () => {
    assert.equal(testSpeechText(owner, "That's **J-A-N-E**."), "That's J, A, N, E.");
  });

  it("a customer's test call is unchanged, and nothing isn't a crash", () => {
    assert.equal(testShownText({}, "**Hi** there."), "**Hi** there.");
    assert.equal(testSpeechText(null, "**Hi** there."), "**Hi** there.");
    assert.equal(testShownText(owner, null), "");
  });
});
