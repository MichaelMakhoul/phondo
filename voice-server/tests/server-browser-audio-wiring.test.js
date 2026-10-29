// SCRUM-619: the owner's bubble isn't a phone line. These run the real server.js text: the
// page asks for wideband, the bubble's classic session gets it (announced before any audio),
// every browser TTS call and the hold loop speak it, and what the bubble shows and says of a
// reply has no markdown.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BROWSER_WIDEBAND } = require("../lib/browser-audio");
const { generateHoldAudio } = require("../lib/hold-audio");

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
    const block = /if \(session\.ownerMode && pagePlaysWideband\) \{\s*session\.browserAudio = BROWSER_WIDEBAND;\s*session\.ttsHost = FAST_DEEPGRAM_HOST;\s*if \(ws\.readyState === WebSocket\.OPEN\) ws\.send\(audioFormatMessage\(BROWSER_WIDEBAND\)\);\s*\}/;
    assert.match(classic, block);
    const at = classic.search(block);
    for (const later of ["openDeepgramStream(", "synthesizeSpeech(DEEPGRAM_API_KEY, disclosureText", "synthesizeSpeech(DEEPGRAM_API_KEY, greeting"]) {
      assert.ok(classic.indexOf(later) > at, `the format is set before ${later}`);
    }
    assert.equal((handler.match(/session\.browserAudio = /g) || []).length, 1, "nowhere else (Gemini's audio stays mulaw)");
  });

  it("every browser TTS call speaks the session's format: setup, the reply, the goodbye, the loop's last words", () => {
    const calls = [...(classic + turn).matchAll(/synthesizeSpeech\(DEEPGRAM_API_KEY, ([^\n]*)/g)].map((m) => m[1]);
    assert.ok(calls.length >= 6, calls.join("\n"));
    for (const call of calls) assert.match(call, /, browserTtsOptions\(session\)\);$/, call);
  });

  it("the goodbye waits for its audio at the session's own rate", () => {
    assert.match(turn, /const graceMs = Math\.min\(15_000, browserAudioMs\(session, turnAudioBytes\) \+ 500\);/);
  });
});

describe("startHoldAudio: the hold loop in the browser's format (run for real)", () => {
  const code = sliceOf("function startHoldAudio(session, ws, mode) {", "\n}\n") + "\n}\n";
  function run(session, mode) {
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
      console: { log() {}, warn() {}, error() {} },
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
