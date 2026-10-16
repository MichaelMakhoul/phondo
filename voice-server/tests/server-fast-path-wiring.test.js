"use strict";

// SCRUM-594: the fast classic pipeline's wiring in server.js (spec 4.8). The
// clients and the turn logic have their own suites; what only server.js decides
// is how they are put together on a live call. Source pins (idiom A) for the
// shape, and the REAL server.js text run against fakes for the behaviour
// (idiom B, as in server-owner-mode-wiring.test.js: server.js can't be required).
//
// The core harness evaluates ONE slice, from buildLLMOptions to the /ws/test
// section: handleUserSpeech, sendTTS, sendClear, startHoldAudio and the "Fast
// classic pipeline" section run together, so a Flux event goes through the real
// turn engine, the real turn, the real sendTTS and the real player. Only the
// network ends (Flux, Aura, the LLM, Twilio) are fakes.

process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

const { CallSession } = require("../call-session");
const toolExecutor = require("../services/tool-executor");
const { chunkAudioForTwilio } = require("../services/deepgram-tts");
const { forwardingFallbackEligible } = require("../lib/transfer-eligibility");
const { buildOwnerTools } = require("../lib/owner-tools");
const { runOwnerToolCall, OWNER_MAX_TOOL_CALLS, ownerToolLoopReply, buildOwnerCallSummary, settleOwnerToolRuns } = require("../lib/owner-tool-runner");
const { noteAssistantSpeech, noteAssistantTurnEnd } = require("../lib/owner-turn-stamps");
const { checkEndCallGuard } = require("../lib/end-call-guard");
const { createFastPlayer } = require("../lib/fast-player");
const { createFastTurnEngine } = require("../lib/fast-turns");
const { startSpeculativeReply } = require("../lib/speculative-reply");
const { maskPhone } = require("../lib/mask-phone");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const startHandler = src.slice(src.indexOf('case "start": {'), src.indexOf('case "media": {'));
const cleanup = src.slice(src.indexOf("async function cleanupSession()"), src.indexOf('twilioWs.on("message"'));

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function sliceOf(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}
/** Runs server.js text between two markers as a function body whose parameters are `scope`'s keys. */
function runSlice({ from, to, scope, names = [], isAsync = false, wrap }) {
  const code = sliceOf(from, to);
  const params = Object.keys(scope);
  const body = wrap ? wrap(code) : `${code}\nreturn { ${names.join(", ")} };`;
  const Ctor = isAsync ? AsyncFunction : Function;
  return new Ctor(...params, body)(...params.map((p) => scope[p]));
}
function recordingConsole(lines) {
  const rec = (m) => (...args) => lines.push(`${m}| ${args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4 }))).join(" ")}`);
  return { log: rec("log"), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond()` holds. */
async function until(cond, what, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}
/** Let pending promise callbacks and immediates run. */
const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};
/** `promise`, or a failure if it takes longer than `ms` (the timer is always cleared). */
async function within(promise, ms, what) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
const abortReason = (signal) =>
  signal.reason instanceof Error ? signal.reason : Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

const AU_HOST = "api.au.deepgram.com";
const FRAME = Buffer.alloc(320, 0x7e); // 40 ms of mulaw, the size Aura usually sends

function makeSession() {
  const s = new CallSession("CA-fast");
  s.streamSid = "MZ-fast";
  s.language = "en";
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  s.callRecordId = "call-1";
  s.callerPhone = "+61400000001";
  s.orgPhoneNumber = "+61238205672";
  s.calendarEnabled = true;
  s.serviceTypes = [];
  s.transferRules = [];
  s.behaviors = {};
  s.organization = { timezone: "Australia/Sydney", industry: "dental" };
  s.deepgramVoice = "aura-2-thalia-en";
  s.setSystemPrompt("SYSTEM");
  return s;
}

/**
 * The server.js core (buildLLMOptions … the fast section), live, against fakes.
 * `o.steps`: one entry per LLM call (drafts included), in order:
 *   { sentences, content } a reply; { sentences, tools } tool calls;
 *   firstDelayMs / gapMs pace the stream (abortable); hang: never finishes; throws: rejects.
 */
function makeFast(o = {}) {
  const lines = [];
  const calls = [];
  const sentry = [];
  const steps = [...(o.steps || [])];
  const llmCalls = [];
  const flux = { opened: [] };
  const aura = { opened: [] };
  const novaOpens = [];
  const twilioWs = {
    readyState: 1,
    sent: [],
    send(json) { this.sent.push(JSON.parse(json)); },
    close(...a) { calls.push(["twilio.close", ...a]); this.readyState = 2; },
  };

  async function llm(messages, opts, which) {
    llmCalls.push({ which, messages: messages.map((m) => ({ ...m })), opts });
    const step = steps.shift();
    if (!step) throw new Error("the LLM was called more often than scripted");
    const signal = opts.signal;
    const pause = (ms) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortReason(signal)); }, { once: true });
    });
    if (step.firstDelayMs) await pause(step.firstDelayMs);
    for (const sentence of step.sentences || []) {
      opts.onSentence(sentence);
      if (step.gapMs) await pause(step.gapMs);
    }
    if (step.hang) await pause(60_000);
    if (step.throws) throw Object.assign(new Error(step.throws), step.errorName ? { name: step.errorName } : {});
    if (step.content !== undefined) return { type: "content", content: step.content };
    const toolCalls = step.tools.map((t, i) => ({ id: `tc${llmCalls.length}-${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }));
    return { type: "tool_calls", toolCalls, message: { role: "assistant", content: (step.sentences || []).join(" ") || null, tool_calls: toolCalls } };
  }

  const engines = [];
  const scope = {
    // ── classic neighbours (as in server-classic-end-call-wiring.test.js) ──
    calendarToolDefinitions: toolExecutor.calendarToolDefinitions,
    listServiceTypesToolDefinition: toolExecutor.listServiceTypesToolDefinition,
    transferToolDefinition: toolExecutor.transferToolDefinition,
    callbackToolDefinition: toolExecutor.callbackToolDefinition,
    endCallToolDefinition: toolExecutor.endCallToolDefinition,
    forwardingFallbackEligible,
    buildOwnerTools,
    DEFAULT_MODEL: "test-model",
    LLM_API_KEY: "llm",
    streamChatResponse: (key, messages, opts) => llm(messages, opts, "chat"),
    executeToolCall: async (name, args, ctx) => {
      calls.push(["executeToolCall", name]);
      if (o.onTool) await o.onTool(name);
      if (name === "end_call") return toolExecutor.executeToolCall(name, args, ctx); // the real sentinel
      return (o.toolResults && o.toolResults[name]) || { success: true, message: `${name} ok` };
    },
    runOwnerToolCall,
    scheduleCache: { invalidate: () => {}, applyDelta: () => {} },
    noteAssistantSpeech,
    noteAssistantTurnEnd,
    OWNER_MAX_TOOL_CALLS,
    ownerToolLoopReply,
    getErrorMsg: (lang, key) => `ERR:${key}`,
    detectExpectedInput: () => o.expectNext || "general",
    logTranscript: (label, text) => lines.push(`log| ${label}: [${(text || "").length} chars]`),
    bookingKey: () => "k",
    classifyRebookAttempt: () => ({ kind: "duplicate" }),
    CORRECTION_ERROR_MESSAGE: "correction failed",
    DUPLICATE_REBOOK_MESSAGE: "duplicate",
    Sentry: {
      withScope: (fn) => {
        const tags = {};
        let extras = {};
        fn({ setTag: (k, v) => { tags[k] = v; }, setExtras: (e) => { extras = { ...extras, ...e }; }, setExtra: (k, v) => { extras[k] = v; }, setLevel() {} });
        if (sentry.length && !sentry.at(-1).tags) Object.assign(sentry.at(-1), { tags, extras });
      },
      captureMessage: (message, level) => sentry.push({ kind: "message", message, level }),
      captureException: (err) => sentry.push({ kind: "exception", message: err?.message }),
    },
    normalizeDatetime: (x) => x,
    CANCEL_NUDGE: " (nothing booked now)",
    RESCHEDULE_SUCCESS_SIGNAL: /moved/,
    applyRescheduleToLedger: () => ({ moved: false }),
    saveForTransfer: () => {},
    checkEndCallGuard,
    END_CALL_PLAYBACK_CAP_MS: o.capMs ?? 800,
    END_CALL_TAIL_MS: o.tailMs ?? 5,
    WebSocket: { OPEN: 1 },
    DEEPGRAM_API_KEY: "dg-key",
    synthesizeSpeech: async (key, text, options) => {
      calls.push(["synthesizeSpeech", text, options]);
      if (o.restDelayMs) await sleep(o.restDelayMs);
      if (o.restFails) throw new Error("Deepgram TTS error 500");
      return Buffer.alloc(o.restBytes ?? 800, 0x7f);
    },
    chunkAudioForTwilio,
    generateHoldAudio: () => (o.holdAudio ? Buffer.alloc(320, 0x55) : null),
    // ── the fast path ──
    openFluxStream: (apiKey, callbacks, options) => {
      const handle = {
        readyState: 0,
        frames: [],
        closes: 0,
        send(buf) { if (this.readyState !== 1) return false; this.frames.push(buf); return true; },
        close() { this.closes += 1; this.readyState = 3; },
        configure() { return true; },
        forceEndTurn() { return true; },
      };
      flux.opened.push({ apiKey, callbacks, options, handle });
      return handle;
    },
    fluxConfigFromEnv: () => o.fluxConfig || { eotThreshold: 0.7, eagerEotThreshold: 0.4, eotTimeoutMs: 5000 },
    openAuraStream: (apiKey, options) => {
      const handle = {
        open: o.auraOpen ?? true,
        spoken: [],
        flushes: [],
        clears: 0,
        closes: 0,
        nextSeq: 0,
        refuse: false,
        ready: Promise.resolve(),
        isOpen() { return this.open; },
        speak(text) { if (!this.open || typeof text !== "string" || !text.trim()) return false; this.spoken.push(text); return true; },
        flush() { if (!this.open || this.refuse) return null; const seq = this.nextSeq++; this.flushes.push(seq); return seq; },
        flushesInLastMinute() { return this.flushes.length; },
        clear() { if (!this.open) return false; this.clears += 1; return true; },
        close() { this.closes += 1; this.open = false; },
      };
      aura.opened.push({ apiKey, options, handle });
      return handle;
    },
    createFastPlayer,
    createFastTurnEngine: (opts) => { engines.push(opts); return createFastTurnEngine(opts); },
    startSpeculativeReply,
    streamClaudeResponse: (messages, opts) => llm(messages, opts, "claude"),
    FAST_LLM_MODEL: "claude-haiku-5-5",
    FAST_LLM_TIMEOUT_MS: o.llmTimeoutMs ?? 15_000,
    FAST_DEEPGRAM_HOST: AU_HOST,
    FLUX_OPEN_TIMEOUT_MS: o.fluxOpenTimeoutMs ?? 40,
    FAST_TTS_MS_PER_CHAR: 70,
    FAST_FLUSHED_WAIT_MS: o.flushedWaitMs ?? 120,
    FAST_IDLE_CAP_MS: o.idleCapMs ?? 60,
    FAST_AUDIO_QUIET_MS: o.quietMs ?? 25,
    console: recordingConsole(lines),
  };
  const names = ["handleUserSpeech", "sendTTS", "sendClear", "startFastPath", "closeFastPath", "onFastMark", "settleFastAudio", "fastFlush", "summarizeFastCall"];
  const fns = runSlice({
    from: "function buildLLMOptions(session, { includeTransfer = false } = {}) {",
    to: "// --- Test Call WebSocket (/ws/test) ---",
    scope,
    // A name server.js does not define comes back undefined, so only the tests that use it fail.
    wrap: (code) => `${code}\nreturn { ${names.map((n) => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(", ")} };`,
  });

  /** Start the fast path on `session` as the classic block does; Nova is a recording stub. */
  function start(session) {
    session.fastPath = true;
    fns.startFastPath(session, twilioWs, () => {
      novaOpens.push(session.callSid);
      session.deepgramWs = { readyState: 0, nova: true, close() {} };
    });
    return session;
  }
  const lastFlux = () => flux.opened.at(-1);
  const lastAura = () => aura.opened.at(-1);
  return {
    ...fns,
    start,
    lines,
    calls,
    sentry,
    steps,
    llmCalls,
    flux,
    aura,
    novaOpens,
    engines,
    twilioWs,
    lastFlux,
    lastAura,
    /** Flux connects. */
    fluxOpens() { const f = lastFlux(); f.handle.readyState = 1; f.callbacks.onOpen(); },
    turn(event, turnIndex, transcript, trigger = event === "EndOfTurn" ? "model" : null) {
      lastFlux().callbacks.onTurnInfo({ event, turnIndex, transcript, eotConfidence: 0.9, trigger });
    },
    /** Aura sends audio, then (optionally) the Flushed for `seq`. */
    audio(frames = 1, flushedSeq) {
      const a = lastAura();
      for (let i = 0; i < frames; i++) a.options.onAudio(FRAME);
      if (flushedSeq !== undefined) a.options.onFlushed(flushedSeq);
    },
    twilio: (event) => twilioWs.sent.filter((m) => m.event === event),
    marks: () => twilioWs.sent.filter((m) => m.event === "mark").map((m) => m.mark.name),
  };
}

/** Twilio echoes every fast mark it was sent (all audio played). */
function echoMarks(h, session) {
  for (const name of h.marks()) h.onFastMark(session, name);
}

// ─── Source pins ────────────────────────────────────────────────────────────

describe("SCRUM-594 fast path wiring — source pins", () => {
  it("imports the fast-path clients, and takes the AU host from the shared Deepgram helpers", () => {
    assert.match(src, /const \{ openFluxStream, fluxConfigFromEnv \} = require\("\.\/services\/flux-stt"\);/);
    assert.match(src, /const \{ openAuraStream \} = require\("\.\/services\/aura-stream"\);/);
    assert.match(src, /const \{ DEFAULT_HOST \} = require\("\.\/services\/deepgram-ws-common"\);/);
    assert.match(src, /const \{ createFastPlayer \} = require\("\.\/lib\/fast-player"\);/);
    assert.match(src, /const \{ createFastTurnEngine \} = require\("\.\/lib\/fast-turns"\);/);
  });

  it("the fast-path constants are the production values", () => {
    assert.match(src, /^const FAST_DEEPGRAM_HOST = process\.env\.FAST_DEEPGRAM_HOST \|\| DEFAULT_HOST;$/m);
    assert.match(src, /^const FLUX_OPEN_TIMEOUT_MS = 3000;$/m);
    assert.match(src, /^const FAST_TTS_MS_PER_CHAR = 70;$/m);
    assert.match(src, /^const FAST_FLUSHED_WAIT_MS = 3000;$/m);
  });

  it("the classic block picks the STT from session.fastPath: the fast path starts Flux, every other call opens Nova", () => {
    const marker = "// ── Classic pipeline (Deepgram STT + OpenAI LLM + Deepgram TTS) ──\n";
    const block = startHandler.slice(startHandler.indexOf(marker));
    assert.match(block, /if \(session\.fastPath\) startFastPath\(session, twilioWs, openClassicStt\);\n\s*else openClassicStt\(\);/);
    assert.ok(block.indexOf("const openClassicStt = () => {") < block.indexOf("session.deepgramWs = openDeepgramStream(DEEPGRAM_API_KEY, {"), "Nova keeps today's callbacks, inside openClassicStt");
  });

  it("the fast path pre-synthesises the greeting and disclosure on the AU host; the classic path's REST calls are unchanged", () => {
    const hosts = startHandler.match(/\.\.\.\(session\.fastPath \? \{ host: FAST_DEEPGRAM_HOST \} : \{\}\)/g) || [];
    assert.equal(hosts.length, 2, "the disclosure and the greeting");
  });

  it("server.js keeps exactly 3 reason-tagged Sentry sites (fast-path captures carry a service tag only)", () => {
    const sites = (src.match(/\w+\.setTag\("reason",/g) || []).length + (src.match(/setReasonTag\(\s*\w+\s*,/g) || []).length;
    assert.equal(sites, 3);
  });

  it("cleanup ends the fast path first, before any await", () => {
    const close = cleanup.indexOf("if (s.fastState) closeFastPath(s);");
    assert.ok(close > 0 && close < cleanup.indexOf("await "), "closed before the post-call awaits");
    assert.ok(close < cleanup.indexOf("if (s.pendingTransfer) {"), "a transferred call closes its fast sockets too");
  });
});

// ─── synthesizeSpeech host ──────────────────────────────────────────────────

describe("SCRUM-594 synthesizeSpeech host", () => {
  it("takes an optional host and keeps mip_opt_out; the default host is unchanged", async () => {
    const savedFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = /** @type {any} */ (async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    });
    try {
      const { synthesizeSpeech } = require("../services/deepgram-tts");
      await synthesizeSpeech("KEY", "Hello there.", { voice: "aura-2-thalia-en", host: AU_HOST });
      await synthesizeSpeech("KEY", "Hello there.", { voice: "aura-2-thalia-en" });
    } finally {
      globalThis.fetch = savedFetch;
    }
    assert.match(urls[0], /^https:\/\/api\.au\.deepgram\.com\/v1\/speak\?model=aura-2-thalia-en&/);
    assert.match(urls[0], /[?&]mip_opt_out=true(&|$)/);
    assert.match(urls[1], /^https:\/\/api\.deepgram\.com\/v1\/speak\?model=aura-2-thalia-en&/);
    assert.match(urls[1], /[?&]mip_opt_out=true(&|$)/);
  });
});

// ─── 4.8.1: the classic block's STT, run for real ───────────────────────────

/** The classic block's top (fastPath flag → STT choice), with the REAL startFastPath from `h`. */
function classicStart(h, session, effectivePipeline) {
  const opened = [];
  runSlice({
    from: "// ── Classic pipeline (Deepgram STT + OpenAI LLM + Deepgram TTS) ──",
    to: "// Recording disclosure + greeting — pre-synthesize disclosure while STT connects",
    scope: {
      session,
      effectivePipeline,
      openDeepgramStream: (key, callbacks, options) => { opened.push({ key, callbacks, options }); return { readyState: 0, nova: true, close() {} }; },
      startFastPath: h.startFastPath,
      DEEPGRAM_API_KEY: "dg-key",
      logTranscript: () => {},
      handleUserSpeech: async () => {},
      twilioWs: h.twilioWs,
      sendTTS: async () => 0,
      getErrorMsg: () => "",
      noteOwnerSpeech: () => {},
      console: recordingConsole(h.lines),
    },
  });
  return opened;
}

describe("SCRUM-594 4.8.1: the fast path's STT and TTS at call start", () => {
  it("classic-fast opens Flux (with the turn engine) on the AU host, and the Aura stream and its player beside it — not Nova", () => {
    const h = makeFast();
    const s = makeSession();
    const nova = classicStart(h, s, "classic-fast");
    assert.equal(nova.length, 0, "no Nova");
    assert.equal(h.flux.opened.length, 1);
    const f = h.lastFlux();
    assert.equal(s.deepgramWs, f.handle, "media frames go to the Flux handle (spec 4.8.2: same interface)");
    assert.equal(f.apiKey, "dg-key");
    assert.deepEqual(f.options, { host: AU_HOST, industry: "dental", eotThreshold: 0.7, eagerEotThreshold: 0.4, eotTimeoutMs: 5000 });
    assert.equal(typeof f.callbacks.onTurnInfo, "function");
    assert.equal(h.engines.length, 1, "Flux events feed a turn engine");
    assert.equal(h.aura.opened.length, 1);
    assert.equal(h.lastAura().options.host, AU_HOST);
    assert.equal(h.lastAura().options.voice, "aura-2-thalia-en");
    assert.equal(s.fastTts, h.lastAura().handle);
    assert.ok(s.fastPlayer, "the player");
    assert.equal(typeof s.awaitPlaybackEnd, "function", "the end_call hang-up waits on the fast path's own playback signal");
    h.closeFastPath(s);
  });

  it("every other pipeline opens Nova with today's callbacks, and nothing of the fast path", () => {
    for (const p of ["classic", "gemini-live"]) {
      const h = makeFast();
      const s = makeSession();
      const nova = classicStart(h, s, p);
      assert.equal(nova.length, 1, p);
      assert.equal(typeof nova[0].callbacks.onTranscript, "function");
      assert.equal(typeof nova[0].callbacks.onUtteranceEnd, "function");
      assert.equal(nova[0].options.industry, "dental");
      assert.equal(h.flux.opened.length + h.aura.opened.length, 0, p);
      assert.equal(s.fastPlayer, null);
      assert.equal(s.fastTts, null);
      assert.equal(s.awaitPlaybackEnd, null);
    }
  });

  it("Flux that does not open in time falls back to Nova: one log, one flux-stt capture, fastPath = degraded-stt", async () => {
    const h = makeFast({ fluxOpenTimeoutMs: 30 });
    const s = makeSession();
    const nova = classicStart(h, s, "classic-fast");
    await sleep(60);
    assert.equal(nova.length, 1, "Nova, with today's callbacks");
    assert.equal(typeof nova[0].callbacks.onTranscript, "function");
    assert.equal(s.fastPath, "degraded-stt");
    assert.equal(s.deepgramWs.nova, true);
    assert.equal(h.lastFlux().handle.closes, 1, "the Flux attempt is closed");
    assert.equal(h.lines.filter((l) => l.includes("[FastPath] Flux unavailable — falling back to Nova")).length, 1, h.lines.join("\n"));
    assert.equal(h.sentry.length, 1);
    assert.equal(h.sentry[0].tags.service, "flux-stt");
    assert.equal(h.sentry[0].tags.reason, undefined, "no reason tag (server.js keeps exactly 3)");
    assert.equal(s.fastTts, h.lastAura().handle, "the rest of the fast path still applies");
    h.closeFastPath(s);
  });

  it("an error before open falls back at once, and the close that follows does not fall back twice", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const f = h.lastFlux();
    f.callbacks.onError(new Error("Unexpected server response: 401"));
    assert.equal(h.novaOpens.length, 1, "at the error, not at the close");
    f.callbacks.onClose(1006, "", { initiatedByUs: false });
    assert.equal(h.novaOpens.length, 1);
    assert.equal(s.fastPath, "degraded-stt");
    assert.equal(h.sentry.length, 1);
    h.closeFastPath(s);
  });

  it("an error after open falls back too, even with the socket still up (a turn engine that throws must not leave the call half-deaf)", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    h.lastFlux().callbacks.onError(new Error("Flux sent a frame that is not valid JSON"));
    assert.equal(h.novaOpens.length, 1);
    assert.equal(s.fastPath, "degraded-stt");
    assert.equal(h.lastFlux().handle.closes, 1);
    assert.equal(s.fastTurns, null);
    h.closeFastPath(s);
  });

  it("a fallback mid-call also aborts the draft in flight (Nova turns never adopt one)", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Can I book for Friday?");
    await settle();
    h.lastFlux().callbacks.onClose(1011, "internal error", { initiatedByUs: false });
    assert.equal(h.llmCalls[0].opts.signal.aborted, true);
    assert.equal(s.speculation, null);
    h.closeFastPath(s);
  });

  it("a Flux that opens in time stays: no fallback when the open deadline passes", async () => {
    const h = makeFast({ fluxOpenTimeoutMs: 20 });
    const s = h.start(makeSession());
    h.fluxOpens();
    await sleep(40);
    assert.equal(h.novaOpens.length, 0);
    assert.equal(s.fastPath, true);
    assert.equal(h.sentry.length, 0);
    h.closeFastPath(s);
  });

  it("an abnormal close mid-call opens Nova the same way; a close we asked for does not", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    h.lastFlux().callbacks.onClose(1005, "", { initiatedByUs: true });
    assert.equal(h.novaOpens.length, 0, "our own close is not a failure");
    h.lastFlux().callbacks.onClose(1005, "", { initiatedByUs: false });
    assert.equal(h.novaOpens.length, 1);
    assert.equal(s.fastPath, "degraded-stt");
    assert.ok(h.lines.some((l) => l.includes("[FastPath] Flux unavailable — falling back to Nova")));
    h.closeFastPath(s);
  });

  it("no Nova once the call is closing or cleaned up", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.closeFastPath(s);
    h.lastFlux().callbacks.onError(new Error("late"));
    assert.equal(h.novaOpens.length, 0, "after cleanup");
    const h2 = makeFast();
    const s2 = h2.start(makeSession());
    h2.twilioWs.readyState = 3;
    h2.lastFlux().callbacks.onError(new Error("boom"));
    assert.equal(h2.novaOpens.length, 0, "the Twilio stream is gone");
    h2.closeFastPath(s2);
  });

  it("a turn action that throws is logged and captured, and never reaches Flux's onError (no needless fall back to Nova)", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    s.queueOrProcess = () => { throw new Error("queue broke"); };
    // Flux's client routes a throwing onTurnInfo to onError: model that here.
    const { callbacks } = h.lastFlux();
    const onTurnInfo = (evt) => { try { callbacks.onTurnInfo(evt); } catch (err) { callbacks.onError(err); } };
    onTurnInfo({ event: "EndOfTurn", turnIndex: 0, transcript: "I need a check-up", eotConfidence: 0.9, trigger: "model" });
    assert.equal(h.novaOpens.length, 0);
    assert.equal(s.fastPath, true);
    assert.ok(h.lines.some((l) => l.startsWith("error| [FastTurn] commit failed") && l.includes("queue broke")), h.lines.join("\n"));
    assert.equal(h.sentry.length, 1);
    assert.equal(h.sentry[0].tags.service, "fast-turns");
    assert.ok(!h.lines.join("\n").includes("check-up"), "no caller words in the logs");
    h.closeFastPath(s);
  });

  it("the turn engine is reset when Flux opens (a forgotten reset would be silent deafness)", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    // Turn 0 ends, then Flux (re)connects: its turn indexes restart at 0, and turn 0 must be heard again.
    s.isProcessing = true; // queue the commits instead of running turns
    h.turn("EndOfTurn", 0, "first time");
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "second time");
    assert.equal(s._pendingTranscript, "first time second time");
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 4.8.1-4.8.2: greeting, disclosure and media on the fast path (run for real)", () => {
  /** The start handler's greeting/disclosure send, with the REAL fast-path functions from `h`. */
  function sendGreeting(h, session, { disclosureAudio = null, greetingAudio = Buffer.alloc(320, 0x11) } = {}) {
    return runSlice({
      from: "// Wait for pre-synthesized audio and send it",
      to: "// (Old sequential disclosure/greeting code removed — replaced by pre-synthesis above)",
      isAsync: true,
      scope: {
        session,
        twilioWs: h.twilioWs,
        disclosureAudioPromise: Promise.resolve(disclosureAudio),
        disclosureText: "This call is recorded.",
        greetingAudioPromise: Promise.resolve(greetingAudio),
        greeting: "Thanks for calling!",
        chunkAudioForTwilio,
        WebSocket: { OPEN: 1 },
        sendTTS: h.sendTTS,
        settleFastAudio: h.settleFastAudio,
        fastFlush: h.fastFlush,
        setTimeout: () => {}, // the greeting's 20 s isSpeaking backstop
        console: recordingConsole(h.lines),
      },
      wrap: (code) => code,
    });
  }

  it("a disclosure that falls back to the Aura stream reaches Twilio before the pre-synthesised greeting (never interleaved)", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const sending = sendGreeting(h, s);
    await settle();
    assert.deepEqual(h.lastAura().handle.spoken, ["This call is recorded."]);
    assert.deepEqual(h.lastAura().handle.flushes, [0]);
    assert.equal(h.twilio("media").length, 0, "the greeting waits for the disclosure's audio");
    h.audio(2, 0); // the disclosure's audio, then its Flushed
    await sending;
    const payloads = h.twilio("media").map((m) => Buffer.from(m.media.payload, "base64")[0]);
    const firstGreeting = payloads.indexOf(0x11);
    assert.ok(firstGreeting > 0 && payloads.slice(0, firstGreeting).every((b) => b === 0x7e) && payloads.slice(firstGreeting).every((b) => b === 0x11),
      `disclosure frames, then greeting frames: ${payloads.map((b) => b.toString(16)).join(" ")}`);
    assert.equal(s.recordingDisclosurePlayed, true);
    h.closeFastPath(s);
  });

  it("a greeting that falls back to the Aura stream is flushed (its last words are released)", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await sendGreeting(h, s, { disclosureAudio: null, greetingAudio: null });
    assert.deepEqual(h.lastAura().handle.spoken, ["This call is recorded.", "Thanks for calling!"]);
    assert.equal(h.lastAura().handle.flushes.length, 2);
    h.closeFastPath(s);
  });

  it("media frames go to the Flux handle exactly as they went to Nova (spec 4.8.2)", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    runSlice({
      from: 'case "media": {',
      to: 'case "mark": {',
      scope: { session: s, msg: { event: "media", media: { payload: Buffer.from([1, 2, 3]).toString("base64") } }, WebSocket: { OPEN: 1 }, console: recordingConsole(h.lines) },
      wrap: (code) => `switch ("media") {\n${code}\n}`,
    });
    assert.deepEqual(h.lastFlux().handle.frames.map((b) => [...b]), [[1, 2, 3]]);
    h.closeFastPath(s);
  });
});

// ─── 4.8.3 sendTTS, 4.8.5 sendClear, 4.8.6 marks ───────────────────────────

describe("SCRUM-594 4.8.3: sendTTS on the fast path", () => {
  it("speaks on the Aura stream while it is open (markdown stripped) and returns chars × 70 ms; no REST", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const ms = await h.sendTTS(s, h.twilioWs, "**Sure**, Michael.");
    assert.deepEqual(h.lastAura().handle.spoken, ["Sure, Michael."]);
    assert.equal(ms, "Sure, Michael.".length * 70);
    assert.ok(!h.calls.some((c) => c[0] === "synthesizeSpeech"));
    h.closeFastPath(s);
  });

  it("uses REST, as today, while the stream is not open — and on every classic call", async () => {
    const h = makeFast({ auraOpen: false });
    const s = h.start(makeSession());
    const ms = await h.sendTTS(s, h.twilioWs, "Hello.");
    assert.equal(ms, 800 / 8, "the REST audio's real duration");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["Hello."]);
    assert.ok(h.twilio("media").length > 0 && h.marks().includes("tts-done"));
    h.closeFastPath(s);
    const classic = makeSession();
    await h.sendTTS(classic, h.twilioWs, "Hi.");
    assert.equal(h.calls.filter((c) => c[0] === "synthesizeSpeech").length, 2);
    clearTimeout(s._speakingTimeout); // the REST path's 20 s isSpeaking backstop
    clearTimeout(classic._speakingTimeout);
  });

  it("an Aura failure moves the rest of the call to REST: one log, one aura-stream capture, the stream closed", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const a = h.lastAura();
    a.options.onError(new Error("Aura error: socket hang up"));
    a.options.onClose(1006, "", { initiatedByUs: false });
    assert.equal(s.fastTts, null);
    assert.equal(a.handle.closes, 1);
    assert.equal(h.lines.filter((l) => l.includes("[FastPath] Aura stream unavailable — falling back to REST TTS")).length, 1, h.lines.join("\n"));
    assert.equal(h.sentry.length, 1);
    assert.equal(h.sentry[0].tags.service, "aura-stream");
    assert.equal(s.awaitPlaybackEnd, null, "the hang-up waits on the REST estimate again");
    await h.sendTTS(s, h.twilioWs, "Still here.");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["Still here."]);
    clearTimeout(s._speakingTimeout); // the REST path's 20 s isSpeaking backstop
    h.closeFastPath(s);
  });

  it("an Aura close we asked for is not a failure; Aura warnings (CLEARED_TIMEOUT too) are logged, never captured", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const a = h.lastAura();
    a.options.onWarning({ code: "CLEARED_TIMEOUT", message: "no Cleared within 750 ms of a Clear - audio resumes" });
    a.options.onWarning({ code: "EXCESSIVE_FLUSH", message: "Rate limit exceeded for flushes." });
    a.options.onClose(1000, "", { initiatedByUs: true });
    assert.equal(h.sentry.length, 0);
    assert.equal(h.lines.filter((l) => l.startsWith("warn|") && l.includes("CLEARED_TIMEOUT")).length, 1);
    assert.equal(s.fastTts, a.handle, "still streaming");
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 4.8.6 + addendum: audio, marks, isSpeaking and the echo filter's text", () => {
  it("Aura audio goes to Twilio through the player; its Flushed sends a fast-* mark; the echoed mark ends isSpeaking", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Sure, Michael.");
    h.audio(2, 0);
    assert.equal(h.twilio("media").length, 4, "2 × 320 bytes in 160-byte Twilio frames");
    assert.equal(s.isSpeaking, true);
    assert.deepEqual(h.marks(), ["fast-1"]);
    h.onFastMark(s, "fast-1");
    assert.equal(s.isSpeaking, false);
    h.closeFastPath(s);
  });

  it("getState hands the turn engine everything spoken since the player was last idle, and forgets it on idle", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const getState = h.engines[0].getState;
    await h.sendTTS(s, h.twilioWs, "Sure, Michael.");
    await h.sendTTS(s, h.twilioWs, "I can book that for you.");
    h.audio(1, 0);
    let state = getState();
    assert.equal(state.aiSpeaking, true);
    assert.equal(state.processing, false);
    assert.equal(state.expectedInputType, "general");
    assert.equal(state.aiSpeakingText, "Sure, Michael. I can book that for you.");
    h.onFastMark(s, "fast-1");
    state = getState();
    assert.equal(state.aiSpeaking, false);
    assert.equal(state.aiSpeakingText, "", "cleared when the last mark came back");
    h.closeFastPath(s);
  });

  it("aiSpeaking also covers REST audio (the greeting and disclosure): it is the player OR session.isSpeaking", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    s.isSpeaking = true;
    assert.equal(h.engines[0].getState().aiSpeaking, true);
    s.isSpeaking = false;
    s.isProcessing = true;
    s.setExpectedInputType("phone");
    assert.deepEqual(h.engines[0].getState(), { aiSpeaking: false, processing: true, expectedInputType: "phone", aiSpeakingText: "" });
    h.closeFastPath(s);
  });

  it("the Twilio mark handler sends fast-* marks to the player and leaves tts-done as it was", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const seen = [];
    const handle = (name, session = s) => runSlice({
      from: 'case "mark": {',
      to: 'case "stop": {',
      scope: { session, msg: { event: "mark", mark: { name } }, onFastMark: (sess, n) => { seen.push(n); h.onFastMark(sess, n); } },
      wrap: (code) => `switch ("mark") {\n${code}\n}`,
    });
    s.isSpeaking = true;
    handle("tts-done");
    assert.equal(s.isSpeaking, false, "tts-done still ends isSpeaking");
    assert.deepEqual(seen, []);
    handle("fast-3");
    assert.deepEqual(seen, ["fast-3"]);
    const classic = makeSession();
    handle("fast-4", classic);
    assert.deepEqual(seen, ["fast-3"], "a call without a player ignores fast marks");
    h.closeFastPath(s);
  });

  it("audio whose Flushed never comes (a refused flush) still gets its mark once Aura goes quiet", async () => {
    const h = makeFast({ quietMs: 20 });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Okay.");
    h.audio(2);
    assert.deepEqual(h.marks(), []);
    await sleep(50);
    assert.deepEqual(h.marks(), ["fast-1"]);
    h.onFastMark(s, "fast-1");
    assert.equal(s.isSpeaking, false, "so the engine does not treat the caller's 'yes' as echo forever");
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 4.8.5: sendClear on the fast path", () => {
  it("also stops the player (Twilio clear, its marks) and Clears Aura while it may still owe audio", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Let me look that up for you.");
    h.audio(1, 0);
    h.sendClear(s, h.twilioWs);
    assert.equal(h.twilio("clear").length, 1, "one Twilio clear (the player's)");
    assert.equal(h.lastAura().handle.clears, 1);
    assert.equal(s.isSpeaking, false);
    assert.equal(s.fastPlayer.isPlaying(), false);
    assert.equal(h.engines[0].getState().aiSpeakingText, "");
    h.closeFastPath(s);
  });

  it("an idle Aura is not sent a Clear (never probed: a lost Cleared would drop the next reply's audio)", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.sendClear(s, h.twilioWs);
    assert.equal(h.twilio("clear").length, 1);
    assert.equal(h.lastAura().handle.clears, 0);
    h.closeFastPath(s);
  });

  it("a classic call's sendClear is today's single Twilio clear", () => {
    const h = makeFast();
    const s = makeSession();
    h.sendClear(s, h.twilioWs);
    assert.deepEqual(h.twilioWs.sent, [{ event: "clear", streamSid: "MZ-fast" }]);
    assert.ok(h.lines.includes("log| [Barge-in] Cleared Twilio audio buffer"));
  });
});

// ─── 4.8.4: flush points ────────────────────────────────────────────────────

describe("SCRUM-594 4.8.4: flush points", () => {
  it("a content reply is flushed once, after its chunks", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure, Michael,", "Tuesday at ten works."], content: "Sure, Michael, Tuesday at ten works." }] });
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "Can I come in Tuesday at ten?");
    const a = h.lastAura().handle;
    assert.deepEqual(a.spoken, ["Sure, Michael,", "Tuesday at ten works."]);
    assert.deepEqual(a.flushes, [0]);
    h.closeFastPath(s);
  });

  it("a tool round is flushed after its filler, while the tool runs; a refused flush is tolerated", async () => {
    const order = [];
    const h = makeFast({
      onTool: async (name) => { order.push(`tool:${name}`); await sleep(5); order.push("tool done"); },
      steps: [{ tools: [{ name: "check_availability", args: { date: "2026-10-20" } }] }, { sentences: ["Ten is free."], content: "Ten is free." }],
    });
    const s = h.start(makeSession());
    const a = h.lastAura().handle;
    const flush = a.flush.bind(a);
    a.flush = () => { order.push("flush"); return flush(); };
    const speak = a.speak.bind(a);
    a.speak = (text) => { order.push(`speak:${text}`); return speak(text); };
    await h.handleUserSpeech(s, h.twilioWs, "Is Tuesday free at all?");
    // The filler goes to Aura in the same tick the tool call starts (as on the classic path, which never
    // waits for TTS before a tool), and its flush follows it before the tool's result is back.
    assert.deepEqual(order, ["tool:check_availability", "speak:One moment, let me check that.", "flush", "tool done", "speak:Ten is free.", "flush"]);
    // The budget runs out: the turn still completes.
    a.refuse = true;
    h.steps.push({ sentences: ["Anything else?"], content: "Anything else?" });
    await h.handleUserSpeech(s, h.twilioWs, "Great, thanks for that.");
    assert.ok(a.spoken.includes("Anything else?"));
    assert.equal(h.lines.filter((l) => l.includes("[FastPath] Aura flush refused")).length, 1);
    h.closeFastPath(s);
  });

  it("the waiting filler is flushed after it is spoken", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 1600, sentences: ["Here you go."], content: "Here you go." }] });
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "What are your opening hours on weekends?");
    const a = h.lastAura().handle;
    assert.deepEqual(a.spoken, ["One moment.", "Here you go."]);
    assert.deepEqual(a.flushes, [0, 1], "one after the filler, one after the reply");
    h.closeFastPath(s);
  });

  it("hold audio stops once: a later round's first chunk does not cut what the turn already said", async () => {
    const h = makeFast({
      holdAudio: true,
      steps: [{ tools: [{ name: "check_availability", args: {} }] }, { sentences: ["Ten is free."], content: "Ten is free." }],
    });
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "Is Tuesday free at all?");
    assert.equal(h.twilio("clear").length, 1, "one clear: the hold audio's");
    assert.equal(h.lastAura().handle.clears, 0, "the filler is not Cleared from Aura");
    assert.deepEqual(h.lastAura().handle.spoken, ["One moment, let me check that.", "Ten is free."]);
    h.closeFastPath(s);
  });
});

// ─── the end_call hang-up's playback signal ─────────────────────────────────

describe("SCRUM-594 addendum: session.awaitPlaybackEnd on the fast path", () => {
  it("flushes, waits for that Flushed, ends the utterance, then waits for its mark", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Thanks for calling — goodbye.");
    let done = false;
    const wait = s.awaitPlaybackEnd().then(() => { done = true; });
    assert.deepEqual(h.lastAura().handle.flushes, [0], "the goodbye is flushed");
    await settle();
    h.audio(3); // the goodbye's audio arrives …
    await settle();
    assert.equal(done, false, "… but its Flushed has not");
    h.lastAura().options.onFlushed(0);
    await settle();
    assert.deepEqual(h.marks(), ["fast-1"]);
    assert.equal(done, false, "the mark is out, Twilio has not played it yet");
    h.onFastMark(s, "fast-1");
    await wait;
    assert.equal(done, true);
    h.closeFastPath(s);
  });

  it("a refused flush skips the Flushed wait: the wait is for Aura to go quiet, then the player's estimate", async () => {
    const h = makeFast({ quietMs: 20, idleCapMs: 10 });
    const s = h.start(makeSession());
    h.lastAura().handle.refuse = true;
    await h.sendTTS(s, h.twilioWs, "Goodbye!");
    const t0 = Date.now();
    const wait = s.awaitPlaybackEnd();
    await sleep(5);
    h.audio(2); // 80 ms of audio
    await wait;
    assert.deepEqual(h.marks(), ["fast-1"]);
    assert.ok(Date.now() - t0 >= 20, "it waited for the audio to stop arriving");
    h.closeFastPath(s);
  });

  it("a Flushed that never comes is waited for at most FAST_FLUSHED_WAIT_MS", async () => {
    const h = makeFast({ flushedWaitMs: 40, idleCapMs: 10 });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Bye now.");
    const t0 = Date.now();
    await s.awaitPlaybackEnd();
    const waited = Date.now() - t0;
    assert.ok(waited >= 35 && waited < 1000, `waited ${waited}ms: the 40 ms bound, not forever`);
    h.closeFastPath(s);
  });

  it("throws when the stream is not open, so the hang-up uses its sendTTS estimate", async () => {
    const h = makeFast({ auraOpen: false });
    const s = h.start(makeSession());
    await assert.rejects(s.awaitPlaybackEnd(), /not open/);
    h.closeFastPath(s);
  });
});

// ─── 4.8.10 cleanup ─────────────────────────────────────────────────────────

describe("SCRUM-594 4.8.10: cleanup", () => {
  it("closes Flux even while it is still CONNECTING, closes Aura, stops the player and releases its waits; idempotent", async () => {
    const h = makeFast({ fluxOpenTimeoutMs: 30 });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Hello.");
    h.audio(1, 0);
    const idle = s.fastPlayer.whenIdle(60_000);
    h.closeFastPath(s);
    h.closeFastPath(s);
    assert.equal(h.lastFlux().handle.closes, 1, "the CONNECTING handle is closed (our pings would keep it alive)");
    assert.equal(h.lastAura().handle.closes, 1);
    await within(idle, 1000, "the player's whenIdle wait, released by its stop (not its 60 s timer)");
    await sleep(50);
    assert.equal(h.novaOpens.length, 0, "the open deadline was cleared");
    assert.equal(h.sentry.length, 0);
  });

  it("after a Nova fallback, Flux is not closed again (Nova is closed by destroy, as before)", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.lastFlux().callbacks.onError(new Error("boom"));
    h.closeFastPath(s);
    assert.equal(h.lastFlux().handle.closes, 1);
  });

  it("a throwing close or stop never escapes", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.lastAura().handle.close = () => { throw new Error("socket gone"); };
    s.fastPlayer.stop = () => { throw new Error("twilio gone"); };
    assert.doesNotThrow(() => h.closeFastPath(s));
  });

  it("cleanupSession ends the fast path (run for real)", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    s.startedAt = Date.now() - 60_000;
    const records = [];
    const { cleanupSession } = runSlice({
      from: "async function cleanupSession() {",
      to: 'twilioWs.on("message", async (raw) => {',
      scope: {
        session: s,
        cleaningUp: false,
        sessions: new Map(),
        Sentry: { withScope: (fn) => fn({ setTag() {}, setExtras() {}, setExtra() {}, setLevel() {} }), captureMessage() {}, captureException() {} },
        detectPostCallPhantoms: () => [],
        summarizePhantoms: () => ({ bugTag: "x", reason: "x" }),
        analyzeCallTranscript: async () => null,
        buildToolOutcomeDigest: () => "",
        DEBUG_TRANSCRIPTS: false,
        maybeEmitUnhappyCall: () => {},
        netLiveOutcome: () => 0,
        setReasonTag: () => {},
        SENTRY_REASONS: { BOOKING_STATE_MISMATCH: "booking-state-mismatch" },
        detectAndRedact: (t) => ({ piiFound: false, redacted: t }),
        redactObject: (x) => ({ piiFound: false, redacted: x }),
        completeCallRecord: async (id, fields) => { records.push(fields); },
        setTimeout: (fn) => fn(),
        notifyCallCompleted: async () => {},
        INTERNAL_API_URL: "http://next.internal",
        INTERNAL_API_SECRET: "secret",
        maskPhone,
        buildOwnerCallSummary,
        settleOwnerToolRuns,
        isDemoLineNumber: () => true,
        closeFastPath: h.closeFastPath,
        summarizeFastCall: h.summarizeFastCall,
        console: recordingConsole(h.lines),
      },
      names: ["cleanupSession"],
    });
    await cleanupSession();
    assert.equal(h.lastFlux().handle.closes, 1);
    assert.equal(h.lastAura().handle.closes, 1);
    assert.equal(records.length, 1);
  });
});

// ─── 4.8.7: the fast turn (Claude, clause chunking, drafts, aborts) ─────────

describe("SCRUM-594 4.8.7: handleUserSpeech on the fast path", () => {
  it("the live call is Claude with clause chunking, the turn's signal and FAST_LLM_MODEL (never streamChatResponse); the turn exposes its abort while it runs", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 20, sentences: ["Sure,", "Tuesday at ten works."], content: "Sure, Tuesday at ten works." }] });
    const s = h.start(makeSession());
    const turn = h.handleUserSpeech(s, h.twilioWs, "Can I come in Tuesday at ten?");
    await settle();
    assert.equal(typeof s.currentTurn?.abort, "function", "session.currentTurn = { abort } while the turn runs");
    await turn;
    assert.equal(h.llmCalls.length, 1);
    const [call] = h.llmCalls;
    assert.equal(call.which, "claude");
    assert.equal(call.opts.chunking, "clause");
    assert.equal(call.opts.model, "claude-haiku-5-5");
    assert.ok(call.opts.signal instanceof AbortSignal);
    assert.ok(call.opts.tools.some((t) => t.function.name === "book_appointment"), "the turn's tools");
    assert.deepEqual(call.messages.at(-1), { role: "user", content: "Can I come in Tuesday at ten?" });
    assert.deepEqual(h.lastAura().handle.spoken, ["Sure,", "Tuesday at ten works."]);
    assert.equal(s.currentTurn, null, "gone once the turn is over");
    h.closeFastPath(s);
  });

  it("a classic call still uses streamChatResponse", async () => {
    const h = makeFast({ steps: [{ sentences: ["Hi."], content: "Hi." }] });
    const s = makeSession();
    await h.handleUserSpeech(s, h.twilioWs, "Hello there, anyone home?");
    assert.equal(h.llmCalls[0].which, "chat");
    assert.equal(s.currentTurn, null);
    clearTimeout(s._speakingTimeout);
  });

  it("a live call that hangs is cut at FAST_LLM_TIMEOUT_MS and handled like any LLM failure: an apology, the user message dropped", async () => {
    const h = makeFast({ llmTimeoutMs: 30, steps: [{ hang: true }] });
    const s = h.start(makeSession());
    await within(h.handleUserSpeech(s, h.twilioWs, "Hello, is anyone there?"), 2000, "the turn, cut at the 30 ms limit");
    assert.deepEqual(h.lastAura().handle.spoken, ["ERR:troubleRepeat"]);
    assert.deepEqual(s.messages.slice(1), [], "dropped, as on the classic path");
    assert.ok(h.lines.some((l) => l.startsWith("error| [Pipeline]")), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("the model's own words before a tool call stand in for the canned tool filler (said once, not twice)", async () => {
    const h = makeFast({
      toolResults: { book_appointment: { success: true, message: "Booked! Your confirmation code is 482913." } },
      steps: [
        { sentences: ["One moment, let me book that for you."], tools: [{ name: "book_appointment", args: { datetime: "2026-10-20T10:00:00" } }] },
        { sentences: ["You're booked for Tuesday at ten."], content: "You're booked for Tuesday at ten." },
      ],
    });
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "Yes, book me in please.");
    assert.deepEqual(h.lastAura().handle.spoken, ["One moment, let me book that for you.", "You're booked for Tuesday at ten."]);
    h.closeFastPath(s);
  });

  it("with no words before the tool call, the canned filler still covers the wait", async () => {
    const h = makeFast({
      toolResults: { book_appointment: { success: true, message: "Booked! Your confirmation code is 482913." } },
      steps: [
        { tools: [{ name: "book_appointment", args: { datetime: "2026-10-20T10:00:00" } }] },
        { sentences: ["You're booked."], content: "You're booked." },
      ],
    });
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "Yes, book me in please.");
    assert.deepEqual(h.lastAura().handle.spoken, ["Let me book that for you.", "You're booked."]);
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 4.8.7 + addendum: speculative drafts", () => {
  it("an adoptable draft is adopted: one LLM call in all, nothing spoken before the commit, its chunks spoken at once", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure, Tuesday at ten works."], content: "Sure, Tuesday at ten works." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("StartOfTurn", 0, "Can I");
    h.turn("EagerEndOfTurn", 0, "Can I come in Tuesday at ten?");
    await settle();
    assert.equal(h.llmCalls.length, 1, "the draft starts at the eager end of turn");
    assert.equal(h.llmCalls[0].which, "claude");
    assert.equal(h.llmCalls[0].opts.chunking, "clause");
    assert.equal(h.llmCalls[0].opts.model, "claude-haiku-5-5");
    assert.deepEqual(h.llmCalls[0].messages.at(-1), { role: "user", content: "Can I come in Tuesday at ten?" });
    assert.equal(h.engines[0].getState().processing, false, "a draft is not processing");
    assert.deepEqual(h.lastAura().handle.spoken, []);
    assert.deepEqual(s.messages.slice(1), [], "a draft never touches the conversation");
    h.turn("EndOfTurn", 0, "Can I come in Tuesday at ten?");
    await until(() => !s.isProcessing, "the turn");
    assert.equal(h.llmCalls.length, 1, "no second LLM call");
    assert.deepEqual(h.lastAura().handle.spoken, ["Sure, Tuesday at ten works."]);
    assert.deepEqual(s.messages.slice(1).map((m) => [m.role, m.content]), [["user", "Can I come in Tuesday at ten?"], ["assistant", "Sure, Tuesday at ten works."]]);
    assert.equal(s.speculation, null);
    h.closeFastPath(s);
  });

  it("a draft for other words is discarded at the commit: aborted, and the turn calls the LLM live", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 300, sentences: ["Sure."], content: "Sure." }, { sentences: ["Ten it is."], content: "Ten it is." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Tuesday");
    await settle();
    const draftSignal = h.llmCalls[0].opts.signal;
    h.turn("EndOfTurn", 0, "Tuesday at ten"); // a ForceEndTurn can do this with no TurnResumed
    assert.equal(draftSignal.aborted, true);
    await until(() => !s.isProcessing, "the turn");
    assert.equal(h.llmCalls.length, 2);
    assert.deepEqual(h.llmCalls[1].messages.at(-1), { role: "user", content: "Tuesday at ten" });
    assert.deepEqual(h.lastAura().handle.spoken, ["Ten it is."]);
    h.closeFastPath(s);
  });

  it("a draft for other words is aborted at the commit even when the turn has to queue", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 300, sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Tuesday");
    await settle();
    s.isProcessing = true; // a turn in flight: the commit queues
    h.turn("EndOfTurn", 0, "Tuesday please"); // two words: no barge-in, so only the commit can drop it
    assert.equal(h.llmCalls[0].opts.signal.aborted, true, "not left running until the queued turn starts");
    assert.equal(s.speculation, null);
    assert.equal(s._pendingTranscript, "Tuesday please");
    h.closeFastPath(s);
  });

  it("a draft whose conversation changed since it started is not adopted: aborted, and the turn calls the LLM live", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 300, sentences: ["Stale."], content: "Stale." }, { sentences: ["Fresh."], content: "Fresh." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Can I book a cleaning?");
    await settle();
    s.addMessage("system", "The schedule changed."); // the draft no longer answers this conversation
    h.turn("EndOfTurn", 0, "Can I book a cleaning?");
    assert.equal(h.llmCalls[0].opts.signal.aborted, true);
    await until(() => !s.isProcessing, "the turn");
    assert.equal(h.llmCalls.length, 2);
    assert.deepEqual(h.lastAura().handle.spoken, ["Fresh."]);
    h.closeFastPath(s);
  });

  it("TurnResumed cancels the draft", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 300, sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "I want to");
    await settle();
    h.turn("TurnResumed", 0, "I want to book");
    assert.equal(h.llmCalls[0].opts.signal.aborted, true);
    assert.equal(s.speculation, null);
    h.closeFastPath(s);
  });

  it("a draft that fails after it was adopted is an LLM failure: an apology, the user message dropped", async (t) => {
    t.mock.method(console, "warn", () => {}); // speculative-reply's own warning (a lib module: the global console)
    const h = makeFast({ steps: [{ firstDelayMs: 40, throws: "Anthropic API error 529 (overloaded_error: Overloaded)" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Do you do Saturdays?");
    await settle();
    h.turn("EndOfTurn", 0, "Do you do Saturdays?");
    await until(() => !s.isProcessing, "the turn");
    assert.equal(h.llmCalls.length, 1, "adopted, so not asked again");
    assert.deepEqual(h.lastAura().handle.spoken, ["ERR:troubleRepeat"]);
    assert.deepEqual(s.messages.slice(1), []);
    h.closeFastPath(s);
  });

  it("speculation off (FLUX_EAGER_EOT_THRESHOLD=off): the engine never drafts", async () => {
    const h = makeFast({ fluxConfig: { eotThreshold: 0.7, eagerEotThreshold: null, eotTimeoutMs: 5000 } });
    const s = h.start(makeSession());
    assert.equal(h.engines[0].speculationEnabled, false);
    assert.equal(h.lastFlux().options.eagerEotThreshold, null);
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Can I book?");
    await settle();
    assert.equal(h.llmCalls.length, 0);
    h.closeFastPath(s);
  });

  it("speculation on by default: the engine is told so (a boolean)", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    assert.equal(h.engines[0].speculationEnabled, true);
    h.closeFastPath(s);
  });
});

// ─── 4.8.8: barge-in ────────────────────────────────────────────────────────

describe("SCRUM-594 4.8.8: barge-in", () => {
  it("stops the player (Twilio clear), Clears Aura and aborts the turn: no apology, the caller's words kept with what the AI had said plus '…'", async () => {
    const h = makeFast({
      steps: [
        { sentences: ["Sure, I can help with that,", "we have openings on Tuesday and Wednesday."], gapMs: 300, content: "unused" },
        { sentences: ["Wednesday it is."], content: "Wednesday it is." },
      ],
    });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "I'd like to book a cleaning");
    await until(() => h.lastAura().handle.spoken.length === 1, "the first clause");
    h.audio(2); // it is playing
    const signal = h.llmCalls[0].opts.signal;
    const clears = h.twilio("clear").length;
    h.turn("StartOfTurn", 1, "no wait");
    assert.equal(signal.aborted, true, "the turn's LLM call is aborted");
    assert.equal(h.twilio("clear").length, clears + 1, "the player's Twilio clear");
    assert.equal(h.lastAura().handle.clears, 1);
    assert.equal(s.fastPlayer.isPlaying(), false);
    assert.equal(s.isSpeaking, false);
    await until(() => !s.isProcessing, "the aborted turn");
    assert.ok(h.lines.some((l) => l.startsWith("log| [Barge-in] (fast)")), h.lines.join("\n"));
    assert.deepEqual(s.messages.slice(1).map((m) => [m.role, m.content]), [["user", "I'd like to book a cleaning"], ["assistant", "Sure, I can help with that,…"]]);
    assert.ok(!h.lastAura().handle.spoken.includes("ERR:troubleRepeat"), "no apology");
    // The caller finishes; the next turn sees the conversation as the caller heard it.
    h.turn("EndOfTurn", 1, "no wait, make it Wednesday");
    await until(() => h.llmCalls.length === 2 && !s.isProcessing, "the next turn");
    assert.deepEqual(h.llmCalls[1].messages.slice(1).map((m) => m.content), ["I'd like to book a cleaning", "Sure, I can help with that,…", "no wait, make it Wednesday"]);
    h.closeFastPath(s);
  });

  it("aborts an adopted draft that is still streaming: what it had said is kept, plus '…'", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure, let me see,", "we have Tuesday at ten or Wednesday at two."], gapMs: 300, content: "unused" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Do you have anything next week?");
    await settle();
    h.turn("EndOfTurn", 0, "Do you have anything next week?");
    await until(() => h.lastAura().handle.spoken.length === 1, "the replayed first clause");
    h.turn("Update", 1, "sorry actually I meant this week");
    assert.equal(h.llmCalls[0].opts.signal.aborted, true, "the adopted draft's own request is cancelled");
    await until(() => !s.isProcessing, "the aborted turn");
    assert.deepEqual(s.messages.slice(1).map((m) => [m.role, m.content]), [["user", "Do you have anything next week?"], ["assistant", "Sure, let me see,…"]]);
    assert.deepEqual(h.lastAura().handle.spoken, ["Sure, let me see,"]);
    h.closeFastPath(s);
  });

  it("after a barge-in no sentence still queued behind REST synthesis is spoken (the stream fell back to REST)", async () => {
    const h = makeFast({ restDelayMs: 150, steps: [{ sentences: ["First part,", "second part."], gapMs: 5, hang: true }] });
    const s = h.start(makeSession());
    h.lastAura().options.onError(new Error("aura down")); // REST from here on
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Tell me about your prices");
    await until(() => h.llmCalls.length === 1 && h.calls.some((c) => c[0] === "synthesizeSpeech"), "chunk one synthesising");
    await sleep(20); // chunk two is queued behind it
    h.turn("Update", 1, "never mind just tell me the hours");
    await until(() => !s.isProcessing, "the aborted turn");
    await sleep(200); // past chunk one's synthesis
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["First part,"]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("survives a player and an Aura stream that throw (the Twilio socket went away mid-call): the turn is still aborted", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Do you take new patients?");
    await settle();
    await h.sendTTS(s, h.twilioWs, "One moment."); // Aura owes audio: the barge-in will Clear it
    s.fastPlayer.stop = () => { throw new Error("socket closed"); };
    h.lastAura().handle.clear = () => { throw new Error("socket closed"); };
    h.turn("Update", 1, "sorry what about Saturdays then");
    assert.equal(h.llmCalls[0].opts.signal.aborted, true);
    assert.equal(h.sentry.length, 0, "handled inside the barge-in, not by the action guard");
    assert.ok(h.lines.some((l) => l.startsWith("warn| [FastPath] Stopping the player threw")), h.lines.join("\n"));
    assert.ok(h.lines.some((l) => l.startsWith("warn| [FastPath] Clearing the Aura stream threw")), h.lines.join("\n"));
    await until(() => !s.isProcessing, "the aborted turn");
    s.fastPlayer = null; // the throwing stop would only be logged again at cleanup
    h.closeFastPath(s);
  });

  it("also aborts a draft the session holds", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "I was wondering");
    await settle();
    s.isProcessing = true; // a turn in flight (e.g. one drained from the queue)
    h.turn("Update", 0, "I was wondering whether you could");
    assert.equal(h.llmCalls[0].opts.signal.aborted, true);
    assert.equal(s.speculation, null);
    h.closeFastPath(s);
  });

  it("an EndOfTurn over a turn in flight: barge-in aborts it, the commit queues behind it and is answered next", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5000, content: "never" }, { sentences: ["Sure, Wednesday."], content: "Sure, Wednesday." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Can I book for Tuesday?");
    await settle();
    h.turn("EndOfTurn", 1, "actually make that Wednesday instead"); // no Update first: the EndOfTurn does both
    await until(() => h.llmCalls.length === 2 && !s.isProcessing, "the queued turn");
    assert.equal(h.llmCalls[0].opts.signal.aborted, true);
    // Nothing was spoken in the aborted turn, so nothing is recorded for it: two user turns in a row
    // (the Messages API joins consecutive same-role turns).
    assert.deepEqual(h.llmCalls[1].messages.slice(1).map((m) => [m.role, m.content]), [["user", "Can I book for Tuesday?"], ["user", "actually make that Wednesday instead"]]);
    assert.deepEqual(h.lastAura().handle.spoken, ["Sure, Wednesday."]);
    h.closeFastPath(s);
  });

  it("never mid-tool: the tool finishes, its tool_use and tool_result stay, and no further LLM round is asked", async () => {
    /** @type {(() => void) | undefined} */
    let release;
    const h = makeFast({
      onTool: () => new Promise((r) => { release = () => r(undefined); }),
      steps: [{ sentences: ["Let me check that for you."], tools: [{ name: "check_availability", args: { date: "2026-10-20" } }] }],
    });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Is Tuesday free at all?");
    await until(() => typeof release === "function", "the tool call");
    h.turn("Update", 1, "actually forget it I will call back"); // processing: barge-in
    assert.equal(s.currentTurn?.ctl.signal.aborted, true, "the turn is aborted");
    /** @type {() => void} */ (release)();
    await until(() => !s.isProcessing, "the turn");
    assert.equal(h.calls.filter((c) => c[0] === "executeToolCall").length, 1, "the tool ran to the end");
    assert.equal(h.llmCalls.length, 1, "no LLM round after the abort");
    assert.deepEqual(s.messages.slice(1).map((m) => m.role), ["user", "assistant", "tool"], "a booking made there is still known to the next turn");
    assert.equal(s.messages[2].tool_calls[0].function.name, "check_availability");
    assert.equal(s.messages[3].content, "check_availability ok");
    h.closeFastPath(s);
  });

  it("no filler is spoken after a barge-in has ended the turn", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "What time do you open tomorrow?");
    await settle();
    h.turn("Update", 1, "hold on a second please");
    await until(() => !s.isProcessing, "the aborted turn");
    await sleep(1600); // past the 1.5 s waiting-filler timer
    assert.deepEqual(h.lastAura().handle.spoken, []);
    h.closeFastPath(s);
  });

  it("a goodbye is never barged in on: the call is ending, and speech over it is not answered anyway", async () => {
    const h = makeFast({ tailMs: 5, steps: [{ sentences: ["You're welcome, goodbye!"], tools: [{ name: "end_call", args: { reason: "caller finished" } }] }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "That's all, thanks");
    await until(() => s.endedReason === "end_call_tool", "the hang-up wait");
    h.audio(2);
    h.turn("Update", 1, "okay thank you so much bye");
    assert.equal(h.lastAura().handle.clears, 0, "the goodbye plays on");
    assert.ok(h.lines.some((l) => l.includes("[Barge-in] (fast) ignored")), h.lines.join("\n"));
    for (const seq of h.lastAura().handle.flushes) h.lastAura().options.onFlushed(seq);
    await settle();
    echoMarks(h, s);
    await until(() => h.calls.some((c) => c[0] === "twilio.close"), "the hang-up");
    h.closeFastPath(s);
  });

  it("with no turn in flight (the reply is still playing) it stops the audio, and the commit after it is answered", async () => {
    const h = makeFast({ steps: [{ sentences: ["We open at nine."], content: "We open at nine." }, { sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "When do you open?");
    await until(() => !s.isProcessing, "the first turn");
    h.audio(3, 0); // still playing
    h.turn("EndOfTurn", 1, "and what about Saturdays");
    assert.equal(h.lastAura().handle.clears, 1);
    await until(() => h.llmCalls.length === 2 && !s.isProcessing, "the second turn");
    h.closeFastPath(s);
  });

  it("a structured final goes through the debounce buffer, then the fast turn", async () => {
    const h = makeFast({ steps: [{ sentences: ["Got it."], content: "Got it." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    s.setExpectedInputType("phone");
    const buffered = [];
    // The real debounce is pinned in its own suite: here it calls back after 60 ms.
    s.bufferTranscript = (text, cb) => { buffered.push(text); setTimeout(() => cb(text, "phone"), 60); };
    h.turn("EndOfTurn", 0, "0412 345 678");
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the turn");
    assert.deepEqual(buffered, ["0412 345 678"]);
    assert.deepEqual(h.lastAura().handle.spoken, ["Got it."]);
    h.audio(1, 0);
    const line = h.lines.find((l) => l.includes("[FastTurn] callSid")) || "";
    assert.match(line, /trigger=buffered spec=none /);
    assert.ok(Number(/eot_to_llm=(\d+)/.exec(line)?.[1]) >= 55, `the clock starts at the caller's EndOfTurn, so the debounce counts: ${line}`);
    h.closeFastPath(s);
  });
});

// ─── 4.8.9: latency logs and calls.metadata.fastPath ────────────────────────

describe("SCRUM-594 4.8.9: [FastTurn], [FastCall] and calls.metadata.fastPath", () => {
  it("[FastTurn] per committed turn: trigger, spec, eot_to_llm, eot_to_audio, eager_lead — and no caller or model words in any log line", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure, Tuesday at ten works."], content: "Sure, Tuesday at ten works." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Can I come in Tuesday at ten?");
    await sleep(15);
    h.turn("EndOfTurn", 0, "Can I come in Tuesday at ten?");
    await until(() => !s.isProcessing, "the turn");
    await sleep(10);
    h.audio(1, 0); // the turn's first audio
    const lines = h.lines.filter((l) => l.includes("[FastTurn]"));
    assert.equal(lines.length, 1, h.lines.join("\n"));
    const m = lines[0].match(/^log\| \[FastTurn\] callSid=CA-fast trigger=model spec=adopted eot_to_llm=(\d+) eot_to_audio=(\d+) eager_lead=(\d+)$/);
    assert.ok(m, lines[0]);
    assert.ok(Number(m[2]) >= 10, `eot_to_audio runs to the first audio byte: ${m[2]}`);
    assert.ok(Number(m[3]) >= 15, `eager_lead is EagerEndOfTurn to EndOfTurn: ${m[3]}`);
    const all = h.lines.join("\n");
    for (const words of ["Tuesday", "Sure", "come in"]) assert.ok(!all.includes(words), `no "${words}" in the logs`);
    h.closeFastPath(s);
  });

  it("a turn with no draft says spec=none; a discarded draft says spec=discarded; a turn without audio logs eot_to_audio=- when the next one starts", async () => {
    const h = makeFast({
      steps: [
        { sentences: ["One."], content: "One." },
        { firstDelayMs: 300, content: "draft" },
        { sentences: ["Two."], content: "Two." },
      ],
    });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "first question here");
    await until(() => !s.isProcessing, "turn 0");
    h.turn("EagerEndOfTurn", 1, "second");
    await settle();
    h.turn("EndOfTurn", 1, "second question");
    await until(() => !s.isProcessing && h.llmCalls.length === 3, "turn 1");
    h.audio(1, 0);
    const lines = h.lines.filter((l) => l.includes("[FastTurn]"));
    assert.equal(lines.length, 2, h.lines.join("\n"));
    assert.match(lines[0], /trigger=model spec=none eot_to_llm=\d+ eot_to_audio=- eager_lead=-$/);
    assert.match(lines[1], /trigger=model spec=discarded eot_to_llm=\d+ eot_to_audio=\d+ eager_lead=\d+$/);
    h.closeFastPath(s);
    const summary = h.summarizeFastCall(s);
    assert.equal(summary.specDiscarded, 1);
    assert.equal(summary.specAdopted, 0);
    assert.equal(summary.turns, 2);
  });

  it("eot_to_llm runs to the LLM's first output: a tool call with no words counts, not the text after the tool", async () => {
    const h = makeFast({
      onTool: () => sleep(80),
      steps: [{ tools: [{ name: "check_availability", args: {} }] }, { sentences: ["Ten is free."], content: "Ten is free." }],
    });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Is Tuesday free at all?");
    await until(() => !s.isProcessing, "the turn");
    h.audio(1, 0);
    const line = h.lines.find((l) => l.includes("[FastTurn] callSid"));
    const llm = Number(/eot_to_llm=(\d+)/.exec(line || "")?.[1]);
    assert.ok(llm < 60, `eot_to_llm=${llm}: stamped at the tool call, not after the 80 ms tool (${line})`);
    h.closeFastPath(s);
    // And for text: the first chunk, not the end of the stream.
    const t = makeFast({ steps: [{ sentences: ["Sure,", "ten is free."], gapMs: 80, content: "Sure, ten is free." }] });
    const ts = t.start(makeSession());
    t.fluxOpens();
    t.turn("EndOfTurn", 0, "Is ten free on Tuesday?");
    await until(() => !ts.isProcessing, "the text turn");
    t.audio(1, 0);
    const textLine = t.lines.find((l) => l.includes("[FastTurn] callSid"));
    const textLlm = Number(/eot_to_llm=(\d+)/.exec(textLine || "")?.[1]);
    assert.ok(textLlm < 60, `eot_to_llm=${textLlm}: the first chunk, not the stream's end 160 ms later (${textLine})`);
    t.closeFastPath(ts);
  });

  it("after a Nova fallback, turns still take the fast LLM and the stream; [FastTurn] says trigger=buffered", async () => {
    const h = makeFast({ steps: [{ sentences: ["Hi there."], content: "Hi there." }] });
    const s = h.start(makeSession());
    h.lastFlux().callbacks.onError(new Error("boom"));
    await h.handleUserSpeech(s, h.twilioWs, "Hello, can you hear me?"); // as Nova's buffer calls it
    assert.equal(h.llmCalls[0].which, "claude");
    assert.deepEqual(h.lastAura().handle.spoken, ["Hi there."]);
    h.audio(1, 0);
    assert.ok(h.lines.some((l) => /\[FastTurn\] callSid=CA-fast trigger=buffered spec=none eot_to_llm=\d+ eot_to_audio=\d+ eager_lead=-$/.test(l)), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("[FastCall] at cleanup, and the same summary in calls.metadata.fastPath (null on every other call)", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }, { sentences: ["Okay."], content: "Okay." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Can I book a cleaning?");
    await settle();
    h.turn("EndOfTurn", 0, "Can I book a cleaning?");
    await until(() => !s.isProcessing, "turn 0");
    h.audio(1, 0);
    h.turn("EndOfTurn", 1, "Tuesday morning please");
    await until(() => !s.isProcessing && h.llmCalls.length === 2, "turn 1");
    h.audio(1, 1);
    s.startedAt = Date.now() - 60_000;
    const records = [];
    const runCleanup = (session) => runSlice({
      from: "async function cleanupSession() {",
      to: 'twilioWs.on("message", async (raw) => {',
      scope: {
        session,
        cleaningUp: false,
        sessions: new Map(),
        Sentry: { withScope: (fn) => fn({ setTag() {}, setExtras() {}, setExtra() {}, setLevel() {} }), captureMessage() {}, captureException() {} },
        detectPostCallPhantoms: () => [],
        summarizePhantoms: () => ({ bugTag: "x", reason: "x" }),
        analyzeCallTranscript: async () => null,
        buildToolOutcomeDigest: () => "",
        DEBUG_TRANSCRIPTS: false,
        maybeEmitUnhappyCall: () => {},
        netLiveOutcome: () => 0,
        setReasonTag: () => {},
        SENTRY_REASONS: { BOOKING_STATE_MISMATCH: "booking-state-mismatch" },
        detectAndRedact: (t) => ({ piiFound: false, redacted: t }),
        redactObject: (x) => ({ piiFound: false, redacted: x }),
        completeCallRecord: async (id, fields) => { records.push(fields); },
        setTimeout: (fn) => fn(),
        notifyCallCompleted: async () => {},
        INTERNAL_API_URL: "http://next.internal",
        INTERNAL_API_SECRET: "secret",
        maskPhone,
        buildOwnerCallSummary,
        settleOwnerToolRuns,
        isDemoLineNumber: () => true,
        closeFastPath: h.closeFastPath,
        summarizeFastCall: h.summarizeFastCall,
        console: recordingConsole(h.lines),
      },
      names: ["cleanupSession"],
    }).cleanupSession();
    await runCleanup(s);
    const fastPath = records[0].fastPath;
    assert.equal(fastPath.turns, 2);
    assert.equal(fastPath.specAdopted, 1);
    assert.equal(fastPath.specDiscarded, 0);
    assert.equal(fastPath.stt, "flux");
    assert.equal(fastPath.tts, "stream");
    assert.ok(Number.isInteger(fastPath.eotToAudioP50) && Number.isInteger(fastPath.eotToAudioP90) && fastPath.eotToAudioP90 >= fastPath.eotToAudioP50, JSON.stringify(fastPath));
    const line = h.lines.find((l) => l.includes("[FastCall]"));
    assert.equal(line, `log| [FastCall] callSid=CA-fast turns=2 eot_to_audio_p50=${fastPath.eotToAudioP50} p90=${fastPath.eotToAudioP90} spec_adopted=1 spec_discarded=0 stt=flux tts=stream`);
    // A classic call writes no fastPath metadata.
    const classic = makeSession();
    classic.startedAt = Date.now() - 60_000;
    await runCleanup(classic);
    assert.equal(records[1].fastPath, null);
  });

  it("p50 and p90 are nearest-rank percentiles of the turns' eot_to_audio", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.closeFastPath(s);
    /** @type {any} */ (s.fastStats).eotToAudioMs = [300, 100, 200, 500, 400, 900, 600, 800, 700, 1000];
    const summary = h.summarizeFastCall(s);
    assert.equal(summary.eotToAudioP50, 500);
    assert.equal(summary.eotToAudioP90, 900);
  });

  it("the summary names the fallbacks: stt=nova-fallback, tts=rest-fallback; no samples gives null percentiles", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.lastFlux().callbacks.onError(new Error("flux down"));
    h.lastAura().options.onError(new Error("aura down"));
    h.closeFastPath(s);
    assert.deepEqual(h.summarizeFastCall(s), { turns: 0, eotToAudioP50: null, eotToAudioP90: null, specAdopted: 0, specDiscarded: 0, stt: "nova-fallback", tts: "rest-fallback" });
    assert.ok(h.lines.includes("log| [FastCall] callSid=CA-fast turns=0 eot_to_audio_p50=- p90=- spec_adopted=0 spec_discarded=0 stt=nova-fallback tts=rest-fallback"), h.lines.join("\n"));
  });
});

// ─── 4.8.10: cleanup, the turn side ─────────────────────────────────────────

describe("SCRUM-594 4.8.10: cleanup ends drafts and the turn in flight", () => {
  it("aborts a draft", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "I need to cancel my appointment");
    await settle();
    h.closeFastPath(s);
    assert.equal(h.llmCalls[0].opts.signal.aborted, true);
    assert.equal(s.speculation, null);
  });

  it("aborts the turn in flight (nobody will hear it)", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "I need to cancel my appointment");
    await settle();
    h.closeFastPath(s);
    assert.equal(h.llmCalls[0].opts.signal.aborted, true);
    await until(() => !s.isProcessing, "the aborted turn");
    assert.ok(h.lines.some((l) => l.startsWith("log| [FastTurn] Reply stopped (cleanup) — nothing was said yet")), h.lines.join("\n"));
  });
});

describe("SCRUM-594 fast turns — source pins", () => {
  it("the fast LLM is Claude, FAST_LLM_MODEL defaults to Haiku 5.5, and a live call carries its own 15 s limit", () => {
    assert.match(src, /const \{ startSpeculativeReply \} = require\("\.\/lib\/speculative-reply"\);/);
    assert.match(src, /const \{ streamClaudeResponse \} = require\("\.\/services\/claude-chat"\);/);
    assert.match(src, /^const FAST_LLM_MODEL = process\.env\.FAST_LLM_MODEL \|\| "claude-haiku-5-5";$/m);
    assert.match(src, /^const FAST_LLM_TIMEOUT_MS = 15_000;$/m);
    assert.match(src, /signal: AbortSignal\.any\(\[turn\.ctl\.signal, AbortSignal\.timeout\(FAST_LLM_TIMEOUT_MS\)\]\)/);
  });

  it("the adoption decision is taken before the user message is added (isAdoptable compares the array the draft saw)", () => {
    const hus = src.slice(src.indexOf("async function handleUserSpeech("), src.indexOf("async function hangUpAfterEndCall("));
    const begin = hus.indexOf("fastTurn = session.fastPath ? beginFastTurn(session, transcript) : null;");
    assert.ok(begin > 0 && begin < hus.indexOf('session.addMessage("user", transcript);'));
  });

  it("one tool loop: the fast path did not duplicate it", () => {
    assert.equal((src.match(/session\.toolCallAudit\.push\(auditEntry\)/g) || []).length, 2, "Gemini + classic");
    assert.equal((src.match(/checkEndCallGuard\(/g) || []).length, 1);
  });

  it("call-logger merges the fast-path summary into calls.metadata", () => {
    const logger = fs.readFileSync(path.join(__dirname, "..", "lib", "call-logger.js"), "utf8");
    assert.match(logger, /\.\.\.\(fastPath && \{ fastPath \}\),/);
    assert.match(cleanup, /fastPath: fastPathSummary,/);
  });
});
