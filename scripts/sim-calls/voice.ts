/**
 * SCRUM-594 simulated calls: the voice server's REAL conversation logic, with
 * text in place of audio.
 *
 * The voice server is CommonJS with its own node_modules, so it is loaded with
 * Node's own require (never vitest's transform). Its Supabase client is swapped
 * for the shared in-memory store BEFORE anything requires it, and `fetch` only
 * reaches two places: the in-process Next.js tool-call route (the real calendar
 * handlers) and Haiku on the Messages API (gateway.ts). Anything else throws — a
 * simulated call can never write to production.
 *
 * Each call is set up the way server.js sets up a demo-line call on the fast
 * pipeline (context → after-hours → system prompt + caller context → live
 * schedule → applyFastConversationSettings → disclosure → greeting), and each caller turn
 * runs server.js's own buildLLMOptions … handleUserSpeech text (the runtime-slice
 * idiom of tests/server-classic-end-call-wiring.test.js) with the real guards,
 * the real tool executor and live Claude, called exactly as fastLlmResponse
 * calls it. What is NOT simulated: audio, barge-in, STT timing, TTS.
 */
import fs from "fs";
import path from "path";
import util from "util";
import crypto from "crypto";
import Module, { createRequire } from "module";
import { fileURLToPath } from "url";
import { AsyncLocalStorage } from "async_hooks";
import { simDb } from "./fake-supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- the voice server is untyped CommonJS */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VOICE_DIR = path.resolve(HERE, "../../voice-server");
export const SIM_INTERNAL_URL = "http://sim.internal";
export const SIM_INTERNAL_SECRET = "sim-internal-secret";

/** The voice server's modules, loaded once per process. */
let loaded: any = null;

export function loadVoiceServer(): any {
  if (loaded) return loaded;
  // Before ANY voice-server module loads: tool-executor reads these at require time.
  process.env.INTERNAL_API_URL = SIM_INTERNAL_URL;
  process.env.INTERNAL_API_SECRET = SIM_INTERNAL_SECRET;
  process.env.SUPABASE_URL = "http://127.0.0.1:9"; // dead on purpose: a leak past the fake fails, never reaches prod
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sim";
  process.env.LLM_PROVIDER = "anthropic";
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "DEEPGRAM_API_KEY", "VOICE_SERVER_PUBLIC_URL", "SENTRY_DSN"]) delete process.env[k];

  const vsRequire = createRequire(path.join(VOICE_DIR, "server.js"));
  const supabasePath = vsRequire.resolve("./lib/supabase");
  const fake = new Module(supabasePath) as any;
  fake.filename = supabasePath;
  fake.loaded = true;
  fake.exports = { getSupabase: () => simDb.client() };
  (vsRequire.cache as any)[supabasePath] = fake;

  const src = fs.readFileSync(path.join(VOICE_DIR, "server.js"), "utf8");
  loaded = {
    src,
    CallSession: vsRequire("./call-session").CallSession,
    toolExecutor: vsRequire("./services/tool-executor"),
    callContext: vsRequire("./lib/call-context"),
    promptBuilder: vsRequire("./lib/prompt-builder"),
    scheduleCache: vsRequire("./lib/schedule-cache"),
    bookingKeyMod: vsRequire("./lib/booking-key"),
    rescheduleLedger: vsRequire("./lib/reschedule-ledger"),
    rebookCorrection: vsRequire("./lib/rebook-correction"),
    endCallGuard: vsRequire("./lib/end-call-guard"),
    transferEligibility: vsRequire("./lib/transfer-eligibility"),
    ownerTools: vsRequire("./lib/owner-tools"),
    ownerToolRunner: vsRequire("./lib/owner-tool-runner"),
    ownerTurnStamps: vsRequire("./lib/owner-turn-stamps"),
    inputTypeDetector: vsRequire("./lib/input-type-detector"),
    logTranscriptMod: vsRequire("./lib/log-transcript"),
    recordingConsent: vsRequire("./lib/recording-consent"),
    callerHistory: vsRequire("./lib/caller-history"),
    voiceMapping: vsRequire("./lib/voice-mapping"),
    maskPhone: vsRequire("./lib/mask-phone").maskPhone,
    Sentry: vsRequire("./lib/sentry").Sentry,
    claudeChat: vsRequire("./services/claude-chat"),
    pendingTransfers: vsRequire("./lib/pending-transfers"),
    // Absent before SCRUM-594 PHASE 2: a run can still score that code (a fair baseline).
    bookingGuards: optionalRequire(vsRequire, "./lib/booking-guards"),
    // Absent before SCRUM-594 F5 (the fast path's languages).
    fastLanguages: optionalRequire(vsRequire, "./lib/fast-languages"),
  };
  const fastModel = /const FAST_LLM_MODEL = process\.env\.FAST_LLM_MODEL \|\| "([^"]+)";/.exec(src);
  const fastTimeout = /const FAST_LLM_TIMEOUT_MS = ([\d_]+);/.exec(src);
  if (!fastModel || !fastTimeout) throw new Error("sim: FAST_LLM_MODEL / FAST_LLM_TIMEOUT_MS not found in server.js");
  loaded.FAST_LLM_MODEL = process.env.FAST_LLM_MODEL || fastModel[1];
  loaded.FAST_LLM_TIMEOUT_MS = Number(fastTimeout[1].replace(/_/g, ""));
  loaded.getErrorMsg = runSlice(src, {
    from: "const ERROR_MESSAGES = {",
    to: "/**\n * Resolve after-hours state from call context.",
    scope: {},
    names: ["getErrorMsg"],
  }).getErrorMsg;
  loaded.resolveAfterHoursState = runSlice(src, {
    from: "function resolveAfterHoursState(context) {",
    to: "// Global error handlers",
    scope: {},
    names: ["resolveAfterHoursState"],
  }).resolveAfterHoursState;
  // The fast path's conversation settings, exactly as a live fast call gets them
  // (before PHASE 2 that was the voice-style addendum alone).
  loaded.applyFastConversationSettings = src.includes("function applyFastConversationSettings(session) {")
    ? runSlice(src, { from: "const FAST_VOICE_ADDENDUM = [", to: "// Gate B: speculative drafts", scope: { fastLanguagesEnabled: loaded.fastLanguages?.fastLanguagesEnabled ?? (() => false) }, names: ["applyFastConversationSettings"] }).applyFastConversationSettings
    : (() => {
        const { FAST_VOICE_ADDENDUM } = runSlice(src, { from: "const FAST_VOICE_ADDENDUM = [", to: "// Gate B: speculative drafts", scope: {}, names: ["FAST_VOICE_ADDENDUM"] });
        return (session: any) => session.setSystemPrompt(`${session.messages[0]?.content || ""}\n${FAST_VOICE_ADDENDUM}`);
      })();
  // The canned fillers (English): a fast turn never says one after the model has spoken.
  const fillers = runSlice(src, {
    from: "const FILLER_MESSAGES = {",
    to: "// Short/closing responses that don't need a filler.",
    scope: {},
    names: ["FILLER_MESSAGES"],
  }).FILLER_MESSAGES;
  loaded.CANNED_FILLERS = new Set(Object.values(fillers.en as Record<string, string>));
  return loaded;
}

function optionalRequire(req: NodeRequire, id: string): any {
  try {
    return req(id);
  } catch (err) {
    if ((err as { code?: string }).code === "MODULE_NOT_FOUND") return null;
    throw err;
  }
}

function sliceOf(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  if (start < 0) throw new Error(`sim: server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  if (end < 0) throw new Error(`sim: server.js end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}

/** server.js text between two markers, run as a function body whose parameters are `scope`'s keys. */
function runSlice(src: string, o: { from: string; to: string; scope: Record<string, unknown>; names: string[] }): any {
  const params = Object.keys(o.scope);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the runtime-slice idiom the wiring tests use
  const fn = new Function(...params, `${sliceOf(src, o.from, o.to)}\nreturn { ${o.names.join(", ")} };`);
  return fn(...params.map((p) => o.scope[p]));
}

/** voice: the Aura voice the line would be said in (phone test F9: English read by the Spanish voice). */
export type SpokenLine = { text: string; kind: "reply" | "filler"; at: number; voice?: string };
export type ToolEvent = { id: string; name: string; args: unknown; result?: string; at: number };

/** What one simulated call exposes to the caller loop and the scorer. */
export type SimCall = {
  session: any;
  /** What the caller hears before saying anything: the disclosure and the greeting. */
  opening: SpokenLine[];
  /** One caller utterance (as the STT heard it) → what the AI says back. */
  callerSays: (heard: string) => Promise<SpokenLine[]>;
  ended: () => { code: number; reason: string } | null;
  /** Every tool call the model made and the result it was given — guard nudges included. */
  toolTrace: ToolEvent[];
  /** Server log lines from the turn handler ([CancelGate], [RebookGuard], [EndCall], [Pipeline] …). */
  logs: string[];
  /** Turn-handler errors: a [Pipeline] error means the turn apologised instead of answering. */
  anomalies: string[];
  llmStats: { calls: number; ms: number[] };
  systemPrompt: string;
};

const NOT_A_REPLY = Object.freeze({ reply: false });

/**
 * Log lines that mean the simulation itself went wrong (a turn that apologised
 * because of an error, a blocked network call, a gap in the fake store, a
 * stubbed transfer), as opposed to the conversation going wrong. A run with any
 * is reported as an anomaly and never scored as if it were the product's behaviour.
 */
const ANOMALY = /\[Pipeline\] .*error|\[ToolExecutor\] (Failed to execute|Internal API error|Cannot execute)|\[ToolCall\] Unhandled error|fake-supabase: |sim: /;

/**
 * Routes the GLOBAL console (lib modules, the Sentry shim, the Next.js route
 * and handlers) to the simulated call whose turn is running, so concurrent
 * calls in one process keep separate logs. Outside a call, lines go to `fallback`.
 */
export const callLogContext = new AsyncLocalStorage<{ logs: string[] }>();
let consoleRouted = false;
export function routeConsole(fallback: (line: string) => void): void {
  if (consoleRouted) return;
  consoleRouted = true;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    (console as unknown as Record<string, (...a: unknown[]) => void>)[m] = (...args: unknown[]) => {
      const line = `${m}| ${args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4 }))).join(" ")}`;
      const store = callLogContext.getStore();
      if (store) store.logs.push(line);
      else fallback(line);
    };
  }
}

function recordingConsole(lines: string[]) {
  const rec = (m: string) => (...args: unknown[]) =>
    lines.push(`${m}| ${args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4 }))).join(" ")}`);
  return { log: rec("log"), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
}

const fastHook = (name: string) => () => {
  throw new Error(`sim: fast-path hook ${name} called on a text turn`);
};

/**
 * Set up one simulated demo-line call. Mirrors server.js's stream "start"
 * handler for a non-owner call on DEMO_LINE_PIPELINE=classic-fast.
 */
export async function startSimCall(o: { calledNumber: string; callerPhone: string; callSid: string }): Promise<SimCall> {
  const logs: string[] = [];
  const call = await callLogContext.run({ logs }, () => setUpSimCall(o, logs));
  // Lines written while the call was being set up count too (turns are scanned as they run).
  for (const line of logs) if (ANOMALY.test(line)) call.anomalies.push(line.slice(0, 500));
  return call;
}

async function setUpSimCall(o: { calledNumber: string; callerPhone: string; callSid: string }, logs: string[]): Promise<SimCall> {
  const vs = loadVoiceServer();
  const anomalies: string[] = [];
  const toolTrace: ToolEvent[] = [];
  const llmStats = { calls: 0, ms: [] as number[] };
  let spoken: SpokenLine[] = [];
  let closed: { code: number; reason: string } | null = null;

  const context = await vs.callContext.loadCallContext(o.calledNumber);
  if (!context) throw new Error(`sim: no call context for ${o.calledNumber}`);

  const session = new vs.CallSession(o.callSid);
  session.streamSid = `MZ${o.callSid}`;
  session.callerPhone = o.callerPhone;
  session.ownerMode = false;
  session.ownerAuth = null;
  session.ownerFirstName = null;
  session.organizationId = context.organizationId;
  session.assistantId = context.assistantId;
  session.phoneNumberId = context.phoneNumberId;
  session.transferRules = context.transferRules || [];
  session.userPhoneNumber = context.userPhoneNumber || null;
  session.forwardingStatus = context.forwardingStatus || null;
  session.sourceType = context.sourceType || null;
  session.behaviors = context.assistant?.promptConfig?.behaviors || {};
  session.language = context.assistant.language || "en";
  // Phone test F9: the voice each line is said in (server.js sets it the same way).
  session.deepgramVoice = vs.voiceMapping.getDeepgramVoice(context.assistant.voiceId);
  session.organization = {
    timezone: context.organization.timezone,
    businessHours: context.organization.businessHours,
    industry: context.organization.industry,
  };
  session.orgPhoneNumber = o.calledNumber;
  session.telephonyProvider = context.telephonyProvider || "twilio";
  session.piiRedactionEnabled = !!context.assistant.settings?.piiRedactionEnabled;
  session.transferToForwardedNumber = context.assistant?.settings?.transferToForwardedNumber === true;
  // The call record's id (createCallRecord): the envelope callId the handlers anchor bookings to.
  session.callRecordId = crypto.randomUUID();

  const { isAfterHours, afterHoursConfig, effectiveCalendarEnabled } = vs.resolveAfterHoursState(context);
  session.calendarEnabled = effectiveCalendarEnabled;
  session.serviceTypes = context.serviceTypes || [];

  const systemPrompt = vs.promptBuilder.buildSystemPrompt(context.assistant, context.organization, context.knowledgeBase, {
    calendarEnabled: effectiveCalendarEnabled,
    transferRules: session.transferRules,
    isAfterHours,
    afterHoursConfig,
    serviceTypes: context.serviceTypes,
  });
  const phoneForPrompt = session.piiRedactionEnabled ? vs.maskPhone(o.callerPhone) : o.callerPhone;
  let callerContext = `\n\nCALLER CONTEXT:\nThe caller's phone number is ${phoneForPrompt}. If they say "use the number I'm calling from" or "it's the same number", use this number. Do NOT ask them to repeat it.`;
  if (/^\+?\d{7,}$/.test(o.callerPhone)) {
    const supabaseClient = simDb.client();
    const [apptResult, callResult] = await Promise.all([
      supabaseClient.from("appointments").select("id", { count: "exact", head: true })
        .eq("organization_id", context.organizationId).eq("attendee_phone", o.callerPhone).in("status", ["confirmed", "completed"]),
      supabaseClient.from("calls").select("id", { count: "exact", head: true })
        .eq("organization_id", context.organizationId).eq("caller_phone", o.callerPhone),
    ]);
    callerContext += vs.callerHistory.buildReturningCallerHint({
      pastApptCount: apptResult.count || 0,
      totalCalls: callResult.count || 0,
    });
  }
  session.setSystemPrompt(systemPrompt + callerContext);

  let scheduleSnapshot = null;
  if (context.calendarProvider !== "cliniko" && (session.calendarEnabled || session.serviceTypes?.length > 0)) {
    scheduleSnapshot = vs.scheduleCache.getSchedule(context.organizationId);
    if (!scheduleSnapshot) {
      scheduleSnapshot = await vs.callContext.loadScheduleSnapshot(context.organizationId, context.organization, context.serviceTypes);
      if (scheduleSnapshot) vs.scheduleCache.setSchedule(context.organizationId, scheduleSnapshot);
    }
    if (scheduleSnapshot) {
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: context.organization.timezone }).format(new Date());
      const liveSection = vs.promptBuilder.buildLiveScheduleSection(scheduleSnapshot, todayStr);
      if (liveSection) session.setSystemPrompt(`${session.messages[0]?.content || ""}\n${liveSection}`);
    }
  }
  session.scheduleSnapshot = scheduleSnapshot;
  if (scheduleSnapshot) {
    session._cacheUnsub = vs.scheduleCache.onScheduleChanged(context.organizationId, async () => {
      let fresh = vs.scheduleCache.getSchedule(context.organizationId);
      if (!fresh && (session.calendarEnabled || session.serviceTypes?.length > 0)) {
        fresh = await vs.callContext.loadScheduleSnapshot(context.organizationId, session.organization, session.serviceTypes);
        if (fresh) vs.scheduleCache.setSchedule(context.organizationId, fresh);
      }
      if (fresh) session.scheduleSnapshot = fresh;
    });
  }

  // The demo line runs the fast path: its voice-style prompt, context window and booking guards.
  vs.applyFastConversationSettings(session);

  const opening: SpokenLine[] = [];
  const consent = vs.recordingConsent.requiresRecordingDisclosureHybrid(
    context.organization.country,
    context.organization.businessState,
    context.organization.recordingConsentMode,
    session.callerPhone,
  );
  if (consent.required) {
    const disclosureText = vs.recordingConsent.getRecordingDisclosureText(
      context.organization.country,
      context.organization.recording_disclosure_text,
      context.organization.name,
    );
    session.recordingDisclosurePlayed = true;
    session.addMessage("assistant", disclosureText);
    opening.push({ text: disclosureText, kind: "reply", at: Date.now(), voice: session.deepgramVoice });
  }
  const greeting = vs.promptBuilder.getGreeting(context.assistant, context.organization.name, { isAfterHours, afterHoursConfig });
  session.addMessage("assistant", greeting);
  opening.push({ text: greeting, kind: "reply", at: Date.now(), voice: session.deepgramVoice });
  session.setExpectedInputType(vs.inputTypeDetector.detectExpectedInput(greeting));

  const twilioWs = {
    readyState: 1,
    send: () => {},
    close: (code: number, reason: string) => {
      closed = { code, reason };
      twilioWs.readyState = 2;
    },
  };

  const scope: Record<string, unknown> = {
    calendarToolDefinitions: vs.toolExecutor.calendarToolDefinitions,
    listServiceTypesToolDefinition: vs.toolExecutor.listServiceTypesToolDefinition,
    transferToolDefinition: vs.toolExecutor.transferToolDefinition,
    callbackToolDefinition: vs.toolExecutor.callbackToolDefinition,
    endCallToolDefinition: vs.toolExecutor.endCallToolDefinition,
    forwardingFallbackEligible: vs.transferEligibility.forwardingFallbackEligible,
    buildOwnerTools: vs.ownerTools.buildOwnerTools,
    DEFAULT_MODEL: vs.FAST_LLM_MODEL,
    LLM_API_KEY: "sim-unused",
    // fastLlmResponse's request, minus the barge-in signal a text turn never fires.
    streamChatResponse: async (_key: string, messages: unknown[], opts: Record<string, unknown>) => {
      const t0 = Date.now();
      llmStats.calls++;
      try {
        return await vs.claudeChat.streamClaudeResponse(messages, {
          ...opts,
          chunking: "clause",
          signal: AbortSignal.timeout(vs.FAST_LLM_TIMEOUT_MS),
          model: vs.FAST_LLM_MODEL,
        });
      } finally {
        llmStats.ms.push(Date.now() - t0);
      }
    },
    startHoldAudio: () => ({ stop: () => {} }),
    sendClear: () => true,
    sendTTS: async (s: any, _ws: unknown, text: string, isStale?: () => boolean, kind?: unknown) => {
      if (isStale?.()) return 0;
      const filler = kind === NOT_A_REPLY && vs.CANNED_FILLERS.has(text);
      // A fast turn never says a canned filler once the model has spoken in it
      // (handleUserSpeech: `if (fastTurn) … fillerSentThisTurn = true`); the text
      // turn here is a classic one, so that rule is applied to what it says.
      if (filler && spoken.some((l) => l.kind === "reply")) return 0;
      // Phone test F9: each sentence in its own language's voice, chosen as the server's fastSpeech does
      // (before F9: the line's voice).
      const voice = vs.fastLanguages?.sentenceVoice ? vs.fastLanguages.sentenceVoice(s, text).voice || s?.baseDeepgramVoice : s?.deepgramVoice;
      spoken.push({ text, kind: kind === NOT_A_REPLY ? "filler" : "reply", at: Date.now(), voice });
      return 0;
    },
    executeToolCall: async (name: string, args: unknown, ctx: unknown) => {
      if (name === "transfer_call") {
        // Never a real Twilio transfer from a simulation. The "sim: " line marks
        // the run as an anomaly: a made-up result is not the product's behaviour.
        console.warn("sim: transfer_call stubbed — this run is not a fair score");
        return { message: "Transfers are unavailable right now.", success: false };
      }
      return vs.toolExecutor.executeToolCall(name, args, ctx);
    },
    applyCallerIdPhoneFallback: vs.toolExecutor.applyCallerIdPhoneFallback,
    checkBookingGuards: vs.bookingGuards?.checkBookingGuards,
    fastCancelGate: vs.bookingGuards?.fastCancelGate,
    checkCallerDone: vs.bookingGuards?.checkCallerDone,
    withBookedName: vs.bookingGuards?.withBookedName,
    noteNameCorrection: vs.bookingGuards?.noteNameCorrection,
    forgetCancelledBooking: vs.bookingGuards?.forgetCancelledBooking,
    noteBookingGuardCap: vs.bookingGuards?.noteBookingGuardCap,
    CANCEL_KEPT_NUDGE: vs.bookingGuards?.CANCEL_KEPT_NUDGE,
    // SCRUM-594 F5/F9: the call's languages — no streams here; the line's move is recorded.
    planLanguageSwitch: vs.fastLanguages?.planLanguageSwitch,
    FAST_LANGUAGES: vs.fastLanguages?.FAST_LANGUAGES,
    recordLanguageSwitch: vs.fastLanguages?.recordLanguageSwitch,
    textLanguage: vs.fastLanguages?.textLanguage,
    beginReplyLanguage: vs.fastLanguages?.beginReplyLanguage,
    LANGUAGE_UNHEARD_NOTE: vs.fastLanguages?.LANGUAGE_UNHEARD_NOTE,
    // Before F9 (a fair baseline): set_language and the caller-side switches.
    setLanguageToolDefinition: vs.fastLanguages?.setLanguageToolDefinition,
    detectCallerLanguage: vs.fastLanguages?.detectCallerLanguage,
    detectCallerEnglish: vs.fastLanguages?.detectCallerEnglish,
    LANGUAGE_UNHEARD_MESSAGE: vs.fastLanguages?.LANGUAGE_UNHEARD_MESSAGE,
    switchFastLanguageStreams: (s: any, sw: { voice?: string }) => { s.deepgramVoice = sw.voice; return true; },
    runOwnerToolCall: vs.ownerToolRunner.runOwnerToolCall,
    scheduleCache: vs.scheduleCache,
    noteAssistantSpeech: vs.ownerTurnStamps.noteAssistantSpeech,
    noteAssistantTurnEnd: vs.ownerTurnStamps.noteAssistantTurnEnd,
    OWNER_MAX_TOOL_CALLS: vs.ownerToolRunner.OWNER_MAX_TOOL_CALLS,
    ownerToolLoopReply: vs.ownerToolRunner.ownerToolLoopReply,
    getErrorMsg: vs.getErrorMsg,
    detectExpectedInput: vs.inputTypeDetector.detectExpectedInput,
    logTranscript: vs.logTranscriptMod.logTranscript,
    bookingKey: vs.bookingKeyMod.bookingKey,
    classifyRebookAttempt: vs.rebookCorrection.classifyRebookAttempt,
    CORRECTION_ERROR_MESSAGE: vs.rebookCorrection.CORRECTION_ERROR_MESSAGE,
    DUPLICATE_REBOOK_MESSAGE: vs.rebookCorrection.DUPLICATE_REBOOK_MESSAGE,
    Sentry: vs.Sentry,
    normalizeDatetime: vs.bookingKeyMod.normalizeDatetime,
    CANCEL_NUDGE: vs.rebookCorrection.CANCEL_NUDGE,
    RESCHEDULE_SUCCESS_SIGNAL: vs.rescheduleLedger.RESCHEDULE_SUCCESS_SIGNAL,
    applyRescheduleToLedger: vs.rescheduleLedger.applyRescheduleToLedger,
    saveForTransfer: vs.pendingTransfers.saveForTransfer,
    checkEndCallGuard: vs.endCallGuard.checkEndCallGuard,
    END_CALL_PLAYBACK_CAP_MS: 0,
    END_CALL_TAIL_MS: 0,
    WebSocket: { OPEN: 1 },
    Date,
    fastFlush: fastHook("fastFlush"),
    beginFastTurn: fastHook("beginFastTurn"),
    NOT_A_REPLY,
    noteFastTurnFailure: fastHook("noteFastTurnFailure"),
    fastAudioBusy: fastHook("fastAudioBusy"),
    waitForFastTurnStart: fastHook("waitForFastTurnStart"),
    console: recordingConsole(logs),
  };
  const { handleUserSpeech } = runSlice(vs.src, {
    from: "function buildLLMOptions(session, { includeTransfer = false } = {}) {",
    to: "/**\n * Synthesize text and stream mulaw chunks back to Twilio.",
    scope,
    names: ["handleUserSpeech"],
  });

  // Tool calls and their results, read from the conversation after each turn
  // (a turn's own messages survive the 20-message window: it trims only older ones).
  const seenToolCalls = new Set<string>();
  const seenToolResults = new Set<string>();
  const harvestTools = () => {
    for (const m of session.messages) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (seenToolCalls.has(tc.id)) continue;
          seenToolCalls.add(tc.id);
          let args: unknown = tc.function?.arguments;
          try {
            if (typeof args === "string") args = JSON.parse(args);
          } catch {
            /* the model's malformed JSON is kept verbatim for the judge */
          }
          toolTrace.push({ id: tc.id, name: tc.function?.name, args, at: Date.now() });
        }
      }
      if (m.role === "tool" && m.tool_call_id && !seenToolResults.has(m.tool_call_id)) {
        seenToolResults.add(m.tool_call_id);
        const ev = toolTrace.find((t) => t.id === m.tool_call_id);
        if (ev) ev.result = String(m.content);
      }
    }
  };

  return {
    session,
    opening,
    systemPrompt: session.messages[0]?.content || "",
    toolTrace,
    logs,
    anomalies,
    llmStats,
    ended: () => closed,
    callerSays: async (heard: string) => {
      spoken = [];
      const before = logs.length;
      await callLogContext.run({ logs }, () => handleUserSpeech(session, twilioWs, heard));
      harvestTools();
      for (const line of logs.slice(before)) {
        if (ANOMALY.test(line)) anomalies.push(line.slice(0, 500));
      }
      return spoken;
    },
  };
}
