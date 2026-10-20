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

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

const { CallSession } = require("../call-session");
const toolExecutor = require("../services/tool-executor");
const { chunkAudioForTwilio } = require("../services/deepgram-tts");
const { boostAura } = require("../lib/aura-gain");
const { forwardingFallbackEligible } = require("../lib/transfer-eligibility");
const { buildOwnerTools } = require("../lib/owner-tools");
const { runOwnerToolCall, OWNER_MAX_TOOL_CALLS, ownerToolLoopReply, buildOwnerCallSummary, settleOwnerToolRuns } = require("../lib/owner-tool-runner");
const { noteAssistantSpeech, noteAssistantTurnEnd } = require("../lib/owner-turn-stamps");
const { checkEndCallGuard } = require("../lib/end-call-guard");
const { createFastPlayer } = require("../lib/fast-player");
const { createFastTurnEngine, endsWithQuestion, isBackchannel, isLikelyEcho } = require("../lib/fast-turns");
const { createNoTurnWatchdog } = require("../lib/no-turn-watchdog");
const { startSpeculativeReply } = require("../lib/speculative-reply");
const { maskPhone } = require("../lib/mask-phone");
const { applyLanguageSwitch, planLanguageSwitch, recordLanguageSwitch, setLanguageToolDefinition, unspeakableText, UNSPEAKABLE_APOLOGY, FLUX_MULTI_MODEL, fastLanguagesEnabled, LANGUAGE_UNHEARD_MESSAGE, detectCallerLanguage, detectCallerEnglish, asksInLanguage, namesLanguage, FAST_LANGUAGES } = require("../lib/fast-languages");

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

/** server.js's FAST_VOICE_ADDENDUM (phone test F3/F5) and the fast path's conversation settings (PHASE 2), evaluated from its own text. */
const { FAST_VOICE_ADDENDUM, FAST_MAX_MESSAGES, applyFastConversationSettings } = runSlice({
  from: "const FAST_VOICE_ADDENDUM = [",
  to: "// Gate B: speculative drafts",
  scope: { fastLanguagesEnabled },
  names: ["FAST_VOICE_ADDENDUM", "FAST_MAX_MESSAGES", "applyFastConversationSettings"],
});
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

/**
 * Every fast path a test starts, so a test that fails before its own cleanup
 * cannot leave a watchdog timer running and hold the file open.
 * @type {Array<() => void>}
 */
const openFastPaths = [];
after(() => {
  for (const close of openFastPaths.splice(0)) close();
});
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
    getErrorMsg: (lang, key) => (o.errorMsgWithLang ? `ERR:${lang}:${key}` : `ERR:${key}`),
    detectExpectedInput: (t) => o.expectNext || (o.realDetector ? require("../lib/input-type-detector").detectExpectedInput(t) : "general"),
    logTranscript: (label, text) => lines.push(`log| ${label}: [${(text || "").length} chars]`),
    bookingKey: () => "k",
    classifyRebookAttempt: () => ({ kind: "duplicate" }),
    CORRECTION_ERROR_MESSAGE: "correction failed",
    DUPLICATE_REBOOK_MESSAGE: "duplicate",
    Sentry: {
      withScope: (fn) => {
        const tags = {};
        let extras = {};
        /** @type {string|undefined} */
        let scopeLevel;
        fn({ setTag: (k, v) => { tags[k] = v; }, setExtras: (e) => { extras = { ...extras, ...e }; }, setExtra: (k, v) => { extras[k] = v; }, setLevel: (l) => { scopeLevel = l; } });
        if (sentry.length && !sentry.at(-1).tags) Object.assign(sentry.at(-1), { tags, extras, scopeLevel });
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
      const delay = o.restDelayFor ? o.restDelayFor(text) : o.restDelayMs;
      if (delay) await sleep(delay);
      if (o.restFails) throw new Error("Deepgram TTS error 500");
      if (o.restFailsFor?.(text, options)) throw new Error(o.restFailMessage || "Deepgram TTS error 400: unknown voice");
      return Buffer.alloc(o.restBytes ?? 800, 0x7f);
    },
    chunkAudioForTwilio,
    boostAura,
    generateHoldAudio: () => (o.holdAudio ? Buffer.alloc(320, 0x55) : null),
    // ── the fast path ──
    openFluxStream: (apiKey, callbacks, options) => {
      const handle = {
        readyState: 0,
        frames: [],
        closes: 0,
        lastMessageAt: Date.now(),
        lastSendAt: 0,
        send(buf) { if (this.readyState !== 1) return false; this.frames.push(buf); this.lastSendAt = Date.now(); return true; },
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
        ready: o.auraReady ?? Promise.resolve(),
        spoken: [],
        flushes: [],
        clears: 0,
        closes: 0,
        nextSeq: 0,
        refuse: false,
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
    endsWithQuestion,
    isBackchannel,
    isLikelyEcho,
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
    FAST_TURN_START_WAIT_MS: o.turnStartWaitMs ?? 2000,
    FAST_TURN_START_POLL_MS: o.turnStartPollMs ?? 5,
    FAST_LOST_MARK_MS: o.lostMarkMs ?? 60_000,
    FAST_FLUSH_WATCHDOG_MS: o.flushWatchdogMs ?? 60_000,
    FLUX_SILENCE_MS: o.fluxSilenceMs ?? 60_000,
    FLUX_WATCHDOG_TICK_MS: o.fluxTickMs ?? 1000,
    FAST_DISCLOSURE_MARK: "fast-disclosure",
    AURA_OPEN_TIMEOUT_MS: o.auraOpenTimeoutMs ?? 60_000,
    FAST_RESPEAK_MS_PER_CHAR: 75,
    FAST_QUESTION_MS_PER_CHAR: 95,
    FAST_REPROMPT_MS: o.repromptMs ?? 60_000,
    FAST_DRAFTS_PER_TURN: o.draftsPerTurn ?? 2,
    FAST_DRAFTS_PER_CALL: o.draftsPerCall ?? 60,
    createNoTurnWatchdog: o.createNoTurnWatchdog || createNoTurnWatchdog,
    getTransfer: o.getTransfer || (() => null),
    // SCRUM-594 (F5): the call's languages
    applyLanguageSwitch,
    detectCallerLanguage,
    detectCallerEnglish,
    asksInLanguage,
    namesLanguage,
    FAST_LANGUAGES,
    planLanguageSwitch,
    recordLanguageSwitch,
    LANGUAGE_UNHEARD_MESSAGE,
    setLanguageToolDefinition,
    unspeakableText,
    UNSPEAKABLE_APOLOGY,
    FLUX_MULTI_MODEL,
    console: recordingConsole(lines),
  };
  const names = ["handleUserSpeech", "buildLLMOptions", "sendTTS", "sendRestTTS", "sendClear", "startFastPath", "closeFastPath", "onFastMark", "onFastRestMark", "settleFastAudio", "fastFlush", "summarizeFastCall",
    "beginFastDisclosure", "armFastDisclosureEnd", "endFastDisclosure", "noteFastRestSpeech", "noteFastInboundAudio", "beginFastTurn"];
  const fns = runSlice({
    from: "function buildLLMOptions(session, { includeTransfer = false } = {}) {",
    to: "// --- Test Call WebSocket (/ws/test) ---",
    scope,
    // A name server.js does not define comes back undefined, so only the tests that use it fail.
    wrap: (code) => `${code}\nreturn { ${names.map((n) => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(", ")} };`,
  });

  /** Start the fast path on `session` as the classic block does; Nova is a recording stub. */
  function start(session) {
    openFastPaths.push(() => {
      fns.closeFastPath(session);
      clearTimeout(session._speakingTimeout); // the REST path's 20 s isSpeaking backstop
    });
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
    assert.match(src, /const \{ createFastTurnEngine, endsWithQuestion, isBackchannel, isLikelyEcho \} = require\("\.\/lib\/fast-turns"\);/);
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
      startFastPath: (...args) => {
        openFastPaths.push(() => h.closeFastPath(session));
        return h.startFastPath(...args);
      },
      DEEPGRAM_API_KEY: "dg-key",
      applyFastConversationSettings,
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
    // SCRUM-594 (F5): with languages on (the default), Flux Multilingual hinted to English.
    assert.deepEqual(f.options, { host: AU_HOST, industry: "dental", eotThreshold: 0.7, eagerEotThreshold: 0.4, eotTimeoutMs: 5000, model: "flux-general-multi", languageHints: ["en"] });
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
        sendRestTTS: h.sendRestTTS,
        settleFastAudio: h.settleFastAudio,
        fastFlush: h.fastFlush,
        beginFastDisclosure: h.beginFastDisclosure,
        armFastDisclosureEnd: h.armFastDisclosureEnd,
        endFastDisclosure: h.endFastDisclosure,
        noteFastRestSpeech: h.noteFastRestSpeech,
        setTimeout: () => {}, // the greeting's 20 s isSpeaking backstop
        console: recordingConsole(h.lines),
      },
      wrap: (code) => code,
    });
  }

  it("a disclosure that falls back goes over REST even with the Aura stream open (R12d′): its frames, then the greeting's, and it is played only once sent", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await sendGreeting(h, s);
    assert.deepEqual(h.lastAura().handle.spoken, [], "not on the Aura stream");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["This call is recorded."]);
    const payloads = h.twilio("media").map((m) => Buffer.from(m.media.payload, "base64")[0]);
    const firstGreeting = payloads.indexOf(0x11);
    assert.ok(firstGreeting > 0 && payloads.slice(0, firstGreeting).every((b) => b === 0x7f) && payloads.slice(firstGreeting).every((b) => b === 0x11),
      `disclosure frames, then greeting frames: ${payloads.map((b) => b.toString(16)).join(" ")}`);
    assert.deepEqual(h.marks(), ["tts-done", "fast-disclosure", "tts-done"], "the disclosure's tts-done, its own mark, then the greeting's tts-done");
    assert.equal(h.engines[0].getState().aiSpeakingText, "This call is recorded. Thanks for calling!", "the echo filter hears both");
    assert.equal(s.recordingDisclosurePlayed, true);
    assert.equal(s.fastState.disclosureActive, true, "until its mark is back");
    h.onFastMark(s, "fast-disclosure");
    assert.equal(s.fastState.disclosureActive, false);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("a pre-synthesised disclosure on the fast path is not cut until its own mark is back, and the echo filter hears it and the greeting", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await sendGreeting(h, s, { disclosureAudio: Buffer.alloc(320, 0x22) });
    const firstBytes = h.twilio("media").map((m) => Buffer.from(m.media.payload, "base64")[0]);
    assert.ok(firstBytes.includes(0x22) && firstBytes.every((b) => b === 0x22 || b === 0x11), "pre-synthesised audio goes out as synthesizeSpeech returned it (no second gain)");
    assert.deepEqual(h.marks(), ["tts-done", "fast-disclosure", "tts-done"]);
    assert.equal(s.recordingDisclosurePlayed, true);
    assert.equal(s.fastState.disclosureActive, true);
    assert.equal(h.engines[0].getState().aiSpeakingText, "This call is recorded. Thanks for calling!");
    const clears = h.twilio("clear").length;
    h.sendClear(s, h.twilioWs);
    assert.equal(h.twilio("clear").length, clears, "not cleared");
    h.onFastMark(s, "fast-disclosure");
    assert.equal(s.fastState.disclosureActive, false);
    h.closeFastPath(s);
  });

  it("a disclosure whose stream closed before its frames went out is not marked played", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const sending = sendGreeting(h, s, { greetingAudio: null });
    h.twilioWs.readyState = 3; // the caller hung up while it synthesised
    await sending;
    assert.equal(s.recordingDisclosurePlayed, false);
    assert.equal(s.recordingDisclosureFailed, true);
    assert.equal(s.fastState.disclosureActive, false);
    h.closeFastPath(s);
  });

  it("a greeting that falls back to the Aura stream is flushed (its last words are released)", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await sendGreeting(h, s, { disclosureAudio: null, greetingAudio: null });
    assert.deepEqual(h.lastAura().handle.spoken, ["Thanks for calling!"]);
    assert.equal(h.lastAura().handle.flushes.length, 1);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("media frames go to the Flux handle exactly as they went to Nova (spec 4.8.2)", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    runSlice({
      from: 'case "media": {',
      to: 'case "mark": {',
      scope: { session: s, msg: { event: "media", media: { payload: Buffer.from([1, 2, 3]).toString("base64") } }, WebSocket: { OPEN: 1 }, console: recordingConsole(h.lines), noteFastInboundAudio: h.noteFastInboundAudio },
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
    h.audio(2);
    assert.equal(s.isSpeaking, true, "from its first audio, before any Flushed");
    h.audio(0, 0);
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
    h.fastFlush(s);
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
    assert.deepEqual(h.engines[0].getState(), { aiSpeaking: false, processing: true, expectedInputType: "phone", aiSpeakingText: "", aiRemainingMs: null, questionAudioStartAt: null });
    h.closeFastPath(s);
  });

  it("the Twilio mark handler sends fast-* marks to the player and leaves tts-done as it was", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const seen = [];
    const handle = (name, session = s) => runSlice({
      from: 'case "mark": {',
      to: 'case "stop": {',
      scope: { session, msg: { event: "mark", mark: { name } }, onFastMark: (sess, n) => { seen.push(n); h.onFastMark(sess, n); }, onFastRestMark: h.onFastRestMark },
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
    // R12d′: on the fast path a tts-done ends isSpeaking only once no other audio plays.
    h.noteFastRestSpeech(s, "This call is recorded.", 2000);
    h.noteFastRestSpeech(s, "Hi, this is Sam.", 2000);
    handle("tts-done");
    assert.equal(s.isSpeaking, true, "the greeting is still playing");
    handle("tts-done");
    assert.equal(s.isSpeaking, false);
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
    for (const seq of a.flushes) h.lastAura().options.onFlushed(seq); // Aura is done with that turn
    // The budget runs out: the turn still completes.
    a.refuse = true;
    h.steps.push({ sentences: ["Anything else?"], content: "Anything else?" });
    await h.handleUserSpeech(s, h.twilioWs, "Great, thanks for that.");
    assert.ok(a.spoken.includes("Anything else?"));
    assert.equal(h.lines.filter((l) => l.includes("[FastPath] Aura flush refused")).length, 1);
    h.closeFastPath(s);
  });

  it("phone test F7 (test review): server.js imports the boost it calls", () => {
    assert.match(src, /\nconst \{ boostAura \} = require\("\.\/lib\/aura-gain"\);\n/);
    assert.match(src, /session\.fastPlayer\.push\(boostAura\(audio, voice\)\);/);
  });

  it("phone test F7: Aura's audio reaches Twilio boosted to line level (lib/aura-gain.js)", async () => {
    const ambient = process.env.AURA_GAIN_DB;
    delete process.env.AURA_GAIN_DB; // the shipped default, whatever the developer's shell says
    try {
      const h = makeFast();
      const s = h.start(makeSession());
      await h.sendTTS(s, h.twilioWs, "Sure, Tuesday at ten.");
      h.fastFlush(s);
      const before = h.twilio("media").length;
      h.audio(1);
      const sent = Buffer.concat(h.twilio("media").slice(before).map((m) => Buffer.from(m.media.payload, "base64")));
      assert.equal(sent.length, 320, "both frames of the 40 ms chunk went out");
      assert.deepEqual(sent, boostAura(FRAME));
      assert.notDeepEqual(sent, FRAME, "not the raw bytes");
      h.closeFastPath(s);
    } finally {
      if (ambient === undefined) delete process.env.AURA_GAIN_DB;
      else process.env.AURA_GAIN_DB = ambient;
    }
  });

  it("phone test F9: the stream's audio is boosted for the voice it opened with, whatever the session's voice turns to later", async () => {
    const ambient = process.env.AURA_GAIN_DB;
    delete process.env.AURA_GAIN_DB; // the shipped default, whatever the developer's shell says
    try {
      const h = makeFast();
      const session = makeSession();
      session.deepgramVoice = "aura-2-orion-en"; // a louder voice: +4.5 dB, not the base +6
      const s = h.start(session);
      assert.equal(h.lastAura().options.voice, "aura-2-orion-en");
      await h.sendTTS(s, h.twilioWs, "Sure, Tuesday at ten.");
      h.fastFlush(s);
      s.deepgramVoice = "aura-2-selena-es"; // an open stream's voice never changes
      const everyCode = Buffer.from(Array.from({ length: 320 }, (_, i) => i & 0xff));
      const before = h.twilio("media").length;
      h.lastAura().options.onAudio(everyCode);
      const sent = Buffer.concat(h.twilio("media").slice(before).map((m) => Buffer.from(m.media.payload, "base64")));
      assert.deepEqual(sent, boostAura(everyCode, "aura-2-orion-en"));
      assert.notDeepEqual(sent, boostAura(everyCode), "not the base gain");
      assert.notDeepEqual(sent, boostAura(everyCode, "aura-2-selena-es"), "not the session's later voice");
      h.closeFastPath(s);
    } finally {
      if (ambient === undefined) delete process.env.AURA_GAIN_DB;
      else process.env.AURA_GAIN_DB = ambient;
    }
  });

  it("phone test F7 (test review): every Aura frame is boosted whatever its size, and in every utterance (not just the first frame)", async () => {
    const ambient = process.env.AURA_GAIN_DB;
    delete process.env.AURA_GAIN_DB; // F9 test review: the shipped default, whatever the developer's shell says
    const h = makeFast();
    const s = h.start(makeSession());
    const aura = () => h.lastAura().options;
    // The frame sizes Aura really sends (290 / 320 / 30 bytes); together 960 bytes = 6 whole Twilio frames.
    const frames = [Buffer.alloc(290, 0x7e), Buffer.alloc(320, 0x8a), Buffer.alloc(30, 0x7d), Buffer.alloc(320, 0xa0)];
    const sentSince = (before) => Buffer.concat(h.twilio("media").slice(before).map((m) => Buffer.from(m.media.payload, "base64")));
    for (const utterance of [1, 2]) {
      await h.sendTTS(s, h.twilioWs, `Sure, part ${utterance}.`);
      const seq = h.fastFlush(s);
      const before = h.twilio("media").length;
      for (const frame of frames) aura().onAudio(frame);
      assert.deepEqual(sentSince(before), boostAura(Buffer.concat(frames)), `utterance ${utterance}`);
      assert.notDeepEqual(sentSince(before), Buffer.concat(frames), "boosted, not the raw bytes");
      aura().onFlushed(seq); // Aura is done: the utterance is marked and the next one starts clean
    }
    h.closeFastPath(s);
    if (ambient === undefined) delete process.env.AURA_GAIN_DB;
    else process.env.AURA_GAIN_DB = ambient;
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

  it("phone test F6: a fast turn plays no hold audio, so nothing is cleared before its words", async () => {
    const h = makeFast({
      holdAudio: true,
      steps: [{ tools: [{ name: "check_availability", args: {} }] }, { sentences: ["Ten is free."], content: "Ten is free." }],
    });
    const holdFrames = () => h.twilio("media").filter((m) => Buffer.from(m.media.payload, "base64")[0] === 0x55).length;
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "Is Tuesday free at all?");
    assert.equal(holdFrames(), 0, "no brown noise before the reply");
    assert.equal(h.twilio("clear").length, 0, "no Twilio clear at the turn's first words");
    assert.equal(h.lastAura().handle.clears, 0, "no Aura Clear either");
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
    h.turn("Update", 1, "no wait actually");
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
    assert.ok(!h.lines.some((l) => l.includes("[Filler]")), "the timer does not even queue it");
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
    const clears = h.twilio("clear").length;
    h.turn("EndOfTurn", 1, "and what about Saturdays");
    assert.equal(h.twilio("clear").length, clears + 1, "the player's Twilio clear");
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
    const m = lines[0].match(/^log\| \[FastTurn\] callSid=CA-fast trigger=model spec=adopted eot_to_llm=(\d+) eot_to_audio=(\d+) eager_lead=(\d+) waited=0$/);
    assert.ok(m, lines[0]);
    // Timers may fire a millisecond or two early: a little under the sleeps (gate N7).
    assert.ok(Number(m[2]) >= 8, `eot_to_audio runs to the first audio byte: ${m[2]}`);
    assert.ok(Number(m[3]) >= 13, `eager_lead is EagerEndOfTurn to EndOfTurn: ${m[3]}`);
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
    h.lastAura().options.onFlushed(0); // Aura is done with turn 0 (and sent no audio)
    h.turn("EagerEndOfTurn", 1, "second");
    await settle();
    h.turn("EndOfTurn", 1, "second question");
    await until(() => !s.isProcessing && h.llmCalls.length === 3, "turn 1");
    h.audio(1, 0);
    const lines = h.lines.filter((l) => l.includes("[FastTurn]"));
    assert.equal(lines.length, 2, h.lines.join("\n"));
    assert.match(lines[0], /trigger=model spec=none eot_to_llm=\d+ eot_to_audio=- eager_lead=- waited=0$/);
    assert.match(lines[1], /trigger=model spec=discarded eot_to_llm=\d+ eot_to_audio=\d+ eager_lead=\d+ waited=0$/);
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
    h.audio(1, 0); // the tool filler's audio, and its Flushed
    h.audio(1); // the reply's first audio
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
    assert.ok(h.lines.some((l) => /\[FastTurn\] callSid=CA-fast trigger=buffered spec=none eot_to_llm=\d+ eot_to_audio=\d+ eager_lead=- waited=0$/.test(l)), h.lines.join("\n"));
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
    assert.equal(fastPath.llmErrors, 0);
    assert.equal(line, `log| [FastCall] callSid=CA-fast turns=2 eot_to_audio_p50=${fastPath.eotToAudioP50} p90=${fastPath.eotToAudioP90} spec_adopted=1 spec_discarded=0 llm_errors=0 stt=flux tts=stream`);
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
    assert.deepEqual(h.summarizeFastCall(s), { turns: 0, eotToAudioP50: null, eotToAudioP90: null, specAdopted: 0, specDiscarded: 0, llmErrors: 0, stt: "nova-fallback", tts: "rest-fallback" });
    assert.ok(h.lines.includes("log| [FastCall] callSid=CA-fast turns=0 eot_to_audio_p50=- p90=- spec_adopted=0 spec_discarded=0 llm_errors=0 stt=nova-fallback tts=rest-fallback"), h.lines.join("\n"));
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

// ─── Task 5 review, fix round 1 ─────────────────────────────────────────────

/** A reply on the stream with audio playing; `flushed`: Aura has also sent all of it (its Flushed is back). */
async function replyPlaying(h, s, text, { flushed = true } = {}) {
  await h.sendTTS(s, h.twilioWs, text);
  const seq = h.fastFlush(s);
  h.audio(2);
  if (flushed) h.lastAura().options.onFlushed(seq);
  return seq;
}

describe("SCRUM-594 review IMPORTANT: Aura owes the words it has not sent audio for yet", () => {
  it("a mark that returns between a reply's speak and its audio keeps the reply in the echo filter, and a barge-in then Clears Aura", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await replyPlaying(h, s, "One moment."); // a filler, all sent
    assert.deepEqual(h.marks(), ["fast-1"]);
    await h.sendTTS(s, h.twilioWs, "Tuesday at ten works for us."); // the reply: no audio yet
    h.onFastMark(s, "fast-1"); // the filler's mark returns: the player is idle
    assert.equal(s.fastPlayer.isPlaying(), false);
    assert.match(h.engines[0].getState().aiSpeakingText, /Tuesday at ten works for us\./, "the reply is still owed: its words stay");
    h.sendClear(s, h.twilioWs);
    assert.equal(h.lastAura().handle.clears, 1, "the barge-in Clears what Aura still owes");
    h.closeFastPath(s);
  });

  it("two marks out: the first echo keeps the text, the second (idle, nothing owed) clears it", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await replyPlaying(h, s, "Let me check.");
    await replyPlaying(h, s, "Ten is free.");
    assert.deepEqual(h.marks(), ["fast-1", "fast-2"]);
    h.onFastMark(s, "fast-1");
    assert.equal(h.engines[0].getState().aiSpeakingText, "Let me check. Ten is free.", "still playing: kept");
    assert.equal(s.isSpeaking, true);
    h.onFastMark(s, "fast-2");
    assert.equal(h.engines[0].getState().aiSpeakingText, "");
    assert.equal(s.isSpeaking, false);
    h.closeFastPath(s);
  });

  it("a Flushed that comes back after the player's last mark clears the text then (nothing plays, nothing owed)", async () => {
    const h = makeFast({ quietMs: 20 });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Sure thing.");
    const seq = h.fastFlush(s);
    h.audio(1);
    await until(() => h.marks().length === 1, "the quiet timer's mark");
    echoMarks(h, s);
    assert.equal(s.isSpeaking, false);
    assert.equal(h.engines[0].getState().aiSpeakingText, "Sure thing.", "its Flushed is not back: still owed");
    h.lastAura().options.onFlushed(seq);
    assert.equal(h.engines[0].getState().aiSpeakingText, "");
    assert.equal(s.isSpeaking, false);
    h.closeFastPath(s);
  });

  it("a flushed reply whose Flushed is not back is owed too (the Clear covers it)", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await replyPlaying(h, s, "Sure, Tuesday works.", { flushed: false });
    h.sendClear(s, h.twilioWs);
    assert.equal(h.lastAura().handle.clears, 1);
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 review R12a′/R13: short turns, backchannels and echo on the fast path (run for real)", () => {
  it('"No worries" while the AI speaks: nothing is cut, nothing is answered', async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "One moment, let me check that.", { flushed: false });
    const clears = h.twilio("clear").length;
    h.turn("StartOfTurn", 0, "No");
    h.turn("Update", 0, "No worries");
    h.turn("EndOfTurn", 0, "No worries.");
    await settle();
    assert.equal(h.twilio("clear").length, clears, "no barge-in");
    assert.equal(h.lastAura().handle.clears, 0);
    assert.equal(h.llmCalls.length, 0, "not answered");
    assert.ok(h.lines.some((l) => l.startsWith("log| [STT] Dropped (backchannel while the AI is busy)")), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it('"No worries" while the AI is thinking: the turn in flight goes on, nothing is queued', async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Can I book a cleaning please?");
    await settle();
    h.turn("StartOfTurn", 1, "No");
    h.turn("EndOfTurn", 1, "No worries.");
    assert.equal(h.llmCalls[0].opts.signal.aborted, false, "not aborted");
    assert.equal(s._pendingTranscript, null, "not queued");
    h.closeFastPath(s);
    await until(() => !s.isProcessing, "the turn, aborted by cleanup");
  });

  it('"No, wait" while the AI speaks: at its end, barge-in (the audio stops, Aura is Cleared) and it is answered', async () => {
    const h = makeFast({ steps: [{ sentences: ["Of course, take your time."], content: "Of course, take your time." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "We have Tuesday at ten or Wednesday at two.", { flushed: false });
    const clears = h.twilio("clear").length;
    h.turn("StartOfTurn", 0, "No");
    h.turn("Update", 0, "No, wait");
    assert.equal(h.twilio("clear").length, clears, "not on the Update");
    h.turn("EndOfTurn", 0, "No, wait.");
    assert.equal(h.twilio("clear").length, clears + 1);
    assert.equal(h.lastAura().handle.clears, 1);
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer");
    assert.deepEqual(h.llmCalls[0].messages.at(-1), { role: "user", content: "No, wait." });
    h.closeFastPath(s);
  });

  it('phone test F2: "Sorry?" over a long reply that says sorry: barge-in at its end, and it is answered without waiting for the reply', async () => {
    const h = makeFast({ steps: [{ sentences: ["I can take a message for Dave."], content: "I can take a message for Dave." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "I'm sorry, I can't make that change, because the details don't match the booking on file. I can take a message so Dave can ring you back and sort out the 10:30 time. Would you like me to do that?", { flushed: false });
    const clears = h.twilio("clear").length;
    h.turn("StartOfTurn", 0, "Sorry");
    h.turn("Update", 0, "Sorry?");
    assert.equal(h.twilio("clear").length, clears, "not on the Update");
    h.turn("EndOfTurn", 0, "Sorry?");
    assert.equal(h.twilio("clear").length, clears + 1, "the reply stops");
    assert.equal(h.lastAura().handle.clears, 1);
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer", 1_000); // no echo mark: the reply never finished
    assert.deepEqual(h.llmCalls[0].messages.at(-1), { role: "user", content: "Sorry?" });
    assert.ok(!h.lines.some((l) => l.includes("[STT] Dropped")), h.lines.join("\n"));
    h.audio(1);
    assert.match(String(h.lines.find((l) => l.startsWith("log| [FastTurn] callSid="))), / waited=0$/);
    h.closeFastPath(s);
  });

  it('"stop" while the AI is thinking: the turn in flight is aborted, and "stop" is answered next', async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5000, content: "never" }, { sentences: ["Okay."], content: "Okay." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Can I book a cleaning please?");
    await settle();
    h.turn("StartOfTurn", 1, "Stop");
    assert.equal(h.llmCalls[0].opts.signal.aborted, false, "judged at the end of the turn");
    h.turn("EndOfTurn", 1, "Stop.");
    assert.equal(h.llmCalls[0].opts.signal.aborted, true);
    await until(() => h.llmCalls.length === 2 && !s.isProcessing, "the answer to stop");
    assert.deepEqual(h.llmCalls[1].messages.at(-1), { role: "user", content: "Stop." });
    h.closeFastPath(s);
  });

  it("the AI's own words coming back while it speaks (R13) are dropped: no barge-in, no answer", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "I have Friday at ten available. Does that work for you?");
    const clears = h.twilio("clear").length;
    h.turn("Update", 0, "I have Friday at ten available");
    h.turn("EndOfTurn", 0, "I have Friday at ten available.");
    await settle();
    assert.equal(h.twilio("clear").length, clears);
    assert.equal(h.llmCalls.length, 0);
    assert.ok(h.lines.some((l) => l.startsWith("log| [STT] Dropped (echo-like: the AI's own words coming back)")), h.lines.join("\n"));
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 review R12b′: a fast turn waits for the AI to finish, it never cuts it off", () => {
  it("a short answer while the reply plays: no clear at the turn's start, and the LLM is asked only once the reply has played", async () => {
    const h = makeFast({ steps: [{ sentences: ["Great, Tuesday it is."], content: "Great, Tuesday it is." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "We have Tuesday or Wednesday. Which suits you?");
    const clears = h.twilio("clear").length;
    h.turn("EndOfTurn", 0, "Tuesday."); // a short content answer while the AI speaks: committed, no barge-in
    await sleep(30);
    assert.equal(s.isProcessing, true, "the turn has started");
    assert.equal(h.llmCalls.length, 0, "but waits for the AI's audio");
    assert.equal(h.twilio("clear").length, clears, "nothing is cut");
    echoMarks(h, s); // the reply has played
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer");
    assert.equal(h.twilio("clear").length, clears, "still nothing cleared");
    assert.ok(h.lines.some((l) => /^log\| \[FastTurn\] Waited \d+ ms for the AI to finish before answering/.test(l)), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("REST audio counts too (isSpeaking: the greeting, or replies after an Aura fallback)", async () => {
    const h = makeFast({ steps: [{ sentences: ["Hello!"], content: "Hello!" }] });
    const s = h.start(makeSession());
    h.lastAura().options.onError(new Error("aura down")); // REST from here on
    await h.sendTTS(s, h.twilioWs, "Thanks for calling, how can I help?");
    assert.equal(s.isSpeaking, true);
    assert.equal(h.engines[0].getState().aiSpeakingText, "Thanks for calling, how can I help?", "the echo filter hears REST audio too");
    const turn = h.handleUserSpeech(s, h.twilioWs, "Hi there, I need help");
    await sleep(30);
    assert.equal(h.llmCalls.length, 0, "waits for the REST audio");
    s.isSpeaking = false; // its tts-done is back: the classic handler, then onFastRestMark
    h.onFastRestMark(s);
    assert.equal(h.engines[0].getState().aiSpeakingText, "", "nothing plays, nothing owed");
    await within(turn, 1000, "the turn");
    assert.equal(h.llmCalls.length, 1);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("words Aura still owes (sent, no audio yet) count too: the turn waits for them to arrive and play", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We open at nine.");
    const seq = h.fastFlush(s); // the last turn's last flush point: no audio, no Flushed yet
    assert.equal(s.fastPlayer.isPlaying(), false);
    assert.equal(s.isSpeaking, false);
    const turn = h.handleUserSpeech(s, h.twilioWs, "Thanks, and on Saturday?");
    await sleep(30);
    assert.equal(h.llmCalls.length, 0, "waits for what Aura owes");
    h.audio(1, seq);
    await sleep(30);
    assert.equal(h.llmCalls.length, 0, "then for it to play");
    echoMarks(h, s);
    await within(turn, 1000, "the turn");
    assert.equal(h.llmCalls.length, 1);
    h.closeFastPath(s);
  });

  it("a caller who hangs up during the wait is not answered", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    await replyPlaying(h, s, "We have Tuesday or Wednesday.");
    const turn = h.handleUserSpeech(s, h.twilioWs, "Wednesday please, thanks");
    await sleep(20);
    h.twilioWs.readyState = 3;
    echoMarks(h, s);
    await within(turn, 1000, "the turn");
    assert.equal(h.llmCalls.length, 0);
    assert.equal(s.isProcessing, false);
    h.closeFastPath(s);
  });

  it("the wait is bounded: the turn starts anyway, and says so", async () => {
    const h = makeFast({ turnStartWaitMs: 40, holdAudio: true, steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const holdFrames = () => h.twilio("media").filter((m) => Buffer.from(m.media.payload, "base64")[0] === 0x55).length;
    const s = h.start(makeSession());
    await replyPlaying(h, s, "This is a very long reply that never finishes playing.");
    const clears = h.twilio("clear").length;
    await within(h.handleUserSpeech(s, h.twilioWs, "Hello, are you still there?"), 1000, "the bounded wait");
    assert.equal(h.llmCalls.length, 1);
    assert.ok(h.lines.some((l) => l.startsWith("warn| [FastTurn] The AI was still speaking after")), h.lines.join("\n"));
    // Phone test F6: no hold loop, so nothing cuts the AI's words still playing (R12b″).
    assert.equal(holdFrames(), 0);
    assert.equal(h.twilio("clear").length, clears, "no Twilio clear");
    assert.equal(h.lastAura().handle.clears, 0, "no Aura Clear");
    h.closeFastPath(s);
  });

  it("phone test F6: after a Nova fallback the turn plays no hold audio either", async () => {
    const h = makeFast({ holdAudio: true, steps: [{ tools: [{ name: "check_availability", args: {} }] }, { sentences: ["Ten is free."], content: "Ten is free." }] });
    const holdFrames = () => h.twilio("media").filter((m) => Buffer.from(m.media.payload, "base64")[0] === 0x55).length;
    const s = h.start(makeSession());
    h.lastFlux().callbacks.onError(new Error("flux down"));
    assert.equal(s.fastPath, "degraded-stt");
    await h.handleUserSpeech(s, h.twilioWs, "Is Tuesday free at all?");
    assert.equal(holdFrames(), 0);
    assert.equal(h.twilio("clear").length, 0, "no Twilio clear at the turn's first words");
    assert.equal(h.lastAura().handle.clears, 0);
    h.closeFastPath(s);
  });

  it("phone test F6 (gate review): after a Nova fallback, a reply Aura still owes is cleared when the next turn starts", async () => {
    // The hold loop's stop used to cut it at the next reply's first words; isSpeaking is false until Aura's first audio.
    const h = makeFast({ steps: [{ sentences: ["Thursday it is."], content: "Thursday it is." }] });
    const s = h.start(makeSession());
    h.lastFlux().callbacks.onError(new Error("flux down"));
    assert.equal(s.fastPath, "degraded-stt");
    await h.sendTTS(s, h.twilioWs, "Tuesday at ten is booked.");
    assert.equal(s.isSpeaking, false, "no audio from Aura yet");
    const clears = h.twilio("clear").length;
    await h.handleUserSpeech(s, h.twilioWs, "Actually, make it Thursday instead.");
    assert.equal(h.twilio("clear").length, clears + 1, "the stale reply is cut at the turn's start");
    assert.equal(h.lastAura().handle.clears, 1, "and Cleared from Aura");
    h.closeFastPath(s);
  });

  it("after a Nova fallback the turn-start clear is still the only barge-in: it clears at once, no wait", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.lastFlux().callbacks.onError(new Error("flux down"));
    assert.equal(s.fastPath, "degraded-stt");
    await replyPlaying(h, s, "We have Tuesday or Wednesday.");
    const clears = h.twilio("clear").length;
    const turn = h.handleUserSpeech(s, h.twilioWs, "Wednesday please, thanks");
    assert.equal(h.twilio("clear").length, clears + 1, "cleared at the turn's start");
    await turn;
    assert.equal(h.llmCalls.length, 1);
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 review R12d′: the recording disclosure is never cut, and REST audio is heard by the echo filter", () => {
  /** The disclosure, pre-synthesised, going out now (as the start handler sends it). */
  function disclosurePlaying(h, s, ms = 4000, restMs = ms) {
    h.beginFastDisclosure(s);
    h.noteFastRestSpeech(s, "This call is recorded for quality.", restMs);
    h.armFastDisclosureEnd(s, h.twilioWs, ms);
  }

  it("while it plays: no barge-in, no clear (hold audio's either), and a turn committed meanwhile waits for it", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure, how can I help?"], content: "Sure, how can I help?" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    disclosurePlaying(h, s);
    const clears = h.twilio("clear").length;
    h.turn("Update", 0, "hi I'm calling about my booking");
    h.sendClear(s, h.twilioWs); // what hold.stop() does
    assert.equal(h.twilio("clear").length, clears, "nothing clears the disclosure");
    assert.ok(h.lines.some((l) => l.includes("[Barge-in] (fast) ignored — the recording disclosure is playing")));
    h.turn("EndOfTurn", 0, "hi I'm calling about my booking for Tuesday");
    await sleep(30);
    assert.equal(h.llmCalls.length, 0, "the turn waits for the disclosure");
    s.isSpeaking = false; // its tts-done (the classic handler) ...
    h.onFastRestMark(s);
    await sleep(30);
    assert.equal(h.llmCalls.length, 0, "... but not its own mark: still waiting");
    h.onFastMark(s, "fast-disclosure");
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer, after the disclosure");
    h.closeFastPath(s);
  });

  it("a lost disclosure mark ends the window after its length plus FAST_LOST_MARK_MS", async () => {
    const h = makeFast({ lostMarkMs: 30 });
    const s = h.start(makeSession());
    // Its tts-done's own backstop (the REST audio) is set well after the disclosure's, so the
    // one lost-mark line (logged once per call) is the disclosure's, deterministically.
    disclosurePlaying(h, s, 10, 400);
    assert.equal(s.fastState.disclosureActive, true);
    await sleep(70);
    assert.equal(s.fastState.disclosureActive, false);
    assert.ok(h.lines.some((l) => l.includes("A playback mark (disclosure) never came back")), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("REST text joins the echo filter's text and clears on tts-done once nothing plays; a fast mark never ends REST audio's isSpeaking", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.noteFastRestSpeech(s, "Thanks for calling Smile Hub, this is Sam.", 3000); // the pre-synthesised greeting
    assert.match(h.engines[0].getState().aiSpeakingText, /Smile Hub/);
    await replyPlaying(h, s, "One moment.");
    h.onFastMark(s, "fast-1"); // the player is idle ...
    assert.equal(s.isSpeaking, true, "... but the greeting still plays");
    assert.match(h.engines[0].getState().aiSpeakingText, /Smile Hub/);
    s.isSpeaking = false; // the classic tts-done handler
    h.onFastRestMark(s);
    assert.equal(s.isSpeaking, false);
    assert.equal(h.engines[0].getState().aiSpeakingText, "");
    h.closeFastPath(s);
  });

  it("the disclosure's and the greeting's tts-done: isSpeaking holds until the second", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.noteFastRestSpeech(s, "This call is recorded.", 2000);
    h.noteFastRestSpeech(s, "Hi, this is Sam.", 2000);
    s.isSpeaking = false;
    h.onFastRestMark(s);
    assert.equal(s.isSpeaking, true, "the greeting is still playing");
    s.isSpeaking = false;
    h.onFastRestMark(s);
    assert.equal(s.isSpeaking, false);
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 review minors", () => {
  it("phone test F6: a Flux fast turn never starts the hold loop, not even while the model is slow", async () => {
    const h = makeFast({ holdAudio: true, steps: [{ firstDelayMs: 5000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "What are your opening hours on Saturday?");
    await settle();
    const holdFrames = () => h.twilio("media").filter((m) => Buffer.from(m.media.payload, "base64")[0] === 0x55).length;
    assert.equal(holdFrames(), 0, "no hold audio while the model thinks");
    h.turn("Update", 1, "sorry actually never mind that");
    await until(() => !s.isProcessing, "the aborted turn");
    await sleep(2100); // past the hold loop's 2 s period
    assert.equal(holdFrames(), 0, "and no loop started later");
    h.closeFastPath(s);
  });

  it("Minor 3: a player mark that never comes back counts as played after the estimate plus FAST_LOST_MARK_MS (logged once)", async () => {
    const h = makeFast({ lostMarkMs: 30 });
    const s = h.start(makeSession());
    await replyPlaying(h, s, "Sure."); // 80 ms of audio, its mark never echoed
    assert.equal(s.isSpeaking, true);
    await sleep(160);
    assert.equal(s.isSpeaking, false);
    assert.equal(h.engines[0].getState().aiSpeaking, false, "the engine no longer takes short answers for echo");
    await replyPlaying(h, s, "Anything else?");
    assert.equal(h.engines[0].getState().aiSpeaking, true, "new audio plays again");
    await sleep(160);
    assert.equal(h.lines.filter((l) => l.includes("A playback mark (player) never came back")).length, 1, "logged once");
    h.closeFastPath(s);
  });

  it("Minor 3: a lost REST tts-done is given up on too: isSpeaking and the echo text recover on their own", async () => {
    const h = makeFast({ lostMarkMs: 20 });
    const s = h.start(makeSession());
    h.noteFastRestSpeech(s, "Hi.", 10);
    assert.equal(h.engines[0].getState().aiSpeaking, true);
    await sleep(80); // past its estimated end plus FAST_LOST_MARK_MS, with no mark at all
    assert.equal(s.isSpeaking, false);
    assert.equal(h.engines[0].getState().aiSpeaking, false);
    assert.equal(h.engines[0].getState().aiSpeakingText, "");
    assert.ok(h.lines.some((l) => l.includes("A playback mark (tts-done) never came back")));
    h.closeFastPath(s);
  });

  it("Minor 3: a refused flush keeps its words owed only until Aura goes quiet", async () => {
    const h = makeFast({ quietMs: 20, steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    const a = h.lastAura().handle;
    await h.sendTTS(s, h.twilioWs, "We open at nine.");
    a.refuse = true;
    assert.equal(h.fastFlush(s), null, "the budget refuses it");
    h.audio(1); // its sentence is released anyway (the trailing space)
    await until(() => h.marks().length === 1, "the quiet timer's mark");
    echoMarks(h, s);
    assert.equal(h.engines[0].getState().aiSpeakingText, "", "Aura went quiet and the audio played: nothing owed");
    await within(h.handleUserSpeech(s, h.twilioWs, "And on Saturday?"), 1000, "a turn that does not wait");
    assert.equal(h.llmCalls.length, 1);
    h.closeFastPath(s);
  });

  it("Minor 3: a refused flush that never brings audio is not owed forever either", async () => {
    const h = makeFast({ quietMs: 20, steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Okay.");
    h.lastAura().handle.refuse = true;
    h.fastFlush(s);
    await sleep(60); // Aura stays quiet
    await within(h.handleUserSpeech(s, h.twilioWs, "Hello? Are you there?"), 1000, "a turn that does not wait");
    assert.equal(h.llmCalls.length, 1);
    h.closeFastPath(s);
  });

  it("a barge-in over REST audio (after an Aura fallback) ends it at once: the turn after it does not wait for its mark", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.lastAura().options.onError(new Error("aura down")); // REST from here on
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten or Wednesday at two.");
    h.sendClear(s, h.twilioWs); // the caller talked over it
    assert.equal(s.isSpeaking, false);
    assert.equal(h.engines[0].getState().aiSpeaking, false);
    await within(h.handleUserSpeech(s, h.twilioWs, "Actually, what about Friday?"), 1000, "a turn that does not wait for the cleared audio's mark");
    assert.equal(h.llmCalls.length, 1);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("Minor 5: REST audio synthesised for a turn that a barge-in has ended is never SENT (the filler's either)", async () => {
    const h = makeFast({ restDelayMs: 150, steps: [{ firstDelayMs: 1600, content: "never" }] });
    const s = h.start(makeSession());
    h.lastAura().options.onError(new Error("aura down")); // REST from here on
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Can you tell me your opening hours?");
    await until(() => h.calls.some((c) => c[0] === "synthesizeSpeech"), "the waiting filler synthesising", 3000);
    h.turn("Update", 1, "never mind just tell me the hours");
    await until(() => !s.isProcessing, "the aborted turn");
    await sleep(250); // past the filler's synthesis
    const restFrames = h.twilio("media").filter((m) => Buffer.from(m.media.payload, "base64")[0] === 0x7f);
    assert.equal(restFrames.length, 0, "no frame of the stale filler went out");
    h.closeFastPath(s);
  });

  it("Minor 6: a Flushed that is overdue with no audio means a stuck stream: REST for the rest of the call", async () => {
    const h = makeFast({ flushWatchdogMs: 40, steps: [{ sentences: ["Yes, I'm here."], content: "Yes, I'm here." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Hello there.");
    h.fastFlush(s);
    await sleep(80);
    assert.equal(s.fastTts, null);
    assert.ok(h.lines.some((l) => l.includes("[FastPath] Aura stream unavailable — falling back to REST TTS (no Flushed and no audio for")), h.lines.join("\n"));
    assert.equal(h.sentry.length, 1);
    assert.equal(h.sentry[0].tags.service, "aura-stream");
    // Gate H2: what it never voiced is said again over REST ...
    await until(() => h.calls.some((c) => c[0] === "synthesizeSpeech" && c[1] === "Hello there."), "the re-speak");
    await settle();
    s.isSpeaking = false; // ... and played (its tts-done)
    h.onFastRestMark(s);
    // The dead stream owes nothing any more: the next turn does not wait for it.
    await within(h.handleUserSpeech(s, h.twilioWs, "Hello, are you there?"), 1000, "the next turn");
    assert.equal(h.llmCalls.length, 1);
    assert.equal(h.sentry.length, 1, "one capture");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("Minor 6: audio still arriving keeps the flush watchdog quiet", async () => {
    const h = makeFast({ flushWatchdogMs: 40 });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "A long answer.");
    const seq = h.fastFlush(s);
    for (let i = 0; i < 6; i++) {
      await sleep(15);
      h.audio(1);
    }
    h.lastAura().options.onFlushed(seq);
    await sleep(80);
    assert.equal(s.fastTts, h.lastAura().handle);
    assert.equal(h.sentry.length, 0);
    h.closeFastPath(s);
  });

  it("Minor 6: no Flux frames for FLUX_SILENCE_MS while audio goes out means a stuck stream: Nova", async () => {
    const h = makeFast({ fluxSilenceMs: 40, fluxTickMs: 10 });
    const s = h.start(makeSession());
    h.fluxOpens();
    const f = h.lastFlux().handle;
    f.lastMessageAt = Date.now();
    for (let i = 0; i < 10 && s.fastPath === true; i++) {
      f.send(Buffer.alloc(160)); // Twilio's audio keeps going out
      await sleep(10);
    }
    assert.equal(s.fastPath, "degraded-stt");
    assert.equal(h.novaOpens.length, 1);
    assert.ok(h.lines.some((l) => /\[FastPath\] Flux unavailable — falling back to Nova \(no frames for \d+ ms while audio went out/.test(l)), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("Minor 6: frames still arriving, or no audio going out, keep the Flux watchdog quiet", async () => {
    const h = makeFast({ fluxSilenceMs: 200, fluxTickMs: 10 });
    const s = h.start(makeSession());
    h.fluxOpens();
    const f = h.lastFlux().handle;
    const started = Date.now();
    while (Date.now() - started < 320) { // audio goes out for longer than FLUX_SILENCE_MS ...
      f.send(Buffer.alloc(160));
      f.lastMessageAt = Date.now(); // ... and Flux answers every frame
      await sleep(10);
    }
    assert.equal(s.fastPath, true, "frames keep coming");
    f.lastMessageAt = Date.now() - 1000;
    f.lastSendAt = Date.now() - 1000; // and nothing is being sent: the caller's line went quiet
    await sleep(60);
    assert.equal(s.fastPath, true, "not sending audio: nothing to judge");
    f.send(Buffer.alloc(160)); // the caller's audio goes out again: Flux gets FLUX_SILENCE_MS of it to answer
    await sleep(25);
    f.send(Buffer.alloc(160));
    await sleep(15);
    assert.equal(s.fastPath, true, "a fresh streak of audio is judged afresh");
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 review: a barge-in's Clear and the flush waits", () => {
  it("a barge-in releases whoever waits for a Flushed at once: the Clear discards it (reviewer's X6)", async () => {
    const h = makeFast({ flushedWaitMs: 5000 });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Goodbye, have a great day.");
    const settled = h.settleFastAudio(s); // flushes, then waits for that flush's Flushed
    await settle();
    assert.deepEqual(h.lastAura().handle.flushes, [0]);
    h.sendClear(s, h.twilioWs);
    await within(settled, 200, "the wait, released by the Clear");
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 review Minor 7: the summary survives a transfer", () => {
  it("cleanup of a leg that is transferring hands its summary, and its pipeline (gate C7), to the pending transfer (finishTransferredCall writes them)", async () => {
    const saved = { callSid: "CA-fast" };
    const h = makeFast({ getTransfer: (sid) => (sid === "CA-fast" ? saved : null) });
    const s = h.start(makeSession());
    s.pendingTransfer = true;
    s.effectivePipeline = "classic-fast";
    s.orgPhoneNumber = "+61238205672";
    const { cleanupSession } = runSlice({
      from: "async function cleanupSession() {",
      to: 'twilioWs.on("message", async (raw) => {',
      scope: { session: s, cleaningUp: false, sessions: new Map(), closeFastPath: h.closeFastPath, summarizeFastCall: h.summarizeFastCall, getTransfer: (sid) => (sid === "CA-fast" ? saved : null), isDemoLineNumber: (n) => n === "+61238205672", console: recordingConsole(h.lines) },
      names: ["cleanupSession"],
    });
    await cleanupSession();
    assert.deepEqual(saved.fastPath, { turns: 0, eotToAudioP50: null, eotToAudioP90: null, specAdopted: 0, specDiscarded: 0, llmErrors: 0, stt: "flux", tts: "stream" });
    assert.equal(saved.pipeline, "classic-fast");
  });

  it("a leg reconnected after a failed dial writes the first leg's summary", () => {
    const s = new CallSession("CA-reconnected");
    s.restoreFrom({ messages: [], fastPath: { turns: 3 } });
    assert.deepEqual(s.carriedFastPath, { turns: 3 });
    const plain = new CallSession("CA-plain");
    plain.restoreFrom({ messages: [] });
    assert.equal(plain.carriedFastPath, null);
    assert.match(cleanup, /const fastPathSummary = s\.fastStats \? summarizeFastCall\(s\) : s\.carriedFastPath;/);
    // Gate C7: and the first leg's pipeline.
    const carried = new CallSession("CA-reconnected-2");
    carried.restoreFrom({ messages: [], pipeline: "classic-fast" });
    assert.equal(carried.carriedPipeline, "classic-fast");
    assert.equal(plain.carriedPipeline, null);
    assert.match(cleanup, /const pipelineServed = \(!s\.ownerMode && isDemoLineNumber\(s\.orgPhoneNumber\) \? s\.effectivePipeline : null\) \|\| s\.carriedPipeline \|\| null;/);
    assert.match(cleanup, /pipeline: pipelineServed,\n/);
  });
});

describe("SCRUM-594 fix round 2, R14: an answer at the end of a question is kept (run for real)", () => {
  it('"Yes" over the tail of "…Shall I book 10 AM?": nothing is cut, and it is answered once the question has played', async () => {
    const h = makeFast({ steps: [{ sentences: ["Great, you're booked."], content: "Great, you're booked." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "Shall I book 10 AM?");
    const clears = h.twilio("clear").length;
    await sleep(520); // R14″: the caller begins once the question is playing (StartOfTurn lags ~500 ms)
    h.turn("StartOfTurn", 0, "Yes");
    h.turn("EndOfTurn", 0, "Yes.");
    await sleep(30);
    assert.equal(h.twilio("clear").length, clears, "the question is not cut");
    assert.equal(h.lastAura().handle.clears, 0);
    assert.equal(h.llmCalls.length, 0, "answered only once the question has played");
    assert.ok(!h.lines.some((l) => l.includes("[STT] Dropped")), h.lines.join("\n"));
    echoMarks(h, s);
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer");
    assert.deepEqual(h.llmCalls[0].messages.at(-1), { role: "user", content: "Yes." });
    h.closeFastPath(s);
  });

  it('"Okay" over a statement is still dropped', async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "Tuesday works, let me check the times.");
    h.turn("EndOfTurn", 0, "Okay.");
    await settle();
    assert.equal(h.llmCalls.length, 0);
    assert.ok(h.lines.some((l) => l.startsWith("log| [STT] Dropped (backchannel while the AI is busy)")), h.lines.join("\n"));
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 fix round 3, R14′: the answer must land in the tail of the AI's question (run for real)", () => {
  it("getState().aiRemainingMs: the player's audio still to play; null when nothing was sent since idle, and while REST audio plays", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    assert.equal(h.engines[0].getState().aiRemainingMs, null, "nothing played yet");
    await h.sendTTS(s, h.twilioWs, "Shall I book 10 AM?");
    h.audio(2); // 2 × 320 bytes = 80 ms
    const remaining = h.engines[0].getState().aiRemainingMs;
    assert.ok(typeof remaining === "number" && remaining > 0 && remaining <= 80, String(remaining));
    h.noteFastRestSpeech(s, "Thanks for calling, how can I help?", 3_000); // REST audio is not in the player
    assert.equal(h.engines[0].getState().aiRemainingMs, null);
    h.closeFastPath(s);
  });

  it('"Okay" over the first sentence of a long reply that ends in a question is dropped (its question is 2.8 s away)', async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten or Wednesday at two, and Friday morning too. Which suits you better?");
    h.audio(70); // 70 × 320 bytes = 2800 ms of audio sent
    h.turn("EndOfTurn", 0, "Okay.");
    await settle();
    assert.equal(h.llmCalls.length, 0);
    assert.ok(h.lines.some((l) => l.startsWith("log| [STT] Dropped (backchannel while the AI is busy)")), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it('"Yes" over the REST greeting\'s question is dropped: what is still to play is unknown there', async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    h.noteFastRestSpeech(s, "Thanks for calling Copperline Plumbing, how can I help?", 3_000);
    h.turn("EndOfTurn", 0, "Yes.");
    await settle();
    assert.equal(h.llmCalls.length, 0);
    assert.ok(h.lines.some((l) => l.startsWith("log| [STT] Dropped (backchannel while the AI is busy)")), h.lines.join("\n"));
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 fix round 4, R12b″: the turn-start wait is part of the turn (run for real)", () => {
  it('"Hi." over the REST greeting, then the request barges in: "Hi." is never answered on its own, and the request is answered after it', async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure, I can book a cleaning."], content: "Sure, I can book a cleaning." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    s.isSpeaking = true; // the pre-synthesised greeting, as the start handler sends it
    h.noteFastRestSpeech(s, "Thanks for calling Smile Hub, this is Sam. How can I help you today?", 4000);
    h.turn("StartOfTurn", 0, "Hi");
    h.turn("EndOfTurn", 0, "Hi.");
    await sleep(30);
    assert.equal(s.isProcessing, true, "the turn waits for the greeting");
    assert.equal(h.llmCalls.length, 0);
    assert.ok(s.currentTurn && !s.currentTurn.over, "it is the session's turn: a barge-in can abort it");
    h.turn("StartOfTurn", 1, "I'd like");
    h.turn("Update", 1, "I'd like to book");
    await until(() => !s.isProcessing, "the waiting turn, aborted", 500);
    assert.equal(h.llmCalls.length, 0, "no reply to \"Hi.\" alone");
    assert.ok(h.twilio("clear").length >= 1, "the greeting was cut");
    h.turn("EndOfTurn", 1, "I'd like to book a cleaning please.");
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer to the request");
    assert.deepEqual(h.llmCalls[0].messages.slice(-2), [{ role: "user", content: "Hi." }, { role: "user", content: "I'd like to book a cleaning please." }]);
    assert.deepEqual(h.lastAura().handle.spoken, ["Sure, I can book a cleaning."], "nothing was said to \"Hi.\" alone");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("a short answer waiting for a long reply, then the caller goes on (3+ words): the wait is aborted, and one answer covers both", async () => {
    const h = makeFast({ holdAudio: true, steps: [{ sentences: ["Sure, Wednesday then."], content: "Sure, Wednesday then." }] });
    const holdFrames = () => h.twilio("media").filter((m) => Buffer.from(m.media.payload, "base64")[0] === 0x55).length;
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten or Wednesday at two, and Friday morning too.");
    const seq = h.fastFlush(s);
    h.audio(70, seq); // 2.8 s of audio
    h.turn("EndOfTurn", 0, "Tuesday.");
    await sleep(30);
    assert.equal(s.isProcessing, true, "waiting for the reply to finish");
    h.turn("StartOfTurn", 1, "Actually");
    h.turn("Update", 1, "Actually no Wednesday");
    await until(() => !s.isProcessing, "the waiting turn, aborted", 500);
    assert.equal(h.llmCalls.length, 0);
    assert.equal(holdFrames(), 0, "the aborted turn never started its hold audio");
    h.turn("EndOfTurn", 1, "Actually no, Wednesday is better.");
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer");
    assert.deepEqual(h.llmCalls[0].messages.slice(-2), [{ role: "user", content: "Tuesday." }, { role: "user", content: "Actually no, Wednesday is better." }]);
    assert.ok(h.lines.some((l) => l.includes("[FastTurn] Reply stopped (barge-in)")), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("the wait ends the moment its turn is aborted, not at its next poll", async () => {
    const h = makeFast({ turnStartPollMs: 5_000 });
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "We have Tuesday or Wednesday.");
    const turn = h.handleUserSpeech(s, h.twilioWs, "Wednesday please, thanks");
    await sleep(20);
    h.turn("Update", 0, "no actually make it Friday");
    await within(turn, 200, "the aborted wait");
    assert.equal(h.llmCalls.length, 0);
    assert.equal(s.isProcessing, false);
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 fix round 4, R14″: an answer must start after the question does (run for real)", () => {
  it("questionAudioStartAt: the question's audio starts after the audio in the player and the audio Aura still owes for the text before it", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const state = () => h.engines[0].getState();
    assert.equal(state().questionAudioStartAt, null);
    // A first sentence (23 chars) Aura has not voiced yet: its audio is estimated (FAST_TTS_MS_PER_CHAR).
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    let before = Date.now();
    await h.sendTTS(s, h.twilioWs, "Shall I book it?");
    let q = state().questionAudioStartAt;
    assert.ok(q >= before + 23 * 95 && q <= Date.now() + 23 * 95, `owed at FAST_QUESTION_MS_PER_CHAR: +${q - before}`);
    h.sendClear(s, h.twilioWs); // a barge-in: cleared with the text
    assert.equal(state().questionAudioStartAt, null);
    // Its audio already in the player (2 s, more than the estimate): the player's figure counts.
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    h.audio(75); // 3 s, more than the estimate (23 × 95 = 2185 ms)
    before = Date.now();
    await h.sendTTS(s, h.twilioWs, "Shall I book it?");
    q = state().questionAudioStartAt;
    assert.ok(q >= before + 2_900 && q <= Date.now() + 3_000, `queued: +${q - before}`);
    h.closeFastPath(s);
  });

  it("questionAudioStartAt: a chunk with a statement before its question counts the statement; it clears with the text", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const state = () => h.engines[0].getState();
    const before = Date.now();
    const seq = await (async () => { await h.sendTTS(s, h.twilioWs, "Tuesday works. Shall I book 10 AM?"); return h.fastFlush(s); })();
    const q = state().questionAudioStartAt;
    assert.ok(q >= before + 15 * 95 && q <= Date.now() + 15 * 95, `lead: +${q - before}`);
    await h.sendTTS(s, h.twilioWs, "Great.");
    assert.equal(state().questionAudioStartAt, q, "a statement after it leaves it (the text no longer ends with a question)");
    h.audio(1, seq);
    h.fastFlush(s);
    h.lastAura().options.onFlushed(1);
    echoMarks(h, s); // nothing plays, nothing owed
    assert.equal(state().aiSpeakingText, "");
    assert.equal(state().questionAudioStartAt, null);
    h.closeFastPath(s);
  });

  it('through server.js: an "Okay" begun at once is dropped; a "Yes" begun after the question started (+500 ms) is kept', async () => {
    const h = makeFast({ steps: [{ sentences: ["Great, you're booked."], content: "Great, you're booked." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Shall I book it?"); // the question alone: its audio starts now
    const seq = h.fastFlush(s);
    h.audio(50, seq); // 2 s of audio, all in the tail (R14′)
    h.turn("StartOfTurn", 0, "Okay");
    h.turn("EndOfTurn", 0, "Okay.");
    await settle();
    assert.ok(h.lines.some((l) => l.startsWith("log| [STT] Dropped (backchannel while the AI is busy)")), h.lines.join("\n"));
    assert.equal(s.isProcessing, false);
    await sleep(520);
    h.turn("StartOfTurn", 1, "Yes");
    h.turn("EndOfTurn", 1, "Yes.");
    await settle();
    assert.equal(s.isProcessing, true, "kept: it waits for the question to finish");
    echoMarks(h, s);
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer");
    assert.deepEqual(h.llmCalls[0].messages.at(-1), { role: "user", content: "Yes." });
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 fix round 4: Minors", () => {
  it("Minor #1: a barge-in declined during the disclosure is not spent: the same turn can still cut the greeting after it (logged once)", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.beginFastDisclosure(s);
    h.noteFastRestSpeech(s, "This call is recorded for quality.", 4000);
    h.armFastDisclosureEnd(s, h.twilioWs, 4000);
    h.turn("Update", 0, "hi I'm calling about my booking"); // declined: the disclosure is playing
    h.turn("Update", 0, "hi I'm calling about my booking for"); // asked again, declined again
    assert.equal(h.lines.filter((l) => l.includes("ignored — the recording disclosure is playing")).length, 1, h.lines.join("\n"));
    h.onFastMark(s, "fast-disclosure"); // the disclosure has played
    s.isSpeaking = false;
    h.onFastRestMark(s); // its tts-done
    s.isSpeaking = true;
    h.noteFastRestSpeech(s, "Thanks for calling Smile Hub, how can I help?", 3000); // the greeting
    const clears = h.twilio("clear").length;
    h.turn("Update", 0, "hi I'm calling about my booking for Tuesday and I need to move it");
    assert.equal(h.twilio("clear").length, clears + 1, "the same turn cuts the greeting");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("Minor #2: after a Nova fallback, a turn that starts during the disclosure clears nothing and leaves isSpeaking set", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.lastFlux().callbacks.onError(new Error("flux down"));
    assert.equal(s.fastPath, "degraded-stt");
    h.beginFastDisclosure(s);
    s.isSpeaking = true;
    h.noteFastRestSpeech(s, "This call is recorded.", 3000);
    h.armFastDisclosureEnd(s, h.twilioWs, 3000);
    const clears = h.twilio("clear").length;
    const turn = h.handleUserSpeech(s, h.twilioWs, "Hi, I need to book a cleaning");
    assert.equal(h.twilio("clear").length, clears, "nothing cleared");
    assert.equal(s.isSpeaking, true, "the disclosure still plays");
    await turn;
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("Minor #2: sendClear says whether it cleared: classic always does, a closed stream does not", () => {
    const h = makeFast();
    const classic = makeSession();
    assert.equal(h.sendClear(classic, h.twilioWs), true);
    assert.equal(h.twilio("clear").length, 1);
    assert.equal(h.sendClear(classic, { readyState: 3, send: () => assert.fail("a closed stream is not written") }), false);
  });

  it("nit: a flush that throws is treated as refused: its words are owed only until Aura goes quiet", async () => {
    const h = makeFast({ quietMs: 20 });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Okay.");
    h.lastAura().handle.flush = () => { throw new Error("socket gone"); };
    assert.equal(h.fastFlush(s), null);
    assert.equal(s.fastState.flushRefused, true);
    await sleep(60);
    assert.equal(s.fastState.unflushed, false, "Aura went quiet: nothing owed");
    assert.ok(h.lines.some((l) => l.includes("[FastPath] Aura flush threw")), h.lines.join("\n"));
    h.closeFastPath(s);
  });
});

// ─── The final gate: silent failures (H1-M5) and the draft cap (B) ───────────

describe("SCRUM-594 gate H1: a failing Claude pages, and is not counted as latency", () => {
  it("a failed fast turn is captured (claude-chat, warning); two in a row page (error); a good turn resets the run; llm_errors counts them", async () => {
    const h = makeFast({ steps: [
      { firstDelayMs: 5, throws: "Anthropic API error 401 (authentication_error)" },
      { firstDelayMs: 5, throws: "Anthropic API error 401 (authentication_error)" },
      { sentences: ["Sure."], content: "Sure." },
      { firstDelayMs: 5, throws: "Anthropic API error 529 (overloaded_error: Overloaded)" },
    ] });
    const s = h.start(makeSession());
    for (const said of ["Can I book a cleaning?", "Hello? Can I book one?", "Thanks, a cleaning please.", "And a check-up too?"]) {
      await h.handleUserSpeech(s, h.twilioWs, said);
      echoMarks(h, s);
    }
    const llm = h.sentry.filter((e) => e.tags?.service === "claude-chat");
    assert.deepEqual(llm.map((e) => e.scopeLevel), ["warning", "error", "warning"]);
    assert.equal(llm[0].extras.what, "fast turn failed (1 in a row)");
    assert.equal(llm[1].extras.what, "fast turn failed (2 in a row)");
    assert.equal(llm.every((e) => !("reason" in e.tags)), true, "a service tag only, never a reason tag");
    assert.equal(h.summarizeFastCall(s).llmErrors, 3);
    assert.ok(h.lines.some((l) => / llm_errors=3 /.test(l)), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("the apology after a failed turn is not the turn's latency: no eot_to_audio sample", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5, throws: "Anthropic API error 529 (overloaded_error: Overloaded)" }] });
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "Can I book a cleaning please?");
    assert.deepEqual(h.lastAura().handle.spoken, ["ERR:troubleRepeat"]);
    h.audio(2); // the apology's audio
    assert.equal(s.fastStats.current.speakAt, null);
    assert.equal(s.fastStats.current.audioAt, null);
    assert.deepEqual(s.fastStats.eotToAudioMs, []);
    h.closeFastPath(s);
  });

  it("the waiting filler is not the turn's latency either: its clock runs to the reply's audio", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 1_600, sentences: ["Tuesday at ten works."], content: "Tuesday at ten works." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Do you have anything on Tuesday?");
    await until(() => h.lastAura().handle.spoken.length === 1, "the waiting filler", 3_000);
    h.audio(1); // the filler's audio
    assert.equal(s.fastStats.current.audioAt, null, "not the reply");
    await until(() => h.lastAura().handle.spoken.length === 2, "the reply", 3_000);
    h.audio(1); // still the filler's (its Flushed is not back): not the reply's latency (gate N5)
    assert.equal(s.fastStats.current.audioAt, null);
    h.lastAura().options.onFlushed(0); // the filler's audio is all here
    h.audio(1); // the reply's
    assert.ok(s.fastStats.current.audioAt !== null);
    assert.ok(s.fastStats.current.audioAt - s.fastStats.current.eotAt >= 1_500, "measured to the reply");
    await until(() => !s.isProcessing, "the turn");
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 gate H2: an Aura failure mid-reply says the unvoiced reply again over REST", () => {
  it("nothing of it voiced: all of it is said again over REST, and its frames go out", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    await h.sendTTS(s, h.twilioWs, "Shall I book it?");
    h.lastAura().options.onError(new Error("aura socket error"));
    await until(() => h.calls.some((c) => c[0] === "synthesizeSpeech"), "the re-speak");
    await settle();
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["We have Tuesday at ten. Shall I book it?"]);
    assert.ok(h.twilio("media").some((m) => Buffer.from(m.media.payload, "base64")[0] === 0x7f), "its REST frames were sent");
    assert.ok(h.lines.some((l) => l.includes("[FastPath] Saying again over REST the 40 characters the Aura stream never voiced")), h.lines.join("\n"));
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("what a Flushed confirmed is not said again; only what came after it", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    const seq = h.fastFlush(s);
    h.audio(5, seq); // its audio, and its Flushed
    await h.sendTTS(s, h.twilioWs, "Shall I book it?");
    h.lastAura().options.onClose(1011, "internal", { initiatedByUs: false });
    await until(() => h.calls.some((c) => c[0] === "synthesizeSpeech"), "the re-speak");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["Shall I book it?"]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("a sentence whose audio arrived in full (at FAST_RESPEAK_MS_PER_CHAR, 75 ms a character) counts as voiced without its Flushed", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "Sure."); // 5 characters: 375 ms at 75 ms a character
    await h.sendTTS(s, h.twilioWs, "Shall I book it?");
    h.fastFlush(s);
    h.audio(2); // 2 × 320 bytes = 80 ms: not enough
    h.lastAura().options.onError(new Error("aura socket error"));
    await until(() => h.calls.some((c) => c[0] === "synthesizeSpeech"), "the re-speak");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["Sure. Shall I book it?"], "80 ms does not cover \"Sure.\"");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);

    const h2 = makeFast();
    const s2 = h2.start(makeSession());
    await h2.sendTTS(s2, h2.twilioWs, "Sure.");
    await h2.sendTTS(s2, h2.twilioWs, "Shall I book it?");
    h2.fastFlush(s2);
    h2.audio(10); // 10 × 320 bytes = 400 ms: "Sure." was voiced
    h2.lastAura().options.onError(new Error("aura socket error"));
    await until(() => h2.calls.some((c) => c[0] === "synthesizeSpeech"), "the re-speak");
    assert.deepEqual(h2.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["Shall I book it?"]);
    clearTimeout(s2._speakingTimeout);
    h2.closeFastPath(s2);
  });

  it("later REST speech waits for the re-speak: its frames follow the re-spoken reply's", async () => {
    // The re-speak synthesises slowly, the later sentence fast: only the wait keeps them in order.
    const h = makeFast({ restDelayFor: (text) => (text === "We have Tuesday at ten." ? 60 : 5), restBytes: 160 });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    h.lastAura().options.onError(new Error("aura socket error"));
    const later = h.sendTTS(s, h.twilioWs, "Anything else?");
    await later;
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["We have Tuesday at ten.", "Anything else?"]);
    assert.deepEqual(h.marks(), ["tts-done", "tts-done"]);
    assert.equal(h.lines.filter((l) => l.startsWith("log| [TTS] (")).length, 2);
    const order = h.lines.filter((l) => l.startsWith("log| [TTS] (")).map((l) => Number(/\((\d+)ms\)/.exec(l)[1]));
    assert.ok(order[0] >= 50, `the re-speak's synthesis was sent first: ${order}`);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("a barge-in while the re-speak synthesises: none of it is sent", async () => {
    const h = makeFast({ restDelayMs: 60 });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    h.lastAura().options.onError(new Error("aura socket error"));
    await sleep(10);
    h.sendClear(s, h.twilioWs);
    await sleep(80);
    assert.equal(h.twilio("media").filter((m) => Buffer.from(m.media.payload, "base64")[0] === 0x7f).length, 0);
    h.closeFastPath(s);
  });

  it("when it cannot be said (the stream is closing, or REST fails too), the next turn is told the caller did not hear it", async () => {
    const NOTE = { role: "system", content: "The caller did not hear your last reply; repeat the key point briefly." };
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    h.twilioWs.readyState = 2;
    h.lastAura().options.onError(new Error("aura socket error"));
    assert.deepEqual(s.messages.at(-1), NOTE);
    assert.equal(h.calls.filter((c) => c[0] === "synthesizeSpeech").length, 0);
    h.closeFastPath(s);

    const h2 = makeFast({ restFails: true });
    const s2 = h2.start(makeSession());
    await h2.sendTTS(s2, h2.twilioWs, "We have Tuesday at ten.");
    h2.lastAura().options.onError(new Error("aura socket error"));
    await until(() => s2.messages.at(-1)?.content === NOTE.content, "the note");
    assert.deepEqual(s2.messages.at(-1), NOTE);
    h2.closeFastPath(s2);
  });

  it("what a barge-in cleared is not said again (the caller interrupted it), nor what a refused flush let Aura voice", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    h.sendClear(s, h.twilioWs);
    h.lastAura().options.onError(new Error("aura socket error"));
    await settle();
    assert.equal(h.calls.filter((c) => c[0] === "synthesizeSpeech").length, 0, "cleared by the barge-in");
    h.closeFastPath(s);

    const h2 = makeFast({ quietMs: 20 });
    const s2 = h2.start(makeSession());
    await h2.sendTTS(s2, h2.twilioWs, "We have Tuesday at ten.");
    h2.lastAura().handle.refuse = true;
    h2.fastFlush(s2); // refused
    h2.audio(1);
    await sleep(50); // Aura went quiet: it voiced it
    h2.lastAura().options.onError(new Error("aura socket error"));
    await settle();
    assert.equal(h2.calls.filter((c) => c[0] === "synthesizeSpeech").length, 0, "voiced by sentence release");
    h2.closeFastPath(s2);
  });

  it("nothing owed (all of it Flushed): no re-speak and no note", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    h.audio(2, h.fastFlush(s));
    h.lastAura().options.onError(new Error("aura socket error"));
    await settle();
    assert.equal(h.calls.filter((c) => c[0] === "synthesizeSpeech").length, 0);
    assert.equal(s.messages.some((m) => m.role === "system" && m.content.includes("did not hear")), false);
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 gate M3: an Aura stream that never opens", () => {
  it("falls back to REST after AURA_OPEN_TIMEOUT_MS: one log, one aura-stream capture, tts=rest-fallback", async () => {
    const h = makeFast({ auraOpen: false, auraReady: new Promise(() => {}), auraOpenTimeoutMs: 30 });
    const s = h.start(makeSession());
    await sleep(60);
    assert.equal(s.fastTts, null);
    assert.equal(h.lines.filter((l) => l.includes("[FastPath] Aura stream unavailable — falling back to REST TTS (no open within 30 ms")).length, 1, h.lines.join("\n"));
    assert.equal(h.sentry.filter((e) => e.tags?.service === "aura-stream").length, 1);
    assert.equal(h.summarizeFastCall(s).tts, "rest-fallback");
    h.closeFastPath(s);
  });

  it("one that opens says so, and its deadline passes quietly", async () => {
    const h = makeFast({ auraOpenTimeoutMs: 30 });
    const s = h.start(makeSession());
    h.fluxOpens();
    await settle();
    assert.ok(h.lines.some((l) => l.startsWith("log| [FastPath] Aura connected (callSid=CA-fast)")), h.lines.join("\n"));
    await sleep(60);
    assert.equal(s.fastTts, h.lastAura().handle);
    assert.equal(h.sentry.length, 0);
    h.closeFastPath(s);
  });

  it("cleanup clears the deadline: no fallback after the call ended", async () => {
    const h = makeFast({ auraOpen: false, auraReady: new Promise(() => {}), auraOpenTimeoutMs: 30 });
    const s = h.start(makeSession());
    h.closeFastPath(s);
    await sleep(60);
    assert.equal(h.sentry.length, 0);
    assert.ok(!h.lines.some((l) => l.includes("no open within")));
  });
});

describe("SCRUM-594 gate M4a: a Flux fallback mid-request keeps the caller's words", () => {
  it("the words of the turn Flux had open are answered (trigger stt-fallback)", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure, when suits you?"], content: "Sure, when suits you?" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("StartOfTurn", 0, "I'd like");
    h.turn("Update", 0, "I'd like to book a cleaning");
    h.lastFlux().callbacks.onError(new Error("flux socket error"));
    assert.equal(s.fastPath, "degraded-stt");
    assert.equal(h.novaOpens.length, 1);
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer");
    assert.deepEqual(h.llmCalls[0].messages.at(-1), { role: "user", content: "I'd like to book a cleaning" });
    h.audio(1); // the reply's first audio: the turn's [FastTurn] line
    assert.ok(h.lines.some((l) => /\[FastTurn\] callSid=CA-fast trigger=stt-fallback /.test(l)), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("a turn that had started with no words yet: the caller is asked to say it again", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("StartOfTurn", 0, "");
    h.lastFlux().callbacks.onClose(1011, "internal", { initiatedByUs: false });
    await settle();
    assert.deepEqual(h.lastAura().handle.spoken, ["ERR:sayAgain"]);
    assert.deepEqual(s.messages.at(-1), { role: "assistant", content: "ERR:sayAgain" });
    assert.equal(h.llmCalls.length, 0);
    h.closeFastPath(s);
  });

  it("no turn open (Flux never opened, or the caller was silent): neither", async () => {
    const h = makeFast({ fluxOpenTimeoutMs: 20 });
    const s = h.start(makeSession());
    await sleep(50);
    assert.equal(s.fastPath, "degraded-stt");
    assert.deepEqual(h.lastAura().handle.spoken, []);
    assert.equal(h.llmCalls.length, 0);
    h.closeFastPath(s);
  });

  it("while the AI is working on a turn, no apology over its reply", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 100, sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    const turn = h.handleUserSpeech(s, h.twilioWs, "Can I book a cleaning?");
    h.turn("StartOfTurn", 0, "");
    h.lastFlux().callbacks.onError(new Error("flux socket error"));
    await turn;
    assert.deepEqual(h.lastAura().handle.spoken, ["Sure."]);
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 gate M4b: speech with no Flux turns hands the call to Nova (NO_TURN_WATCHDOG=act)", () => {
  const LOUD = Buffer.alloc(800, 0x00); // 100 ms of speech
  // The wiring, on a fixed threshold: the watchdog's own tests cover the line-relative one.
  const watchdog = () => createNoTurnWatchdog({ speechMs: 200, noiseFactor: 0 });
  /** Start a call with NO_TURN_WATCHDOG set to `mode` (read when the fast path starts). */
  function startWith(h, mode) {
    const previous = process.env.NO_TURN_WATCHDOG;
    if (mode === undefined) delete process.env.NO_TURN_WATCHDOG;
    else process.env.NO_TURN_WATCHDOG = mode;
    try {
      return h.start(makeSession());
    } finally {
      if (previous === undefined) delete process.env.NO_TURN_WATCHDOG;
      else process.env.NO_TURN_WATCHDOG = previous;
    }
  }
  it("speech with no turn event trips the watchdog: Nova, one flux-stt capture (warning: a false trip must not page), and the caller is asked to say it again", async () => {
    const h = makeFast({ createNoTurnWatchdog: watchdog });
    const s = startWith(h, "act");
    h.fluxOpens();
    h.noteFastInboundAudio(s, LOUD);
    assert.equal(s.fastPath, true, "100 ms: not yet");
    h.noteFastInboundAudio(s, LOUD);
    assert.equal(s.fastPath, "degraded-stt");
    assert.equal(h.novaOpens.length, 1);
    assert.ok(h.lines.some((l) => l.includes("[FastPath] Flux unavailable — falling back to Nova (speech but no turns")), h.lines.join("\n"));
    assert.deepEqual(h.sentry.filter((e) => e.tags?.service === "flux-stt").map((e) => e.scopeLevel), ["warning"]);
    await settle();
    assert.deepEqual(h.lastAura().handle.spoken, ["ERR:sayAgain"]);
    h.closeFastPath(s);
  });

  it("a Flux turn event starts the count again; the AI's own audio, its work, and silence never count", () => {
    const h = makeFast({ createNoTurnWatchdog: watchdog });
    const s = startWith(h, "act");
    h.fluxOpens();
    h.noteFastInboundAudio(s, LOUD);
    h.turn("Update", 0, "hello");
    h.noteFastInboundAudio(s, LOUD);
    assert.equal(s.fastPath, true, "heard: the count started again");
    s.isSpeaking = true; // the AI speaking: its echo is not the caller
    for (let i = 0; i < 5; i++) h.noteFastInboundAudio(s, LOUD);
    s.isSpeaking = false;
    s.isProcessing = true; // gate N2: the AI working (hold audio, thinking) does not count either
    for (let i = 0; i < 5; i++) h.noteFastInboundAudio(s, LOUD);
    s.isProcessing = false;
    for (let i = 0; i < 20; i++) h.noteFastInboundAudio(s, Buffer.alloc(800, 0xff));
    assert.equal(s.fastPath, true);
    h.closeFastPath(s);
  });

  it("the media handler feeds it on the fast path only", () => {
    const fed = [];
    const run = (session) => runSlice({
      from: 'case "media": {',
      to: 'case "mark": {',
      scope: { session, msg: { event: "media", media: { payload: Buffer.from([9, 9]).toString("base64") } }, WebSocket: { OPEN: 1 }, console: recordingConsole([]), noteFastInboundAudio: (sess, audio) => fed.push([sess.callSid, [...audio]]) },
      wrap: (code) => `switch ("media") {\n${code}\n}`,
    });
    const fast = makeSession();
    fast.fastPath = true;
    fast.deepgramWs = { readyState: 1, send() {} };
    run(fast);
    const classic = new CallSession("CA-classic");
    classic.deepgramWs = { readyState: 1, send() {} };
    run(classic);
    const degraded = makeSession();
    degraded.fastPath = "degraded-stt";
    degraded.deepgramWs = { readyState: 1, send() {} };
    run(degraded);
    assert.deepEqual(fed, [["CA-fast", [9, 9]]]);
  });
});

describe("SCRUM-594 gate M5: a dropped answer to a long question, and a silence after a question", () => {
  it("(i) a \"Yes\" begun during a long question (before its tail) is answered once the question has played", async () => {
    const h = makeFast({ steps: [{ sentences: ["Great, you're booked."], content: "Great, you're booked." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Would you like me to book you in for Tuesday at ten in the morning?");
    const seq = h.fastFlush(s);
    h.audio(75); // 3 s of audio: "Yes" is not in the last 2 s yet
    await sleep(520);
    h.turn("StartOfTurn", 0, "Yes");
    h.turn("EndOfTurn", 0, "Yes.");
    await settle();
    assert.ok(h.lines.some((l) => l.startsWith("log| [STT] Dropped (backchannel")), "dropped as it played");
    assert.equal(h.llmCalls.length, 0);
    h.lastAura().options.onFlushed(seq);
    echoMarks(h, s); // the question has played: the AI is idle
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the deferred answer");
    assert.deepEqual(h.llmCalls[0].messages.at(-1), { role: "user", content: "Yes." });
    h.audio(1); // the reply's first audio: the turn's [FastTurn] line
    assert.ok(h.lines.some((l) => /\[FastTurn\] callSid=CA-fast trigger=deferred /.test(l)), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("(ii) no turn after a question: the AI asks it again after FAST_REPROMPT_MS, once", async () => {
    const h = makeFast({ repromptMs: 40 });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Tuesday works. Shall I book it?");
    h.audio(1, h.fastFlush(s));
    echoMarks(h, s); // idle after the question
    await sleep(70);
    assert.deepEqual(h.lastAura().handle.spoken, ["Tuesday works. Shall I book it?", "ERR:didntCatch Shall I book it?"]);
    assert.equal(s.messages.some((m) => m.content === "ERR:didntCatch Shall I book it?"), false, "not heard yet: not recorded");
    h.audio(1); // its first audio: the caller is hearing it
    assert.deepEqual(s.messages.at(-1), { role: "assistant", content: "ERR:didntCatch Shall I book it?" });
    assert.ok(h.lines.some((l) => l.includes("[FastTurn] No answer 40 ms after the AI's question — asking it again")), h.lines.join("\n"));
    h.audio(1, h.fastFlush(s) ?? 1);
    h.lastAura().options.onFlushed(1);
    echoMarks(h, s); // idle after the re-prompt: the same question
    await sleep(70);
    assert.equal(h.lastAura().handle.spoken.length, 2, "once per question");
    h.closeFastPath(s);
  });

  it("(ii) the caller starting a turn, a commit or a barge-in cancels it; so does the call ending", async () => {
    for (const cancel of ["StartOfTurn", "commit", "barge-in", "close"]) {
      const h = makeFast({ repromptMs: 40, steps: [{ sentences: ["Sure."], content: "Sure." }] });
      const s = h.start(makeSession());
      h.fluxOpens();
      await h.sendTTS(s, h.twilioWs, "Shall I book it?");
      h.audio(1, h.fastFlush(s));
      echoMarks(h, s);
      if (cancel === "StartOfTurn") h.turn("StartOfTurn", 0, "");
      if (cancel === "commit") h.turn("EndOfTurn", 0, "Yes please, Tuesday.");
      if (cancel === "barge-in") h.sendClear(s, h.twilioWs);
      if (cancel === "close") h.closeFastPath(s);
      await sleep(70);
      assert.ok(!h.lastAura().handle.spoken.some((t) => t.startsWith("ERR:didntCatch")), cancel);
      await until(() => !s.isProcessing, "the turn");
      h.closeFastPath(s);
    }
  });

  it("(ii) after a statement, no re-prompt", async () => {
    const h = makeFast({ repromptMs: 40 });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "You're booked for Tuesday at ten.");
    h.audio(1, h.fastFlush(s));
    echoMarks(h, s);
    await sleep(70);
    assert.equal(h.lastAura().handle.spoken.length, 1);
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 gate B: the draft cap", () => {
  it("at most 2 drafts for a turn: the third EagerEndOfTurn starts none (logged once), and the commit still answers live", async () => {
    const h = makeFast({ steps: [
      { firstDelayMs: 5_000, content: "never" },
      { firstDelayMs: 5_000, content: "never" },
      { sentences: ["Sure."], content: "Sure." },
    ] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Can I book");
    h.turn("TurnResumed", 0, "");
    h.turn("EagerEndOfTurn", 0, "Can I book a");
    h.turn("TurnResumed", 0, "");
    h.turn("EagerEndOfTurn", 0, "Can I book a cleaning");
    await settle();
    assert.equal(h.llmCalls.length, 2, "two drafts, not three");
    assert.equal(s.speculation, null);
    assert.equal(h.lines.filter((l) => l.includes("[FastTurn] Draft cap reached")).length, 1);
    h.turn("EndOfTurn", 0, "Can I book a cleaning?");
    await until(() => h.llmCalls.length === 3 && !s.isProcessing, "the live answer");
    assert.equal(h.llmCalls[2].which, "claude");
    assert.deepEqual(h.lastAura().handle.spoken, ["Sure."]);
    h.closeFastPath(s);
  });

  it("at most FAST_DRAFTS_PER_CALL in a call (logged once)", async () => {
    const h = makeFast({ draftsPerCall: 1, steps: [{ firstDelayMs: 5_000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Can I book");
    h.turn("TurnResumed", 0, "");
    h.turn("EagerEndOfTurn", 0, "Can I book a cleaning");
    h.turn("TurnResumed", 0, "");
    h.turn("EagerEndOfTurn", 0, "Can I book a cleaning please");
    await settle();
    assert.equal(h.llmCalls.length, 1);
    assert.equal(h.lines.filter((l) => l.includes("[FastTurn] Draft cap reached")).length, 1);
    h.closeFastPath(s);
  });
});

// ─── The final gate: code-lens minors (C4, C5) ───────────────────────────────

describe("SCRUM-594 gate C4/C5: the question's start errs late, and a turn that waited is no latency sample", () => {
  it("the production values of the gate's constants", () => {
    assert.match(src, /^const FAST_QUESTION_MS_PER_CHAR = 95;$/m);
    assert.match(src, /^const AURA_OPEN_TIMEOUT_MS = 3000;$/m);
    assert.match(src, /^const FAST_RESPEAK_MS_PER_CHAR = 75;$/m);
    assert.match(src, /^const FAST_REPROMPT_MS = 6000;$/m);
    assert.match(src, /^const FAST_DRAFTS_PER_TURN = 2;$/m);
    assert.match(src, /^const FAST_DRAFTS_PER_CALL = 60;$/m);
    assert.match(src, /charsBefore \* FAST_QUESTION_MS_PER_CHAR - state\.auraReceivedMs/);
  });

  it("a turn that waited for the AI's audio logs waited=N, and its eot_to_audio is no p50/p90 sample", async () => {
    const h = makeFast({ steps: [{ sentences: ["Great."], content: "Great." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "We have Tuesday or Wednesday.");
    h.turn("EndOfTurn", 0, "Tuesday.");
    await sleep(40);
    echoMarks(h, s); // the reply has played: the turn starts
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer");
    h.audio(1); // its first audio
    const line = h.lines.find((l) => l.startsWith("log| [FastTurn] callSid="));
    const waited = Number(/ waited=(\d+)$/.exec(String(line))?.[1]);
    assert.ok(waited >= 30, line);
    assert.deepEqual(s.fastStats.eotToAudioMs, [], "no sample");
    h.closeFastPath(s);
  });

  it("a turn committed behind one in flight (queued) waited too", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 60, sentences: ["Sure."], content: "Sure." }, { sentences: ["And Friday too."], content: "And Friday too." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Can I book Tuesday?");
    await settle();
    h.turn("EndOfTurn", 1, "And Friday?");
    await until(() => h.llmCalls.length === 2 && !s.isProcessing, "both", 3_000);
    assert.equal(s.fastStats.current.queued, true);
    assert.ok(s.fastStats.current.waitedMs >= 30, String(s.fastStats.current.waitedMs));
    h.closeFastPath(s);
  });

  it("the queue alone counts: a queued turn's wait runs from its commit to its start", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    s.fastStats.pending = { eotAt: Date.now() - 250, trigger: "model", eagerAt: null, drafted: false, spec: "none", llmAt: null, speakAt: null, audioAt: null, queued: true, waitedMs: 0, logged: false };
    const turn = h.beginFastTurn(s, "And Friday?");
    assert.ok(turn.record.waitedMs >= 250 && turn.record.waitedMs < 1_000, String(turn.record.waitedMs));
    s.fastStats.pending = { ...s.fastStats.pending, eotAt: Date.now() - 250, queued: false, waitedMs: 0 };
    assert.equal(h.beginFastTurn(s, "Thanks").record.waitedMs, 0, "not queued: no wait");
    h.closeFastPath(s);
  });
});

// ─── The final gate: the tests lens's gaps (D1-D8) ───────────────────────────

describe("SCRUM-594 gate D: the tests lens's gaps", () => {
  it("D1: a draft that ends in tool_calls is adopted once; the tool runs once; the next round asks the LLM live (never re-adopts)", async () => {
    const h = makeFast({
      toolResults: { check_availability: { success: true, message: "Tuesday at 10:00 is free." } },
      steps: [
        { sentences: ["Let me check,"], tools: [{ name: "check_availability", args: { date: "2026-10-20" } }] },
        { sentences: ["Tuesday at ten is free."], content: "Tuesday at ten is free." },
      ],
    });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Is Tuesday at ten free?");
    await settle();
    assert.equal(h.llmCalls.length, 1, "the draft is the only LLM call so far");
    h.turn("EndOfTurn", 0, "Is Tuesday at ten free?");
    await until(() => !s.isProcessing, "the turn");
    assert.equal(h.llmCalls.length, 2, "round 0 = the adopted draft, round 1 = one live call");
    assert.equal(h.llmCalls[1].which, "claude");
    assert.deepEqual(h.calls.filter((c) => c[0] === "executeToolCall"), [["executeToolCall", "check_availability"]], "the tool ran exactly once");
    assert.ok(h.lastAura().handle.spoken.includes("Tuesday at ten is free."), JSON.stringify(h.lastAura().handle.spoken));
    assert.ok(!h.lastAura().handle.spoken.includes("ERR:troubleRepeat"), "no apology");
    assert.deepEqual(s.messages.slice(1).map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(h.llmCalls[1].messages.at(-1).role, "tool", "round 1 saw the tool result");
    h.closeFastPath(s);
  });

  it("D2: an Aura close nobody asked for, with no Error frame first (the 1008 a bad message earns), moves the call to REST: one log, one capture, no stuck flush", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Hello there.");
    h.fastFlush(s); // a flush is pending: the stream owes a Flushed
    h.lastAura().options.onClose(1008, "DATA-0000", { initiatedByUs: false });
    assert.equal(s.fastTts, null, "the rest of the call is REST");
    assert.equal(h.lines.filter((l) => l.includes("[FastPath] Aura stream unavailable — falling back to REST TTS")).length, 1, h.lines.join("\n"));
    assert.equal(h.sentry.length, 1);
    assert.equal(h.sentry[0].tags.service, "aura-stream");
    assert.equal(s.fastState.pendingFlushSeq, null, "a dead stream owes no Flushed: the next turn must not wait for one");
    await h.sendTTS(s, h.twilioWs, "Still here.");
    // gate H2: what it never voiced first, then the next sentence, both over REST.
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["Hello there.", "Still here."]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("D4: the production values of the fast path's timing constants (spec 4.9)", () => {
    assert.match(src, /^const FLUX_SILENCE_MS = 5000;$/m);
    assert.match(src, /^const FAST_FLUSH_WATCHDOG_MS = 3000;$/m);
    assert.match(src, /^const FAST_LOST_MARK_MS = 5000;$/m);
    assert.match(src, /^const FAST_TURN_START_WAIT_MS = 10_000;$/m);
    assert.match(src, /^const FAST_TURN_START_POLL_MS = 20;$/m);
    assert.match(src, /^const FAST_AUDIO_QUIET_MS = 500;$/m);
    assert.match(src, /^const FAST_IDLE_CAP_MS = 2000;$/m);
    assert.match(src, /^const FAST_FLUSHED_WAIT_MS = 3000;$/m);
    assert.match(src, /^const FLUX_WATCHDOG_TICK_MS = 1000;$/m);
    assert.match(src, /^const FLUX_OPEN_TIMEOUT_MS = 3000;$/m);
    assert.match(src, /^const FAST_DISCLOSURE_MARK = "fast-disclosure";$/m);
  });

  it("D5: nearest-rank percentiles, also for the 1-3 turn calls that dominate", () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.closeFastPath(s);
    s.fastStats.eotToAudioMs = [400, 100, 300];
    assert.deepEqual([h.summarizeFastCall(s).eotToAudioP50, h.summarizeFastCall(s).eotToAudioP90], [300, 400]);
    s.fastStats.eotToAudioMs = [700];
    assert.deepEqual([h.summarizeFastCall(s).eotToAudioP50, h.summarizeFastCall(s).eotToAudioP90], [700, 700]);
  });

  it("D6: the transfer announcement is flushed (Aura holds an unfinished sentence until a flush)", async () => {
    const h = makeFast({
      toolResults: { transfer_call: { success: true, message: "Transferring you to Dr Smith now", action: "transfer", transferTo: "+61400000000", transferTargetName: "Dr Smith", allDestinations: [], destinationIndex: 0 } },
      steps: [{ tools: [{ name: "transfer_call", args: { reason: "wants the dentist" } }] }],
    });
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "Please put me through to the dentist");
    const a = h.lastAura().handle;
    assert.equal(a.spoken.at(-1), "Transferring you to Dr Smith now");
    assert.ok(a.flushes.length >= 1);
    assert.equal(s.fastState.unflushed, false, "nothing is left sitting in Aura's buffer");
    h.closeFastPath(s);
  });

  it("D6: the error apology is flushed too", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5, throws: "Anthropic API error 529 (overloaded_error: Overloaded)" }] });
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "Can I book a cleaning please?");
    assert.deepEqual(h.lastAura().handle.spoken, ["ERR:troubleRepeat"]);
    assert.equal(s.fastState.unflushed, false);
    assert.equal(h.lastAura().handle.flushes.length, 1);
    h.closeFastPath(s);
  });

  it("D6: so is the reply when the tool loop runs out", async () => {
    const tools = [{ name: "check_availability", args: { date: "2026-10-20" } }];
    const h = makeFast({ steps: [{ tools }, { tools }, { tools }] });
    const s = h.start(makeSession());
    await h.handleUserSpeech(s, h.twilioWs, "Is anything free next week?");
    assert.equal(h.lastAura().handle.spoken.at(-1), "ERR:repeatRequest");
    assert.equal(s.fastState.unflushed, false);
    h.closeFastPath(s);
  });

  it("D8: a new draft aborts the one before it", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5_000, content: "never" }, { firstDelayMs: 5_000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Can I book");
    await settle();
    const first = h.llmCalls[0].opts.signal;
    h.turn("EagerEndOfTurn", 0, "Can I book a cleaning");
    await settle();
    assert.equal(h.llmCalls.length, 2);
    assert.equal(first.aborted, true, "the first draft was aborted");
    assert.equal(h.llmCalls[1].opts.signal.aborted, false);
    h.closeFastPath(s);
  });
});

// ─── The gate re-review (round 2): N1-N6 ─────────────────────────────────────

describe("SCRUM-594 gate round 2, N1: the re-prompt never talks into a caller's open turn", () => {
  it("P1: the caller started in the question's tail (StartOfTurn before the AI went idle): no re-prompt", async () => {
    const h = makeFast({ repromptMs: 40 });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Tuesday works. Shall I book it?");
    h.audio(1, h.fastFlush(s));
    h.turn("StartOfTurn", 0, "");
    h.turn("Update", 0, "Um well");
    echoMarks(h, s); // the question has played: idle, with the caller's turn open
    h.turn("Update", 0, "Um well I think Tuesday");
    await sleep(70);
    assert.ok(!h.lastAura().handle.spoken.some((t) => t.startsWith("ERR:didntCatch")), JSON.stringify(h.lastAura().handle.spoken));
    h.closeFastPath(s);
  });

  it("P5: a REST greeting ending in a question, the caller's StartOfTurn just before its tts-done: no re-prompt over the answer", async () => {
    const h = makeFast({ repromptMs: 40 });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.noteFastRestSpeech(s, "Thanks for calling Copperline Plumbing, how can I help you today?", 3000);
    h.turn("StartOfTurn", 0, "Yeah");
    s.isSpeaking = false;
    h.onFastRestMark(s); // the greeting's tts-done
    h.turn("Update", 0, "Yeah hi I've got a burst pipe under the sink");
    await sleep(70);
    assert.deepEqual(h.lastAura().handle.spoken, []);
    h.closeFastPath(s);
  });

  it("a turn that opens after the timer was armed, with no StartOfTurn seen (an Update with words): the re-prompt holds off when it fires", async () => {
    const h = makeFast({ repromptMs: 40 });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Shall I book it?");
    h.audio(1, h.fastFlush(s));
    echoMarks(h, s); // idle, nobody talking: armed
    h.turn("Update", 0, "I was just going to say"); // no StartOfTurn (missed), so the timer stays
    await sleep(70);
    assert.ok(!h.lastAura().handle.spoken.some((t) => t.startsWith("ERR:didntCatch")));
    h.closeFastPath(s);
  });

  it("P4: armed, then Flux falls back to Nova: no re-prompt on the Nova path", async () => {
    const h = makeFast({ repromptMs: 40 });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Tuesday works. Shall I book it?");
    h.audio(1, h.fastFlush(s));
    echoMarks(h, s); // armed
    h.lastFlux().callbacks.onError(new Error("flux socket error"));
    assert.equal(s.fastState.repromptTimer, null, "cancelled by the fallback");
    await sleep(70);
    assert.ok(!h.lastAura().handle.spoken.some((t) => t.startsWith("ERR:didntCatch")));
    h.closeFastPath(s);
  });

  it("a re-prompt a barge-in cut before any of it played is not recorded; over REST, one whose frames went out is", async () => {
    const h = makeFast({ repromptMs: 40 });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Shall I book it?");
    h.audio(1, h.fastFlush(s));
    echoMarks(h, s);
    await until(() => h.lastAura().handle.spoken.length === 2, "the re-prompt", 1_000);
    h.sendClear(s, h.twilioWs); // cut before its audio
    h.audio(1); // too late: cleared
    assert.equal(s.messages.some((m) => typeof m.content === "string" && m.content.startsWith("ERR:didntCatch")), false);
    h.closeFastPath(s);

    const r = makeFast({ repromptMs: 40 });
    const rs = r.start(makeSession());
    r.fluxOpens();
    r.lastAura().options.onError(new Error("aura down")); // REST from here on
    await r.sendTTS(rs, r.twilioWs, "Shall I book it?");
    rs.isSpeaking = false;
    r.onFastRestMark(rs); // its tts-done: idle after a question
    await until(() => r.calls.some((c) => c[0] === "synthesizeSpeech" && c[1] === "ERR:didntCatch Shall I book it?"), "the REST re-prompt", 1_000);
    await until(() => rs.messages.at(-1)?.content === "ERR:didntCatch Shall I book it?", "recorded once sent", 1_000);
    clearTimeout(rs._speakingTimeout);
    r.closeFastPath(rs);
  });
});

describe("SCRUM-594 gate round 2, N2: the no-turn watchdog logs only, unless NO_TURN_WATCHDOG=act", () => {
  const LOUD = Buffer.alloc(800, 0x00);
  const watchdog = () => createNoTurnWatchdog({ speechMs: 200, noiseFactor: 0 });
  function startWith(h, mode) {
    const previous = process.env.NO_TURN_WATCHDOG;
    if (mode === undefined) delete process.env.NO_TURN_WATCHDOG;
    else process.env.NO_TURN_WATCHDOG = mode;
    try {
      return h.start(makeSession());
    } finally {
      if (previous === undefined) delete process.env.NO_TURN_WATCHDOG;
      else process.env.NO_TURN_WATCHDOG = previous;
    }
  }

  for (const [label, mode] of [["unset (the default)", undefined], ["log", "log"], [" LOG ", " LOG "]]) {
    it(`${label}: a trip is logged and captured at warning level, once a call, and Flux stays`, async () => {
      const h = makeFast({ createNoTurnWatchdog: watchdog });
      const s = startWith(h, mode);
      h.fluxOpens();
      for (let i = 0; i < 6; i++) h.noteFastInboundAudio(s, LOUD);
      assert.equal(s.fastPath, true, "no fallback");
      assert.equal(h.novaOpens.length, 0);
      assert.equal(h.lines.filter((l) => l.startsWith("warn| [FastPath] no-turn watchdog would fall back (speech but no turns)")).length, 1, h.lines.join("\n"));
      assert.deepEqual(h.sentry.map((e) => [e.tags?.service, e.scopeLevel]), [["flux-stt", "warning"]]);
      await settle();
      assert.deepEqual(h.lastAura().handle.spoken, [], "nobody is asked to say it again");
      h.closeFastPath(s);
    });
  }

  it("an unrecognised value warns once and logs only", async () => {
    const h = makeFast({ createNoTurnWatchdog: watchdog });
    const s = startWith(h, "fallback");
    const s2 = startWith(h, "fallback");
    assert.equal(h.lines.filter((l) => l.includes('NO_TURN_WATCHDOG "fallback" not recognised — logging only')).length, 1, h.lines.join("\n"));
    h.fluxOpens();
    for (let i = 0; i < 6; i++) h.noteFastInboundAudio(s2, LOUD);
    assert.equal(s2.fastPath, true);
    h.closeFastPath(s);
    h.closeFastPath(s2);
  });
});

describe("SCRUM-594 gate round 2, N4: the turn Flux left open is answered only if the engine would have", () => {
  it("P3: an \"Okay\" open over the AI's reply when Flux dies is a backchannel: not answered, and no \"say that again\"", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "We have Tuesday at ten, Wednesday at two, or Friday at nine.");
    h.turn("StartOfTurn", 0, "Okay");
    h.lastFlux().callbacks.onError(new Error("flux socket error"));
    await settle();
    assert.equal(h.llmCalls.length, 0);
    assert.ok(!h.lastAura().handle.spoken.includes("ERR:sayAgain"));
    assert.ok(h.lines.some((l) => l.startsWith("log| [STT] Dropped (a backchannel or echo Flux left open)")), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("the AI's own words left open are not answered either; the caller's own words are", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "We have Tuesday at ten or Wednesday at two.", { flushed: false });
    h.turn("Update", 0, "We have Tuesday at ten");
    h.lastFlux().callbacks.onError(new Error("flux socket error"));
    await settle();
    assert.equal(h.llmCalls.length, 0, "echo");
    h.closeFastPath(s);

    const c = makeFast({ steps: [{ sentences: ["Sure, Friday it is."], content: "Sure, Friday it is." }] });
    const cs = c.start(makeSession());
    c.fluxOpens();
    await replyPlaying(c, cs, "We have Tuesday at ten or Wednesday at two.");
    c.turn("Update", 0, "Actually Friday would suit me");
    c.lastFlux().callbacks.onError(new Error("flux socket error"));
    echoMarks(c, cs); // the reply plays out
    await until(() => c.llmCalls.length === 1 && !cs.isProcessing, "the answer", 3_000);
    assert.deepEqual(c.llmCalls[0].messages.at(-1), { role: "user", content: "Actually Friday would suit me" });
    c.closeFastPath(cs);
  });

  it("a turn opened with no words while the AI still speaks: no \"say that again\" over it", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, "We have Tuesday at ten or Wednesday at two.");
    h.turn("StartOfTurn", 0, "");
    h.lastFlux().callbacks.onClose(1011, "internal", { initiatedByUs: false });
    await settle();
    assert.ok(!h.lastAura().handle.spoken.includes("ERR:sayAgain"));
    h.closeFastPath(s);
  });
});

describe("SCRUM-594 gate round 2, N6: the surviving mutants", () => {
  it("H2h: once a segment is owed, every later one is too (its audio cannot have come first)", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten or Wednesday at two."); // 3300 ms at 75 ms a character
    await h.sendTTS(s, h.twilioWs, "Okay?"); // 375 ms
    h.fastFlush(s);
    h.audio(12); // 480 ms: covers "Okay?" by length, but it is the first sentence's audio
    h.lastAura().options.onError(new Error("aura socket error"));
    await until(() => h.calls.some((c) => c[0] === "synthesizeSpeech"), "the re-speak");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["We have Tuesday at ten or Wednesday at two. Okay?"]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("H2j: audio heard before a Flushed belongs to what that Flushed confirmed, not to the text after it", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, "We have Tuesday at ten.");
    h.audio(12, h.fastFlush(s)); // 480 ms, then its Flushed
    await h.sendTTS(s, h.twilioWs, "Sure."); // 375 ms, none of its audio yet
    h.lastAura().options.onError(new Error("aura socket error"));
    await until(() => h.calls.some((c) => c[0] === "synthesizeSpeech"), "the re-speak");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), ["Sure."]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("Bb: the per-turn draft count starts again for the next turn", async () => {
    const h = makeFast({ steps: [{ firstDelayMs: 5_000, content: "never" }, { firstDelayMs: 5_000, content: "never" }, { firstDelayMs: 5_000, content: "never" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Can I book");
    h.turn("TurnResumed", 0, "");
    h.turn("EagerEndOfTurn", 0, "Can I book a");
    await settle();
    assert.equal(h.llmCalls.length, 2, "turn 0's two drafts");
    h.turn("EagerEndOfTurn", 1, "And Friday?");
    await settle();
    assert.equal(h.llmCalls.length, 3, "turn 1 drafts again");
    h.closeFastPath(s);
  });

  it("M5h: a turn in flight when the timer fires: no re-prompt", async () => {
    const h = makeFast({ repromptMs: 40, steps: [{ firstDelayMs: 200, sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Shall I book it?");
    h.audio(1, h.fastFlush(s));
    echoMarks(h, s); // armed
    const turn = h.handleUserSpeech(s, h.twilioWs, "Yes please, book it"); // not through a commit: the timer stays
    await sleep(70);
    assert.ok(!h.lastAura().handle.spoken.some((t) => t.startsWith("ERR:didntCatch")));
    await turn;
    h.closeFastPath(s);
  });

  it("M5m: a caller's answer lets the same question be asked again later", async () => {
    const h = makeFast({ repromptMs: 40, steps: [{ sentences: ["Shall I book it?"], content: "Shall I book it?" }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "Shall I book it?");
    h.audio(1, h.fastFlush(s));
    echoMarks(h, s);
    await until(() => h.lastAura().handle.spoken.length === 2, "the first re-prompt", 1_000);
    h.audio(1, 1);
    echoMarks(h, s); // the re-prompt played: the same question, not asked again
    h.turn("EndOfTurn", 0, "Sorry, what was that?"); // the caller answers ...
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the answer");
    h.audio(1, 2); // ... and the AI asks the same question again
    echoMarks(h, s);
    await until(() => h.lastAura().handle.spoken.filter((t) => t.startsWith("ERR:didntCatch")).length === 2, "a second re-prompt", 1_000);
    h.closeFastPath(s);
  });
});

// ─── Phone test F4: Aura drops letters of a hyphenated spelling ─────────────

describe("phone test F4: a hyphenated spelling reaches TTS as letters with commas; nothing else changes", () => {
  const spellLettersForTts = runSlice({ from: "function spellLettersForTts(text) {", to: "/**\n * Send clear event", scope: {}, names: ["spellLettersForTts"] }).spellLettersForTts;
  const SPELLED = "Your last name is spelled M-A-K-H-O-U-L.";
  const SAID = "Your last name is spelled M, A, K, H, O, U, L.";

  it("letters joined by hyphens become letters joined by commas", () => {
    assert.equal(spellLettersForTts("M-A-K-H-O-U-L"), "M, A, K, H, O, U, L");
    assert.equal(spellLettersForTts(SPELLED), SAID);
    assert.equal(spellLettersForTts("J-O, then K-L-M"), "J, O, then K, L, M", "every run, and two letters are a run");
    assert.equal(spellLettersForTts("m-a-k"), "m, a, k");
  });

  it("words, digits and mixed runs are left alone", () => {
    for (const text of ["9-5", "co-op", "re-book", "0414-141-883", "x-ray", "T-shirt", "e-mail", "A-1", "Plan-B", "9:30-10:30", "M", "Hello there."]) {
      assert.equal(spellLettersForTts(text), text, text);
    }
  });

  it("the Aura stream gets the commas; the echo filter's text and the re-speak segments keep the hyphens", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    const ms = await h.sendTTS(s, h.twilioWs, SPELLED);
    assert.deepEqual(h.lastAura().handle.spoken, [SAID]);
    assert.equal(h.engines[0].getState().aiSpeakingText, SPELLED);
    assert.deepEqual(s.fastState.auraSegments.map((x) => x.text), [SPELLED]);
    assert.equal(ms, SPELLED.length * 70, "the estimate is the written text's, as before");
    h.closeFastPath(s);
  });

  it("REST TTS gets the commas too: the fast path off the stream, and a classic call (harmless there)", async () => {
    const h = makeFast({ auraOpen: false });
    const s = h.start(makeSession());
    await h.sendTTS(s, h.twilioWs, SPELLED);
    assert.equal(h.engines[0].getState().aiSpeakingText, SPELLED, "the echo filter hears what was written");
    const classic = makeSession();
    await h.sendTTS(classic, h.twilioWs, "That's B-O-B, and 9-5 on weekdays.");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), [SAID, "That's B, O, B, and 9-5 on weekdays."]);
    clearTimeout(s._speakingTimeout); // the REST path's 20 s isSpeaking backstop
    clearTimeout(classic._speakingTimeout);
    h.closeFastPath(s);
  });

  it("a reply that spells: the caller hears every letter, the transcript keeps what the AI wrote", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure.", "It's M-A-K-H-O-U-L."], content: "Sure. It's M-A-K-H-O-U-L." }] });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "How is my last name spelled?");
    await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the reply");
    assert.deepEqual(h.lastAura().handle.spoken, ["Sure.", "It's M, A, K, H, O, U, L."]);
    assert.deepEqual(s.messages.at(-1), { role: "assistant", content: "Sure. It's M-A-K-H-O-U-L." });
    h.closeFastPath(s);
  });

  it("the spoken letters coming back on a speakerphone are still the AI's own words (R13): dropped, no barge-in", async () => {
    const h = makeFast();
    const s = h.start(makeSession());
    h.fluxOpens();
    await replyPlaying(h, s, SPELLED);
    const clears = h.twilio("clear").length;
    h.turn("Update", 0, "M, A, K, H, O");
    h.turn("EndOfTurn", 0, "M, A, K, H, O, U, L.");
    await settle();
    assert.equal(h.twilio("clear").length, clears);
    assert.equal(h.llmCalls.length, 0);
    assert.ok(h.lines.some((l) => l.startsWith("log| [STT] Dropped (echo-like: the AI's own words coming back)")), h.lines.join("\n"));
    h.closeFastPath(s);
  });
});

// ─── SCRUM-594 (phone test F5): languages ───────────────────────────────────

describe("SCRUM-594 (F5): the call's languages on the fast path", () => {
  /** A fast session with languages on, as applyFastConversationSettings leaves it. */
  const langSession = () => {
    const s = makeSession();
    s.fastLanguages = true;
    s.fastLanguage = "en";
    s.baseDeepgramVoice = s.deepgramVoice;
    return s;
  };
  const toolMessage = (s) => s.messages.find((m) => m.role === "tool")?.content;

  it("languages on: Flux opens on the multilingual model, hinted to English; off: the English model, as before", () => {
    const on = makeFast();
    const s = on.start(langSession());
    assert.equal(on.lastFlux().options.model, FLUX_MULTI_MODEL);
    assert.deepEqual(on.lastFlux().options.languageHints, ["en"]);
    on.closeFastPath(s);
    const off = makeFast();
    const plain = off.start(makeSession());
    assert.equal(off.lastFlux().options.model, undefined);
    assert.equal(off.lastFlux().options.languageHints, undefined);
    off.closeFastPath(plain);
  });

  it("set_language is offered only when the call's languages are on", () => {
    const h = makeFast();
    const names = (s) => (h.buildLLMOptions(s).tools || []).map((t) => t.function.name);
    assert.ok(names(langSession()).includes("set_language"));
    assert.ok(!names(makeSession()).includes("set_language"));
  });

  it("set_language: Flux's hints follow, the rest of the call speaks over REST in the new voice (no failure capture), the model reads the switch; the executor never sees it", async () => {
    const reply = "¡Claro! ¿En qué puedo ayudarle?";
    const h = makeFast({ steps: [{ tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: [reply], content: reply }] });
    const s = h.start(langSession());
    h.fluxOpens();
    const configured = [];
    h.lastFlux().handle.configure = (settings) => { configured.push(settings); return true; };
    const aura = h.lastAura().handle;
    await h.handleUserSpeech(s, h.twilioWs, "Do you speak Spanish?");
    assert.deepEqual(configured, [{ language_hints: ["es", "en"] }]);
    assert.equal(aura.closes, 1, "Aura voices are fixed per stream");
    assert.equal(s.fastTts, null);
    assert.equal(s.fastLanguage, "es");
    assert.equal(s.deepgramVoice, "aura-2-selena-es");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [[reply, "aura-2-selena-es"]]);
    assert.ok(!h.calls.some((c) => c[0] === "executeToolCall" && c[1] === "set_language"));
    assert.match(toolMessage(s), /^Switched to Spanish/);
    assert.equal(h.sentry.length, 0, "a language switch is no failure");
    assert.ok(!h.lines.some((l) => l.includes("Aura stream unavailable")), h.lines.join("\n"));
    assert.ok(h.lines.some((l) => l.includes("[FastPath] Language en → es")), h.lines.join("\n"));
    clearTimeout(s._speakingTimeout); // the REST path's 20 s isSpeaking backstop
    h.closeFastPath(s);
    const summary = h.summarizeFastCall(s);
    assert.equal(summary.tts, "rest-language");
    assert.deepEqual(summary.languages, ["en", "es"]);
  });

  it("set_language to a language this line can't speak: nothing switches, and the model is told to say so in English", async () => {
    const reply = "Sorry, this line can't speak Arabic yet. Shall I ask the team to call you back?";
    const h = makeFast({ steps: [{ tools: [{ name: "set_language", args: { language: "ar" } }] }, { sentences: [reply], content: reply }] });
    const s = h.start(langSession());
    h.fluxOpens();
    const configured = [];
    h.lastFlux().handle.configure = (settings) => { configured.push(settings); return true; };
    await h.handleUserSpeech(s, h.twilioWs, "Can you speak Arabic?");
    assert.deepEqual(configured, []);
    assert.equal(h.lastAura().handle.closes, 0);
    assert.equal(s.fastLanguage, "en");
    assert.match(toolMessage(s), /^NOT SWITCHED/);
    assert.deepEqual(h.lastAura().handle.spoken, [reply]);
    h.closeFastPath(s);
  });

  it("a reply in a script the voice can't say is replaced by the apology, once per caller turn, and the model is told", async () => {
    const h = makeFast({ steps: [{ sentences: ["Yes.", "نعم، أستطيع التحدث بالعربية.", "هل تفضل أن أكمل بالعربية؟"], content: "Yes. نعم، أستطيع التحدث بالعربية. هل تفضل أن أكمل بالعربية؟" }] });
    const s = h.start(langSession());
    await h.handleUserSpeech(s, h.twilioWs, "Do you speak Arabic?");
    assert.deepEqual(h.lastAura().handle.spoken, ["Yes.", UNSPEAKABLE_APOLOGY]);
    assert.ok(s.messages.some((m) => m.role === "system" && /can't speak/.test(m.content)));
    assert.ok(h.lines.some((l) => l.includes("[FastPath] Replaced a reply this voice can't speak")), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("fillers follow the call's language: Spanish ones in Spanish, none in a language without canned fillers", async () => {
    // The caller speaks the call's language (phone test F9: clear English would switch the line back).
    const run = async (language, words) => {
      const h = makeFast({ steps: [{ tools: [{ name: "check_availability", args: { date: "2026-10-20" } }] }, { sentences: ["OK."], content: "OK." }] });
      const s = h.start(langSession());
      s.fastLanguage = language;
      await h.handleUserSpeech(s, h.twilioWs, words);
      const spoken = [...h.lastAura().handle.spoken];
      h.closeFastPath(s);
      return spoken;
    };
    assert.deepEqual(await run("es", "¿Está libre el martes por la mañana?"), ["Un momento, déjeme verificar.", "OK."]);
    assert.deepEqual(await run("fr", "Mardi matin, c'est libre ?"), ["Un instant, je vérifie cela.", "OK."]);
    assert.deepEqual(await run("nl", "Is dinsdagochtend nog vrij?"), ["OK."], "no canned Dutch fillers: none, never an English one in a Dutch voice");
    assert.deepEqual(await run("en", "Is Tuesday free in the morning at all?"), ["One moment, let me check that.", "OK."]);
  });

  it("gate review: what the round said before set_language plays first, in the old voice — never again, never in the new one", async () => {
    const reply = "¡Claro!";
    const h = makeFast({ steps: [{ sentences: ["Of course."], tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: [reply], content: reply }] });
    const s = h.start(langSession());
    h.fluxOpens();
    const turn = h.handleUserSpeech(s, h.twilioWs, "Do you speak Spanish?");
    setTimeout(() => h.audio(3, 0), 20); // Aura voices it and confirms the flush
    await turn;
    assert.deepEqual(h.lastAura().handle.spoken, ["Of course."]);
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [[reply, "aura-2-selena-es"]]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("gate review: a second switch moves the hints and the voice again — back to English is the assistant's own voice", async () => {
    const h = makeFast({ steps: [
      { tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Claro."], content: "Claro." },
      { tools: [{ name: "set_language", args: { language: "en" } }] }, { sentences: ["Sure."], content: "Sure." },
    ] });
    const s = h.start(langSession());
    h.fluxOpens();
    const configured = [];
    h.lastFlux().handle.configure = (settings) => { configured.push(settings.language_hints); return true; };
    await h.handleUserSpeech(s, h.twilioWs, "¿Habla español?");
    await h.handleUserSpeech(s, h.twilioWs, "Actually, English please.");
    assert.deepEqual(configured, [["es", "en"], ["en"]]);
    assert.equal(h.lastAura().handle.closes, 1);
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [["Claro.", "aura-2-selena-es"], ["Sure.", "aura-2-thalia-en"]]);
    assert.equal(s.fastLanguage, "en");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("F5 simulated calls: a caller clearly speaking French switches the line before the reply — the model never called set_language", async () => {
    const reply = "Oui, bien sûr. Comment puis-je vous aider ?";
    const h = makeFast({ steps: [{ sentences: [reply], content: reply }] });
    const s = h.start(langSession());
    h.fluxOpens();
    const configured = [];
    h.lastFlux().handle.configure = (settings) => { configured.push(settings); return true; };
    await h.handleUserSpeech(s, h.twilioWs, "Bonjour, vous parlez français ?");
    assert.deepEqual(configured, [{ language_hints: ["fr", "en"] }]);
    assert.equal(s.fastLanguage, "fr");
    assert.deepEqual(s.languagesUsed, ["en", "fr"]);
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [[reply, "aura-2-agathe-fr"]]);
    assert.ok(s.messages.some((m) => m.role === "system" && /^The caller spoke French, so the line switched to French/.test(m.content)), "the model is told");
    assert.ok(h.lines.some((l) => l.includes("[FastPath] Language en → fr")), h.lines.join("\n"));
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("gate review: the automatic switch happens once a call — never after the caller chose English, never back to a voice that failed", async () => {
    const h = makeFast({ steps: [{ sentences: ["Of course."], content: "Of course." }] });
    const s = h.start(langSession());
    h.fluxOpens();
    s.languagesUsed = ["en", "fr"]; // switched to French earlier, then back to English
    await h.handleUserSpeech(s, h.twilioWs, "Oui, d'accord, merci beaucoup, c'est parfait pour moi.");
    assert.equal(s.fastLanguage, "en");
    assert.equal(s.messages.filter((m) => m.role === "system" && /^The caller spoke/.test(m.content)).length, 0);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  /** Phone test F9's start: the model switches the line to Spanish (set_language) and answers in Spanish. */
  const spanishFirst = (more) => makeFast({ steps: [
    { tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Claro, ahora podemos seguir en español."], content: "Claro, ahora podemos seguir en español." },
    ...more,
  ] });
  const voicesSpoken = (h) => h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]);

  it("phone test F9: a caller back in English hears the English voice — the line switches back before the reply, no set_language needed", async () => {
    const reply = "Sure. This line speaks English, Spanish, French, German, Italian, Dutch and Japanese. Is there anything else you need today?";
    const h = spanishFirst([{ sentences: [reply], content: reply }]);
    const s = h.start(langSession());
    h.fluxOpens();
    const configured = [];
    h.lastFlux().handle.configure = (settings) => { configured.push(settings.language_hints); return true; };
    await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
    await h.handleUserSpeech(s, h.twilioWs, "No. I just want to check if you speak any other languages.");
    assert.deepEqual(configured, [["es", "en"], ["en"]], "Flux hears English first again");
    assert.equal(s.fastLanguage, "en");
    assert.equal(s.deepgramVoice, "aura-2-thalia-en", "the assistant's own voice");
    assert.deepEqual(voicesSpoken(h), [["Claro, ahora podemos seguir en español.", "aura-2-selena-es"], [reply, "aura-2-thalia-en"]]);
    assert.deepEqual(s.languagesUsed, ["en", "es"]);
    const notes = s.messages.filter((m) => m.role === "system" && /^The caller spoke English, so the line switched back to English \(no set_language needed\)\. Answer in English while the line speaks English\.$/.test(m.content));
    assert.equal(notes.length, 1, "the model is told, once");
    assert.ok(h.lines.some((l) => l.includes("[FastPath] Language es → en, voice aura-2-thalia-en")), h.lines.join("\n"));
    assert.ok(h.lines.some((l) => l.includes("[FastPath] The caller spoke English on the Spanish line: switched back automatically")), "silent-failure review: told apart from set_language in the logs");
    assert.equal(s.fastAutoEnglish, true);
    assert.equal(h.llmCalls.length, 3, "no extra model round for the way back");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("phone test F9: a few English words, or words in the line's language, leave the line as it is", async () => {
    for (const words of ["Okay, thank you.", "Sí, sí, thank you, gracias.", "¿Cómo estás?", "Two PM is good."]) {
      const h = spanishFirst([{ sentences: ["De nada."], content: "De nada." }]);
      const s = h.start(langSession());
      h.fluxOpens();
      await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
      await h.handleUserSpeech(s, h.twilioWs, words);
      assert.equal(s.fastLanguage, "es", words);
      assert.deepEqual(voicesSpoken(h).at(-1), ["De nada.", "aura-2-selena-es"], words);
      assert.equal(s.messages.filter((m) => m.role === "system" && /^The caller spoke English/.test(m.content)).length, 0, words);
      clearTimeout(s._speakingTimeout);
      h.closeFastPath(s);
    }
  });

  it("phone test F9 (security review): a German line's own sentence never reads as English, however English its words look", async () => {
    const h = makeFast({ steps: [
      { tools: [{ name: "set_language", args: { language: "de" } }] }, { sentences: ["Natürlich."], content: "Natürlich." },
      { sentences: ["Gern, am Montag."], content: "Gern, am Montag." },
    ] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "Sprechen Sie Deutsch?");
    await h.handleUserSpeech(s, h.twilioWs, "Ich will am Montag in der Früh kommen");
    assert.equal(s.fastLanguage, "de");
    assert.deepEqual(voicesSpoken(h).at(-1), ["Gern, am Montag.", "aura-2-elara-de"]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("phone test F9: a draft written in the old language is dropped; the reply is written after the switch, in English", async () => {
    const h = spanishFirst([{ sentences: ["Claro que sí."], content: "Claro que sí." }, { sentences: ["Sure, here they are."], content: "Sure, here they are." }]);
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
    s.isSpeaking = false; // the Spanish reply has played: its tts-done is back
    h.onFastRestMark(s);
    h.turn("EagerEndOfTurn", 0, "Can you tell me which languages you speak?");
    await settle();
    const draftSignal = h.llmCalls[2].opts.signal;
    h.turn("EndOfTurn", 0, "Can you tell me which languages you speak?");
    await until(() => !s.isProcessing, "the turn");
    assert.equal(draftSignal.aborted, true, "the draft is aborted");
    assert.equal(h.llmCalls.length, 4, "the reply is written after the switch");
    assert.deepEqual(voicesSpoken(h).at(-1), ["Sure, here they are.", "aura-2-thalia-en"]);
    assert.ok(!voicesSpoken(h).some(([text]) => text === "Claro que sí."), "the draft is never said");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("silent-failure review: after the automatic way back, a caller who goes on in their language is followed back to it", async () => {
    const h = spanishFirst([{ sentences: ["Sure."], content: "Sure." }, { sentences: ["Claro, sin problema."], content: "Claro, sin problema." }]);
    const s = h.start(langSession());
    h.fluxOpens();
    const configured = [];
    h.lastFlux().handle.configure = (settings) => { configured.push(settings.language_hints); return true; };
    await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
    await h.handleUserSpeech(s, h.twilioWs, "My name is Sami Khoury and I can be there in the morning.");
    assert.equal(s.fastLanguage, "en");
    await h.handleUserSpeech(s, h.twilioWs, "Perdón, sí, prefiero hablar español, por favor.");
    assert.equal(s.fastLanguage, "es", "followed back to Spanish");
    assert.equal(s.fastAutoEnglish, false);
    assert.deepEqual(configured, [["es", "en"], ["en"], ["es", "en"]]);
    assert.deepEqual(voicesSpoken(h).at(-1), ["Claro, sin problema.", "aura-2-selena-es"]);
    assert.ok(s.messages.some((m) => m.role === "system" && /^The caller spoke Spanish, so the line switched to Spanish/.test(m.content)));
    assert.ok(h.lines.some((l) => l.includes("[FastPath] The caller spoke Spanish: switched automatically")), h.lines.join("\n"));
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("re-review: a caller who asked for English by name stays in English — the automatic way back doesn't re-arm the switch away", async () => {
    for (const model of ["no set_language", "set_language en"]) {
      const h = spanishFirst([
        ...(model === "set_language en" ? [{ tools: [{ name: "set_language", args: { language: "en" } }] }] : []),
        { sentences: ["Of course."], content: "Of course." }, { sentences: ["Great."], content: "Great." },
      ]);
      const s = h.start(langSession());
      h.fluxOpens();
      await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
      await h.handleUserSpeech(s, h.twilioWs, "Can you speak English please?");
      assert.equal(s.fastLanguage, "en", model);
      assert.equal(s.fastAutoEnglish, false, model);
      await h.handleUserSpeech(s, h.twilioWs, "Sí, gracias, muy bien.");
      assert.equal(s.fastLanguage, "en", `${model}: stays in English`);
      assert.deepEqual(voicesSpoken(h).at(-1), ["Great.", "aura-2-thalia-en"], model);
      clearTimeout(s._speakingTimeout);
      h.closeFastPath(s);
    }
  });

  it("phone test F9: a caller who asked for English (set_language) stays in English, as before — no automatic switch away", async () => {
    const h = spanishFirst([{ tools: [{ name: "set_language", args: { language: "en" } }] }, { sentences: ["Sure."], content: "Sure." }, { sentences: ["Of course."], content: "Of course." }]);
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
    await h.handleUserSpeech(s, h.twilioWs, "English please.");
    assert.equal(s.fastLanguage, "en");
    assert.equal(s.fastAutoEnglish, false);
    await h.handleUserSpeech(s, h.twilioWs, "Bonjour, vous parlez français ?");
    assert.equal(s.fastLanguage, "en", "the caller chose English: no automatic switch to French");
    assert.equal(s.messages.filter((m) => m.role === "system" && /^The caller spoke/.test(m.content)).length, 0);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("phone test F9: never followed back to a language whose voice or hearing failed", async () => {
    for (const failed of [["fr"], null]) {
      const h = makeFast({ steps: [{ sentences: ["Bien sûr."], content: "Bien sûr." }] });
      const s = h.start(langSession());
      h.fluxOpens();
      s.languagesUsed = ["en", "fr", "es"];
      s.fastAutoEnglish = true; // came back to English on its own
      s.failedLanguages = failed;
      await h.handleUserSpeech(s, h.twilioWs, "Bonjour, vous parlez français ?");
      assert.equal(s.fastLanguage, failed ? "en" : "fr", JSON.stringify(failed));
      clearTimeout(s._speakingTimeout);
      h.closeFastPath(s);
    }
  });

  it("re-review: \"I don't speak Spanish\" switches back, and is a choice — a later Spanish courtesy doesn't switch away again", async () => {
    const h = spanishFirst([{ sentences: ["Sorry about that. How can I help?"], content: "Sorry about that. How can I help?" }, { sentences: ["Great."], content: "Great." }]);
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
    await h.handleUserSpeech(s, h.twilioWs, "No, no, I don't speak Spanish, I was just asking.");
    assert.equal(s.fastLanguage, "en");
    assert.equal(s.fastAutoEnglish, false, "turning the language down is a choice");
    assert.deepEqual(voicesSpoken(h).at(-1), ["Sorry about that. How can I help?", "aura-2-thalia-en"]);
    await h.handleUserSpeech(s, h.twilioWs, "Sí, gracias, muy bien.");
    assert.equal(s.fastLanguage, "en");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("re-review: Spanish words asking for English never switch the line to Spanish — after the way back, or at the start", async () => {
    const h = spanishFirst([{ sentences: ["Sure."], content: "Sure." }, { sentences: ["Of course."], content: "Of course." }]);
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
    await h.handleUserSpeech(s, h.twilioWs, "No. I just want to check if you speak any other languages.");
    assert.equal(s.fastAutoEnglish, true);
    await h.handleUserSpeech(s, h.twilioWs, "Sí, en inglés, por favor.");
    assert.equal(s.fastLanguage, "en", "asked for English, in Spanish");
    assert.deepEqual(voicesSpoken(h).at(-1), ["Of course.", "aura-2-thalia-en"]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
    assert.ok(h.lines.some((l) => l.includes("[FastPath] The caller spoke Spanish asking for English: staying in English")), h.lines.join("\n"));
    const first = makeFast({ steps: [{ sentences: ["Of course."], content: "Of course." }] });
    const t = first.start(langSession());
    first.fluxOpens();
    await first.handleUserSpeech(t, first.twilioWs, "Bonjour, je voudrais parler en anglais, merci.");
    assert.equal(t.fastLanguage, "en", "F5's first switch too");
    clearTimeout(t._speakingTimeout);
    first.closeFastPath(t);
  });

  it("silent-failure verification: \"bad at English\" asks for nothing — a caller naming their own language is switched to it", async () => {
    for (const [words, code, voice] of [
      ["soy muy malo en inglés, ¿habla español?", "es", "aura-2-selena-es"],
      ["je suis nul en anglais, vous parlez français ?", "fr", "aura-2-agathe-fr"],
      ["ich bin nicht so gut in Englisch. Sprechen Sie Deutsch?", "de", "aura-2-elara-de"],
      ["non sono bravo in inglese, parla italiano?", "it", "aura-2-cinzia-it"],
      ["ik ben niet zo goed in Engels, spreekt u Nederlands?", "nl", "aura-2-daphne-nl"],
      ["英語ではなく日本語でお願いします", "ja", "aura-2-uzume-ja"],
    ]) {
      const h = makeFast({ steps: [{ sentences: ["OK."], content: "OK." }] });
      const s = h.start(langSession());
      h.fluxOpens();
      await h.handleUserSpeech(s, h.twilioWs, words);
      assert.equal(s.fastLanguage, code, words);
      assert.deepEqual(voicesSpoken(h), [["OK.", voice]], words);
      clearTimeout(s._speakingTimeout);
      h.closeFastPath(s);
    }
  });

  it("silent-failure verification: a request for the line's language with a negation elsewhere keeps the line", async () => {
    const h = spanishFirst([{ sentences: ["Claro: ¿en qué le puedo ayudar?"], content: "Claro: ¿en qué le puedo ayudar?" }]);
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
    await h.handleUserSpeech(s, h.twilioWs, "Sorry, can you say that again in Spanish? I can't hear you very well.");
    assert.equal(s.fastLanguage, "es");
    assert.deepEqual(voicesSpoken(h).at(-1), ["Claro: ¿en qué le puedo ayudar?", "aura-2-selena-es"]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("silent-failure re-review: declining to follow the caller into a language that failed is logged", async () => {
    const h = makeFast({ steps: [{ sentences: ["Of course."], content: "Of course." }] });
    const s = h.start(langSession());
    h.fluxOpens();
    s.languagesUsed = ["en", "es", "fr"];
    s.fastAutoEnglish = true;
    s.failedLanguages = ["es"];
    await h.handleUserSpeech(s, h.twilioWs, "Sí, por favor, necesito una cita para mañana.");
    assert.equal(s.fastLanguage, "en");
    assert.ok(h.lines.some((l) => l.includes("[FastPath] The caller spoke Spanish, which stopped working earlier on this call: staying in English")), h.lines.join("\n"));
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("code review: English words asking for the line's own language leave it be — the model answers", async () => {
    const h = spanishFirst([{ sentences: ["Claro: ¿en qué le puedo ayudar?"], content: "Claro: ¿en qué le puedo ayudar?" }]);
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "Oh, pues español.");
    await h.handleUserSpeech(s, h.twilioWs, "Can you say that again in Spanish?");
    assert.equal(s.fastLanguage, "es");
    assert.deepEqual(voicesSpoken(h).at(-1), ["Claro: ¿en qué le puedo ayudar?", "aura-2-selena-es"]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("gate review: the switch note holds only while the line speaks the language (Claude keeps every note in its system prompt)", async () => {
    const h = makeFast({ steps: [{ sentences: ["Oui."], content: "Oui." }] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "Bonjour, vous parlez français ?");
    const note = s.messages.find((m) => m.role === "system" && /^The caller spoke French/.test(m.content));
    assert.ok(note, JSON.stringify(s.messages));
    assert.doesNotMatch(note.content, /from now on/);
    assert.match(note.content, /while the line speaks French/);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("gate review: a draft written before the switch is dropped, never spoken in the new voice", async () => {
    const h = makeFast({ steps: [{ sentences: ["Hello, how can I help?"], content: "Hello, how can I help?" }, { sentences: ["Oui, bien sûr."], content: "Oui, bien sûr." }] });
    const s = h.start(langSession());
    h.fluxOpens();
    h.turn("EagerEndOfTurn", 0, "Bonjour, vous parlez français ?");
    await settle();
    const draftSignal = h.llmCalls[0].opts.signal;
    h.turn("EndOfTurn", 0, "Bonjour, vous parlez français ?");
    await until(() => !s.isProcessing, "the turn");
    assert.equal(draftSignal.aborted, true, "the draft is aborted");
    assert.equal(h.llmCalls.length, 2, "the reply is written after the switch");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [["Oui, bien sûr.", "aura-2-agathe-fr"]]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("test review (F9): FAST_LANGUAGES=off — a session as applyFastConversationSettings leaves it (fastLanguage \"en\") never switches, whatever the caller speaks", async () => {
    const prev = process.env.FAST_LANGUAGES;
    process.env.FAST_LANGUAGES = "off";
    try {
      for (const words of ["Bonjour, vous parlez français ?", "Hola, ¿habla español? Necesito una cita para mañana, por favor."]) {
        const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
        const session = makeSession();
        applyFastConversationSettings(session);
        assert.equal(session.fastLanguages, false);
        assert.equal(session.fastLanguage, "en", "the production shape: English, languages off");
        const s = h.start(session);
        h.fluxOpens();
        const configured = [];
        h.lastFlux().handle.configure = (settings) => { configured.push(settings); return true; };
        await h.handleUserSpeech(s, h.twilioWs, words);
        assert.equal(s.fastLanguage, "en", words);
        assert.deepEqual(configured, [], words);
        assert.equal(h.lastAura().handle.closes, 0, `${words}: the English stream stays`);
        assert.deepEqual(h.lastAura().handle.spoken, ["Sure."], words);
        clearTimeout(s._speakingTimeout);
        h.closeFastPath(s);
      }
    } finally {
      if (prev === undefined) delete process.env.FAST_LANGUAGES;
      else process.env.FAST_LANGUAGES = prev;
    }
  });

  it("test review (F9): on a Japanese line, a Japanese caller's English pleasantries don't switch it back (F5 reads the same words as Japanese)", async () => {
    const words = "はい、OK, thank you very much";
    assert.equal(detectCallerLanguage(words), "ja", "F5's detector: Japanese");
    const h = makeFast({ steps: [{ sentences: ["かしこまりました。"], content: "かしこまりました。" }, { sentences: ["どういたしまして。"], content: "どういたしまして。" }] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "トイレの水が止まらないんです。"); // F5: the line switches to Japanese
    assert.equal(s.fastLanguage, "ja");
    await h.handleUserSpeech(s, h.twilioWs, words);
    assert.equal(s.fastLanguage, "ja", "still Japanese");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [["かしこまりました。", "aura-2-uzume-ja"], ["どういたしまして。", "aura-2-uzume-ja"]]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("F5 simulated calls: no switch for an English caller, a call with languages off, a call already in another language, or one the hearing can't follow", async () => {
    const run = async (setup, words) => {
      const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
      const s = h.start(setup === "off" ? makeSession() : langSession());
      h.fluxOpens();
      const configured = [];
      h.lastFlux().handle.configure = (settings) => { configured.push(settings); return true; };
      if (setup === "spanish") s.fastLanguage = "es";
      if (setup === "nova") h.lastFlux().callbacks.onError(new Error("flux down"));
      await h.handleUserSpeech(s, h.twilioWs, words);
      const result = { language: s.fastLanguage, configured, notes: s.messages.filter((m) => m.role === "system" && /^The caller spoke/.test(m.content)).length };
      clearTimeout(s._speakingTimeout);
      h.closeFastPath(s);
      return result;
    };
    assert.deepEqual(await run("english", "Hello, do you speak French?"), { language: "en", configured: [], notes: 0 });
    assert.deepEqual(await run("english", "Merci."), { language: "en", configured: [], notes: 0 }, "one word is no language");
    assert.equal((await run("off", "Bonjour, vous parlez français ?")).notes, 0);
    assert.deepEqual(await run("spanish", "Bonjour, vous parlez français ?"), { language: "es", configured: [], notes: 0 });
    assert.deepEqual(await run("nova", "Bonjour, vous parlez français ?"), { language: "en", configured: [], notes: 0 });
  });

  it("gate review: no switch the hearing can't follow — on the Nova fallback, or with Flux not open: NOT SWITCHED, nothing changes", async () => {
    for (const setup of ["nova", "closed"]) {
      const h = makeFast({ steps: [{ tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Sorry, only English."], content: "Sorry, only English." }] });
      const s = h.start(langSession());
      h.fluxOpens();
      if (setup === "nova") h.lastFlux().callbacks.onError(new Error("flux down"));
      else h.lastFlux().handle.configure = () => false;
      await h.handleUserSpeech(s, h.twilioWs, "¿Habla español?");
      assert.equal(toolMessage(s), LANGUAGE_UNHEARD_MESSAGE, setup);
      assert.equal(s.fastLanguage, "en", setup);
      assert.equal(s.deepgramVoice, "aura-2-thalia-en", setup);
      assert.equal(h.lastAura().handle.closes, 0, `${setup}: the stream stays`);
      h.closeFastPath(s);
    }
  });

  it("gate review: Flux refusing the hints after a switch is captured, the call goes back to English, and the model is told", async () => {
    const h = makeFast({ steps: [{ tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Claro."], content: "Claro." }] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "¿Habla español?");
    assert.equal(s.fastLanguage, "es");
    h.lastFlux().callbacks.onWarning({ type: "ConfigureFailure", code: "INVALID_LANGUAGE_HINT", message: "bad hint" });
    assert.equal(s.fastLanguage, "en");
    assert.equal(s.deepgramVoice, "aura-2-thalia-en");
    assert.ok(h.sentry.some((e) => e.tags?.service === "flux-stt"), JSON.stringify(h.sentry));
    assert.ok(s.messages.some((m) => m.role === "system" && /only continue in English/.test(m.content)));
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("gate review: Flux falling back to Nova mid-Spanish call takes the call back to English, with a note", async () => {
    const h = makeFast({ steps: [{ tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Claro."], content: "Claro." }] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "¿Habla español?");
    h.lastFlux().callbacks.onError(new Error("flux down"));
    assert.equal(s.fastPath, "degraded-stt");
    assert.equal(s.fastLanguage, "en");
    assert.equal(s.deepgramVoice, "aura-2-thalia-en");
    assert.ok(s.messages.some((m) => m.role === "system" && /only continue in English/.test(m.content)));
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("gate review: REST failing in the new voice is captured once, the call goes back to English, and the sentence is said in the base voice", async () => {
    const h = makeFast({ restFailsFor: (_text, options) => options?.voice === "aura-2-selena-es", steps: [{ tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Claro."], content: "Claro." }] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "¿Habla español?");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [["Claro.", "aura-2-selena-es"], ["Claro.", "aura-2-thalia-en"]]);
    assert.equal(s.fastLanguage, "en");
    assert.deepEqual(s.failedLanguages, ["es"], "phone test F9: never followed back to it");
    assert.equal(h.sentry.filter((e) => e.tags?.service === "aura-rest").length, 1, JSON.stringify(h.sentry));
    assert.ok(s.messages.some((m) => m.role === "system" && /only continue in English/.test(m.content)));
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("gate review: a voice that fails again after the model switches back to it is not captured twice", async () => {
    const h = makeFast({ restFailsFor: (_text, options) => options?.voice === "aura-2-selena-es", steps: [
      { tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Claro."], content: "Claro." },
      { tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Sí."], content: "Sí." },
    ] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "¿Habla español?");
    await h.handleUserSpeech(s, h.twilioWs, "Por favor, en español.");
    assert.equal(h.calls.filter((c) => c[0] === "synthesizeSpeech" && c[2]?.voice === "aura-2-selena-es").length, 2, "it failed twice");
    assert.equal(h.sentry.filter((e) => e.tags?.service === "aura-rest").length, 1, "captured once a call");
    assert.deepEqual(s.failedLanguages, ["es"], "phone test F9 (re-review): recorded once");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("confirmation review: a switch in a later round waits for every earlier round's speech, which keeps its voice", async () => {
    const h = makeFast({ restDelayFor: (text) => (text === "Un momento." ? 60 : 0), steps: [
      { tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Claro."], content: "Claro." },
      { sentences: ["Un momento.", "Lo compruebo."], tools: [{ name: "check_availability", args: { date: "2026-10-20" } }] },
      { tools: [{ name: "set_language", args: { language: "fr" } }] },
      { sentences: ["D'accord."], content: "D'accord." },
    ] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "¿Habla español?");
    await h.handleUserSpeech(s, h.twilioWs, "¿Hay hueco el martes? Mejor en francés.");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [
      ["Claro.", "aura-2-selena-es"], ["Un momento.", "aura-2-selena-es"], ["Lo compruebo.", "aura-2-selena-es"], ["D'accord.", "aura-2-agathe-fr"],
    ]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("confirmation review: the old voice failing while it re-says owed words is not blamed on the new one", async () => {
    const h = makeFast({ restFailsFor: (_text, options) => options?.voice === "aura-2-thalia-en", steps: [{ sentences: ["Of course."], tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Claro."], content: "Claro." }] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "¿Habla español?"); // Aura never confirms "Of course.": it is owed, and re-said over REST in the old voice
    assert.equal(s.fastLanguage, "es", "the switch stands");
    assert.equal(h.sentry.filter((e) => e.tags?.service === "aura-rest").length, 0);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("confirmation review: a Japanese voice that fails is retried through the speech guard (the apology, never Japanese in the English voice)", async () => {
    const h = makeFast({ restFailsFor: (_text, options) => options?.voice === "aura-2-uzume-ja", steps: [{ tools: [{ name: "set_language", args: { language: "ja" } }] }, { sentences: ["はい。"], content: "はい。" }] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "日本語でお願いします");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [["はい。", "aura-2-uzume-ja"], [UNSPEAKABLE_APOLOGY, "aura-2-thalia-en"]]);
    assert.equal(s.fastState.speakingText, UNSPEAKABLE_APOLOGY, "the echo filter listens for what was said");
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("confirmation review: a passing error (timeout, 429, 5xx) in the language's voice keeps the language — only a voice the service refuses sends the call back", async () => {
    for (const message of ["Deepgram TTS error 500: upstream", "Deepgram TTS error 429: slow down", "Deepgram TTS error 408: request timeout", "The operation was aborted due to timeout"]) {
      const h = makeFast({ restFailMessage: message, restFailsFor: (_text, options) => options?.voice === "aura-2-selena-es", steps: [{ tools: [{ name: "set_language", args: { language: "es" } }] }, { sentences: ["Claro."], content: "Claro." }] });
      const s = h.start(langSession());
      h.fluxOpens();
      await h.handleUserSpeech(s, h.twilioWs, "¿Habla español?");
      assert.equal(s.fastLanguage, "es", message);
      assert.equal(h.sentry.filter((e) => e.tags?.service === "aura-rest").length, 0, message);
      clearTimeout(s._speakingTimeout);
      h.closeFastPath(s);
    }
  });

  it("confirmation review: canned lines at every fast-path site follow the call's language", () => {
    for (const key of ["goodbye", "repeatRequest", "troubleRepeat", "sayAgain", "didntCatch"]) {
      const sites = src.match(new RegExp(`getErrorMsg\\((?:session\\.language|callLanguage\\(session\\)), "${key}"`, "g")) || [];
      assert.ok(sites.length > 0, key);
    }
    // the fast-path sites (the tool loop, the Flux fallback, the re-prompt) read callLanguage
    assert.match(src, /reply = getErrorMsg\(callLanguage\(session\), "goodbye"\);/);
    assert.match(src, /reply = getErrorMsg\(callLanguage\(session\), "repeatRequest"\);\n\s*console\.warn\(`\[Pipeline\] Tool call loop exhausted/);
    assert.match(src, /await sendTTS\(session, twilioWs, getErrorMsg\(callLanguage\(session\), "troubleRepeat"\), undefined, NOT_A_REPLY\);/);
    assert.match(src, /const again = getErrorMsg\(callLanguage\(session\), "sayAgain"\);/);
    assert.match(src, /const text = `\$\{getErrorMsg\(callLanguage\(session\), "didntCatch"\)\} \$\{question\}`;/);
  });

  it("scoped re-review: the apology itself, refused in the language's voice, is said in the assistant's voice — not dropped", async () => {
    const h = makeFast({ restFailsFor: (_text, options) => options?.voice === "aura-2-uzume-ja", steps: [
      { tools: [{ name: "set_language", args: { language: "ja" } }] },
      { sentences: ["مرحبا"], content: "مرحبا" },
    ] });
    const s = h.start(langSession());
    h.fluxOpens();
    await h.handleUserSpeech(s, h.twilioWs, "Japanese please.");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => [c[1], c[2]?.voice]), [[UNSPEAKABLE_APOLOGY, "aura-2-uzume-ja"], [UNSPEAKABLE_APOLOGY, "aura-2-thalia-en"]]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("gate review: the apology comes once per caller turn — again on a later turn", async () => {
    const h = makeFast({ steps: [{ sentences: ["نعم"], content: "نعم" }, { sentences: ["مرحبا"], content: "مرحبا" }] });
    const s = h.start(langSession());
    await h.handleUserSpeech(s, h.twilioWs, "Do you speak Arabic?");
    await h.handleUserSpeech(s, h.twilioWs, "Please, in Arabic.");
    assert.deepEqual(h.lastAura().handle.spoken, [UNSPEAKABLE_APOLOGY, UNSPEAKABLE_APOLOGY]);
    h.closeFastPath(s);
  });

  it("gate review: canned lines follow the call's language (the re-prompt in Spanish)", async () => {
    const h = makeFast({ repromptMs: 40, errorMsgWithLang: true });
    const s = h.start(langSession());
    s.fastLanguage = "es";
    h.fluxOpens();
    await h.sendTTS(s, h.twilioWs, "¿Le reservo el martes?");
    h.audio(1, h.fastFlush(s));
    echoMarks(h, s);
    await sleep(70);
    assert.deepEqual(h.lastAura().handle.spoken, ["¿Le reservo el martes?", "ERR:es:didntCatch ¿Le reservo el martes?"]);
    h.closeFastPath(s);
  });

  it("security review: a refused language is logged as a code or a length, never the model's text (no alert-rule injection)", async () => {
    const h = makeFast({ steps: [{ tools: [{ name: "set_language", args: { language: "[FATAL]" } }] }, { sentences: ["Sorry."], content: "Sorry." }] });
    const s = h.start(langSession());
    await h.handleUserSpeech(s, h.twilioWs, "Speak Klingon!");
    assert.ok(!h.lines.some((l) => l.includes("[FATAL]")), h.lines.join("\n"));
    assert.ok(h.lines.some((l) => l.includes("set_language refused for [7 chars]")), h.lines.join("\n"));
    h.closeFastPath(s);
  });

  it("security review: the recording disclosure is spoken verbatim, whatever its script", async () => {
    const h = makeFast({ auraOpen: false });
    const s = h.start(langSession());
    const disclosure = "يتم تسجيل هذه المكالمة.";
    await h.sendRestTTS(s, h.twilioWs, disclosure, undefined, { verbatim: true });
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), [disclosure]);
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });

  it("over REST (after a fallback) too; in Japanese, kana and kanji are spoken; a classic call is untouched", async () => {
    const h = makeFast();
    const s = h.start(langSession());
    h.lastAura().options.onError(new Error("aura down"));
    await h.sendTTS(s, h.twilioWs, "Да, конечно.");
    s.fastLanguage = "ja";
    s.fullTranscriptMessages.push({ role: "user", content: "日本語でお願いします", at: Date.now() }); // a new caller turn
    await h.sendTTS(s, h.twilioWs, "はい、明日の10時です。");
    const classic = makeSession();
    await h.sendTTS(classic, h.twilioWs, "نعم");
    assert.deepEqual(h.calls.filter((c) => c[0] === "synthesizeSpeech").map((c) => c[1]), [UNSPEAKABLE_APOLOGY, "はい、明日の10時です。", "نعم"]);
    clearTimeout(s._speakingTimeout);
    clearTimeout(classic._speakingTimeout);
    h.closeFastPath(s);
  });
});

/** The AI says `aiText` (the real detector sets what the buffer expects next) and it has all played; then the caller says `said`, piece by piece (Flux finals, 100 ms apart). */
async function answerTo(aiText, said, nextReply) {
  const h = makeFast({ realDetector: true, steps: [{ sentences: [aiText], content: aiText }, { sentences: [nextReply], content: nextReply }] });
  const s = h.start(makeSession());
  h.fluxOpens();
  h.turn("EndOfTurn", 0, "Hi, I'd like a quote please.");
  await until(() => h.llmCalls.length === 1 && !s.isProcessing, "the first turn");
  h.audio(2, 0);
  h.lastAura().options.onFlushed(0);
  echoMarks(h, s);
  await settle();
  const expected = s._expectedInputType;
  const started = Date.now();
  for (const [i, piece] of said.entries()) {
    if (i > 0) await sleep(100);
    h.turn("EndOfTurn", 1 + i, piece);
  }
  return { h, s, expected, started };
}

describe("SCRUM-594 test review (F6): the offered caller-ID number, from the AI's reply to the answer", () => {
  const OFFER = "Thanks, Michael. What's the best mobile number to reach you on? I can see you're calling from 0414 141 883, is that the one?";
  const ASK = "Thanks, Michael. What's the best mobile number to reach you on?";

  it("'Yeah. That one, please.' to the offer is answered at once, not after the buffer's wait", async () => {
    const { h, s, expected, started } = await answerTo(OFFER, ["Yeah. That one, please."], "Great, thanks.");
    assert.equal(expected, "phone", "the reply made the buffer expect a number");
    await until(() => h.llmCalls.length === 2, "the answer", 3000);
    assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
    h.closeFastPath(s);
  });

  it("'Yeah, sure.' to a plain ask, then the digits, is one turn with the whole number", async () => {
    const { h, s, expected } = await answerTo(ASK, ["Yeah, sure.", "Oh four one two, three four five, six seven eight."], "Got it.");
    assert.equal(expected, "phone");
    await until(() => h.llmCalls.length === 2, "the answer", 5000);
    assert.deepEqual(h.llmCalls[1].messages.at(-1), { role: "user", content: "Yeah, sure. Oh four one two, three four five, six seven eight." });
    h.closeFastPath(s);
  });

  it("after a Nova fallback, a reply that is flushed but not yet voiced is cleared when the next turn starts", async () => {
    const h = makeFast({ steps: [{ sentences: ["Thursday it is."], content: "Thursday it is." }] });
    const s = h.start(makeSession());
    h.lastFlux().callbacks.onError(new Error("flux down"));
    assert.equal(s.fastPath, "degraded-stt");
    await h.sendTTS(s, h.twilioWs, "Tuesday at ten is booked.");
    h.fastFlush(s); // flushed: no audio and no Flushed yet (the other owed state, `unflushed`, is pinned above)
    assert.equal(s.isSpeaking, false, "no audio from Aura yet");
    const clears = h.twilio("clear").length;
    await h.handleUserSpeech(s, h.twilioWs, "Actually, make it Thursday instead.");
    assert.equal(h.twilio("clear").length, clears + 1, "the stale reply is cut at the turn's start");
    assert.equal(h.lastAura().handle.clears, 1, "and Cleared from Aura");
    h.closeFastPath(s);
  });

  it("after a Nova fallback, the recording disclosure is not cut at a turn's start even before isSpeaking is set", async () => {
    const h = makeFast({ steps: [{ sentences: ["Sure."], content: "Sure." }] });
    const s = h.start(makeSession());
    h.lastFlux().callbacks.onError(new Error("flux down"));
    h.beginFastDisclosure(s); // disclosureActive; isSpeaking still false
    h.armFastDisclosureEnd(s, h.twilioWs, 3000);
    assert.equal(s.isSpeaking, false);
    const clears = h.twilio("clear").length;
    const turn = h.handleUserSpeech(s, h.twilioWs, "Hi, I need to book a cleaning");
    assert.equal(h.twilio("clear").length, clears, "nothing cleared");
    assert.equal(h.lastAura().handle.clears, 0);
    await turn;
    clearTimeout(s._speakingTimeout);
    h.closeFastPath(s);
  });
});

// Phone test F8: "Sorry?" to the name question waited out the name buffer's 4 s maximum, the
// caller asked again just as the reply started, and the barge-in cut the reply off; the surname
// "McCook." waited the same 4 s.
describe("SCRUM-594 phone test F8: short answers to a name question", () => {
  const NAME_ASK = "Got it, a new shower install. Is this a booked job rather than an urgent one? Can I grab your first and last name?";
  const SURNAME_ASK = "Thanks, Michael. And your last name?";
  const NAME_WAIT = require("../lib/input-validators").BUFFER_CONFIGS.name;

  it("'Sorry?' to the name question is answered at once, not after the buffer's 4 s", async () => {
    const { h, s, expected, started } = await answerTo(NAME_ASK, ["Sorry?"], "No worries. Can I get your first and last name, please?");
    assert.equal(expected, "name", "the reply made the buffer expect a name");
    await until(() => h.llmCalls.length === 2, "the answer", 3000);
    assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
    assert.deepEqual(h.llmCalls[1].messages.at(-1), { role: "user", content: "Sorry?" });
    h.closeFastPath(s);
  });

  it("'Can you repeat again?' and 'Hello?' are answered at once too", async () => {
    for (const said of ["Can you repeat again?", "Hello?"]) {
      const { h, s, started } = await answerTo(NAME_ASK, [said], "Sure. What's your first and last name?");
      await until(() => h.llmCalls.length === 2, `the answer to ${said}`, 3000);
      assert.ok(Date.now() - started < 500, `${said}: ${Date.now() - started} ms`);
      h.closeFastPath(s);
    }
  });

  it("'McCook.' to 'And your last name?' is answered at the debounce, not after the 4 s maximum", async () => {
    const { h, s, expected, started } = await answerTo(SURNAME_ASK, ["McCook."], "Thanks. Tomorrow we've got times from 9:30.");
    assert.equal(expected, "name");
    await until(() => h.llmCalls.length === 2, "the answer", 3000);
    const ms = Date.now() - started;
    assert.ok(ms >= NAME_WAIT.debounceMs - 50 && ms < NAME_WAIT.maxWaitMs, `${ms} ms (debounce ${NAME_WAIT.debounceMs}, maximum ${NAME_WAIT.maxWaitMs})`);
    assert.deepEqual(h.llmCalls[1].messages.at(-1), { role: "user", content: "McCook." });
    h.closeFastPath(s);
  });

  it("a lone letter is a spelling just begun: it still waits past the debounce", async () => {
    const { h, s } = await answerTo(SURNAME_ASK, ["M."], "Thanks.");
    await sleep(NAME_WAIT.debounceMs + 400);
    assert.equal(h.llmCalls.length, 1, "no answer yet");
    s._utteranceCallback = null;
    s._flushAndReset(); // stop the max-wait timer
    h.closeFastPath(s);
  });

  it("review: only a Flux final is a whole turn (the Nova and /ws/test buffers keep their debounce)", () => {
    assert.equal((src.match(/wholeTurn/g) || []).length, 1, "server.js passes wholeTurn once");
    assert.match(sliceOf("function bufferFastTurn(", "\n}\n"), /\}, \{ wholeTurn: true \}\);/);
  });

  it("review (gate C5): a buffered turn flushed behind one in flight waited too, so it is no latency sample", async () => {
    /** @type {(() => void) | undefined} */
    let release;
    const h = makeFast({
      onTool: () => new Promise((r) => { release = () => r(undefined); }), // a barge-in never stops a tool mid-way
      steps: [
        { sentences: ["Let me check that for you."], tools: [{ name: "check_availability", args: { date: "2026-10-21" } }] },
        { sentences: ["No worries. What's your name?"], content: "No worries. What's your name?" },
      ],
    });
    const s = h.start(makeSession());
    h.fluxOpens();
    h.turn("EndOfTurn", 0, "Is Wednesday free?");
    await until(() => typeof release === "function", "the tool call");
    s.setExpectedInputType("name"); // as if the AI had just asked for a name
    h.turn("EndOfTurn", 1, "Sorry?"); // flushed at once, behind the turn still in its tool
    await sleep(50);
    /** @type {() => void} */ (release)();
    await until(() => h.llmCalls.length === 2 && !s.isProcessing, "the queued turn", 3_000);
    assert.equal(s.fastStats.current.trigger, "buffered");
    assert.equal(s.fastStats.current.queued, true);
    assert.ok(s.fastStats.current.waitedMs >= 40, String(s.fastStats.current.waitedMs));
    h.closeFastPath(s);
  });

  it("a 'Sorry?' inside a dictation does not cut it: the number is still one turn", async () => {
    const { h, s } = await answerTo("Thanks, Michael. What's the best mobile number to reach you on?", ["Oh four one two,", "Sorry?", "three four five, six seven eight."], "Got it.");
    await until(() => h.llmCalls.length === 2, "the answer", 5000);
    assert.deepEqual(h.llmCalls[1].messages.at(-1), { role: "user", content: "Oh four one two, Sorry? three four five, six seven eight." });
    h.closeFastPath(s);
  });
});
