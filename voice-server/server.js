require("dotenv").config();

const { initSentry, Sentry } = require("./lib/sentry");
const { SENTRY_REASONS, setReasonTag } = require("./lib/sentry-reasons");
initSentry();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
// express ships no bundled types and @types/express isn't a dependency; keeping
// it untyped scopes the SCRUM-317 burndown (typing every route handler — and the
// req/res/query shapes that come with it — is a separate effort).
// @ts-ignore -- missing type declarations for "express"
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { CallSession } = require("./call-session");
const { openDeepgramStream, transcribeRecording } = require("./services/deepgram-stt");
const { getChatResponse, streamChatResponse, LLM_PROVIDER, DEFAULT_MODEL } = require("./services/openai-llm");
const { synthesizeSpeech, chunkAudioForTwilio } = require("./services/deepgram-tts");
const { boostAura } = require("./lib/aura-gain");
const { loadCallContext, loadTestCallContext, loadScheduleSnapshot } = require("./lib/call-context");
const { buildSystemPrompt, getGreeting, buildLiveScheduleSection } = require("./lib/prompt-builder");
const scheduleCache = require("./lib/schedule-cache");
const { bookingKey, normalizeDatetime } = require("./lib/booking-key");
const { applyRescheduleToLedger, RESCHEDULE_SUCCESS_SIGNAL } = require("./lib/reschedule-ledger"); // SCRUM-563
const { classifyRebookAttempt, DUPLICATE_REBOOK_MESSAGE, CORRECTION_ERROR_MESSAGE, CANCEL_NUDGE } = require("./lib/rebook-correction"); // SCRUM-557
const { createCallRecord, completeCallRecord, notifyCallCompleted, applyReanalysis } = require("./lib/call-logger");
const { calendarToolDefinitions, listServiceTypesToolDefinition, transferToolDefinition, callbackToolDefinition, endCallToolDefinition, executeToolCall, applyCallerIdPhoneFallback } = require("./services/tool-executor");
const { createGeminiSession, GEMINI_MODEL } = require("./services/gemini-live");
const { createOpenAIRealtimeSession, createGrokRealtimeSession, resolveOpenAIRealtimeModel } = require("./services/openai-realtime"); // SCRUM-378 eval spike (OpenAI + Grok share the adapter)
const { createSessionWithFailover, isFailoverEnabled } = require("./services/gemini-failover"); // SCRUM-535
const { resolveTestPipeline, KNOWN_TEST_PIPELINES, resolveOwnerPipeline, resolveCallPipeline, fastPathKeysPresent } = require("./lib/pipeline-routing"); // SCRUM-378 per-number test override; SCRUM-587 OWNER_PIPELINE; SCRUM-594 DEMO_LINE_PIPELINE
const { checkEndCallGuard } = require("./lib/end-call-guard"); // SCRUM-594: the SCRUM-373 end_call guard for the classic pipeline
const { checkBookingGuards, fastCancelGate, checkCallerDone, withBookedName, noteNameCorrection, forgetCancelledBooking, noteBookingGuardCap, CANCEL_KEPT_NUDGE } = require("./lib/booking-guards"); // SCRUM-594 PHASE 2: the fast path's booking guards
// SCRUM-594: the fast classic pipeline (DEMO_LINE_PIPELINE=classic-fast, spec 4.8):
// Flux STT and its turn engine, the Aura stream and the player that carries it
// to Twilio, speculative drafts, and Claude with clause chunking. These modules
// never capture to Sentry; server.js does.
const { openFluxStream, fluxConfigFromEnv } = require("./services/flux-stt");
const { openAuraStream } = require("./services/aura-stream");
const { createAuraRouter } = require("./services/aura-router"); // SCRUM-594 (phone test F9): a stream per voice
const { DEFAULT_HOST } = require("./services/deepgram-ws-common");
const { createFastPlayer } = require("./lib/fast-player");
const { createFastTurnEngine, endsWithQuestion, isBackchannel, isLikelyEcho } = require("./lib/fast-turns");
const { FLUX_MULTI_MODEL, FAST_LANGUAGES, fastLanguagesEnabled, unspeakableText, planLanguageSwitch, recordLanguageSwitch, textLanguage, sentenceVoice, beginReplyLanguage, UNSPEAKABLE_APOLOGY, LANGUAGE_UNHEARD_NOTE } = require("./lib/fast-languages"); // SCRUM-594 (F5, F9)
const { createNoTurnWatchdog } = require("./lib/no-turn-watchdog");
const { startSpeculativeReply } = require("./lib/speculative-reply");
const { streamClaudeResponse } = require("./services/claude-chat");
const { handleConversationRelayConnection, buildConversationRelayTwiml } = require("./services/conversationrelay"); // SCRUM-378 eval spike (ConversationRelay + Claude)
const { validateToolResponse } = require("./services/turn-validator");
const { detectPhantomAction, detectPostCallPhantoms, summarizePhantoms, netLiveOutcome, buildToolOutcomeDigest } = require("./lib/action-claim-detector"); // SCRUM-381 live + SCRUM-383 post-call + SCRUM-559 cancel-aware state checks
// SCRUM-166 outbound calling service (cherry-picked to main for smoke testing)
const {
  makeOutboundCall,
  runOutboundSuite,
  handleOutboundConnection,
  verifyOutboundToken,
  pendingCalls: outboundPendingCalls,
} = require("./services/outbound-caller");
const { createAllFixtures } = require("./lib/outbound-fixtures");
const {
  outboundSmokeTestEnabled,
  validateOutboundTarget,
} = require("./lib/outbound-guard");
const { buildReturningCallerHint } = require("./lib/caller-history");

const VOICE_PIPELINE = process.env.VOICE_PIPELINE || "classic"; // "classic" or "gemini-live"

// Audio caches — used by classic pipeline only (Gemini Live uses native TTS)
const disclosureAudioCache = new Map();
const { analyzeCallTranscript, judgeTranscriptContentLoss } = require("./services/post-call-analysis");
const { getDeepgramVoice, getGeminiVoice } = require("./lib/voice-mapping");
const { generateHoldAudio, getHoldPreset } = require("./lib/hold-audio");
const { detectExpectedInput } = require("./lib/input-type-detector");
const { requiresRecordingDisclosureHybrid, getRecordingDisclosureText } = require("./lib/recording-consent");
const { getSupabase } = require("./lib/supabase");
const { handleRetranscribe } = require("./lib/route-handlers/retranscribe");
const { buildTwoSidedTranscript } = require("./lib/transcript-from-utterances");
const { saveForTransfer, getTransfer, consumeTransfer, finishTransferredCall } = require("./lib/pending-transfers");
const { maybeEmitUnhappyCall } = require("./lib/unhappy-call");
const { forwardingFallbackEligible } = require("./lib/transfer-eligibility");

// SCRUM-375: human-readable name for the assistant's configured language, used
// to bias Gemini's (native-audio, per-turn) language auto-detection toward the
// expected language + English and away from spurious detections on poor audio.
const LANG_DISPLAY = {
  en: "English", ar: "Arabic", es: "Spanish", fr: "French", de: "German",
  it: "Italian", pt: "Portuguese", zh: "Chinese", ja: "Japanese", ko: "Korean",
  hi: "Hindi", vi: "Vietnamese", th: "Thai", id: "Indonesian", nl: "Dutch",
  pl: "Polish", tr: "Turkish", ru: "Russian", el: "Greek", he: "Hebrew",
};
function languageName(code) {
  return LANG_DISPLAY[String(code || "en").toLowerCase().slice(0, 2)] || "the configured language";
}

/**
 * SCRUM-375: per-call LANGUAGE LOCK + take-a-message fail-safe directive.
 * Native-audio Gemini cannot pin input language via config, so this soft prior
 * is the lever: bias toward the configured language + English, refuse to drift
 * to a language the caller hasn't actually used (the low-volume Arabic call was
 * mis-heard as Spanish and locked there), and — the user-chosen safe failure
 * mode — take a message rather than guess/transact when audio can't be
 * understood.
 * SCRUM-547: the original wording (detect once from the first clear turn,
 * then keep that language for the whole call) made a WRONG first-turn
 * detection permanent —
 * a train caller's noise-garbled English was transcribed as one Russian word
 * and the call stayed Russian while they kept speaking English. Switching now
 * needs full-sentence directed evidence, background voices are explicitly not
 * the caller, and switching back when the caller clearly speaks a served
 * language is mandatory.
 * @param {string} langCode
 */
function buildLanguageLockDirective(langCode) {
  const lang = languageName(langCode);
  const langsPhrase = lang === "English" ? "English" : `${lang} and English`;
  const langOrEnglish = lang === "English" ? "English" : `${lang} or English`;
  return (
    `\n\n🌐 LANGUAGE LOCK (read carefully): This business serves callers in ${langsPhrase}. ` +
    `Speak ${langOrEnglish} unless the caller clearly establishes another language — by explicitly asking for it, or by speaking a FULL, clearly intelligible sentence in it directed at you. ` +
    `A single word or fragment is NEVER enough evidence to change language: phone lines are noisy, and background voices (station and train announcements, TVs, other people talking near the caller) are NOT the caller — ignore them completely. ` +
    `Do NOT assume an unrelated language (e.g. Russian, Spanish, German) from unclear, quiet, or noisy audio — ` +
    `if a turn sounds like a language the caller has not clearly used, treat it as ${langOrEnglish} mis-heard on a noisy line and continue in the language they have been using. ` +
    `ONE EXCEPTION cuts through the garble: if you can make out the NAME of a language in an otherwise unclear turn ('Arabic', 'عربي', 'Chinese', 'Greek'…), that is a language REQUEST — do not ignore it and do not transfer; confirm in ONE short line spoken in both your current language and the requested one (e.g. "Would you like to continue in Arabic? تحب تكمل بالعربي؟"), and a yes in either language is full evidence to switch immediately. ` +
    `RECOVERY IS MANDATORY: if you changed language and the caller then clearly speaks ${langOrEnglish}, switch back on that very turn — a wrong language guess must never stick for the rest of the call. ` +
    `If you genuinely cannot understand a turn, ask them to repeat — in the language the caller last clearly used. ` +
    `If after ONE repeat the turn is still COMPLETELY unintelligible (not merely a strong accent or one unclear word), do NOT guess and do NOT book, cancel, or change anything: ` +
    `tell the caller you're having trouble hearing them and use schedule_callback to take their name and number so a person can call them back.`
  );
}

// Cached Twilio REST client for recording and transfer operations
let _twilioRestClient = null;
function getTwilioRestClient() {
  if (!_twilioRestClient) {
    _twilioRestClient = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _twilioRestClient;
}
const { lookupPhoneNumber, isAiEnabled, getAnswerMode, getPhoneNumberContext } = require("./lib/answer-mode");
const { initAudioFrontend } = require("./lib/audio-frontend");
const { detectAndRedact, redactObject } = require("./lib/pii-detector");
const { maskPhone } = require("./lib/mask-phone");
const { getTestClientIp, createTestSessionCaps } = require("./lib/test-session-caps");
const { getMaxSessionDurationMs, DEMO_ORG_ID, MAX_DEMO_CALL_DURATION_MS } = require("./lib/session-limits");
// SCRUM-571/573: rate limits for the public tap-to-call demo line (phone
// path). Guards key on the published NUMBER or the demo org — the line stays
// capped whichever org the owner points it at (currently Smile Hub Dental).
const { isDemoLineCall, isDemoLineNumber, checkDemoLineCall, buildDemoLineRejectTwiml } = require("./lib/demo-line");
const { timingSafeEqualStr } = require("./lib/timing-safe");
const { buildFallbackDisclosureSay } = require("./lib/fallback-dial-consent");
const { getPollyVoice } = require("./lib/polly-voice");
const killSwitch = require("./lib/route-handlers/kill-switch");
// SCRUM-587: owner assistant — PIN front door (lib/route-handlers/owner-pin.js)
// and the pure helpers it shares with the /twiml owner check.
const { getEmbeddedOwnerAccess, isOwnerCall, ownerAssistantEnabled, pinLengthOf } = require("./lib/owner-auth");
const { handleOwnerPin, buildOwnerPinGatherTwiml, gatherLanguageFor, HANGUP_TWIML } = require("./lib/route-handlers/owner-pin");
const { loadOwnerFirstName } = require("./lib/owner-context");
// SCRUM-587: nonce'd stream tokens + the owner_access strip for pendingTokens.
const { mintStreamToken, verifyStreamToken, withoutOwnerAccess } = require("./lib/stream-token");
// SCRUM-587: the owner session — its prompt and tools, the ONE tool path that
// bypasses the customer guards, and the turn clock its confirmation gate reads.
const { buildOwnerPrompt, buildOwnerGreeting, buildOwnerGeminiSuffix } = require("./lib/owner-prompt");
const { buildOwnerTools } = require("./lib/owner-tools");
const { runOwnerToolCall, buildOwnerCallSummary, settleOwnerToolRuns, noteCancelledOwnerToolCalls, ownerToolLoopReply, OWNER_MAX_TOOL_CALLS } = require("./lib/owner-tool-runner");
const { noteAssistantSpeech, noteAssistantTurnEnd, noteOwnerSpeech } = require("./lib/owner-turn-stamps");

// Mirror of API-layer E164_REGEX. Defense-in-depth at the dialer so a bad
// value introduced via direct SQL or a future bug can't be sent to Twilio.
const E164_REGEX_VOICE = /^\+[1-9]\d{7,14}$/;

// SCRUM-339: caller PII (transcripts, AI echoes, tool-call args) must never
// reach stdout in production — Fly ships it to Grafana Loki. Shared helpers
// gate full content behind DEBUG_TRANSCRIPTS (off in prod) and otherwise log a
// non-PII breadcrumb. See voice-server/lib/log-transcript.js.
const { DEBUG_TRANSCRIPTS, logTranscript, logToolCall } = require("./lib/log-transcript");

// Validate required env vars before deriving any constants
// LLM API key env var depends on provider
const LLM_KEY_MAP = { openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
const llmKeyEnv = LLM_KEY_MAP[LLM_PROVIDER] || "ANTHROPIC_API_KEY";
const REQUIRED_ENV = [
  "DEEPGRAM_API_KEY",
  llmKeyEnv,
  "PUBLIC_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];
// Twilio credentials are optional — only needed if serving Twilio numbers
const OPTIONAL_PROVIDER_ENV = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TELNYX_API_KEY"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}
if (!process.env.TWILIO_ACCOUNT_SID && !process.env.TELNYX_API_KEY) {
  console.error("At least one telephony provider must be configured: TWILIO_ACCOUNT_SID or TELNYX_API_KEY");
  process.exit(1);
}

const PORT = process.env.PORT || 3001;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const LLM_API_KEY = process.env[LLM_KEY_MAP[LLM_PROVIDER] || "OPENAI_API_KEY"];
const PUBLIC_URL = process.env.PUBLIC_URL;
// Public URL of the Next.js app — used to build recording webhook URLs that
// Twilio/Telnyx POST to. Intentionally NO fallback to PUBLIC_URL: if unset,
// recording is hard-disabled (otherwise we'd POST to the voice server's URL → 404).
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL;
if (!APP_PUBLIC_URL) {
  // SCRUM-212: page once at boot instead of a per-call console.warn — this
  // misconfig silently disables ALL recording storage (AI calls refuse to
  // record; voicemail stays on Twilio and the dashboard 401s on playback).
  // Line format matches lib/sentry.js so the Grafana error-logged rule fires.
  console.error("[ALERT:error] [voice-server] APP_PUBLIC_URL not set — call recordings (AI calls + voicemail) cannot reach Supabase storage; recording is disabled for AI calls and voicemail playback will 401");
}
const WS_SECRET = process.env.TWILIO_AUTH_TOKEN;
const WS_URL = PUBLIC_URL.replace(/^http/, "ws") + "/ws/audio";
// SCRUM-378 eval spike: ConversationRelay connects to its own WS path (JSON
// protocol, not the μ-law media stream). Only reached for a TEST number listed
// in TEST_PIPELINE_OVERRIDES as "<number>:conversationrelay".
const CR_WS_URL = PUBLIC_URL.replace(/^http/, "ws") + "/ws/conversationrelay";
const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const TEST_CALL_SECRET = process.env.TEST_CALL_SECRET;

if (!INTERNAL_API_URL || !INTERNAL_API_SECRET) {
  console.warn("[Startup] INTERNAL_API_URL or INTERNAL_API_SECRET not set — post-call notifications will not work (spam analysis, billing, webhooks skipped)");
}

if (!TEST_CALL_SECRET) {
  console.warn("[Startup] TEST_CALL_SECRET not set — browser test calls will be disabled (token validation will reject all requests)");
}

if (!process.env.OUTBOUND_CALLER_NUMBER) {
  console.warn("[Startup] OUTBOUND_CALLER_NUMBER not set — outbound test calls will not work");
}

// Localized error/fallback messages spoken to callers via TTS
const ERROR_MESSAGES = {
  en: {
    notConfigured: "Sorry, this number is not currently configured. Please try again later.",
    technicalDifficulty: "I'm sorry, I'm experiencing technical difficulties. Please try calling again.",
    repeatRequest: "I apologize, I'm having trouble processing that. Could you repeat what you said?",
    troubleRepeat: "I'm sorry, I'm having a little trouble right now. Could you repeat that?",
    transferFailed: (name) => `I'm sorry, ${name} wasn't available right now. Would you like me to take a message, or is there something else I can help you with?`,
    // SCRUM-594: spoken when the model ends a classic call without saying goodbye itself
    goodbye: "Thanks for calling — goodbye.",
    // SCRUM-594 gate (fast path): the caller's words were lost with Flux (M4a, M4b), or no answer came to a question (M5)
    sayAgain: "Sorry, could you say that again?",
    didntCatch: "Sorry, I didn't catch that.",
  },
  es: {
    notConfigured: "Lo sentimos, este número no está configurado actualmente. Por favor intente más tarde.",
    technicalDifficulty: "Lo siento, estoy experimentando dificultades técnicas. Por favor llame de nuevo.",
    repeatRequest: "Disculpe, tuve problemas procesando eso. ¿Podría repetirlo?",
    troubleRepeat: "Lo siento, estoy teniendo un pequeño problema. ¿Podría repetir eso?",
    transferFailed: (name) => `Lo siento, ${name} no está disponible en este momento. ¿Le gustaría dejar un mensaje, o hay algo más en lo que pueda ayudarle?`,
    goodbye: "Gracias por llamar. ¡Adiós!",
    sayAgain: "Perdón, ¿podría repetirlo?",
    didntCatch: "Perdón, no le entendí.",
  },
  // SCRUM-594 (F5): the lines a fast-path call can hear once it has switched language
  // (lib/fast-languages.js); any other key falls back to English.
  fr: {
    repeatRequest: "Excusez-moi, je n'ai pas pu traiter cela. Pourriez-vous répéter ?",
    troubleRepeat: "Désolée, j'ai un petit souci. Pourriez-vous répéter ?",
    goodbye: "Merci de votre appel. Au revoir !",
    sayAgain: "Pardon, pourriez-vous répéter ?",
    didntCatch: "Pardon, je n'ai pas compris.",
  },
  de: {
    repeatRequest: "Entschuldigung, das konnte ich nicht verarbeiten. Könnten Sie das wiederholen?",
    troubleRepeat: "Entschuldigung, ich habe gerade ein kleines Problem. Könnten Sie das wiederholen?",
    goodbye: "Danke für Ihren Anruf. Auf Wiederhören!",
    sayAgain: "Entschuldigung, könnten Sie das noch einmal sagen?",
    didntCatch: "Entschuldigung, das habe ich nicht verstanden.",
  },
  it: {
    repeatRequest: "Mi scusi, non sono riuscita a elaborarlo. Può ripetere?",
    troubleRepeat: "Mi scusi, ho un piccolo problema. Può ripetere?",
    goodbye: "Grazie per la chiamata. Arrivederci!",
    sayAgain: "Scusi, può ripetere?",
    didntCatch: "Scusi, non ho capito.",
  },
  nl: {
    repeatRequest: "Sorry, dat kon ik niet verwerken. Kunt u het herhalen?",
    troubleRepeat: "Sorry, ik heb even een klein probleem. Kunt u dat herhalen?",
    goodbye: "Bedankt voor het bellen. Tot ziens!",
    sayAgain: "Sorry, kunt u dat herhalen?",
    didntCatch: "Sorry, dat verstond ik niet.",
  },
  ja: {
    repeatRequest: "申し訳ございません、うまく処理できませんでした。もう一度おっしゃっていただけますか？",
    troubleRepeat: "申し訳ございません、少し問題が発生しています。もう一度おっしゃっていただけますか？",
    goodbye: "お電話ありがとうございました。失礼いたします。",
    sayAgain: "すみません、もう一度おっしゃっていただけますか？",
    didntCatch: "すみません、聞き取れませんでした。",
  },
};

function getErrorMsg(lang, key, ...args) {
  const msgs = ERROR_MESSAGES[lang] || ERROR_MESSAGES.en;
  const msg = msgs[key] || ERROR_MESSAGES.en[key];
  return typeof msg === "function" ? msg(...args) : msg;
}

/**
 * Resolve after-hours state from call context.
 * Returns { isAfterHours, afterHoursConfig, effectiveCalendarEnabled } used
 * to customize prompts/greetings. Calendar tools remain available during
 * after-hours so callers can still book appointments for business hours.
 */
function resolveAfterHoursState(context) {
  const isAfterHours = context.isAfterHours || false;
  const afterHoursConfig = context.afterHoursConfig || null;
  const afterHoursEnabled = !!(context.assistant.promptConfig?.behaviors?.afterHoursHandling);
  const isActive = isAfterHours && afterHoursEnabled;

  // Keep calendar tools available during after-hours so callers can still
  // book appointments for business hours. The prompt instructs the AI to
  // let the caller know the office is closed while offering to schedule.
  const effectiveCalendarEnabled = context.calendarEnabled || false;

  return { isAfterHours: isActive, afterHoursConfig, effectiveCalendarEnabled };
}

// Global error handlers — fail fast and let Fly.io restart the process.
// Both handlers exit with code 1 so a broken process doesn't linger in a
// zombie state. Fly's init will immediately restart the VM.
process.on("unhandledRejection", async (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason);
  Sentry.captureException(reason);
  await Sentry.flush(2000).catch(() => {});
  process.exit(1);
});

process.on("uncaughtException", async (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  Sentry.captureException(err);
  await Sentry.flush(2000).catch(() => {});
  process.exit(1);
});

// Escape XML attribute values to prevent TwiML injection
function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Validate Twilio request signature.
 * Twilio signs every webhook request with HMAC-SHA1 using the Auth Token.
 * See: https://www.twilio.com/docs/usage/security#validating-requests
 */
function validateTwilioSignature(req) {
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return false;

  // Build the full URL Twilio used to generate the signature
  const url = PUBLIC_URL + req.originalUrl;

  // Sort POST params alphabetically and concatenate key+value
  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + params[k]).join("");

  const expected = crypto
    .createHmac("sha1", WS_SECRET)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// Pending tokens: issued at /twiml and /twiml/owner-pin, consumed at WebSocket start. Expire after 30s.
// Stores { issuedAt, calledNumber, callerPhone, reconnectCallSid, phoneRecord (owner_access stripped),
// ownerMode, ownerAuth, ownerFirstName } so the WebSocket handler uses server-side values instead of
// trusting client-provided parameters.
const pendingTokens = new Map();
const TOKEN_TTL_MS = 30_000;

/**
 * @param {string} calledNumber
 * @param {string} callerPhone
 * @param {string} [reconnectCallSid]
 * @param {any} [phoneRecord]
 * @param {{ ownerMode?: boolean, ownerAuth?: "verified"|"locked"|"failed"|"error"|null, ownerFirstName?: string|null }} [extra]
 *   SCRUM-587: owner-mode flags live HERE (server-side) — the TwiML parameter
 *   stays an opaque HMAC token, so a client can never assert owner mode.
 */
function issueStreamToken(calledNumber, callerPhone, reconnectCallSid, phoneRecord, extra = {}) {
  // SCRUM-587: `${ts}.${nonce}.${hmac}` — the random nonce keeps two tokens
  // issued in the same millisecond apart (see lib/stream-token.js).
  const token = mintStreamToken(WS_SECRET);
  pendingTokens.set(token, {
    issuedAt: Date.now(),
    calledNumber,
    callerPhone,
    reconnectCallSid,
    // SCRUM-587: never the owner's PIN hash/salt (embedded by lookupPhoneNumber while the flag is on).
    phoneRecord: withoutOwnerAccess(phoneRecord),
    // Owner mode only with a verified PIN: a caller stamped "failed"/"locked" can never carry it.
    ownerMode: extra.ownerMode === true && extra.ownerAuth === "verified",
    ownerAuth: typeof extra.ownerAuth === "string" ? extra.ownerAuth : null,
    ownerFirstName: typeof extra.ownerFirstName === "string" ? extra.ownerFirstName : null,
  });
  return token;
}

/**
 * Verify and consume a stream token. Returns the stored call metadata
 * (calledNumber, callerPhone, reconnectCallSid, phoneRecord, ownerMode, ownerAuth,
 * ownerFirstName) or null if invalid/expired.
 */
function consumeStreamToken(token) {
  try {
    if (!pendingTokens.has(token)) return null;
    const entry = pendingTokens.get(token);
    pendingTokens.delete(token); // single-use
    if (Date.now() - entry.issuedAt > TOKEN_TTL_MS) return null;
    if (!verifyStreamToken(WS_SECRET, token)) return null;
    return {
      calledNumber: entry.calledNumber,
      callerPhone: entry.callerPhone,
      reconnectCallSid: entry.reconnectCallSid,
      phoneRecord: entry.phoneRecord,
      ownerMode: entry.ownerMode === true,
      ownerAuth: entry.ownerAuth || null,
      ownerFirstName: entry.ownerFirstName || null,
    };
  } catch (err) {
    console.error("[Auth] Token verification threw unexpectedly — if this repeats, all calls will be rejected:", err);
    return null;
  }
}

// Clean up expired tokens every 60s
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pendingTokens) {
    if (now - entry.issuedAt > TOKEN_TTL_MS) pendingTokens.delete(token);
  }
}, 60_000).unref();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// SCRUM-287: kill-switch handlers were extracted to
// lib/route-handlers/kill-switch.js for unit testability. The module
// takes a dependency-injection bundle so tests can mock everything;
// this factory wires the real deps used at runtime.
function makeKillSwitchDeps() {
  return {
    Sentry,
    supabase: getSupabase(),
    isAiEnabled,
    lookupPhoneNumber,
    getPhoneNumberContext,
    createCallRecord,
    completeCallRecord,
    maskPhone,
    escapeXml,
    buildFallbackDisclosureSay,
    getPollyVoice,
    publicUrl: PUBLIC_URL,
    e164Regex: E164_REGEX_VOICE,
    // SCRUM-212: Next.js webhook that downloads voicemail recordings into
    // Supabase storage (same endpoint the AI-call paths use). Null when
    // APP_PUBLIC_URL is unset — the handlers degrade to the raw-URL flow.
    recordingStatusCallbackUrl: APP_PUBLIC_URL
      ? `${APP_PUBLIC_URL}/api/webhooks/twilio-recording-done`
      : null,
  };
}

// TwiML endpoint — tells Twilio to connect a bidirectional media stream.
// Validates the Twilio request signature, then stores call metadata server-side
// with the token (never sent back in the XML response to prevent spoofing).
app.post("/twiml", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn("[TwiML] Rejected request — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }

  const called = req.body.Called || "";
  const from = req.body.From || "";
  const reqCallSid = req.body.CallSid || null;

  // Single phone number lookup — shared across isAiEnabled, getAnswerMode, and loadCallContext
  const phoneRecord = await lookupPhoneNumber(called, { callSid: reqCallSid });

  // SCRUM-287: kill-switch (AI-disabled branch) extracted to
  // lib/route-handlers/kill-switch.js so the failure paths are unit-
  // testable. Returns true when a response was sent (we must not
  // continue); false when AI should answer normally.
  if (await killSwitch.handleAiDisabledBranch(req, res, {
    called,
    from,
    reqCallSid,
    phoneRecord,
    provider: "twilio",
    deps: makeKillSwitchDeps(),
  })) {
    return;
  }

  // SCRUM-571/573: the public demo line is an unauthenticated spend surface —
  // rate-gate it BEFORE any stream token is issued. Keyed on the published
  // number OR the demo org (isDemoLineCall), so the guards survive the owner
  // pointing the line at a real org, and even a null phoneRecord (DB
  // fail-open). Rejected calls get static TwiML (no Gemini session).
  if (isDemoLineCall(called, phoneRecord)) {
    const gate = checkDemoLineCall(from);
    if (!gate.allowed) {
      console.warn(`[DemoLine] Rejected call from=${maskPhone(from)} reason=${gate.reason}`);
      return res
        .type("text/xml")
        .send(buildDemoLineRejectTwiml(getPollyVoice(phoneRecord?.organizations?.country)));
    }
    console.log(`[DemoLine] Accepted demo-line call from=${maskPhone(from)}`);
  }

  // SCRUM-587: owner assistant (spec §1). Caller ID is necessary, never
  // sufficient (spoofable, SCRUM-414) — a PIN <Gather> follows, collected by
  // Twilio BEFORE the AI connects so the digits never reach the recording,
  // the transcript or the analysis. Placed after the kill switch + demo gate
  // and BEFORE ring-first, so an owner whose ring-first target is their own
  // mobile doesn't ring themselves. Fails toward a customer call on any defect.
  try {
    const ownerAccess = getEmbeddedOwnerAccess(phoneRecord);
    if (isOwnerCall({ from, forwardedFrom: req.body.ForwardedFrom, ownerAccess, enabled: ownerAssistantEnabled() })) {
      console.log(`[OwnerPin] Owner caller ID matched for ${called} (from=${maskPhone(from)}) — gathering PIN`);
      return res.type("text/xml").send(buildOwnerPinGatherTwiml({
        publicUrl: PUBLIC_URL,
        pollyVoice: getPollyVoice(phoneRecord?.organizations?.country),
        pinLength: pinLengthOf(ownerAccess),
        attempt: 1,
        retry: false,
        language: gatherLanguageFor(phoneRecord?.organizations?.country),
        escapeXml,
      }));
    }
  } catch (err) {
    console.error("[ALERT:error] [OwnerPin] owner check failed — continuing as a customer call:", err.message);
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "owner_pin");
        scope.setExtras({ calledMasked: maskPhone(called), callSid: reqCallSid });
        Sentry.captureException(err);
      });
    } catch (sentryErr) {
      console.error("[OwnerPin] Sentry capture failed (suppressed):", sentryErr.message);
    }
  }

  // Check if this assistant uses ring-first mode
  try {
    const answerMode = await getAnswerMode(called, phoneRecord);
    if (answerMode && answerMode.answerMode === "ring_first") {
      console.log(`[TwiML] Ring-first mode: from=${maskPhone(from)} to=${called}, ringing ${maskPhone(answerMode.ringFirstNumber)} for ${answerMode.ringFirstTimeout}s`);

      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${escapeXml(String(answerMode.ringFirstTimeout))}" action="${escapeXml(PUBLIC_URL + '/twiml/ring-first-fallback')}" callerId="${escapeXml(from)}">
    ${escapeXml(answerMode.ringFirstNumber)}
  </Dial>
</Response>`);
    }
  } catch (err) {
    // Non-fatal — fall through to default AI-first behavior. Still surface
    // to Sentry though: ring-first is a customer intent ("ring my mobile
    // first, then AI as fallback"). Silently degrading to AI-first is a
    // UX-level intent violation, even if it's not a kill-switch violation.
    console.error("[TwiML] getAnswerMode failed (falling back to AI):", err.message);
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.RING_FIRST_DEGRADED);
        scope.setLevel("warning");
        scope.setExtras({
          calledMasked: maskPhone(called),
          callSid: reqCallSid,
          provider: "twilio",
        });
        Sentry.captureException(err);
      });
    } catch (sentryErr) {
      console.error("[TwiML] Sentry capture failed (suppressed):", sentryErr.message);
    }
  }

  // Default: AI answers immediately — pass phoneRecord to avoid re-querying in loadCallContext
  const token = issueStreamToken(called, from, undefined, phoneRecord);
  console.log(`[TwiML] Incoming call from=${maskPhone(from)} to=${called}, streaming to ${WS_URL}`);

  // Recording is started via Twilio REST API in the WebSocket handler (not TwiML)
  // because <Connect record="record-from-answer"> doesn't work with <Stream>.

  // SCRUM-378: non-destructive eval override. A TEST number listed in
  // TEST_PIPELINE_OVERRIDES as "<number>:conversationrelay" gets a
  // <Connect><ConversationRelay> (Twilio-side Deepgram STT + ElevenLabs TTS,
  // Claude on our WS) instead of the μ-law <Stream> below. The kill-switch and
  // ring-first checks above already ran, and the same server-side token is
  // issued, so only the transport changes. Unset env → unchanged <Stream>.
  if (resolveTestPipeline(called) === "conversationrelay") {
    console.log(`[Pipeline] TEST override → conversationrelay for called=${called}`);
    return res.type("text/xml").send(buildConversationRelayTwiml({ wsUrl: CR_WS_URL, token, escapeXml }));
  }

  // Gemini Live: NO TwiML <Say> — Gemini speaks everything in one voice.
  // The clientContent trigger (sent after setupComplete) makes Gemini speak
  // the greeting immediately, including the recording disclosure.

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(WS_URL)}">
      <Parameter name="auth_token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`);
});

// SCRUM-587: real deps for the owner-PIN action handler (mirrors makeKillSwitchDeps).
function makeOwnerPinDeps() {
  return {
    lookupPhoneNumber,
    supabase: getSupabase(),
    loadOwnerFirstName,
    issueStreamToken,
    Sentry,
    maskPhone,
    escapeXml,
    getPollyVoice,
    publicUrl: PUBLIC_URL,
    wsUrl: WS_URL,
  };
}

// SCRUM-587: Twilio posts the <Gather> result here (Digits / SpeechResult).
// Signed like every other Twilio webhook; everything else lives in the
// injectable handler so each outcome is unit-tested without live env.
app.post("/twiml/owner-pin", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn("[OwnerPin] Rejected request — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }
  try {
    await handleOwnerPin(req, res, { deps: makeOwnerPinDeps() });
  } catch (err) {
    // Last-resort net: the handler never throws by design; if it does, hang up
    // rather than leave Twilio waiting on a 500 (which would play its error tone).
    // The message only, never the error object (the handler's own log rule).
    console.error("[ALERT:error] [OwnerPin] handler threw:", err && err.message);
    if (!res.headersSent) res.type("text/xml").send(HANGUP_TWIML);
  }
});

/**
 * TeXML endpoint — Telnyx-compatible version of /twiml.
 * Telnyx TeXML uses the same XML format (TwiML-compatible) and the same
 * WebSocket media stream protocol. The only difference is webhook signature
 * validation and the endpoint URL used in action callbacks.
 */
// SCRUM-432: make the fail-closed posture visible at boot — if Telnyx is
// ever activated without keys, /texml rejecting everything should not be a
// silent mystery.
if (!process.env.TELNYX_PUBLIC_KEY && !process.env.TELNYX_WEBHOOK_SECRET) {
  console.warn("[TeXML] No TELNYX_PUBLIC_KEY / TELNYX_WEBHOOK_SECRET configured — all /texml webhooks will be REJECTED (fail-closed). Fine while Telnyx is dormant.");
}

/**
 * Validate Telnyx webhook signature (ed25519).
 * Uses Node.js built-in crypto.verify with ed25519 algorithm.
 */
function validateTelnyxSignature(req) {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) {
    // If no public key configured, use shared secret as stopgap
    const secret = process.env.TELNYX_WEBHOOK_SECRET;
    if (secret) {
      const headerSecret = req.headers["x-telnyx-secret"] || req.query?.secret;
      if (!headerSecret || headerSecret.length !== secret.length) return false;
      return crypto.timingSafeEqual(Buffer.from(headerSecret), Buffer.from(secret));
    }
    // SCRUM-432: no verification configured — fail CLOSED regardless of
    // NODE_ENV. The old dev-allow meant a misconfigured staging/dev box
    // accepted unsigned Telnyx webhooks; local testing can set
    // TELNYX_WEBHOOK_SECRET instead.
    console.error("[TeXML] No TELNYX_PUBLIC_KEY or TELNYX_WEBHOOK_SECRET configured — rejecting unsigned webhook");
    return false;
  }

  try {
    const signature = req.headers["telnyx-signature-ed25519"];
    const timestamp = req.headers["telnyx-timestamp"];
    if (!signature || !timestamp) return false;

    const payload = `${timestamp}|${JSON.stringify(req.body)}`;
    const sigBuffer = Buffer.from(signature, "base64");
    const keyBuffer = Buffer.from(publicKey, "base64");
    return crypto.verify(null, Buffer.from(payload), { key: keyBuffer, format: "der", type: "spki" }, sigBuffer);
  } catch (err) {
    console.error("[TeXML] Signature verification error:", err.message);
    return false;
  }
}

app.post("/texml", async (req, res) => {
  if (!validateTelnyxSignature(req)) {
    console.warn("[TeXML] Rejected request — invalid Telnyx signature");
    return res.status(403).send("Forbidden");
  }

  const called = req.body.Called || req.body.To || "";
  const from = req.body.From || req.body.Caller || "";
  const reqCallSid = req.body.CallSid || null;

  const phoneRecord = await lookupPhoneNumber(called, { callSid: reqCallSid });

  // SCRUM-287: kill-switch extracted, same as /twiml. Provider flag
  // selects Telnyx-specific action URLs and the callerId override
  // (Telnyx requires its own number, not the inbound `from`).
  if (await killSwitch.handleAiDisabledBranch(req, res, {
    called,
    from,
    reqCallSid,
    phoneRecord,
    provider: "telnyx",
    deps: makeKillSwitchDeps(),
  })) {
    return;
  }

  // Ring-first mode check (same as /twiml)
  try {
    const answerMode = await getAnswerMode(called, phoneRecord);
    if (answerMode && answerMode.answerMode === "ring_first") {
      console.log(`[TeXML] Ring-first mode: from=${maskPhone(from)} to=${called}, ringing ${maskPhone(answerMode.ringFirstNumber)} for ${answerMode.ringFirstTimeout}s`);
      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${escapeXml(String(answerMode.ringFirstTimeout))}" action="${escapeXml(PUBLIC_URL + '/texml/ring-first-fallback')}" callerId="${escapeXml(from)}">
    ${escapeXml(answerMode.ringFirstNumber)}
  </Dial>
</Response>`);
    }
  } catch (err) {
    // See /twiml note above — ring-first degradation is a UX-level intent
    // violation worth alerting on.
    console.error("[TeXML] getAnswerMode failed (falling back to AI):", err.message);
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.RING_FIRST_DEGRADED);
        scope.setLevel("warning");
        scope.setExtras({
          calledMasked: maskPhone(called),
          callSid: reqCallSid,
          provider: "telnyx",
        });
        Sentry.captureException(err);
      });
    } catch (sentryErr) {
      console.error("[TeXML] Sentry capture failed (suppressed):", sentryErr.message);
    }
  }

  // Default: AI answers
  // Note: recording is started via Telnyx Call Control `record_start` API in the
  // WebSocket stream-start handler — NOT via TeXML — because TeXML-initiated
  // recording does not reliably fire `call.recording.saved` events.
  const token = issueStreamToken(called, from, undefined, phoneRecord);
  console.log(`[TeXML] Incoming call from=${maskPhone(from)} to=${called}, streaming to ${WS_URL}`);

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(WS_URL)}">
      <Parameter name="auth_token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`);
});

// TeXML callback routes — handle Telnyx callbacks with Telnyx signature validation
app.post("/texml/ring-first-fallback", async (req, res) => {
  if (!validateTelnyxSignature(req)) return res.status(403).send("Forbidden");
  const called = req.body.Called || req.body.To || "";
  const from = req.body.From || req.body.Caller || "";
  const phoneRecord = await lookupPhoneNumber(called);
  const token = issueStreamToken(called, from, undefined, phoneRecord);
  console.log(`[TeXML] Ring-first fallback — connecting to AI (from=${maskPhone(from)})`);
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(WS_URL)}">
      <Parameter name="auth_token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`);
});

app.post("/texml/transfer-status", async (req, res) => {
  if (!validateTelnyxSignature(req)) return res.status(403).send("Forbidden");
  const dialStatus = req.body.DialCallStatus || "no-answer";
  const callSid = req.body.CallSid;
  console.log(`[TeXML] Transfer status: ${dialStatus} (callSid=${callSid})`);
  if (dialStatus !== "completed") {
    const called = req.body.Called || req.body.To || "";
    const from = req.body.From || req.body.Caller || "";
    const phoneRecord = await lookupPhoneNumber(called);
    const token = issueStreamToken(called, from, callSid, phoneRecord);
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(WS_URL)}">
      <Parameter name="auth_token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`);
  }
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
});

app.post("/texml/recording-done", async (req, res) => {
  if (!validateTelnyxSignature(req)) return res.status(403).send("Forbidden");
  console.log(`[TeXML] Recording done (callSid=${req.body.CallSid})`);
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
});

/**
 * Transfer whisper — Twilio fetches this when the transfer recipient picks
 * up, before bridging the caller in. Returns a <Say> TwiML that the
 * RECIPIENT hears (caller doesn't). Used to:
 *   - Announce the transfer ("This is a transferred call from <business>…")
 *   - Play the recording disclosure (required for AU all-party consent)
 *
 * Query params:
 *   text — the message to speak. URL-encoded, max 2000 chars.
 *
 * The signature validator covers query params, so the URL we hand Twilio
 * in <Number url="..."> can't be replayed with different text.
 */
app.post("/twiml/transfer-whisper", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn("[TransferWhisper] Rejected request — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }

  const rawText = (req.query.text || req.body.text || "").toString();
  const text = rawText.slice(0, 2000).trim();
  if (!text) {
    return res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  }

  const safeText = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>${safeText}</Say>\n</Response>`
  );
});

/**
 * Transfer status callback — Twilio POSTs here after <Dial> completes.
 * If the target answered, we finish the call record.
 * If no-answer/busy/failed, we reconnect the caller to the AI.
 */
app.post("/twiml/transfer-status", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn("[TransferStatus] Rejected request — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }

  const callSid = req.body.CallSid;
  const dialStatus = req.body.DialCallStatus; // completed, no-answer, busy, failed, canceled
  console.log(`[TransferStatus] callSid=${callSid} dialStatus=${dialStatus}`);

  if (!callSid) {
    return res.status(400).send("Missing CallSid");
  }

  if (dialStatus === "completed") {
    // Target answered — call was successfully transferred
    const savedState = consumeTransfer(callSid);
    if (savedState) {
      finishTransferredCall(savedState, "answered").catch((err) => {
        console.error("[TransferStatus] finishTransferredCall failed:", err);
      });
    }
    // Nothing more to do — Twilio will end the call after both parties hang up
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
  }

  // Transfer failed — try next destination or reconnect caller to AI
  // Use getTransfer (peek) instead of consumeTransfer to avoid a state-loss window.
  // Both saveForTransfer (for chaining/reconnect) and the catch block handle cleanup.
  const savedState = getTransfer(callSid);
  if (!savedState) {
    console.warn(`[TransferStatus] No pending transfer for callSid=${callSid} — hanging up`);
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
  }

  try {
    // Update the transfer attempt outcome
    if (savedState.transferAttempt) {
      savedState.transferAttempt.outcome = dialStatus || "failed";
    }

    // Check if there are more destinations to try in the fallback chain
    const nextIndex = (savedState.destinationIndex || 0) + 1;
    const allDests = savedState.allDestinations || [];
    const MAX_DESTINATIONS = 6; // primary + 5 fallbacks

    if (nextIndex < allDests.length && nextIndex < MAX_DESTINATIONS) {
      if (!PUBLIC_URL) {
        console.error(`[TransferStatus] PUBLIC_URL is empty — cannot chain to destination ${nextIndex + 1}/${allDests.length}, falling back to AI reconnection`);
      } else {
        const nextDest = allDests[nextIndex];
        const safePhone = nextDest.phone.replace(/[^+\d]/g, "");

        // Skip invalid phone numbers
        if (!safePhone || safePhone.length < 7) {
          console.warn(`[TransferStatus] Skipping invalid destination phone at index ${nextIndex}: "${nextDest.phone}"`);
        } else {
          console.log(`[TransferStatus] Trying next destination ${nextIndex + 1}/${allDests.length}: ${nextDest.name || nextDest.phone}`);

          // Update state for the next attempt
          savedState.destinationIndex = nextIndex;
          if (savedState.transferAttempt) {
            savedState.transferAttempt.targetPhone = nextDest.phone;
            savedState.transferAttempt.targetName = nextDest.name || "a team member";
          }
          savedState.transferTargetName = nextDest.name || "a team member";

          // Re-save state for the next callback (overwrites the peeked entry)
          saveForTransfer(callSid, savedState);

          return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25" action="${escapeXml(PUBLIC_URL + '/twiml/transfer-status')}">${safePhone}</Dial>
</Response>`);
        }
      }
    }

    // No more destinations — reconnect caller to AI
    // Issue a new stream token that carries the reconnectCallSid
    const token = issueStreamToken(
      savedState.orgPhoneNumber || "",
      savedState.callerPhone || "",
      callSid
    );

    // Re-save the state so the WebSocket reconnection handler can pick it up
    saveForTransfer(callSid, savedState);

    console.log(`[TransferStatus] Reconnecting callSid=${callSid} to AI (dialStatus=${dialStatus})`);

    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(WS_URL)}">
      <Parameter name="auth_token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`);
  } catch (err) {
    console.error(`[TransferStatus] Failed to set up reconnection for callSid=${callSid}:`, err);
    // Safety net: complete the call record since reconnection failed
    finishTransferredCall(savedState, dialStatus || "failed").catch((finishErr) => {
      console.error("[TransferStatus] Safety net finishTransferredCall also failed:", finishErr);
    });
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
  }
});

/**
 * Ring-first fallback — Twilio POSTs here after <Dial> completes.
 * If owner answered (completed), just hang up. Otherwise, AI picks up.
 */
app.post("/twiml/ring-first-fallback", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn("[RingFirst] Rejected request — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }

  const callSid = req.body.CallSid;
  const dialStatus = req.body.DialCallStatus; // completed, no-answer, busy, failed, canceled
  const called = req.body.Called || "";
  const from = req.body.From || "";

  console.log(`[RingFirst] callSid=${callSid} dialStatus=${dialStatus}`);

  if (dialStatus === "completed") {
    // Owner answered the call — log it so it appears in the dashboard
    try {
      const ctx = await getPhoneNumberContext(called);
      if (ctx) {
        const callId = await createCallRecord({
          orgId: ctx.organizationId,
          assistantId: ctx.assistantId,
          phoneNumberId: ctx.phoneNumberId,
          callerPhone: from,
          callSid,
        });
        if (callId) {
          const durationSeconds = parseInt(req.body.DialCallDuration, 10) || 0;
          await completeCallRecord(callId, {
            status: "completed",
            durationSeconds,
            answeredBy: "owner",
          });
          await notifyCallCompleted(INTERNAL_API_URL, INTERNAL_API_SECRET, {
            callId,
            organizationId: ctx.organizationId,
            assistantId: ctx.assistantId,
            endedReason: "owner-answered",
          });
          console.log(`[RingFirst] Logged owner-answered call ${callId} (${durationSeconds}s)`);
        }
      }
    } catch (err) {
      console.warn("[RingFirst] Failed to log owner-answered call (non-fatal):", err.message);
    }

    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
  }

  // Owner didn't answer — AI picks up
  // Look up phone record to check recording consent mode
  const ringFirstPhoneRecord = await lookupPhoneNumber(called);
  const token = issueStreamToken(called, from, undefined, ringFirstPhoneRecord);
  console.log(`[RingFirst] Owner missed → AI fallback for from=${maskPhone(from)} to=${called}`);

  const ringFirstRecordingMode = ringFirstPhoneRecord?.organizations?.recording_consent_mode || "auto";
  let ringFirstShouldRecord = ringFirstRecordingMode !== "never";
  if (ringFirstShouldRecord && !APP_PUBLIC_URL) {
    console.warn("[Recording] APP_PUBLIC_URL not set — refusing to attach recording attributes to ring-first <Connect> (callback would 404). Recording disabled for this call.");
    ringFirstShouldRecord = false;
  }
  const ringFirstConnectAttrs = ringFirstShouldRecord
    ? ` record="record-from-answer" recordingStatusCallback="${escapeXml(APP_PUBLIC_URL + '/api/webhooks/twilio-recording-done')}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed failed absent"`
    : "";

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect${ringFirstConnectAttrs}>
    <Stream url="${escapeXml(WS_URL)}">
      <Parameter name="auth_token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`);
});

/**
 * Kill-switch fallback status — Twilio POSTs here after the <Dial> to the
 * customer's configured fallback number completes. If the owner answered,
 * finalise the call record as a successful transfer. Otherwise, fall
 * through to voicemail so the caller is never just dropped.
 *
 * Mirrors /twiml/ring-first-fallback but for the AI-paused path.
 */
// SCRUM-287: finaliseFallbackDial + the two /<provider>/ai-disabled-
// fallback-status routes were extracted to lib/route-handlers/
// kill-switch.js. server.js retains only the signature-validation
// wrapper + thin call into the extracted handler.

app.post("/twiml/ai-disabled-fallback-status", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn("[FallbackStatus] Rejected request — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }
  await killSwitch.handleAiDisabledFallbackStatus(req, res, {
    provider: "twilio",
    deps: makeKillSwitchDeps(),
  });
});

app.post("/texml/ai-disabled-fallback-status", async (req, res) => {
  if (!validateTelnyxSignature(req)) {
    console.warn("[FallbackStatus] Rejected TeXML request — invalid Telnyx signature");
    return res.status(403).send("Forbidden");
  }
  await killSwitch.handleAiDisabledFallbackStatus(req, res, {
    provider: "telnyx",
    deps: makeKillSwitchDeps(),
  });
});

// Legacy Twilio recording callback. The new flow POSTs directly to the Next.js
// webhook /api/webhooks/twilio-recording-done. This handler stays as a no-op so
// older-provisioned numbers still return 200 instead of 404.
app.post("/twiml/recording-status", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    return res.status(403).send("Forbidden");
  }
  console.log("[Recording] Legacy callback hit — new flow is /api/webhooks/twilio-recording-done. Ignoring.", {
    CallSid: req.body.CallSid,
    RecordingSid: req.body.RecordingSid,
  });
  res.status(200).send("OK");
});

// Recording callback for AI-disabled voicemail — Twilio POSTs here after recording ends.
// SCRUM-212: body extracted to lib/route-handlers/kill-switch.js. The raw-URL
// write is now a guarded fallback; Supabase storage happens via the <Record>
// recordingStatusCallback → Next.js webhook (same pipeline as AI calls).
app.post("/twiml/ai-disabled-recording-done", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn("[RecordingDone] Rejected request — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }
  // The goodbye TwiML is owed to the caller no matter what fails here —
  // an async throw (e.g. makeKillSwitchDeps → getSupabase on missing env)
  // would otherwise become an unhandledRejection and take the whole
  // server down mid-call. The original inline handler could never throw;
  // the extraction must keep that invariant.
  try {
    await killSwitch.handleVoicemailRecordingDone(req, res, { deps: makeKillSwitchDeps() });
  } catch (err) {
    console.warn("[RecordingDone] handler failed (non-fatal):", err.message);
    if (!res.headersSent) {
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${getPollyVoice(null)}">Thank you for your message. Goodbye.</Say>
  <Hangup/>
</Response>`);
    }
  }
});

// Health check with Supabase connectivity test
// SCRUM-355: SHALLOW public liveness probe — no DB round-trip. The previous
// version ran a Supabase query on every unauthenticated hit, which (a) let an
// anonymous flood amplify load onto Postgres, and (b) made a Supabase blip fail
// the liveness check, so Fly would cycle the single machine and drop in-flight
// calls. Liveness should reflect "process is up", not "Supabase is reachable".
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Secret-gated READINESS probe — exposes DB connectivity for ops/monitoring
// (NOT used by Fly's liveness checker, which hits /health). Returns a generic
// error on failure (no raw err.message to the client).
app.get("/health/ready", async (req, res) => {
  if (!timingSafeEqualStr(req.headers["x-internal-secret"], INTERNAL_API_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("organizations").select("id").limit(1);
    if (error) throw error;
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    console.error("[Health] DB readiness check failed:", err);
    res.status(503).json({ status: "degraded", db: "error" });
  }
});

app.post("/cache/invalidate", (req, res) => {
  // SCRUM-355: constant-time secret comparison (was a plain !== that leaked
  // length/prefix via timing).
  if (!timingSafeEqualStr(req.headers["x-internal-secret"], process.env.INTERNAL_API_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { organizationId } = req.body;
  if (!organizationId) {
    return res.status(400).json({ error: "organizationId required" });
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(organizationId)) {
    return res.status(400).json({ error: "Invalid organizationId format" });
  }
  console.log(`[CacheInvalidate] Invalidating schedule cache for org=${organizationId}`);
  scheduleCache.invalidate(organizationId);
  res.json({ success: true });
});

/**
 * Build a minimal WAV container around a raw PCM buffer.
 * Gemini TTS returns PCM at 24kHz mono 16-bit — we need to wrap it in a WAV
 * header so the browser's <audio> element can play it directly.
 */
function pcmToWav(pcmBuffer, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// Pre-generated static preview audio. Populated at boot by reading
// voice-server/public/preview/<voiceId>.wav from disk (shipped in the Docker
// image). These files are generated by scripts/generate-previews.js once and
// committed to the repo, so serving them is free (no runtime Gemini calls).
// Map key = voiceId (e.g. "XB0fDUnXU5powFXDhCwa"), value = WAV Buffer.
const STATIC_PREVIEWS = new Map();
(function loadStaticPreviews() {
  try {
    const staticDir = path.join(__dirname, "public", "preview");
    if (!fs.existsSync(staticDir)) return;
    const files = fs.readdirSync(staticDir);
    for (const file of files) {
      if (!file.endsWith(".wav")) continue;
      const voiceId = file.slice(0, -4); // strip .wav
      const buf = fs.readFileSync(path.join(staticDir, file));
      STATIC_PREVIEWS.set(voiceId, buf);
    }
    if (STATIC_PREVIEWS.size > 0) {
      console.log(`[preview] Loaded ${STATIC_PREVIEWS.size} static preview files from ${staticDir}`);
    }
  } catch (err) {
    console.warn("[preview] Failed to load static preview files:", err.message);
  }
})();

// Runtime fallback cache for voices that don't have a static file yet (e.g.
// a new catalog entry after a deploy but before generate-previews.js is run).
// Key = `${voiceId}|${text}`, value = WAV Buffer. Process-local, resets on
// deploy. Intentionally NOT used for voices with static files — those are
// the authoritative source.
const previewCache = new Map();
const PREVIEW_CACHE_MAX = 32;

function previewCacheGet(key) {
  return previewCache.get(key) || null;
}

function previewCacheSet(key, buffer) {
  if (previewCache.size >= PREVIEW_CACHE_MAX) {
    // Drop the oldest entry (insertion-ordered Maps give us LRU-ish semantics)
    const firstKey = previewCache.keys().next().value;
    if (firstKey !== undefined) previewCache.delete(firstKey);
  }
  previewCache.set(key, buffer);
}

// Voice preview endpoint — synthesises a short sample using the SAME Gemini
// Live voices the production pipeline uses, so what the user hears in the
// preview is what callers hear on a real call. Uses Gemini TTS
// (gemini-2.5-pro-preview-tts — higher rate limits than the flash preview),
// returns base64 PCM at 24kHz mono, wrapped in a WAV container for browser
// playback. Results are cached in-memory so subsequent clicks on the same
// voice are free and can't hit Gemini rate limits.
// SCRUM-550: post-call re-transcription. Fired fire-and-forget by the Next.js
// twilio-recording-done webhook once the recording lands in Supabase. Runs
// Deepgram on the dual-channel recording, re-runs analysis, and writes the
// accurate transcript — all off the live-call path. The handler never throws;
// it degrades to Gemini's transcript on any failure. body is parsed by the
// global express.json() (line ~348).
app.post("/internal/retranscribe", async (req, res) => {
  if (!timingSafeEqualStr(req.headers["x-internal-secret"], INTERNAL_API_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const callId = req.body && req.body.callId;
  if (!callId || typeof callId !== "string") {
    return res.status(400).json({ error: "callId (string) required" });
  }
  try {
    const result = await handleRetranscribe({
      callId,
      deps: {
        getSupabase,
        transcribeRecording,
        buildTwoSidedTranscript,
        analyzeCallTranscript,
        judgeContentLoss: judgeTranscriptContentLoss,
        applyReanalysis,
        Sentry,
        deepgramApiKey: process.env.DEEPGRAM_API_KEY,
        retranscribeEnabled: process.env.RETRANSCRIBE_ENABLED !== "false",
      },
    });
    return res.json(result);
  } catch (err) {
    // handleRetranscribe is designed never to throw; this is a last-resort net
    // so an unexpected defect can't 500 the (fire-and-forget) trigger.
    console.error("[Retranscribe] unexpected handler error:", err);
    return res.json({ ok: true, retranscribed: false, reason: "handler-error" });
  }
});

app.post("/preview", async (req, res) => {
  // SCRUM-355: constant-time secret comparison (was a plain !== that leaked
  // length/prefix via timing).
  if (!timingSafeEqualStr(req.headers["x-internal-secret"], process.env.INTERNAL_API_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { voiceId, text } = req.body || {};
  if (!voiceId || typeof voiceId !== "string") {
    return res.status(400).json({ error: "voiceId (string) required" });
  }
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "text (string) required" });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: "text must be 500 chars or fewer" });
  }

  const geminiVoice = getGeminiVoice(voiceId);
  const cacheKey = `${geminiVoice}|${text}`;

  // Tier 1: pre-generated static file. Cheap, fast, abuse-proof, free. This
  // is the primary path once scripts/generate-previews.js has been run.
  const staticBuf = STATIC_PREVIEWS.get(voiceId);
  if (staticBuf) {
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", staticBuf.length.toString());
    res.setHeader("Cache-Control", "private, max-age=86400"); // 1 day — static files never change until next deploy
    res.setHeader("X-Preview-Cache", "static");
    return res.send(staticBuf);
  }

  // Tier 2: in-memory runtime cache — backup for voices without a static file.
  const cached = previewCacheGet(cacheKey);
  if (cached) {
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", cached.length.toString());
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Preview-Cache", "runtime");
    return res.send(cached);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[preview] GEMINI_API_KEY not set");
    return res.status(503).json({ error: "Voice preview is not configured on the server." });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro-preview-tts:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: geminiVoice },
              },
            },
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => "");
      console.error(
        `[preview] Gemini TTS ${geminiRes.status} for voice=${geminiVoice}: ${errText.slice(0, 800)}`
      );
      // Pass the upstream status through so the client can distinguish 429
      // (rate-limited — retry after a moment) from 5xx (actual server error).
      // 4xx/5xx from Gemini go through as-is; unexpected codes become 502.
      const forwardStatus =
        geminiRes.status === 429 || (geminiRes.status >= 400 && geminiRes.status < 500)
          ? geminiRes.status
          : 502;
      if (geminiRes.status === 429) {
        res.setHeader("Retry-After", "30");
      }
      return res.status(forwardStatus).json({
        error:
          geminiRes.status === 429
            ? "Voice preview is rate-limited by the provider. Please try again in a moment."
            : "Voice preview generation failed",
        upstreamStatus: geminiRes.status,
      });
    }

    const payload = /** @type {any} */ (await geminiRes.json());
    const audioPart = payload?.candidates?.[0]?.content?.parts?.find(
      (p) => p?.inlineData?.data
    );
    if (!audioPart) {
      console.error("[preview] Gemini TTS returned no audio part:", JSON.stringify(payload).slice(0, 500));
      return res.status(502).json({ error: "Voice preview generation failed (no audio in response)" });
    }

    const pcmBuffer = Buffer.from(audioPart.inlineData.data, "base64");
    const wavBuffer = pcmToWav(pcmBuffer, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
    previewCacheSet(cacheKey, wavBuffer);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", wavBuffer.length.toString());
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Preview-Cache", "miss");
    res.send(wavBuffer);
  } catch (err) {
    console.error("[preview] exception:", err);
    Sentry.captureException(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal error generating voice preview" });
    }
  }
});

// ── SCRUM-166: Outbound calling service endpoints ───────────────────────────
// Cherry-picked from feature/SCRUM-166-outbound-calling-service for automated
// smoke testing of the inbound AI receptionist. Each /outbound/call places a
// real Twilio call from OUTBOUND_CALLER_NUMBER to the target; Twilio hits
// /outbound/twiml/:token which returns <Connect><Stream> pointing at
// /ws/outbound, and outbound-caller wires a Gemini Live "caller persona"
// session into that WebSocket so the outbound side has a real speaker.

function validateInternalSecret(req) {
  // SCRUM-355: constant-time comparison (was a plain === timing side-channel).
  return timingSafeEqualStr(req.headers["x-internal-secret"], INTERNAL_API_SECRET);
}

app.post("/outbound/call", express.json(), async (req, res) => {
  // SCRUM-413: 404 first when the dialer is disabled, so the endpoint is
  // indistinguishable from a non-existent route in production.
  if (!outboundSmokeTestEnabled()) {
    return res.status(404).json({ error: "Not found" });
  }
  if (!validateInternalSecret(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const targetCheck = validateOutboundTarget(req.body && req.body.targetNumber);
  if (!targetCheck.ok) {
    return res.status(400).json({ error: targetCheck.error });
  }
  try {
    const result = await makeOutboundCall(req.body);
    res.json(result);
  } catch (err) {
    console.error("[Outbound] /outbound/call error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/outbound/suite", express.json(), async (req, res) => {
  // SCRUM-413: 404 first when disabled (see /outbound/call). Every scenario
  // dials this same target, so validate it once up front (the per-call
  // allowlist + E.164 + rate-limit backstop lives in makeOutboundCall).
  if (!outboundSmokeTestEnabled()) {
    return res.status(404).json({ error: "Not found" });
  }
  if (!validateInternalSecret(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const targetCheck = validateOutboundTarget(req.body && req.body.targetNumber);
  if (!targetCheck.ok) {
    return res.status(400).json({ error: targetCheck.error });
  }
  const scenarios = req.body.scenarios || [];
  const maxDuration = req.body.maxDurationSeconds || 180;
  const delay = req.body.delayBetweenCallsMs || 15000;
  const timeoutMs = (scenarios.length * (maxDuration * 1000 + delay)) + 30000;
  req.setTimeout(timeoutMs);
  res.setTimeout(timeoutMs);
  try {
    const result = await runOutboundSuite(req.body);
    res.json(result);
  } catch (err) {
    console.error("[Outbound] /outbound/suite error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/outbound/setup-fixtures", express.json(), async (req, res) => {
  if (!outboundSmokeTestEnabled()) {
    return res.status(404).json({ error: "Not found" });
  }
  if (!validateInternalSecret(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const industries = req.body.industries || null;
    const fixtures = await createAllFixtures(industries);
    res.json({ fixtures });
  } catch (err) {
    console.error("[Outbound] /outbound/setup-fixtures error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/outbound/twiml/:token", (req, res) => {
  // SCRUM-449: pre-flight verify only ({ consume: false }) — the same token is
  // presented again at the /ws/outbound connect (the stage that consumes the
  // single-use jti). Consuming here would reject Twilio's own WebSocket.
  const tokenData = verifyOutboundToken(req.params.token, INTERNAL_API_SECRET, { consume: false });
  if (!tokenData) {
    console.warn("[Outbound] Rejected TwiML request — invalid token");
    return res.status(403).send("Forbidden");
  }
  console.log(`[Outbound] TwiML requested for scenario=${tokenData.scenarioId} → streaming to /ws/outbound`);
  // Token goes in the PATH, not a query string — Twilio Media Streams strips
  // query params from the <Stream url> before opening the WebSocket.
  const wsUrl = PUBLIC_URL.replace(/^http/, "ws") + `/ws/outbound/${encodeURIComponent(req.params.token)}`;
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`);
});

app.post("/outbound/status/:token", (req, res) => {
  const callStatus = req.body.CallStatus;
  if (callStatus === "no-answer" || callStatus === "busy" || callStatus === "failed") {
    // SCRUM-449: consuming verify. These statuses only fire when the call never
    // connected, so the twiml/ws path never ran — the jti is still unconsumed
    // on the legitimate flow, and a replayed status callback is rejected.
    const tokenData = verifyOutboundToken(req.params.token, INTERNAL_API_SECRET);
    if (tokenData) {
      const pending = outboundPendingCalls.get(req.params.token);
      if (pending) {
        outboundPendingCalls.delete(req.params.token);
        pending.resolve({
          status: callStatus === "no-answer" ? "no_answer" : "failed",
          scenario: { id: pending.scenario.id, name: pending.scenario.name },
          call: {
            sid: req.body.CallSid,
            from: process.env.OUTBOUND_CALLER_NUMBER,
            to: tokenData.targetNumber,
            duration: 0,
            startedAt: null,
            endedAt: new Date().toISOString(),
          },
          transcript: [],
          expectedOutcomes: pending.scenario.expectedOutcomes || [],
          error: `Call ${callStatus}`,
        });
      }
    }
  }
  res.sendStatus(200);
});

// Sentry Express error handler — captures unhandled route errors
app.use((err, req, res, _next) => {
  Sentry.captureException(err);
  console.error("[Express] Unhandled route error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Active sessions keyed by streamSid
const sessions = new Map();

wss.on("connection", (twilioWs) => {
  let session = null;
  let cleaningUp = false;
  // SCRUM-571: demo-line duration cap timer (set only for demo-org calls).
  /** @type {ReturnType<typeof setTimeout> | null} */
  let demoLineTimer = null;

  async function cleanupSession() {
    if (!session || cleaningUp) return;
    cleaningUp = true;
    const s = session;
    session = null;
    sessions.delete(s.streamSid);

    // SCRUM-594 (spec 4.8.10): the fast path's sockets, timers, draft and turn
    // go first: a Flux handle still CONNECTING would otherwise leak (our pings
    // keep it alive). Then its latency summary (spec 4.8.9: [FastCall], and
    // calls.metadata.fastPath below).
    if (s.fastState) closeFastPath(s);
    // A reconnected leg after a failed transfer carries the first leg's summary.
    const fastPathSummary = s.fastStats ? summarizeFastCall(s) : s.carriedFastPath;
    // SCRUM-594: which pipeline served a demo-line customer call (the DEMO_LINE_PIPELINE
    // comparison); gate C7: a reconnected leg carries the first leg's. Null on every other call.
    const pipelineServed = (!s.ownerMode && isDemoLineNumber(s.orgPhoneNumber) ? s.effectivePipeline : null) || s.carriedPipeline || null;

    // Unsubscribe from schedule cache events
    if (s._cacheUnsub) {
      s._cacheUnsub();
      s._cacheUnsub = null;
    }

    // If a transfer is pending, don't run post-call processing yet —
    // the /twiml/transfer-status callback or TTL cleanup will handle it.
    if (s.pendingTransfer) {
      console.log(`[Cleanup] Transfer pending for callSid=${s.callSid} — deferring post-call processing`);
      // SCRUM-594: whoever writes this call's record later (finishTransferredCall,
      // or the cleanup of a leg reconnected after a failed dial) writes the summary.
      if (fastPathSummary || pipelineServed) {
        const saved = getTransfer(s.callSid);
        if (saved && fastPathSummary) saved.fastPath = fastPathSummary;
        if (saved && pipelineServed) saved.pipeline = pipelineServed; // gate C7
      }
      s.destroy();
      return;
    }

    let transcript = s.getTranscript();
    const durationSeconds = s.getDurationSeconds();
    let callStatus = s.callFailed ? "failed" : "completed";
    let endedReason = s.endedReason || "caller-hangup";

    // SCRUM-227/383: detect hallucinated ACTIONS. If the transcript claims an
    // action (booking, reschedule, cancellation, callback) the call never actually
    // performed with a successful tool, flag the call loudly so we catch it before
    // a customer is told something that didn't happen. Claim-based + completion-
    // only (see detectPostCallPhantoms), so legitimate non-completions (slot taken,
    // caller declined) are NOT flagged. SCRUM-381: an atomic reschedule backs a
    // "you're all set" booking claim, so a real reschedule isn't mislabelled.
    // NOTE: English claim-based; the *live* SCRUM-373 end_call guard is the real
    // language-agnostic safeguard. Non-English post-call flagging tracked separately.
    // Scans assistant turns only (detectPostCallPhantoms filters internally) — a
    // hallucinated claim is something the AI said, so a caller reciting a code or
    // narrating a past appointment must not trip it.
    // SCRUM-587: owner calls skip the claim scan — "cancelled Mrs Smith's job" is the owner's instruction, not a receptionist claim.
    const phantomActions = s.ownerMode ? [] : detectPostCallPhantoms(s.fullTranscriptMessages, s.toolCallAudit);
    if (phantomActions.length) {
      const { bugTag, reason } = summarizePhantoms(phantomActions);
      console.error(`[HallucinatedAction] callSid=${s.callSid} claimed [${phantomActions.join(", ")}] but no backing tool succeeded. toolCallAudit=${JSON.stringify(s.toolCallAudit || [])}`);
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        scope.setTag("bug", bugTag);
        scope.setExtras({
          callSid: s.callSid,
          organizationId: s.organizationId,
          phantomActions,
          toolCallAudit: s.toolCallAudit || [],
          transcriptHead: (transcript || "").slice(0, 500),
        });
        Sentry.captureMessage(`Hallucinated action detected: ${phantomActions.join(", ")} (SCRUM-227/383)`, "error");
      });
      callStatus = "failed";
      endedReason = reason;
    }

    // Run post-call analysis (best-effort, awaited because results feed into the call record)
    let analysis = null;
    // SCRUM-587: no OpenAI analysis on owner calls — the summary is built from the tool audit below.
    if (!s.ownerMode && transcript && durationSeconds > 5) {
      try {
        analysis = await analyzeCallTranscript(transcript, {
          language: s.language,
          toolDigest: buildToolOutcomeDigest(s.toolCallAudit || []), // SCRUM-559: analysis sees tool ground truth
        });
        if (analysis) {
          // SCRUM-339: caller name AND the free-text call reason are PII —
          // redact both unless DEBUG_TRANSCRIPTS. success is a safe enum.
          const callerForLog = DEBUG_TRANSCRIPTS ? (analysis.callerName || "unknown") : "[redacted]";
          const reasonForLog = DEBUG_TRANSCRIPTS ? (analysis.callerPhoneReason || "unknown") : "[redacted]";
          console.log(`[PostCall] Analysis complete: caller=${callerForLog}, reason=${reasonForLog}, success=${analysis.successEvaluation}`);

          // SCRUM-192: page unhappy calls — shared helper, also wired into
          // the transfer-completion path (lib/pending-transfers.js), which
          // handles every call that ends in a transfer attempt.
          maybeEmitUnhappyCall(analysis, {
            callSid: s.callSid,
            organizationId: s.organizationId,
            durationSeconds,
          });

          // SCRUM-559: language-agnostic booking-state check. The English
          // claim regexes missed the real incident's ARABIC "you're booked"
          // claims; the analysis LLM judges the claim in any language and the
          // tool audit is ground truth. finalBookingClaimed with zero net live
          // outcome = the caller hung up believing in an appointment that does
          // not exist.
          if (analysis.finalBookingClaimed === true && netLiveOutcome(s.toolCallAudit || []) === 0 && callStatus !== "failed") {
            console.error(`[BookingStateMismatch] callSid=${s.callSid} — analysis says the caller left believing a booking from this call exists, but the tool log shows NO live appointment. toolCallAudit=${JSON.stringify(s.toolCallAudit || [])}`);
            Sentry.withScope((scope) => {
              scope.setTag("service", "booking_state_monitor");
              setReasonTag(scope, SENTRY_REASONS.BOOKING_STATE_MISMATCH);
              scope.setExtras({
                callSid: s.callSid,
                organizationId: s.organizationId,
                toolCallAudit: s.toolCallAudit || [],
              });
              Sentry.captureMessage("Booking state mismatch: caller left believing in a nonexistent appointment (SCRUM-559)", "error");
            });
            callStatus = "failed";
            endedReason = "booking-state-mismatch";
          }
        }
      } catch (err) {
        console.error("[PostCall] Analysis failed:", err);
      }
    }

    // SCRUM-587: an owner call's summary is built from its tool audit (no
    // OpenAI) and, with the org's PII redaction on, redacted like the
    // transcript below before it is stored. An owner tool call still running
    // (the owner hung up right after "yes") gets a bounded wait first, so the
    // summary names a change that lands instead of "no changes made".
    if (s.ownerMode) await settleOwnerToolRuns(s);
    let ownerSummary = s.ownerMode ? buildOwnerCallSummary(s.toolCallAudit || []) : null;

    // PII redaction — runs after analysis, before anything is persisted
    let piiRedacted = false;
    if (s.piiRedactionEnabled) {
      const transcriptResult = detectAndRedact(transcript);
      if (transcriptResult.piiFound) {
        transcript = transcriptResult.redacted;
        piiRedacted = true;
      }
      if (ownerSummary) {
        const ownerSummaryResult = detectAndRedact(ownerSummary);
        if (ownerSummaryResult.piiFound) {
          ownerSummary = ownerSummaryResult.redacted;
          piiRedacted = true;
        }
      }
      if (analysis?.summary) {
        const summaryResult = detectAndRedact(analysis.summary);
        if (summaryResult.piiFound) {
          analysis.summary = summaryResult.redacted;
          piiRedacted = true;
        }
      }
      if (analysis?.collectedData) {
        const redactedData = redactObject(analysis.collectedData);
        analysis.collectedData = redactedData.redacted;
        if (redactedData.piiFound) piiRedacted = true;
      }
      if (piiRedacted) {
        console.log(`[PII] Redacted PII from call ${s.callSid}`);
      }
    }

    // SCRUM-424: a disclosure that was REQUIRED (woven into the first
    // message) but whose audio never reached the caller must be recorded as
    // failed — not silently indistinguishable from "never required". Same
    // semantics as the classic path's pre-synthesis failure: played=false +
    // failed=true means "required but not delivered", which is what a
    // two-party-consent audit needs to find.
    if (s.pendingDisclosureInFirstMessage && !s.recordingDisclosurePlayed) {
      console.warn(`[Cleanup] Required recording disclosure never reached the caller — marking failed. callSid=${s.callSid}`);
      s.recordingDisclosureFailed = true;
    }

    // Complete call record if we have one
    // SCRUM-587: PR B tells an owner call from a customer one by THIS row
    // (call_type), so an owner call's write gets one retry, and if the row
    // still isn't written the webhook below is skipped. Customer calls: one
    // attempt, exactly as before.
    let recordWritten = false;
    if (s.callRecordId) {
      for (let attempt = 1; !recordWritten && attempt <= (s.ownerMode ? 2 : 1); attempt++) {
        if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          await completeCallRecord(s.callRecordId, {
            status: callStatus,
            durationSeconds,
            transcript,
            summary: s.ownerMode ? ownerSummary : (analysis?.summary || null),
            callerName: s.ownerMode ? (s.ownerFirstName || "Owner") : (analysis?.callerName || null),
            collectedData: analysis?.collectedData || null,
            successEvaluation: analysis?.successEvaluation || null,
            recordingDisclosurePlayed: s.recordingDisclosurePlayed || false,
            recordingDisclosureFailed: s.recordingDisclosureFailed || false,
            transferAttempt: s.transferAttempt || null,
            callerState: s.callerState || null,
            consentReason: s.consentReason || null,
            pipelineFailover: s.pipelineFailover || null,
            // SCRUM-594: which pipeline served a demo-line customer call (the
            // DEMO_LINE_PIPELINE comparison). Null on every other call, so they
            // write no new metadata (tests/call-logger-metadata.test.js).
            pipeline: pipelineServed,
            // SCRUM-594: the fast path's latency summary; null on every other call.
            fastPath: fastPathSummary,
            sentiment: analysis?.sentiment || null,
            piiRedacted,
            cleanedTranscript: analysis?.cleanedTranscript ?? null,
            // SCRUM-498: daily summary + analytics count
            // action_taken="appointment_booked". The tool audit is the ground
            // truth on the Gemini/realtime paths (reschedules deliberately
            // excluded); the CLASSIC pipeline's tool loop doesn't write the
            // audit, so fall back to its confirmedBookings map (review P2 —
            // classic bookings were otherwise silently uncounted).
            // SCRUM-559: net-live, not "a book succeeded somewhere" — the
            // incident call was recorded failed AND "appointment_booked" (the
            // booking had been cancelled). confirmedBookings already clears on
            // cancel, so the classic fallback is naturally net-aware.
            actionTaken: s.ownerMode
              ? "owner_call"
              : netLiveOutcome(s.toolCallAudit || []) > 0 || (s.confirmedBookings?.size ?? 0) > 0
                ? "appointment_booked"
                : null,
            // SCRUM-587: written BEFORE notifyCallCompleted (below) — PR B reads
            // call_type from the row. owner_auth also marks a customer call that
            // failed the PIN gate.
            callType: s.ownerMode ? "owner" : null,
            ownerAuth: s.ownerAuth || null,
          });
          recordWritten = true;
        } catch (err) {
          console.error("[Cleanup] Failed to complete call record:", err);
        }
      }
    } else if (durationSeconds > 0) {
      console.error("[Cleanup] Call completed with no database record — call data is lost:", {
        callSid: s.callSid,
        organizationId: s.organizationId,
        callerPhone: maskPhone(s.callerPhone),
        durationSeconds,
      });
    }

    // Notify the Next.js app for spam analysis, billing, notifications, webhooks
    if (s.ownerMode && !recordWritten) {
      // SCRUM-587: without call_type="owner" in the row, PR B would process the
      // owner's call as a customer's — customer alerts, the org webhook carrying
      // the owner's transcript, the daily summary. Page instead (ids only) —
      // unless the owner simply hung up before setup reached the call record
      // (SF6): nothing failed, and there is no record to complete.
      if (s.streamStoppedByCaller && !s.callRecordRequested) {
        console.warn(`[OwnerCall] owner hung up during call setup, before the call record was created — no record to complete, call-completed webhook skipped (callSid=${s.callSid}, org=${s.organizationId})`);
      } else {
        console.error(`[ALERT:error] [OwnerCall] owner call record not written — call-completed webhook skipped (callSid=${s.callSid}, callId=${s.callRecordId}, org=${s.organizationId})`);
      }
    } else if (INTERNAL_API_URL && INTERNAL_API_SECRET && s.organizationId) {
      notifyCallCompleted(INTERNAL_API_URL, INTERNAL_API_SECRET, {
        callId: s.callRecordId,
        organizationId: s.organizationId,
        assistantId: s.assistantId,
        callerPhone: s.callerPhone,
        status: callStatus,
        durationSeconds,
        transcript,
        endedReason,
        summary: analysis?.summary || undefined,
        callerName: analysis?.callerName || undefined,
        collectedData: analysis?.collectedData || undefined,
        successEvaluation: analysis?.successEvaluation || undefined,
        unansweredQuestions: analysis?.unansweredQuestions || undefined,
        // SCRUM-587: informational — PR B reads call_type / owner_auth from
        // the row written above. Absent from a plain customer call's body.
        callType: s.ownerMode ? "owner" : undefined,
        ownerAuth: s.ownerAuth || undefined,
      }).catch((err) =>
        console.error("[Cleanup] Failed to notify call completed:", err)
      );
    }

    s.destroy();
  }

  twilioWs.on("message", async (raw) => {
    let msg;
    try {
      // raw is ws RawData; Twilio media-stream frames arrive as JSON text, so
      // toString() is a no-op on the string and a utf8 decode on a Buffer.
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.warn("[Twilio] Received non-JSON message, ignoring");
      return;
    }

    try {
      switch (msg.event) {
        case "connected":
          console.log("[Twilio] WebSocket connected");
          // Keep WebSocket alive — send pings every 30s to prevent Fly.io proxy idle timeout
          const pingInterval = setInterval(() => {
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.ping();
            } else {
              clearInterval(pingInterval);
            }
          }, 30000);
          twilioWs.on("close", () => clearInterval(pingInterval));
          break;

        case "start": {
          const { callSid, streamSid, customParameters } = msg.start;
          const token = customParameters?.auth_token;
          // Consume the token and retrieve the server-side call metadata
          // (calledNumber + callerPhone stored at /twiml time, NOT from client params)
          const tokenData = token ? consumeStreamToken(token) : null;
          if (!tokenData) {
            console.warn(`[Auth] Rejected WebSocket — invalid or missing token (callSid=${callSid})`);
            twilioWs.close();
            return;
          }

          const { calledNumber, callerPhone, reconnectCallSid, phoneRecord } = tokenData;

          // Reconnection after failed transfer — restore session from saved state
          if (reconnectCallSid) {
            const savedState = consumeTransfer(reconnectCallSid);
            if (savedState) {
              console.log(`[Reconnect] Restoring session for callSid=${reconnectCallSid} (dialStatus=${savedState.transferAttempt?.outcome || "unknown"})`);

              session = new CallSession(reconnectCallSid);
              session.streamSid = streamSid;
              // SCRUM-325: restore via the shared mapping so the forwarding
              // fields (userPhoneNumber/forwardingStatus/sourceType) come back
              // too — a 2nd transfer on the reconnected call needs them for the
              // forwarded-number fallback.
              session.restoreFrom(savedState);
              sessions.set(streamSid, session);

              // SCRUM-573: the reconnect path never reaches the normal start-
              // branch cap block — re-arm the demo ceiling here, or a demo
              // caller whose transfer fails comes back to an UNCAPPED paid
              // session on the public line. Same condition + close-handler
              // cleanup as the primary site.
              if (session.organizationId === DEMO_ORG_ID || isDemoLineNumber(calledNumber)) {
                demoLineTimer = setTimeout(() => {
                  console.log(`[DemoLine] Max duration reached — ending reconnected demo call callSid=${session?.callSid}`);
                  if (session) session.endedReason = "demo-max-duration";
                  try {
                    twilioWs.close(1000, "Demo max duration");
                  } catch (err) {
                    console.error("[DemoLine] Failed to close socket at max duration:", err.message);
                  }
                }, MAX_DEMO_CALL_DURATION_MS);
              }

              // Re-open Deepgram STT
              session.deepgramWs = openDeepgramStream(DEEPGRAM_API_KEY, {
                language: session.language,
                onTranscript: ({ transcript, isFinal }) => {
                  if (!isFinal) return;
                  const INTERRUPT_RE_RECONNECT = /^(stop|wait|hold on|no|cancel|nevermind|never mind|excuse me|hello|hey)\b/i;
                  if (session.isSpeaking && transcript.trim().split(/\s+/).length <= 2 && !INTERRUPT_RE_RECONNECT.test(transcript.trim())) {
                    logTranscript("[STT] Dropped (echo suppression while AI speaking)", transcript);
                    return;
                  }
                  logTranscript("[STT] Final", transcript);
                  session.bufferTranscript(transcript, (combined, inputType) => {
                    logTranscript("[STT] Buffered", combined);
                    session.queueOrProcess(combined, (text) => handleUserSpeech(session, twilioWs, text, inputType));
                  });
                },
                onUtteranceEnd: () => {
                  session.flushBuffer();
                },
                onError: (err) => {
                  console.error("[STT] Error:", err);
                  if (session) {
                    session.callFailed = true;
                    session.endedReason = "stt-error";
                  }
                  sendTTS(session, twilioWs, getErrorMsg(session.language, "technicalDifficulty"))
                    .catch((ttsErr) => console.error("[STT] Failed to send error message to caller:", ttsErr))
                    .finally(() => setTimeout(() => twilioWs.close(), 2000));
                },
                onClose: (code) => {
                  if (code !== 1000 && code !== 1005 && session && !session.callFailed) {
                    console.error(`[STT] Connection lost during active call (callSid=${session.callSid})`);
                    session.callFailed = true;
                    session.endedReason = "stt-connection-lost";
                    sendTTS(session, twilioWs, getErrorMsg(session.language, "troubleRepeat"))
                      .catch((ttsErr) => console.error("[STT] Failed to send reconnect message:", ttsErr));
                  }
                },
              }, { industry: session.organization?.industry });

              // Inject system context about the failed transfer
              const transferTargetName = savedState.transferTargetName || "the team member";
              const failReason = savedState.transferAttempt?.outcome || "unavailable";
              session.addMessage("system",
                `Transfer to ${transferTargetName} was unsuccessful (${failReason}). Resume the conversation naturally. Offer to take a message or schedule a callback.`
              );

              // Send fallback message via TTS
              const fallbackMsg = getErrorMsg(session.language, "transferFailed", transferTargetName);
              try {
                await sendTTS(session, twilioWs, fallbackMsg);
                session.addMessage("assistant", fallbackMsg);
              } catch (ttsErr) {
                console.error("[Reconnect] Failed to send fallback TTS — caller will hear silence:", ttsErr);
                // Don't add to history since the caller never heard it
                session.addMessage("system",
                  "The fallback message after the failed transfer could not be delivered via TTS. The caller has heard nothing since being reconnected. Start by telling them you're still here."
                );
              }
              break;
            }
            // If savedState not found (expired), fall through to normal start
            console.warn(`[Reconnect] No saved state for callSid=${reconnectCallSid} — falling through to normal start`);
            if (!calledNumber) {
              console.error(`[Reconnect] Fallthrough with empty calledNumber for callSid=${reconnectCallSid} — cannot recover`);
              session = new CallSession(callSid);
              session.streamSid = streamSid;
              try {
                await sendTTS(session, twilioWs, getErrorMsg(session.language, "technicalDifficulty"));
              } catch (ttsErr) {
                console.error("[Reconnect] Failed to send error TTS:", ttsErr);
              }
              twilioWs.close();
              break;
            }
          }

          session = new CallSession(callSid);
          session.streamSid = streamSid;
          session.callerPhone = callerPhone;
          // SCRUM-587: owner mode comes ONLY from the server-side token (set by
          // /twiml/owner-pin after a verified PIN) — never from client params.
          session.ownerMode = tokenData.ownerMode === true;
          session.ownerAuth = tokenData.ownerAuth || null;
          session.ownerFirstName = tokenData.ownerFirstName || null;
          if (session.ownerMode) console.log(`[OwnerPin] Owner session for callSid=${callSid}`);
          sessions.set(streamSid, session);
          console.log(`[Twilio] Stream started — callSid=${callSid} streamSid=${streamSid} called=${calledNumber} from=${maskPhone(callerPhone)}`);

          // Load call context from database
          let context = null;
          if (calledNumber) {
            try {
              context = await loadCallContext(calledNumber, phoneRecord);
            } catch (err) {
              console.error("[Context] Failed to load call context:", err);
            }
          }

          if (!context) {
            console.warn(`[Context] No context found for ${calledNumber} — sending fallback and closing`);
            try {
              await sendTTS(session, twilioWs, getErrorMsg(session.language, "notConfigured"));
            } catch (ttsErr) {
              console.error("[Context] Failed to send fallback message — caller heard silence before disconnect:", ttsErr);
            }
            twilioWs.close();
            return;
          }

          // Store context on session
          session.organizationId = context.organizationId;
          session.assistantId = context.assistantId;
          session.phoneNumberId = context.phoneNumberId;

          // SCRUM-571/573: the public demo line gets the same 3-minute
          // ceiling as the browser demo (/ws/test) — a phone caller must not
          // hold a paid Gemini session open indefinitely. Keyed on the demo
          // org OR the published line number, so the cap survives the line
          // pointing at a real org (Smile Hub). Customer calls to their OWN
          // numbers stay uncapped. Closing the stream ends the call (the
          // TwiML is <Connect><Stream>, which terminates with its stream).
          if (session.organizationId === DEMO_ORG_ID || isDemoLineNumber(calledNumber)) {
            demoLineTimer = setTimeout(() => {
              console.log(`[DemoLine] Max duration reached — ending demo call callSid=${session?.callSid}`);
              // cleanupSession defaults endedReason to "caller-hangup" — stamp
              // the real reason so a capped call isn't misattributed to the
              // prospect in call records ("did they hang up or did we cut
              // them off at 3:00?" is the demo-funnel question).
              if (session) session.endedReason = "demo-max-duration";
              try {
                twilioWs.close(1000, "Demo max duration");
              } catch (err) {
                console.error("[DemoLine] Failed to close socket at max duration:", err.message);
              }
            }, MAX_DEMO_CALL_DURATION_MS);
          }
          session.transferRules = context.transferRules || [];
          // SCRUM-260: expose forwarding fields so transfer_call can fall back
          // to the business's own number when no transfer rules are configured.
          session.userPhoneNumber = context.userPhoneNumber || null;
          session.forwardingStatus = context.forwardingStatus || null;
          session.sourceType = context.sourceType || null;
          // SCRUM-238: expose behaviors on session so buildLLMOptions can
          // gate the transfer_call tool by behaviors.transferToHuman.
          session.behaviors = context.assistant?.promptConfig?.behaviors || {};
          session.language = context.assistant.language || "en";
          session.deepgramVoice = getDeepgramVoice(context.assistant.voiceId);
          session.holdPreset = getHoldPreset(context.organization.industry);
          session.organization = {
            timezone: context.organization.timezone,
            businessHours: context.organization.businessHours,
            industry: context.organization.industry,
          };
          session.orgPhoneNumber = calledNumber;
          session.telephonyProvider = context.telephonyProvider || "twilio";
          session.piiRedactionEnabled = !!(context.assistant.settings?.piiRedactionEnabled);
          // SCRUM-327: owner opt-in (default off) for the forwarded-number
          // transfer fallback — gates whether transfer_call is offered when no
          // explicit transfer rules exist (see forwardingFallbackEligible).
          session.transferToForwardedNumber = context.assistant?.settings?.transferToForwardedNumber === true;

          // Start call recording if consent mode allows.
          // - Twilio: <Connect> record= doesn't work with <Stream>, so use REST API.
          // - Telnyx: TeXML-initiated recording doesn't reliably fire `call.recording.saved`,
          //   so use Call Control `record_start` API. context.callSid IS the Telnyx
          //   call_control_id (see tool-executor.js → telnyxTransfer.transferCall).
          const recordingConsentMode = context.organization.recordingConsentMode || "auto";
          if (recordingConsentMode !== "never" && callSid) {
            if (!APP_PUBLIC_URL) {
              // Hard-fail: never start recording with the wrong callback URL —
              // PUBLIC_URL points at the voice server, which doesn't host the
              // /api/webhooks/* routes (those live on Next.js).
              const skipErr = new Error("APP_PUBLIC_URL not set — refusing to start recording with wrong callback URL");
              console.warn(`[Recording] ${skipErr.message} (callSid=${callSid})`);
              Sentry.withScope((scope) => {
                scope.setTag("service", "recording-start");
                scope.setExtra("callSid", callSid);
                scope.setExtra("provider", session.telephonyProvider);
                Sentry.captureException(skipErr);
              });
            } else if (session.telephonyProvider === "twilio") {
              try {
                const recording = await getTwilioRestClient().calls(callSid).recordings.create({
                  recordingStatusCallback: `${APP_PUBLIC_URL}/api/webhooks/twilio-recording-done`,
                  recordingStatusCallbackMethod: "POST",
                  recordingStatusCallbackEvent: ["completed", "failed", "absent"],
                  recordingChannels: "dual",
                });
                console.log(`[Recording] Started Twilio recording for callSid=${callSid} recordingSid=${recording.sid}`);
              } catch (recErr) {
                // Non-fatal — call continues without recording
                console.warn("[Recording] Failed to start Twilio recording (non-fatal):", recErr.message);
                Sentry.withScope((scope) => {
                  scope.setTag("service", "twilio-recording");
                  scope.setExtra("callSid", callSid);
                  Sentry.captureException(recErr);
                });
              }
            } else if (session.telephonyProvider === "telnyx") {
              // call.recording.saved events fire to the Call Control Application's
              // webhook URL (configured in the Telnyx portal once per app). The
              // payload.call_control_id will match what we store as
              // vapi_call_id = sh_${callSid} so the lookup works.
              try {
                if (!process.env.TELNYX_API_KEY) {
                  throw new Error("TELNYX_API_KEY not configured");
                }
                const recRes = await fetch(`https://api.telnyx.com/v2/calls/${callSid}/actions/record_start`, {
                  method: "POST",
                  signal: AbortSignal.timeout(10_000),
                  headers: {
                    Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    format: "mp3",
                    channels: "dual",
                    play_beep: false,
                  }),
                });
                if (!recRes.ok) {
                  const errText = await recRes.text().catch(() => "");
                  throw new Error(`Telnyx record_start failed (${recRes.status}): ${errText.slice(0, 200)}`);
                }
                const recData = /** @type {any} */ (await recRes.json().catch(() => ({})));
                const recordingId = recData?.data?.recording_id || "unknown";
                console.log(`[Recording] Started Telnyx recording for callSid=${callSid} recordingId=${recordingId}`);
              } catch (recErr) {
                // Non-fatal — call continues without recording
                console.warn("[Recording] Failed to start Telnyx recording (non-fatal):", recErr.message);
                Sentry.withScope((scope) => {
                  scope.setTag("service", "telnyx-recording");
                  scope.setExtra("callSid", callSid);
                  Sentry.captureException(recErr);
                });
              }
            }
          }

          // After-hours detection
          const { isAfterHours, afterHoursConfig, effectiveCalendarEnabled } = resolveAfterHoursState(context);
          session.calendarEnabled = effectiveCalendarEnabled;
          session.serviceTypes = context.serviceTypes || [];

          if (isAfterHours) {
            console.log(`[AfterHours] Call arriving outside business hours (org=${context.organizationId}, calendar=${effectiveCalendarEnabled})`);
          }

          // Build system prompt (guided or legacy). SCRUM-587: an owner call
          // gets lib/owner-prompt.js instead — the customer prompt's privacy,
          // name-collection and booking rules contradict owner use (spec §2).
          // Its "Today is <weekday> <date>" is the ORG-local date: a server-UTC
          // date is a day behind until 10-11 a.m. in Sydney. A missing zone is
          // Sydney, as in PR B's owner handlers; a malformed one ("AEST") must
          // never kill the owner's call at setup, so it falls back the same way.
          let ownerTz = context.organization.timezone || "Australia/Sydney";
          let ownerToday = "";
          if (session.ownerMode) {
            try {
              ownerToday = new Intl.DateTimeFormat("en-CA", { timeZone: ownerTz }).format(new Date());
            } catch {
              console.warn(`[OwnerPrompt] org timezone ${JSON.stringify(String(ownerTz)).replace(/[\[\]]/g, "").slice(0, 60)} is not a valid IANA zone — using Australia/Sydney (org=${context.organizationId})`);
              ownerTz = "Australia/Sydney";
              ownerToday = new Intl.DateTimeFormat("en-CA", { timeZone: ownerTz }).format(new Date());
            }
          }
          const systemPrompt = session.ownerMode
            ? buildOwnerPrompt({
                orgName: context.organization.name,
                ownerFirstName: session.ownerFirstName,
                timezone: ownerTz,
                todayStr: ownerToday,
                serviceTypes: context.serviceTypes || [],
                practitioners: [],
              })
            : buildSystemPrompt(
                context.assistant,
                context.organization,
                context.knowledgeBase,
                {
                  // SCRUM-322: userPhoneNumber/forwardingStatus/sourceType used to
                  // be passed here too, but buildSystemPrompt never reads them (only
                  // executeToolCall consumes them, for the forwarded-number transfer
                  // fallback — still wired via the session/context). Dropped the dead
                  // hand-off so the prompt options reflect what's actually used.
                  calendarEnabled: effectiveCalendarEnabled,
                  transferRules: session.transferRules,
                  isAfterHours,
                  afterHoursConfig,
                  serviceTypes: context.serviceTypes,
                }
              );
          // Append caller context — phone number + client history
          const phoneForPrompt = session.piiRedactionEnabled ? maskPhone(callerPhone) : callerPhone;
          let callerContext = "";
          // SCRUM-587: no returning-caller hint on owner calls (owner tools return names).
          if (callerPhone && !session.ownerMode) {
            callerContext = `\n\nCALLER CONTEXT:\nThe caller's phone number is ${phoneForPrompt}. If they say "use the number I'm calling from" or "it's the same number", use this number. Do NOT ask them to repeat it.`;

            // SCRUM-414: returning-caller signal ONLY — never inject the name or
            // appointment history into the prompt (caller ID is spoofable, so
            // that would disclose PII to a spoofer, and the verbatim name was a
            // stored-prompt-injection vector). Use EXACT phone equality (not a
            // %suffix% ilike that over-matches) and HEAD counts only — no name,
            // no dates are fetched. Identity is verified by the lookup tool
            // before any on-file detail is referenced.
            //
            // Only run for a plausible phone number: a withheld/anonymous caller
            // ID is a placeholder ("anonymous", "Restricted", ...) that would
            // spuriously .eq-match prior placeholder rows from unrelated callers.
            // (calls.caller_phone is E.164-normalised per SCRUM-295;
            // appointments.attendee_phone may not be — migration 00137 left it
            // out — so the appointments side may under-match, which is the safe
            // direction.)
            if (/^\+?\d{7,}$/.test(callerPhone)) {
              try {
                const supabaseClient = require("./lib/supabase").getSupabase();
                const [apptResult, callResult] = await Promise.all([
                  supabaseClient.from("appointments").select("id", { count: "exact", head: true })
                    .eq("organization_id", context.organizationId).eq("attendee_phone", callerPhone).in("status", ["confirmed", "completed"]),
                  supabaseClient.from("calls").select("id", { count: "exact", head: true })
                    .eq("organization_id", context.organizationId).eq("caller_phone", callerPhone),
                ]);
                if (apptResult.error || callResult.error) {
                  console.warn(
                    "[ClientHistory] query error (non-fatal):",
                    (apptResult.error && apptResult.error.message) || (callResult.error && callResult.error.message),
                  );
                }
                callerContext += buildReturningCallerHint({
                  pastApptCount: apptResult.count || 0,
                  totalCalls: callResult.count || 0,
                });
              } catch (histErr) {
                // Non-fatal — continue without the returning-caller hint
                console.warn("[ClientHistory] Failed to fetch (non-fatal):", histErr.message);
              }
            }
          }
          session.setSystemPrompt(systemPrompt + callerContext);

          // ── Schedule cache: pre-fetch availability snapshot ──
          // SCRUM-12: skip entirely for a Cliniko-connected org — the snapshot
          // is built from LOCAL appointments only, so it would quote a near-empty
          // diary as available and the AI would offer slots that fail at booking.
          // With no snapshot set, check_availability falls through to the internal
          // API (clinikoCheckAvailability), which reads the real Cliniko diary.
          let scheduleSnapshot = null;
          const clinikoOwnsAvailability = context.calendarProvider === "cliniko";
          if (clinikoOwnsAvailability) {
            console.log(`[ScheduleCache] Skipped — Cliniko owns availability for org=${context.organizationId} (live diary)`);
          }
          // SCRUM-587: owner sessions carry no snapshot (it has no names); check_availability falls through to the API.
          if (!session.ownerMode && !clinikoOwnsAvailability && (session.calendarEnabled || session.serviceTypes?.length > 0)) {
            try {
              scheduleSnapshot = scheduleCache.getSchedule(context.organizationId);
              if (!scheduleSnapshot) {
                scheduleSnapshot = await loadScheduleSnapshot(
                  context.organizationId,
                  context.organization,
                  context.serviceTypes
                );
                if (scheduleSnapshot) {
                  scheduleCache.setSchedule(context.organizationId, scheduleSnapshot);
                  console.log(`[ScheduleCache] Loaded snapshot for org=${context.organizationId} (${Object.keys(scheduleSnapshot.slots).length} days, ${Object.values(scheduleSnapshot.slots).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : (v?._any?.length || 0)), 0)} total slots)`);
                }
              } else {
                console.log(`[ScheduleCache] Cache hit for org=${context.organizationId}`);
              }

              if (scheduleSnapshot) {
                const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: context.organization.timezone }).format(new Date());
                const liveSection = buildLiveScheduleSection(scheduleSnapshot, todayStr);
                if (liveSection) {
                  const currentPrompt = session.messages[0]?.content || "";
                  session.setSystemPrompt(currentPrompt + "\n" + liveSection);
                }
              }
            } catch (err) {
              console.warn("[ScheduleCache] Failed to load snapshot (non-fatal):", err.message);
            }
          }
          session.scheduleSnapshot = scheduleSnapshot;

          // Subscribe to cache changes from other sessions (same org)
          if (scheduleSnapshot) {
            session._cacheUnsub = scheduleCache.onScheduleChanged(context.organizationId, async () => {
              // Guard: session may have been cleaned up between invalidation and this callback
              if (!session) return;
              try {
                let fresh = scheduleCache.getSchedule(context.organizationId);
                if (!fresh && (session.calendarEnabled || session.serviceTypes?.length > 0)) {
                  fresh = await loadScheduleSnapshot(context.organizationId, session.organization, session.serviceTypes);
                  if (fresh) scheduleCache.setSchedule(context.organizationId, fresh);
                }
                // Re-check session after await — it may have been cleaned up during the fetch
                if (fresh && session) {
                  session.scheduleSnapshot = fresh;
                  console.log(`[ScheduleCache] Session ${session.callSid || "live"} refreshed from cache event`);
                }
              } catch (err) {
                console.warn("[ScheduleCache] Failed to refresh session:", err.message);
              }
            });
          }

          // Create call record in database
          // SCRUM-587 (SF6): setup has reached the record — an owner call that
          // ends without one from here on is a fault (cleanup pages on it).
          if (session) session.callRecordRequested = true;
          try {
            const callRecordId = await createCallRecord({
              orgId: context.organizationId,
              assistantId: context.assistantId,
              phoneNumberId: context.phoneNumberId,
              callerPhone,
              callSid,
            });
            session.callRecordId = callRecordId;
          } catch (err) {
            console.error("[DB] Failed to create call record:", err);
            // Non-fatal — continue handling the call
          }

          // ── Pipeline selection ───────────────────────────────────────────
          // SCRUM-587: owner calls may run a different pipeline (OWNER_PIPELINE),
          // resolved once per call; the key check follows the EFFECTIVE pipeline.
          // SCRUM-594: a customer call to the published demo line may be moved by
          // DEMO_LINE_PIPELINE (read on every call); every other customer call
          // follows VOICE_PIPELINE as before. Owner calls never reach the switch.
          // classic-fast without ANTHROPIC_API_KEY/DEEPGRAM_API_KEY (read when the
          // resolver asks) takes VOICE_PIPELINE instead (R12c).
          const effectivePipeline = session.ownerMode
            ? resolveOwnerPipeline()
            : resolveCallPipeline({
                calledNumber,
                ownerMode: session.ownerMode,
                language: session.language,
                globalPipeline: VOICE_PIPELINE,
                demoLinePipeline: process.env.DEMO_LINE_PIPELINE,
                isDemoLine: isDemoLineNumber,
                hasFastPathKeys: () => fastPathKeysPresent(process.env),
              });
          session.effectivePipeline = effectivePipeline;
          if (effectivePipeline === "gemini-live" && !process.env.GEMINI_API_KEY) {
            console.error("[GeminiLive] pipeline=gemini-live but GEMINI_API_KEY not set — falling back to classic pipeline");
          }
          if (effectivePipeline === "gemini-live" && process.env.GEMINI_API_KEY) {
            // Gemini Live pipeline — single model handles STT + LLM + TTS
            const geminiT0 = Date.now();
            console.log(`[GeminiLive] Starting session for callSid=${callSid}`);

            const llmOptions = session.ownerMode ? { tools: buildOwnerTools() } : buildLLMOptions(session, { includeTransfer: true });
            const allTools = llmOptions.tools || [];

            // ── Build greeting text for Gemini to speak ──
            // Gemini speaks the disclosure + greeting as its FIRST utterance.
            // This gives ONE consistent voice throughout the call and eliminates
            // the Deepgram TTS delay + voice mismatch.
            // SCRUM-587: no spoken disclosure on owner calls (consent is captured
            // in Settings; recording still runs as today).
            const consentResult = session.ownerMode
              ? { required: false, callerState: null, reason: "owner-call" }
              : requiresRecordingDisclosureHybrid(
                  context.organization.country,
                  context.organization.businessState,
                  context.organization.recordingConsentMode,
                  session.callerPhone
                );
            const greeting = session.ownerMode
              ? buildOwnerGreeting(session.ownerFirstName)
              : getGreeting(context.assistant, context.organization.name, { isAfterHours, afterHoursConfig });

            // Build the full first message — disclosure (if needed) + greeting
            let firstMessage = greeting;
            let disclosureText = null;
            if (consentResult.required) {
              disclosureText = getRecordingDisclosureText(
                context.organization.country,
                context.organization.recording_disclosure_text,
                context.organization.name
              );
              // Weave disclosure naturally into the greeting
              firstMessage = `${disclosureText} ${greeting}`;
              // SCRUM-424 (finding #11): do NOT mark the disclosure played
              // yet — at this point it is only woven into the prompt. The
              // flag is set in onAudio when the first utterance's audio
              // actually reaches Twilio (the disclosure is the mandated
              // start of that utterance). Marking here recorded "disclosed"
              // even when Gemini never spoke (setup stall, instant hangup).
              session.pendingDisclosureInFirstMessage = true;
            }
            // Don't add greeting to transcript manually — Gemini's outputTranscription
            // captures it when it actually speaks. Adding it here causes duplicates.

            // Build system prompt — Gemini speaks the greeting itself
            let geminiSystemPrompt = session.messages[0]?.content || "You are a helpful receptionist.";

            // Gemini Live is natively multilingual — always remove English-only restrictions.
            geminiSystemPrompt = geminiSystemPrompt
              .replace(/ENGLISH ONLY:.*?Do NOT respond in their language\./gs, "LANGUAGE: You are multilingual. Respond in the caller's language naturally.")
              .replace(/You MUST ONLY respond in English\..*?Do NOT use any non-English words\./gs, "Respond in the caller's language naturally.")
              .replace(/You must respond in English\..*?Do NOT respond in their language\./gs, "Respond in the caller's language naturally.")
              .replace(/I can only assist in English/g, "I can assist in multiple languages")
              .replace(/I'm sorry, I can only assist in English[^"']*/g, "I can assist in multiple languages");

            if (disclosureText) {
              // SCRUM-368: the LANGUAGE rule tells the model to translate every
              // utterance into the caller's language — but a recording-consent
              // disclosure is a legal notice and must be spoken EXACTLY as the
              // org configured it. Carve it out so it is never machine-translated
              // or paraphrased; only the greeting may be localized.
              geminiSystemPrompt += `\n\nIMPORTANT — YOUR FIRST MESSAGE: When the call connects, you will receive a short text message. Respond by FIRST speaking this recording disclosure EXACTLY as written, in its original language — do NOT translate, paraphrase, shorten, or skip it (it is a legal notice): "${disclosureText}" Then warmly deliver this greeting (you MAY say it in the caller's language): "${greeting}" — then wait for the caller. Do NOT add anything extra. Do NOT invent a receptionist name — you are an AI assistant.`;
            } else {
              geminiSystemPrompt += `\n\nIMPORTANT — YOUR FIRST MESSAGE: When the call connects, you will receive a short text message. Immediately respond by speaking the following greeting (word for word, naturally and warmly): "${firstMessage}" — Then wait for the caller to respond. Do NOT add anything extra. Do NOT invent a receptionist name — you are an AI assistant.`;
            }

            // SCRUM-587: the customer rules below (tool/booking/transfer rules, the
            // FINAL CRITICAL RULE and the language lock) are for customer calls. An
            // owner call gets the owner variant of the freshest-instruction block
            // instead, and NOTHING after it: the language lock ends on
            // schedule_callback, a customer tool the owner session does not have.
            if (!session.ownerMode) {
              // CRITICAL — tool calling, filler words, and name enforcement
              geminiSystemPrompt += `\n\nCRITICAL RULES FOR THIS CONVERSATION:`;
              geminiSystemPrompt += `\n- ABSOLUTELY NEVER FABRICATE ACTIONS: This is the most important rule. It is IMPOSSIBLE to book, cancel, or schedule anything without calling the corresponding tool. The tools (book_appointment, cancel_appointment, schedule_callback) are the ONLY way actions happen in the database. If you say "I've booked your appointment" without calling book_appointment first, the caller will have NO actual appointment — this is a catastrophic failure. The correct sequence is ALWAYS: (1) say a brief filler phrase in the caller's language (the equivalent of "one moment, let me do that for you"), (2) CALL THE TOOL, (3) WAIT for the tool to return a result, (4) ONLY THEN tell the caller what happened based on the tool's response. NEVER speak the words "booked", "confirmed", "cancelled", "scheduled" BEFORE the tool returns. If you catch yourself about to confirm an action — STOP and call the tool first.`;
              geminiSystemPrompt += `\n- 🔎 UNDERSTAND BEFORE YOU ACT (be a real receptionist): Acting on a misheard request is worse than asking again. If a caller's turn is garbled, cuts in and out, is only fragments, suddenly switches to a language they weren't using, or doesn't form a clear request, do NOT guess what they meant and do NOT act on it — warmly say you didn't catch it and ask them to repeat, in the language they are using (e.g. "Sorry, I didn't quite catch that — could you say it again?"). If you DID hear the request clearly, just proceed — do NOT tack on an extra "is that right?" (the name read-back and post-booking confirmation already cover that). Only when you genuinely couldn't hear, or you'd be guessing a name / date / time / which person they want, restate it and get a clear "yes" before transferring, booking, cancelling, rescheduling, or taking a message (e.g. "Just to confirm, you'd like to move your Thursday 10 a.m. to Friday — is that right?"). A caller who is upset or in a hurry is NOT a reason to make them repeat — if the words are clear, help right away. After a couple of unclear tries, take their name and number for a callback rather than guessing. NEVER transfer, book, cancel, reschedule, or record details based on a guess or an unclear turn.`;
              // Build name verification instruction based on business config
              // Check verification method for name fields (first_name or legacy full_name)
              const nameField = context.assistant.promptConfig?.fields?.find((f) => f.id === "first_name" || f.id === "full_name");
              const nameVerification = nameField?.verification || "repeat-confirm";
              let nameInstruction = "";
              if (nameVerification === "spell-out") {
                nameInstruction = "Ask them to spell it out letter by letter using the English alphabet (e.g., 'M-I-C-H-A-E-L'). After they spell it, READ THE SPELLING BACK to confirm: 'So that's M-I-C-H-A-E-L, is that correct?' WAIT for them to confirm before proceeding. If they say no, ask them to spell it again.";
              } else if (nameVerification === "read-back-characters") {
                nameInstruction = "Read back the name character by character to confirm.";
              } else {
                nameInstruction = "Repeat the name back and ask them to confirm it's correct.";
              }

              geminiSystemPrompt += `\n- NAME COLLECTION IS MANDATORY — ZERO EXCEPTIONS: Before calling book_appointment, you MUST: (1) Ask for FIRST NAME — wait for answer, (2) ${nameInstruction}, (3) Ask for LAST NAME — wait for answer, (4) ${nameInstruction}, (5) ONLY after you have BOTH confirmed names, call book_appointment with first_name and last_name. Names MUST be in English letters. If you are unsure of the spelling, ask again. NEVER call book_appointment until the caller has fully spelled and confirmed BOTH names. If you only have one name, ask for the other BEFORE booking.`;
              geminiSystemPrompt += `\n- CONFIRM BOOKING DETAILS: AFTER book_appointment returns a successful result, read back ALL details to the caller: name, date, time, and practitioner. Then ask "Is everything correct?" If the caller says something is wrong, fix it (cancel and rebook with the correct details). Do NOT end the booking conversation without confirmation. NEVER promise a confirmation text, email, or any other follow-up notification — none are sent automatically. The read-back is the only confirmation the caller receives.`;
              geminiSystemPrompt += `\n- FILLER WORDS — SPEAK FIRST, THEN CALL TOOL: When you need to call a tool, you MUST speak a filler phrase FIRST as a separate response BEFORE making the tool call. Say a brief filler in the caller's language (the equivalent of "one moment, let me check that") and WAIT for the audio to play. THEN make the tool call in the next step. NEVER bundle the filler and tool result into one response. The caller must hear the filler DURING the silence, not after. Example flow: (1) caller asks for availability → (2) you say "Let me check that for you" → (3) you call check_availability → (4) you say "We have slots on Wednesday...". Steps 2 and 4 must be SEPARATE speech outputs.`;
              geminiSystemPrompt += `\n- POST-CONFIRMATION CLOSE — MANDATORY: When the caller responds to "Is everything correct?" with ANY positive answer (yes, sounds right, sounds good, thanks, perfect, great, looks good, sure, yep, absolutely) or says goodbye, you MUST follow this exact sequence in ONE response: (1) Say ONE brief warm closing phrase IN THE CALLER'S LANGUAGE (the equivalent of "Perfect! You're all set. Have a great day!") (2) IMMEDIATELY call end_call with reason="booking_complete" in the SAME response. NEVER say "goodbye" without calling end_call. NEVER mirror the caller's goodbye. NEVER continue the conversation after the caller confirms. The closing phrase and the end_call MUST happen together, without waiting for another turn.`;
              geminiSystemPrompt += `\n- RESCHEDULING: When a caller wants to move or change the time of an existing appointment, you MUST call the reschedule_appointment tool — ONE call that books the new time and removes the old one atomically (verified server-side). Identify the existing appointment by the caller's phone plus its current date (look it up first with lookup_appointment if you don't already know it) and pass new_datetime. NEVER reschedule by calling cancel_appointment and book_appointment separately — that can leave a duplicate appointment.`;
              // SCRUM-294: imperative transfer instruction. Two variants because
              // the transfer_call tool is only REGISTERED when both
              // session.behaviors.transferToHuman !== false AND there's at least
              // one transfer rule (see line ~2764). If the prompt told the model
              // to call transfer_call when the tool wasn't registered, Gemini
              // would hallucinate the invocation and break mid-call — exactly the
              // class of silent failure SCRUM-294 was filed to fix.
              const transferAvailableInbound =
                (session.behaviors?.transferToHuman !== false &&
                  (session.transferRules?.length || 0) > 0) ||
                forwardingFallbackEligible(session);
              if (transferAvailableInbound) {
                geminiSystemPrompt += `\n- TRANSFERS — MUST OBEY: If the caller asks to be transferred, asks to speak to a human / person / manager / somebody / an actual human / a real person / staff, says 'transfer me' / 'put me through' / 'I want to talk to someone' / 'can I speak to a human' / 'get me a person' or any equivalent intent — you MUST IMMEDIATELY say a short filler in the caller's language (the equivalent of "one moment, let me connect you") and call the transfer_call tool in the same turn. The caller already asked — asking again is disobedience. Forbidden phrasings (do NOT say any of these): 'would you like me to transfer you?', 'do you want me to connect you?', 'I can also take a message', 'I can help with that instead', 'is there something specific you need first?', 'first let me check...', 'could you just tell me briefly what you need to discuss with them'. Do NOT ask the caller what they want to discuss. Do NOT offer the message/callback option BEFORE the transfer attempt. Only AFTER the tool returns an error or 'no answer' may you offer a callback or message. If the tool's RESPONSE message tells you to confirm with the caller first, do that — otherwise NEVER ask permission, just transfer. (This "transfer without asking" applies ONLY to a request you CLEARLY heard. If the line was unclear/garbled and you're not sure they actually asked for a person, do NOT transfer on a guess — re-check first by asking them to say it again, e.g. "Sorry, you cut out there — could you repeat that?")`;
              } else {
                geminiSystemPrompt += `\n- TRANSFERS — MUST OBEY: If the caller asks to be transferred, asks to speak to a human / person / manager / somebody / an actual human / a real person / staff, says 'transfer me' / 'put me through' / 'I want to talk to someone' / 'can I speak to a human' / 'get me a person' or any equivalent intent — this business has not configured a transfer destination, so you MUST IMMEDIATELY acknowledge the request and call schedule_callback to capture their name and number. Do NOT argue. Do NOT claim you can help instead. Do NOT redirect to booking. The caller asked for a human — your only job is to capture their details and reassure them someone will call back.`;
              }

              // SCRUM-227: booking invariant restated as the LAST instruction so it's
              // the freshest rule in Gemini's context when it decides what to do.
              geminiSystemPrompt += `\n\n══════════════════════════════════════════════════════\n` +
                `🚨 FINAL CRITICAL RULE — READ THIS LAST 🚨\n` +
                `══════════════════════════════════════════════════════\n` +
                `BOOKING PATH (strict order — no exceptions):\n` +
                `  1. Caller says a time works ("9am is fine")\n` +
                `  2. You ask for first name (if not captured)\n` +
                `  3. You ask for last name (if not captured)\n` +
                `  4. You say a short filler in the caller's language (the equivalent of "one moment, let me book that for you")\n` +
                `  5. You CALL THE book_appointment TOOL — this is non-negotiable\n` +
                `  6. You WAIT for the tool result\n` +
                `  7. You read back the booking details (name, date, time, practitioner) from the tool result\n` +
                `  8. You ask "Is everything correct?" — NEVER promise a text, email, or any follow-up notification\n` +
                `  9. You call end_call AFTER the caller acknowledges\n\n` +
                `BETWEEN step 4 and step 7, you MUST be SILENT — do not speak any words while the tool is executing. Wait for the tool result before opening your mouth again. The tool call takes 1-3 seconds; the caller will hear your filler phrase during this time.\n\n` +
                `YOU MUST NOT speak the words "you're all set", "I've booked", "appointment is confirmed", or anything that implies success BEFORE step 6 (tool result) arrives. If you speak these words without a prior successful book_appointment result, THE CALL HAS FAILED and the caller has NO actual appointment.\n\n` +
                `If book_appointment returns an error, do NOT pretend the booking succeeded. Tell the caller — in their language — that you're having trouble completing the booking and will take their details so someone can call them back. Then call schedule_callback.\n` +
                `\nINCOMPLETE BOOKING: If you started taking booking details but book_appointment NEVER returned a successful result, do NOT end the call as if it worked. Tell the caller honestly you couldn't finish it this time, then take a callback with schedule_callback (or connect them to the team if a transfer is available and the office is open). Only call end_call AFTER that fallback returns success.\n` +
                `\nDON'T HANG UP ON "YES": After you ask "Is there anything else I can help you with?", a "yes" / "yeah" / "ok" / "sure" / "please" or ANY unclear reply means the caller wants MORE help — say the equivalent of "Of course — what else can I help you with?" and do NOT call end_call. Only give a farewell and call end_call when the caller CLEARLY declines: "no" / "no thanks" / "that's all" / "that's everything" / "I'm good" / "goodbye" / "bye". NEVER end the call on a bare "yes" or "ok" right after asking "anything else?".\n` +
                `\n🌐 LANGUAGE — conduct the ENTIRE call in the caller's language: fillers, tool acknowledgements, transfer/hold messages, booking confirmations and closings included. Every English phrase quoted above is an ENGLISH SAMPLE — say its equivalent in the caller's language, never the literal English unless the caller is speaking English. When a tool returns an English message, translate it before speaking, keeping names, numbers, dates, times and confirmation codes exactly as given.\n` +
                `══════════════════════════════════════════════════════`;
              geminiSystemPrompt += buildLanguageLockDirective(session.language);
            } else {
              geminiSystemPrompt += buildOwnerGeminiSuffix();
            }

            // Transcript buffering — accumulate fragments, flush on turn complete
            let pendingUserTranscript = "";
            let pendingAiTranscript = "";

            // SCRUM-378: non-destructive eval override — a dedicated TEST number
            // can run OpenAI Realtime or Grok Realtime instead of Gemini (same
            // session interface, same callbacks/tools/guards). Unset env → null
            // → unchanged Gemini.
            // SCRUM-587: never for owner calls — owner mode is Gemini/classic
            // only (the eval adapters pass the model a tool's message without
            // its data, so the owner's appointment ids would never arrive).
            const _testPipeline = session.ownerMode ? null : resolveTestPipeline(session.orgPhoneNumber);
            if (_testPipeline && !KNOWN_TEST_PIPELINES.has(_testPipeline)) {
              // A typo'd pipeline name would silently run Gemini and corrupt
              // the A/B comparison — never let that stay invisible.
              console.warn(`[Pipeline] TEST override "${_testPipeline}" for callSid=${callSid} is not a known pipeline (${[...KNOWN_TEST_PIPELINES].join(", ")}) — using Gemini`);
            }
            const _useOpenAIRealtime = _testPipeline === "openai-realtime" && !!process.env.OPENAI_API_KEY;
            const _useGrokRealtime = _testPipeline === "grok-realtime" && !!process.env.XAI_API_KEY;
            // Don't fail the call on a missing key — fall through to Gemini —
            // but make the misconfiguration impossible to miss while A/B-ing by ear.
            if (_testPipeline === "openai-realtime" && !_useOpenAIRealtime) {
              console.warn(`[Pipeline] TEST override openai-realtime IGNORED for callSid=${callSid} — OPENAI_API_KEY not set; using Gemini`);
            }
            if (_testPipeline === "grok-realtime" && !_useGrokRealtime) {
              console.warn(`[Pipeline] TEST override grok-realtime IGNORED for callSid=${callSid} — XAI_API_KEY not set; using Gemini`);
            }
            if (_useOpenAIRealtime) console.log(`[Pipeline] TEST override → openai-realtime for callSid=${callSid}`);
            if (_useGrokRealtime) console.log(`[Pipeline] TEST override → grok-realtime for callSid=${callSid}`);
            // SCRUM-496: the callbacks below are SHARED by every pipeline this
            // factory can produce — label failures with the pipeline that
            // actually ran, in the logs AND in endedReason (which reaches
            // calls.metadata.ended_reason; the email layer maps the code to
            // neutral copy — customers never see it verbatim).
            // `let`, not `const`: a SCRUM-535 failover re-labels mid-setup so
            // a post-failover error is recorded against the provider that
            // actually failed.
            let _pipelineLabel = _useOpenAIRealtime ? "openai" : _useGrokRealtime ? "grok" : "gemini";
            let _pipelineTag = _useOpenAIRealtime ? "OpenAIRealtime" : _useGrokRealtime ? "GrokRealtime" : "GeminiLive";
            // SCRUM-535: when the primary is Gemini (no A/B override in play),
            // wrap it so a call whose Gemini session never comes up is served
            // by OpenAI Realtime instead of apologising and hanging up. The
            // wrapper only ever fires BEFORE Gemini's setupComplete — the
            // caller has heard nothing, so the swap is invisible. Disable
            // with GEMINI_LIVE_FAILOVER=off.
            // SCRUM-588: the adapter owns the default — metadata records the
            // model it actually dials, with no second literal to drift.
            const _failoverModel = resolveOpenAIRealtimeModel();
            const _geminiWithFailover = (cfg, cbs) =>
              createSessionWithFailover(
                createGeminiSession,
                {
                  enabled: isFailoverEnabled(process.env.GEMINI_LIVE_FAILOVER, !!process.env.OPENAI_API_KEY),
                  canFailover: () => !!session && !session.callFailed && twilioWs.readyState === WebSocket.OPEN,
                  fallbackFactory: (c, cb) =>
                    createOpenAIRealtimeSession(
                      { ...c, voiceName: process.env.OPENAI_REALTIME_VOICE || "marin", language: session.language },
                      cb
                    ),
                  onFailover: (reason, err) => {
                    _pipelineLabel = "openai";
                    _pipelineTag = "OpenAIRealtime(failover)";
                    console.error(`[Failover] GeminiLive → openai-realtime (${reason}) callSid=${callSid}:`, err?.message);
                    // Stable construction site + message → one Sentry issue for
                    // the whole outage. This is the "notify the operator" leg;
                    // the call-record metadata below is the audit trail.
                    Sentry.withScope((scope) => {
                      scope.setTag("failover", "gemini-to-openai");
                      scope.setExtra("reason", reason);
                      scope.setExtra("callSid", callSid);
                      Sentry.captureException(new Error("GeminiLive failover to openai-realtime"));
                    });
                    if (session) {
                      session.pipelineFailover = {
                        from: "gemini-live",
                        to: "openai-realtime",
                        reason,
                        model: _failoverModel,
                      };
                    }
                  },
                },
                cfg,
                cbs
              );
            const _sessionFactory = _useOpenAIRealtime
              ? (cfg, cbs) => createOpenAIRealtimeSession({ ...cfg, voiceName: process.env.OPENAI_REALTIME_VOICE || "marin", language: session.language }, cbs)
              : _useGrokRealtime
                ? (cfg, cbs) => createGrokRealtimeSession({ ...cfg, voiceName: process.env.GROK_REALTIME_VOICE || "eve", language: session.language }, cbs)
                : _geminiWithFailover;
            session.geminiSession = _sessionFactory(
              {
                systemPrompt: geminiSystemPrompt,
                tools: allTools,
                voiceName: getGeminiVoice(context.assistant.voiceId),
              },
              {
                onAudio: (twilioBase64) => {
                  if (twilioWs.readyState === WebSocket.OPEN) {
                    twilioWs.send(JSON.stringify({
                      event: "media",
                      streamSid: session.streamSid,
                      media: { payload: twilioBase64 },
                    }));
                    // SCRUM-424 (finding #11): the disclosure is the mandated
                    // start of Gemini's first utterance — the first audio
                    // chunk actually sent to Twilio is the earliest faithful
                    // "spoken to the caller" signal. (A caller hanging up
                    // mid-sentence is unavoidable residual; the prior
                    // behavior marked it played before Gemini even connected.)
                    if (session?.pendingDisclosureInFirstMessage && !session.recordingDisclosurePlayed) {
                      session.recordingDisclosurePlayed = true;
                      session.pendingDisclosureInFirstMessage = false;
                    }
                    // SCRUM-587: this assistant turn produced speech (the owner confirmation gate's turn clock).
                    if (session?.ownerMode) noteAssistantSpeech(session);
                  }
                },
                onToolCall: async (toolCall) => {
                  // Guard: session may be null if Gemini delivers buffered tool calls after cleanup
                  if (!session) {
                    console.warn(`[GeminiLive] Ignoring tool call ${toolCall.name} — session already cleaned up`);
                    return { message: "" };
                  }
                  logToolCall("[GeminiLive] Tool call", toolCall.name, toolCall.args);

                  // SCRUM-587: owner calls use their own tool set and skip every
                  // customer guard below (RebookGuard, cancel gate, end_call
                  // funnel, ledgers, cache deltas, loop caps) — see
                  // lib/owner-tool-runner.js for why each one would misfire.
                  // Every owner tool call (end_call and parallel calls included)
                  // goes through the runner, and its result — message AND data —
                  // is the function response, whole. In flight exactly as the
                  // customer path below, so the goodbye-loop auto-end can't
                  // close the call mid-write. sendText: a write Gemini cancelled
                  // after it had gone out is reported to the model (SF4).
                  if (session.ownerMode) {
                    if (session) session._toolCallInFlight = true;
                    try {
                      return await runOwnerToolCall(session, toolCall, { executeToolCall, scheduleCache, sendText: (text) => session?.geminiSession?.sendText(text) });
                    } finally {
                      if (session) session._toolCallInFlight = false;
                    }
                  }

                  // SCRUM-373: block end_call when a booking was started but never
                  // completed — LANGUAGE-AGNOSTIC. The old guard matched English
                  // transcript phrases only, so an Arabic "you're all set" + hangup
                  // with no real booking slipped through. Now keys off tool state +
                  // the end_call reason (see CallSession.hasUnfinishedBooking). Nudges
                  // ONCE so a caller who genuinely wants to leave isn't trapped.
                  if (toolCall.name === "end_call" && session.hasUnfinishedBooking(toolCall.args?.reason)) {
                    const alreadyNudged = (session.toolCallAudit || []).some((t) => t.name === "end_call_blocked");
                    if (!alreadyNudged) {
                      console.error(`[HallucinationGuard] Blocking end_call — booking started but no successful book_appointment. callSid=${session.callSid} reason="${toolCall.args?.reason || ""}"`);
                      session.toolCallAudit.push({ name: "end_call_blocked", successful: false, at: Date.now() });
                      Sentry.withScope((scope) => {
                        scope.setTag("service", "hallucination_guard");
                        scope.setExtras({ callSid: session.callSid, endCallReason: toolCall.args?.reason || "" });
                        Sentry.captureMessage("end_call blocked — unfinished booking (language-agnostic)", "warning");
                      });
                      return {
                        message:
                          "CANNOT END CALL YET: a booking was started but book_appointment never returned success, so the caller has NO appointment. Do NOT say it is booked or 'all set'. Either (1) call book_appointment now with the collected details, OR (2) if you cannot complete it, tell the caller — in their language — that you could not finish the booking and call schedule_callback to take a message. Only call end_call AFTER one of those succeeds.",
                      };
                    }
                    // Already nudged once — allow end_call so a caller who genuinely
                    // wants to leave isn't trapped, but alert at error level: the call
                    // is ending on an unfinished booking (caller may be misinformed).
                    console.error(`[HallucinationGuard] Allowing end_call on unfinished booking AFTER a prior nudge. callSid=${session.callSid}`);
                    Sentry.withScope((scope) => {
                      scope.setTag("service", "hallucination_guard");
                      scope.setExtras({ callSid: session.callSid, endCallReason: toolCall.args?.reason || "" });
                      Sentry.captureMessage("end_call allowed on unfinished booking after nudge", "error");
                    });
                  }

                  // SCRUM-372: cancel-confirmation gate — NEVER cancel on the first
                  // (possibly misheard) request. The first attempt is held pending an
                  // explicit caller confirmation; only a second matching attempt
                  // within 5 minutes executes. Prevents an irreversible cancel from a
                  // single garbled turn.
                  if (toolCall.name === "cancel_appointment") {
                    if (!session.confirmCancel(toolCall.args || {}, Date.now())) {
                      console.warn(`[CancelGate] Holding cancel_appointment pending confirmation. callSid=${session.callSid}`);
                      session.toolCallAudit.push({ name: "cancel_appointment_held", successful: false, at: Date.now() });
                      return {
                        message:
                          "DO NOT CANCEL YET. Before cancelling, confirm with the caller: read back which appointment would be cancelled (its date and time) and ask them — in their language — to clearly confirm (yes/no). ONLY if they clearly say yes, call cancel_appointment again with the same details. If they say no or you are unsure, do NOT cancel — never cancel from an unclear or mis-heard request.",
                      };
                    }
                    console.log(`[CancelGate] Confirmed — proceeding with cancel_appointment. callSid=${session.callSid}`);
                  }

                  // SCRUM-257: intercept duplicate book_appointment calls.
                  // After a successful booking, Sophie sometimes "second-guesses"
                  // herself and re-calls the tool, producing a different code and
                  // confusing the caller. The intercept returns a hard rejection
                  // so she can't create a duplicate.
                  // SCRUM-557: unless the re-book carries a DIFFERENT surname —
                  // that's the caller correcting a mis-heard name (booking-key
                  // drops surnames by design, so the correction maps to the same
                  // key). Blocking it convinced the model the fixed booking
                  // existed; a follow-up cancel then left a real caller with
                  // ZERO appointments while being told "you're booked". Perform
                  // an in-place attendee update on this call's appointment.
                  if (toolCall.name === "book_appointment" && session.confirmedBookings?.size > 0) {
                    const reqKey = bookingKey(toolCall.args);
                    const existing = session.confirmedBookings.get(reqKey);
                    if (existing) {
                      const verdict = classifyRebookAttempt(existing, toolCall.args);
                      if (verdict.kind === "name-correction") {
                        console.warn(`[RebookGuard] Name-corrected re-book — updating attendee in place. callSid=${session.callSid}`);
                        let correctionMsg;
                        try {
                          const corrected = await executeToolCall("update_appointment_attendee", {
                            datetime: toolCall.args.datetime,
                            first_name: toolCall.args.first_name,
                            last_name: toolCall.args.last_name,
                          }, {
                            organizationId: session.organizationId,
                            assistantId: session.assistantId,
                            callSid: session.callSid,
                            callId: session.callRecordId,
                            sourceType: session.sourceType,
                            organization: session.organization,
                            callerPhone: session.callerPhone,
                          });
                          correctionMsg = typeof corrected === "string" ? corrected : corrected.message;
                        } catch (corrErr) {
                          console.error(`[RebookGuard] attendee correction threw: ${corrErr && corrErr.message} callSid=${session.callSid}`);
                          correctionMsg = CORRECTION_ERROR_MESSAGE;
                        }
                        const correctionOk = correctionMsg.startsWith("NAME CORRECTED");
                        session.toolCallAudit.push({ name: "book_appointment_corrected", successful: correctionOk, at: Date.now() });
                        if (correctionOk) {
                          session.confirmedBookings.set(reqKey, {
                            ...existing,
                            name: `${toolCall.args.first_name || ""} ${toolCall.args.last_name || ""}`.trim(),
                          });
                        } else {
                          Sentry.withScope((scope) => {
                            scope.setTag("service", "rebook_guard");
                            scope.setExtras({ callSid: session.callSid, attemptedDatetime: toolCall.args.datetime });
                            Sentry.captureMessage("Name-corrected re-book: attendee update FAILED", "warning");
                          });
                        }
                        return { message: correctionMsg };
                      }
                      console.warn(`[RebookGuard] Blocking duplicate book_appointment — already booked code=${existing.code} callSid=${session.callSid}`);
                      session.toolCallAudit.push({ name: "book_appointment_blocked", successful: false, at: Date.now() });
                      Sentry.withScope((scope) => {
                        scope.setTag("service", "rebook_guard");
                        scope.setExtras({ callSid: session.callSid, existingCode: existing.code, attemptedDatetime: toolCall.args.datetime });
                        Sentry.captureMessage("Duplicate book_appointment intercepted", "warning");
                      });
                      return {
                        message: DUPLICATE_REBOOK_MESSAGE,
                      };
                    }
                  }

                  // Flag so goodbye-loop auto-end knows a tool call is in progress
                  // and won't close the session mid-execution.
                  if (session) session._toolCallInFlight = true;
                  session.rememberDetails(toolCall.name, toolCall.args); // SCRUM-506: carry caller details forward this call
                  let result;
                  try {
                    result = await executeToolCall(toolCall.name, toolCall.args, {
                      organizationId: session.organizationId,
                      collectedDetails: session.getCollectedDetails(), // SCRUM-506
                      assistantId: session.assistantId,
                      callSid: session.callSid,
                      callId: session.callRecordId,
                      transferRules: session.transferRules,
                      userPhoneNumber: session.userPhoneNumber,
                      forwardingStatus: session.forwardingStatus,
                      sourceType: session.sourceType,
                      transferToForwardedNumber: session.transferToForwardedNumber,
                      organization: session.organization,
                      callerPhone: session.callerPhone,
                      orgPhoneNumber: session.orgPhoneNumber,
                      telephonyProvider: session.telephonyProvider || "twilio",
                      scheduleSnapshot: session.scheduleSnapshot,
                    });
                  } finally {
                    if (session) session._toolCallInFlight = false;
                  }
                  let message = typeof result === "string" ? result : result.message;
                  console.log(`[GeminiLive] Tool result: "${message.slice(0, 100)}"`);

                  // Track last tool result for Tier 2 validator — it compares
                  // Sophie's spoken response against what the tool actually returned.
                  if (session) {
                    session._lastToolResult = { name: toolCall.name, message, at: Date.now() };
                  }

                  // SCRUM-227: audit tool calls so cleanupSession can detect
                  // hallucinated bookings (AI said "booked" but never called the tool).
                  // For write-actions (book_appointment, cancel_appointment,
                  // schedule_callback), "successful" means the result text
                  // actually contains a confirmation phrase — a result saying
                  // "Dr X isn't available" doesn't count as a successful booking
                  // even if it doesn't have an `error` field.
                  if (session) {
                    // Trust an explicit success:false (e.g. a failed
                    // reschedule_appointment that returns no `error` field) —
                    // otherwise a failed write would be audited as successful and
                    // let end_call through on an unfinished booking (SCRUM-377).
                    let successful = !(typeof result === "object" && (result?.error || result?.success === false));
                    if (successful && toolCall.name === "book_appointment") {
                      // Require actual success signal: "confirmation code", "booked", "confirmed"
                      const msg = typeof result === "string" ? result : (result?.message || "");
                      const hasSuccessSignal = /\b(confirmation code|i've booked|you'?re all set|booked your|appointment (?:is|has been) (?:booked|confirmed))\b/i.test(msg);
                      if (!hasSuccessSignal) successful = false;
                    }
                    // SCRUM-559: appointment identity so netLiveOutcome can
                    // pair a cancel with the booking it actually cancels — an
                    // identity-blind counter false-failed "book Friday, cancel
                    // my Monday checkup" calls.
                    const auditEntry = { name: toolCall.name, successful, at: Date.now() };
                    if (toolCall.name === "book_appointment") {
                      auditEntry.dt = normalizeDatetime(toolCall.args?.datetime) || undefined;
                      const codeM = message.match(/\b(\d{6})\b/);
                      if (codeM) auditEntry.code = codeM[1];
                    } else if (toolCall.name === "reschedule_appointment") {
                      auditEntry.dt = normalizeDatetime(toolCall.args?.new_datetime) || undefined;
                      auditEntry.oldDt = normalizeDatetime(toolCall.args?.current_datetime || toolCall.args?.current_date) || undefined;
                    } else if (toolCall.name === "cancel_appointment") {
                      auditEntry.dt = normalizeDatetime(toolCall.args?.datetime || toolCall.args?.date) || undefined;
                      auditEntry.codeArg = String(toolCall.args?.confirmation_code || "").trim() || undefined;
                    }
                    session.toolCallAudit.push(auditEntry);
                  }

                  // SCRUM-367 (B): break the name/detail re-confirm loop
                  // deterministically (see CallSession.registerBookOutcome).
                  // Keyed off the handler's authoritative `success` boolean
                  // (threaded through executeCalendarCall), falling back to the
                  // SCRUM-227 audit signal. Availability/conflict rejections are
                  // legitimate "offer another time" turns and reset the counter
                  // rather than escalating. The directive is appended to the
                  // RETURNED message only — the audit/dedupe/cache checks above
                  // key off the unmodified `message` const.
                  // SCRUM-367/503: availability/conflict rejections are the
                  // legitimate "offer another time" turns shared by BOTH the book
                  // and reschedule loop-breakers. One pattern keeps the twin caps
                  // byte-identical and covers every availability message their
                  // shared handleBookAppointment path emits — including the
                  // practitioner-unavailable case ("unavailable at this time").
                  const availabilityRejectRe = /no longer available|already booked|currently blocked|not available for this service|fully booked|no available slot|unavailable at this time/i;

                  let bookLoopDirective = "";
                  if (session && toolCall.name === "book_appointment") {
                    const lastAudit = session.toolCallAudit[session.toolCallAudit.length - 1] || {};
                    const succeeded = (typeof result === "object" && typeof result.success === "boolean")
                      ? result.success
                      : lastAudit.successful === true;
                    const isAvailabilityReject = availabilityRejectRe.test(message);
                    bookLoopDirective = session.registerBookOutcome({ successful: succeeded, isAvailabilityReject });
                    if (bookLoopDirective) {
                      console.warn(`[BookLoopCap] Escalation injected (attempt ${session.bookRejectionCount}). callSid=${session.callSid}`);
                    }
                  }

                  // SCRUM-503: same anti-loop escalation for reschedule — on the
                  // first completed Grok eval call the model re-fired
                  // reschedule_appointment ~10x in 40s instead of relaying the
                  // tool's "confirm the name" question to the caller, until the
                  // per-number attempt cap blocked the flow. Faithful twin of the
                  // book block above: authoritative `result.success`, with the
                  // SCRUM-227 audit signal as the fallback (governs the test-mode
                  // simulated path, which omits `success`) and the SAME shared
                  // availability regex so a legit "offer another time" resets.
                  let rescheduleLoopDirective = "";
                  if (session && toolCall.name === "reschedule_appointment") {
                    const lastAudit = session.toolCallAudit[session.toolCallAudit.length - 1] || {};
                    const succeeded = (typeof result === "object" && typeof result.success === "boolean")
                      ? result.success
                      : lastAudit.successful === true;
                    const isAvailabilityReject = availabilityRejectRe.test(message);
                    rescheduleLoopDirective = session.registerRescheduleOutcome({ successful: succeeded, isAvailabilityReject });
                    if (rescheduleLoopDirective) {
                      console.warn(`[RescheduleLoopCap] Escalation injected (attempt ${session.rescheduleRetryCount}). callSid=${session.callSid}`);
                    }
                  }

                  // SCRUM-257: track confirmed bookings to prevent duplicates.
                  // SCRUM-514: keyed by lib/booking-key, which folds the datetime
                  // to a UTC instant and drops the surname — the model respelling
                  // it mid-call used to slip straight past this guard.
                  if (session && toolCall.name === "book_appointment" && (message.includes("confirmed") || message.includes("booked") || message.includes("confirmation"))) {
                    if (!session.confirmedBookings) session.confirmedBookings = new Map();
                    const bookKey = bookingKey(toolCall.args);
                    const codeMatch = message.match(/\b(\d{6})\b/);
                    session.confirmedBookings.set(bookKey, {
                      code: codeMatch?.[1] || "unknown",
                      datetime: toolCall.args.datetime,
                      name: `${toolCall.args.first_name || ""} ${toolCall.args.last_name || ""}`.trim(),
                      practitioner_id: toolCall.args.practitioner_id, // SCRUM-557: correction-vs-second-person discriminator
                      at: Date.now(),
                    });
                  }
                  // SCRUM-257: clear confirmedBookings entry on successful cancel so
                  // the reschedule flow (cancel → book) still works.
                  // SCRUM-557: also tell the model, in the tool result itself, that
                  // NOTHING is booked now — a real caller was told "you're booked
                  // 9am tomorrow" right after the only appointment was cancelled.
                  // SCRUM-557 (review): key on the handler's authoritative success
                  // flag — the old text heuristic matched EVERY failure message
                  // ("I'm having trouble cancelling…" contains neither "error" nor
                  // "not found"), so a FAILED cancel cleared the ledger and told the
                  // model nothing was booked while the appointment still stood.
                  const cancelOk =
                    typeof result === "object" && result !== null && typeof result.success === "boolean"
                      ? result.success
                      : !message.toLowerCase().includes("error") && !message.toLowerCase().includes("not found");
                  if (session && toolCall.name === "cancel_appointment" && cancelOk) {
                    if (session.confirmedBookings) session.confirmedBookings.clear();
                    message += CANCEL_NUDGE;
                  }

                  // SCRUM-563: a successful reschedule MOVES this call's ledger
                  // entry — book writes it, cancel clears it, but reschedule
                  // used to leave the OLD slot vouched-for, so RebookGuard
                  // refused a legitimate re-book at the freed time ("already
                  // booked... LOCKED") for the rest of the call. Same
                  // authoritative-flag pattern as cancelOk above. The fallback
                  // additionally requires a positive success signal: the ONLY
                  // structured-less results reschedule can produce are the
                  // test-mode simulated success and the tool-executor INFRA
                  // failures (config missing / 5xx / timeout) — bare
                  // `{message}` shapes the audit records as successful, which
                  // would move the ledger on a reschedule that never happened.
                  if (session && toolCall.name === "reschedule_appointment") {
                    const lastAudit = session.toolCallAudit[session.toolCallAudit.length - 1] || {};
                    const rescheduleOk =
                      typeof result === "object" && result !== null && typeof result.success === "boolean"
                        ? result.success
                        : lastAudit.successful === true && RESCHEDULE_SUCCESS_SIGNAL.test(message);
                    if (rescheduleOk) {
                      const move = applyRescheduleToLedger(session.confirmedBookings, toolCall.args, Date.now());
                      if (move.moved) {
                        console.log(`[RebookGuard] Reschedule moved ledger entry ${move.fromKey} -> ${move.toKey}. callSid=${session.callSid}`);
                      } else if (move.ambiguous) {
                        // A stale entry is now guaranteed to false-block the
                        // freed slot for the rest of the call — page like the
                        // sibling duplicate-block does; near-impossible
                        // precondition makes a page-per-occurrence cheap.
                        console.warn(`[RebookGuard] Reschedule ledger move ambiguous — entries left untouched. callSid=${session.callSid}`);
                        Sentry.withScope((scope) => {
                          scope.setTag("service", "rebook_guard");
                          scope.setExtras({ callSid: session.callSid, attemptedDatetime: toolCall.args?.current_datetime || toolCall.args?.current_date });
                          Sentry.captureMessage("Reschedule ledger move ambiguous — stale entry left", "warning");
                        });
                      } else if (session.confirmedBookings?.size > 0) {
                        // Breadcrumb only: legitimately reached when a PRIOR-
                        // call appointment is moved while this call also booked
                        // something, but it's the one trace of key-fold drift.
                        console.log(`[RebookGuard] Reschedule matched no this-call ledger entry (${session.confirmedBookings.size} held). callSid=${session.callSid}`);
                      }
                      // The move also freed the old slot and took the new one —
                      // the pre-loaded availability snapshot is stale on both
                      // counts (book/cancel already maintain the cache below;
                      // reschedule never did).
                      if (session.scheduleSnapshot) {
                        scheduleCache.invalidate(session.organizationId);
                      }
                    }
                  }

                  // Apply cache delta for writes — guard against cleanup race
                  if (session && session.scheduleSnapshot) {
                    if (toolCall.name === "book_appointment" && (message.includes("confirmed") || message.includes("booked") || message.includes("confirmation"))) {
                      scheduleCache.applyDelta(session.organizationId, "book", {
                        appointment: {
                          id: "pending-" + Date.now(),
                          start_time: toolCall.args.datetime,
                          duration_minutes: session.serviceTypes?.find((st) => st.id === toolCall.args.service_type_id)?.duration_minutes || 30,
                          status: "confirmed",
                        },
                        dateKey: toolCall.args.datetime?.split("T")[0],
                        slotTime: toolCall.args.datetime,
                      });
                    }
                    if (toolCall.name === "cancel_appointment") {
                      scheduleCache.invalidate(session.organizationId);
                    }
                  }

                  // Preserve __endCall flag so gemini-live.js can detect end_call
                  // and close the WebSocket. Without this, the session stays open
                  // indefinitely after end_call.
                  const ret = { message: message + bookLoopDirective + rescheduleLoopDirective };
                  if (typeof result === "object" && result?.__endCall) ret.__endCall = true;
                  // SCRUM-378: forward `action` (e.g. "transfer") so the OpenAI
                  // Realtime adapter can suppress its follow-up response.create on a
                  // call that the tool already redirected. Gemini ignores this field.
                  if (typeof result === "object" && result?.action) ret.action = result.action;
                  return ret;
                },
                onTranscriptIn: (text) => {
                  // Buffer user transcript fragments — flush on turn complete
                  pendingUserTranscript += text;
                  // SCRUM-587: the owner spoke — the first worded fragment after the last assistant turn (once per utterance).
                  if (session?.ownerMode) noteOwnerSpeech(session, text);
                },
                onTranscriptOut: (text) => {
                  // Buffer AI transcript fragments — flush on turn complete.
                  // Goodbye-loop detection moved to onTurnComplete so the counter
                  // increments once per TURN, not once per streaming fragment.
                  pendingAiTranscript += text;
                  // SCRUM-587: never a mark on the owner turn clock — transcription can
                  // trail its turn; only audio (onAudio) makes a turn "spoken".
                },
                onInterrupted: () => {
                  // Guard: session may be null if Gemini delivers buffered events after cleanup
                  if (!session) {
                    pendingAiTranscript = "";
                    return;
                  }
                  // SCRUM-587: an interrupted turn has ended — counted once, even
                  // when its turnComplete follows (same serverContent or not).
                  if (session.ownerMode) noteAssistantTurnEnd(session);
                  // Flush any pending AI transcript before interruption
                  if (pendingAiTranscript.trim()) {
                    session.addMessage("assistant", pendingAiTranscript.trim());
                    logTranscript("[GeminiLive] AI", pendingAiTranscript.trim());
                    pendingAiTranscript = "";
                  }
                  if (twilioWs.readyState === WebSocket.OPEN) {
                    twilioWs.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));
                  }
                },
                onTurnComplete: (turnInfo) => {
                  // Guard: session may be null if Gemini delivers buffered events after cleanup
                  if (!session) {
                    pendingUserTranscript = "";
                    pendingAiTranscript = "";
                    return;
                  }
                  // SCRUM-587: one assistant turn on the confirmation gate's clock —
                  // only if it produced speech (a tool-call-only turn is not one).
                  // A realtime-failover response that ends in tool calls is not the
                  // end of the turn: its spoken follow-up is (Gemini's semantics).
                  if (session.ownerMode && turnInfo?.endedWithToolCalls !== true) noteAssistantTurnEnd(session);
                  // Flush accumulated transcripts as complete messages
                  if (pendingUserTranscript.trim()) {
                    session.addMessage("user", pendingUserTranscript.trim());
                    logTranscript("[GeminiLive] User (turn)", pendingUserTranscript.trim());
                    pendingUserTranscript = "";
                  }
                  if (pendingAiTranscript.trim()) {
                    const aiTurnText = pendingAiTranscript.trim();
                    session.addMessage("assistant", aiTurnText);
                    logTranscript("[GeminiLive] AI (turn)", aiTurnText);

                    // SCRUM-258: goodbye-loop detector — runs once per COMPLETE turn,
                    // not per streaming fragment, to count TURNS not fragments.
                    const isGoodbye = /\b(goodbye|bye|have a (great|nice|wonderful) day|take care|see you)\b/i.test(aiTurnText);
                    if (isGoodbye) {
                      session.consecutiveGoodbyeCount = (session.consecutiveGoodbyeCount || 0) + 1;
                      if (session.consecutiveGoodbyeCount >= 3 && !session._goodbyeAutoEndFired) {
                        // Guard: don't auto-end if a tool call is in-flight — the booking
                        // may have succeeded and the result hasn't been read back yet.
                        const toolInFlight = session._toolCallInFlight;
                        if (toolInFlight) {
                          console.warn(`[GoodbyeLoop] Skipping auto-end — tool call in flight. callSid=${session.callSid}`);
                        } else {
                          session._goodbyeAutoEndFired = true;
                          console.log(`[GoodbyeLoop] Auto-ending call after ${session.consecutiveGoodbyeCount} goodbye turns. callSid=${session.callSid}`);
                          Sentry.withScope((scope) => {
                            scope.setTag("service", "goodbye_loop_detector");
                            scope.setExtras({ callSid: session.callSid, count: session.consecutiveGoodbyeCount });
                            Sentry.captureMessage("Goodbye loop detected — auto-ending call", "warning");
                          });
                          session.endedReason = "goodbye_loop_autoend";
                          try {
                            if (session.geminiSession?.close) session.geminiSession.close();
                          } catch (closeErr) {
                            console.warn("[GoodbyeLoop] Error closing Gemini session:", closeErr);
                          }
                          try {
                            if (twilioWs.readyState === WebSocket.OPEN) {
                              twilioWs.close(1000, "end_call");
                            }
                          } catch (wsErr) {
                            console.warn("[GoodbyeLoop] Error closing Twilio WebSocket:", wsErr);
                          }
                        }
                      }
                    } else if (aiTurnText.length > 10) {
                      session.consecutiveGoodbyeCount = 0;
                    }

                    // ── TIER 1: Phantom action detector ──────────────────────
                    // If Sophie claimed an action (booking, reschedule, cancel,
                    // callback) but no tool that would accomplish it was called
                    // successfully, inject a correction so she actually calls the
                    // tool on the next turn. SCRUM-381: reschedule-aware — an
                    // atomic reschedule_appointment now backs booking/cancel
                    // claims too, so a legit reschedule no longer false-positives
                    // into a re-book thrash, and a phantom "I rebooked you" is
                    // finally caught.
                    // SCRUM-587: off for owner calls — "cancelled Mrs Smith's job"
                    // there is the owner's instruction, not a receptionist claim.
                    const phantom = session.ownerMode ? null : detectPhantomAction(aiTurnText, session.toolCallAudit);
                    if (phantom) {
                      const { action, primaryTool, negated } = phantom;
                      const notDone =
                        action === "booking" ? "the caller has NO appointment booked"
                        : action === "reschedule" ? "the caller's appointment was NOT moved — it is still at the original time"
                        : action === "cancellation" ? "the caller's appointment is NOT cancelled — it is still on the calendar"
                        : "no callback was scheduled";

                      session._phantomActionCount = (session._phantomActionCount || 0) + 1;
                      console.error(
                        `[PhantomAction] Sophie claimed ${action} but ${primaryTool} (or an equivalent tool) was never called successfully ` +
                        `(attempt ${session._phantomActionCount}). callSid=${session.callSid}`
                      );
                      Sentry.withScope((scope) => {
                        scope.setTag("service", "phantom_action_detector");
                        scope.setTag("action", action);
                        scope.setExtras({ callSid: session.callSid, toolName: primaryTool, attempt: session._phantomActionCount });
                        Sentry.captureMessage(`Phantom ${action} detected — tool never called`, "error");
                      });

                      // Inject correction — but limit to 2 attempts to avoid an
                      // infinite correction loop if Gemini keeps ignoring us.
                      if (session._phantomActionCount <= 2 && session.geminiSession?.sendText) {
                        // SCRUM-559: a NEGATED booking needs truthful wording —
                        // the model DID call book_appointment (it has the result
                        // in context), so "you did NOT call it" is a false
                        // premise it can dismiss. The truth: it was cancelled.
                        session.geminiSession.sendText(
                          negated
                            ? `CRITICAL ERROR: The appointment you booked earlier in this call was CANCELLED — the caller currently has NO live appointment, but you just told them one exists. ` +
                              `You MUST now: (1) tell the caller honestly where things stand, (2) if they still want the appointment, call book_appointment NOW with the full details, ` +
                              `(3) only confirm what the tool actually returns. Do NOT end the call while the caller believes an appointment exists that does not.`
                            : `CRITICAL ERROR: You just told the caller the ${action} was done, but you did NOT call ${primaryTool}. ` +
                              `The action did NOT happen — ${notDone}. ` +
                              `You MUST now: (1) apologize briefly ("I'm sorry, let me actually do that for you now"), ` +
                              `(2) call ${primaryTool} NOW with the correct details, ` +
                              `(3) then confirm the REAL result to the caller. Do NOT end the call until ${primaryTool} has been called.`
                        );
                      } else if (session._phantomActionCount > 2) {
                        // Gemini is ignoring corrections — fall back to schedule_callback
                        console.error(`[PhantomAction] ${session._phantomActionCount} phantom attempts — falling back to callback. callSid=${session.callSid}`);
                        if (session.geminiSession?.sendText) {
                          session.geminiSession.sendText(
                            `STOP: You have failed to call ${primaryTool} after multiple attempts. ` +
                            `Apologize to the caller and say: "I'm having some technical difficulties — ` +
                            `let me take your details and have someone call you back to confirm." ` +
                            `Then call schedule_callback with the caller's details.`
                          );
                        }
                      }
                    }

                    // ── TIER 2: Claude Haiku tool-result validator ────────────
                    // After a tool result turn, compare Sophie's spoken response
                    // against what the tool actually returned. Catches wrong dates,
                    // times, practitioner names, and other subtle mismatches.
                    // Runs async — no caller-facing latency. Correction injected
                    // into Gemini's next turn if discrepancy found.
                    if (!session.ownerMode && session._lastToolResult && !session._phantomActionCount) { // SCRUM-587: customer tools only
                      const lastTool = session._lastToolResult;
                      // Only validate if this turn is likely the response to the tool
                      // (within 10 seconds of the tool result)
                      if (Date.now() - lastTool.at < 10000) {
                        validateToolResponse({
                          toolName: lastTool.name,
                          toolResult: lastTool.message,
                          spokenResponse: aiTurnText,
                        }).then((validation) => {
                          if (!validation.accurate && session?.geminiSession?.sendText) {
                            console.warn(`[Tier2Validator] Discrepancy in ${lastTool.name}: ${DEBUG_TRANSCRIPTS ? validation.discrepancy : "[redacted]"}. callSid=${session.callSid}`);
                            Sentry.withScope((scope) => {
                              scope.setTag("service", "tier2_validator");
                              scope.setExtras({ callSid: session.callSid, toolName: lastTool.name, discrepancy: validation.discrepancy });
                              Sentry.captureMessage(`Tier 2: detail mismatch in ${lastTool.name}`, "warning");
                            });
                            session.geminiSession.sendText(
                              `CORRECTION: You told the caller something that doesn't match what actually happened. ` +
                              `The discrepancy is: ${validation.discrepancy}. ` +
                              `Please correct this with the caller now — say "Actually, let me clarify that..." ` +
                              `and give them the correct information from the tool result.`
                            );
                          }
                        }).catch((err) => {
                          console.warn("[Tier2Validator] Validation error (non-fatal):", err.message);
                        });
                      }
                      session._lastToolResult = null; // Consumed
                    }

                    pendingAiTranscript = "";
                  }
                },
                // SCRUM-587: Gemini cancelled these tool calls — the owner talked
                // over them. An owner write not yet sent never will be, and one
                // already out has its real result told to the model (lib/owner-tool-runner.js).
                onToolCallCancellation: (ids) => {
                  if (session?.ownerMode) noteCancelledOwnerToolCalls(session, ids);
                },
                onError: (err) => {
                  // A failure was already recorded (e.g. the setup watchdog) —
                  // a close is in flight; don't overwrite endedReason or race
                  // the apology with a faster close (SCRUM-424 review).
                  if (session?.callFailed) return;
                  console.error(`[${_pipelineTag}] Session error:`, err.message);
                  if (session) {
                    session.callFailed = true;
                    session.endedReason = `${_pipelineLabel}-error`;
                  }
                  // Close the Twilio call — caller would be stuck in silence otherwise
                  if (twilioWs.readyState === WebSocket.OPEN) {
                    setTimeout(() => twilioWs.close(1000, `${_pipelineTag} session error`), 1000);
                  }
                },
                // SCRUM-424 (finding #10): Gemini setup never completed — the
                // caller has heard NOTHING yet. Speak a brief apology via
                // Deepgram TTS (independent of Gemini) so they aren't dropped
                // from dead silence, then end the call. Every step is
                // fail-safe: if TTS also fails we still close, which is
                // exactly what the plain onError path would have done.
                onSetupTimeout: (err) => {
                  // Null session = cleanup already started (caller hung up) —
                  // nobody left to apologize to; cleanup owns the teardown.
                  if (!session) return;
                  console.error(`[${_pipelineTag}] Setup timeout — apologizing and ending call. callSid=${session.callSid}:`, err.message);
                  session.callFailed = true;
                  session.endedReason = `${_pipelineLabel}-setup-timeout`;
                  if (twilioWs.readyState !== WebSocket.OPEN) return;
                  // Close only after the apology has had time to PLAY —
                  // sendTTS resolves once chunks are pushed, but Twilio plays
                  // them in real time; an early close discards its buffer.
                  let closeDelayMs = 2000; // fallback when TTS fails
                  sendTTS(session, twilioWs, getErrorMsg(session.language, "technicalDifficulty"))
                    .then((durationMs) => {
                      closeDelayMs = Math.min((durationMs || 0) + 500, 8000);
                    })
                    .catch((ttsErr) => {
                      console.error(`[${_pipelineTag}] Setup-timeout apology TTS failed:`, ttsErr.message || ttsErr);
                    })
                    .finally(() => {
                      setTimeout(() => {
                        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, "Gemini setup timeout");
                      }, closeDelayMs);
                    });
                },
                onClose: (code, reason) => {
                  console.log(`[${_pipelineTag}] Session closed (code=${code}, reason="${reason}")`);
                  // SCRUM-378 (review): commit transcript fragments still
                  // buffered when the session closes without a final
                  // turn-complete (e.g. the caller's last utterance before an
                  // end_call/transfer close, or a Grok provisional committed by
                  // the adapter's close-flush) so cleanupSession's
                  // getTranscript() → post-call analysis sees them. Caller
                  // hang-up tears down in the other order (cleanup first) —
                  // that pre-existing gap is unchanged here.
                  if (session && pendingUserTranscript.trim()) {
                    session.addMessage("user", pendingUserTranscript.trim());
                    logTranscript(`[${_pipelineTag}] User (close)`, pendingUserTranscript.trim());
                    pendingUserTranscript = "";
                  }
                  if (session && pendingAiTranscript.trim()) {
                    session.addMessage("assistant", pendingAiTranscript.trim());
                    logTranscript(`[${_pipelineTag}] AI (close)`, pendingAiTranscript.trim());
                    pendingAiTranscript = "";
                  }
                  // Planned close via end_call tool — not a failure.
                  if (reason === "end_call") {
                    if (session) session.endedReason = "end_call_tool";
                    if (twilioWs.readyState === WebSocket.OPEN) {
                      setTimeout(() => twilioWs.close(1000, "end_call"), 1000);
                    }
                    return;
                  }
                  // SCRUM-378: planned close after a transfer (OpenAI Realtime path).
                  // The call was already redirected via Twilio REST inside the tool,
                  // so this is a SUCCESS, not a failed call — don't set callFailed.
                  if (reason === "transfer") {
                    if (session) session.endedReason = "transferred";
                    if (twilioWs.readyState === WebSocket.OPEN) {
                      setTimeout(() => twilioWs.close(1000, "transferred"), 1000);
                    }
                    return;
                  }
                  // If the voice session closes unexpectedly mid-call, end the Twilio call too
                  if (session && !session.callFailed && twilioWs.readyState === WebSocket.OPEN) {
                    console.warn(`[${_pipelineTag}] Unexpected session close — ending Twilio call`);
                    session.callFailed = true;
                    session.endedReason = `${_pipelineLabel}-session-closed`;
                    setTimeout(() => twilioWs.close(1000, `${_pipelineTag} session closed`), 1000);
                  }
                },
              }
            );

            // No greeting needed — Gemini handles the full conversation including greeting
            // The system prompt tells it what to say first
            break; // Skip the classic pipeline setup below
          }

          // ── Classic pipeline (Deepgram STT + OpenAI LLM + Deepgram TTS) ──
          // SCRUM-594: fastPath marks the demo line's fast variant
          // (DEMO_LINE_PIPELINE=classic-fast) before any STT opens. A Gemini
          // selection that fell back for a missing key lands here too, and is
          // recorded as the classic call it is.
          session.fastPath = !session.ownerMode && effectivePipeline === "classic-fast";
          if (!session.fastPath) session.effectivePipeline = "classic";
          // SCRUM-594 (phone test F3/F5, PHASE 2): short turns, one question at a time,
          // a booking made in this call changed with what was booked, the whole call
          // in context, and the booking guards.
          if (session.fastPath) applyFastConversationSettings(session);
          // Nova-3 with today's callbacks: the classic STT, and the fast path's
          // fallback whenever Flux cannot serve the call (spec 4.8.1).
          const openClassicStt = () => {
            session.deepgramWs = openDeepgramStream(DEEPGRAM_API_KEY, {
              language: session.language,
              onTranscript: ({ transcript, isFinal }) => {
                if (!isFinal) return;
                // Echo suppression: drop STT transcripts that arrive while AI is speaking.
                // Allow through: substantial speech (>2 words) or known interrupt phrases.
                const INTERRUPT_RE = /^(stop|wait|hold on|no|cancel|nevermind|never mind|excuse me|hello|hey)\b/i;
                if (session.isSpeaking && transcript.trim().split(/\s+/).length <= 2 && !INTERRUPT_RE.test(transcript.trim())) {
                  logTranscript("[STT] Dropped (echo suppression while AI speaking)", transcript);
                  return;
                }
                logTranscript("[STT] Final", transcript);
                // SCRUM-587: the owner spoke (confirmation-gate clock; once per utterance).
                if (session.ownerMode) noteOwnerSpeech(session, transcript);
                session.bufferTranscript(transcript, (combined, inputType) => {
                  logTranscript("[STT] Buffered", combined);
                  session.queueOrProcess(combined, (text) => handleUserSpeech(session, twilioWs, text, inputType));
                });
              },
              onUtteranceEnd: () => {
                session.flushBuffer();
              },
              onError: (err) => {
                console.error("[STT] Error:", err);
                if (session) {
                  session.callFailed = true;
                  session.endedReason = "stt-error";
                }
                sendTTS(session, twilioWs, getErrorMsg(session.language, "technicalDifficulty"))
                  .catch((ttsErr) => {
                    console.error("[STT] Failed to send error message to caller:", ttsErr);
                  })
                  .finally(() => {
                    // Disconnect after delivering the error message
                    setTimeout(() => twilioWs.close(), 2000);
                  });
              },
              onClose: (code) => {
                if (code !== 1000 && code !== 1005 && session && !session.callFailed) {
                  console.error(`[STT] Connection lost during active call (callSid=${session.callSid})`);
                  session.callFailed = true;
                  session.endedReason = "stt-connection-lost";
                  sendTTS(session, twilioWs, getErrorMsg(session.language, "troubleRepeat"))
                    .catch((ttsErr) => console.error("[STT] Failed to send reconnect message:", ttsErr))
                    .finally(() => setTimeout(() => twilioWs.close(), 3000));
                }
              },
            }, { industry: session.organization?.industry });
          };
          // SCRUM-594: the fast path starts Flux (and its turn engine), the Aura
          // stream and the player instead; every other call opens Nova as before.
          if (session.fastPath) startFastPath(session, twilioWs, openClassicStt);
          else openClassicStt();

          // Recording disclosure + greeting — pre-synthesize disclosure while STT connects
          // SCRUM-587: no spoken disclosure on owner calls (as on the Gemini path).
          const consentResult = session.ownerMode
            ? { required: false, callerState: null, reason: "owner-call" }
            : requiresRecordingDisclosureHybrid(
                context.organization.country,
                context.organization.businessState,
                context.organization.recordingConsentMode,
                session.callerPhone
              );
          session.callerState = consentResult.callerState;
          session.consentReason = consentResult.reason;
          console.log(`[Recording] Consent: required=${consentResult.required}, callerState=${consentResult.callerState}, reason=${consentResult.reason}`);

          // Pre-synthesize disclosure audio in parallel with STT connection
          // This eliminates the 7+ second wait for disclosure TTS
          let disclosureAudioPromise = null;
          let disclosureText = "";
          if (consentResult.required) {
            disclosureText = getRecordingDisclosureText(
              context.organization.country,
              context.organization.recording_disclosure_text,
              context.organization.name
            );
            disclosureAudioPromise = synthesizeSpeech(DEEPGRAM_API_KEY, disclosureText, {
              voice: session.deepgramVoice,
              // SCRUM-594: the fast path pre-synthesises on the AU host (spec 4.8.1)
              ...(session.fastPath ? { host: FAST_DEEPGRAM_HOST } : {}),
            }).catch((err) => {
              console.error("[Recording] Disclosure pre-synthesis failed:", err);
              return null;
            });
          }

          // Pre-synthesize greeting in parallel too
          const greeting = session.ownerMode
            ? buildOwnerGreeting(session.ownerFirstName)
            : getGreeting(context.assistant, context.organization.name, { isAfterHours, afterHoursConfig });
          const greetingAudioPromise = synthesizeSpeech(DEEPGRAM_API_KEY, stripMarkdown(greeting), {
            voice: session.deepgramVoice,
            ...(session.fastPath ? { host: FAST_DEEPGRAM_HOST } : {}),
          }).catch((err) => {
            console.error("[TTS] Greeting pre-synthesis failed:", err);
            return null;
          });

          // Wait for pre-synthesized audio and send it
          if (disclosureAudioPromise) {
            const disclosureAudio = await disclosureAudioPromise;
            if (disclosureAudio) {
              const t0 = Date.now();
              const chunks = chunkAudioForTwilio(disclosureAudio);
              session.isSpeaking = true;
              // SCRUM-594 (R12d′): nothing on the fast path may cut the disclosure off.
              if (session.fastPath) beginFastDisclosure(session);
              for (const chunk of chunks) {
                if (twilioWs.readyState !== WebSocket.OPEN) break;
                twilioWs.send(JSON.stringify({ event: "media", streamSid: session.streamSid, media: { payload: chunk } }));
              }
              twilioWs.send(JSON.stringify({ event: "mark", streamSid: session.streamSid, mark: { name: "tts-done" } }));
              if (session.fastPath) {
                noteFastRestSpeech(session, disclosureText, disclosureAudio.length / 8);
                armFastDisclosureEnd(session, twilioWs, disclosureAudio.length / 8);
              }
              console.log(`[TTS] Disclosure (pre-synth, ${Date.now() - t0}ms send) ${disclosureAudio.length} bytes`);
              session.recordingDisclosurePlayed = true;
              session.addMessage("assistant", disclosureText);
            } else {
              // Pre-synthesis failed — MUST fall back to synchronous TTS for legal compliance
              // In two-party consent jurisdictions, skipping disclosure is illegal
              console.warn("[Recording] Disclosure pre-synthesis failed — falling back to synchronous TTS");
              try {
                if (session.fastPath) {
                  // SCRUM-594 (R12d′): over REST on the fast path too. It is legally
                  // required, and REST knows its frames went out (and before the
                  // pre-synthesised greeting's); nothing may cut it off.
                  beginFastDisclosure(session);
                  const disclosureMs = await sendRestTTS(session, twilioWs, disclosureText, undefined, { verbatim: true });
                  if (twilioWs.readyState !== WebSocket.OPEN) throw new Error("the Twilio stream closed before the disclosure was sent");
                  armFastDisclosureEnd(session, twilioWs, disclosureMs);
                } else {
                  await sendTTS(session, twilioWs, disclosureText);
                }
                session.recordingDisclosurePlayed = true;
                session.addMessage("assistant", disclosureText);
              } catch (fallbackErr) {
                if (session.fastPath) endFastDisclosure(session);
                console.error("[Recording] CRITICAL: Disclosure fallback TTS also failed — cannot play legally required disclosure:", fallbackErr);
                session.recordingDisclosureFailed = true;
              }
            }
          }

          const greetingAudio = await greetingAudioPromise;
          if (greetingAudio) {
            const t0 = Date.now();
            const chunks = chunkAudioForTwilio(greetingAudio);
            session.isSpeaking = true;
            for (const chunk of chunks) {
              if (twilioWs.readyState !== WebSocket.OPEN) break;
              twilioWs.send(JSON.stringify({ event: "media", streamSid: session.streamSid, media: { payload: chunk } }));
            }
            twilioWs.send(JSON.stringify({ event: "mark", streamSid: session.streamSid, mark: { name: "tts-done" } }));
            // SCRUM-594 (R12d′): the echo filter hears the greeting too.
            if (session.fastPath) noteFastRestSpeech(session, greeting, greetingAudio.length / 8);
            // Safety timeout: reset isSpeaking even if mark event is lost
            setTimeout(() => { if (session) session.isSpeaking = false; }, 20000);
            console.log(`[TTS] Greeting (pre-synth, ${Date.now() - t0}ms send) ${greetingAudio.length} bytes`);
            session.addMessage("assistant", greeting);
          } else {
            // Fallback: synthesize greeting normally if pre-synth failed
            try {
              await sendTTS(session, twilioWs, greeting);
              if (session.fastPath) fastFlush(session); // SCRUM-594: release the greeting's last words (spec 4.8.4)
              session.addMessage("assistant", greeting);
            } catch (err) {
              console.error("[TTS] Greeting fallback also failed:", err);
              session.addMessage("system", "The greeting failed to play. Start by greeting the caller.");
            }
          }

          // (Old sequential disclosure/greeting code removed — replaced by pre-synthesis above)
          const greetingInputType = detectExpectedInput(greeting);
          session.setExpectedInputType(greetingInputType);
          console.log(`[InputDetect] After greeting: ${greetingInputType}`);
          break;
        }

        case "media": {
          // Route audio based on pipeline mode
          if (session?.geminiSession) {
            // Gemini Live pipeline — send audio directly (conversion handled internally)
            session.geminiSession.sendAudio(msg.media.payload);
            break;
          }
          if (!session || !session.deepgramWs) break;
          // Classic pipeline — forward raw mulaw audio to Deepgram (no conversion needed)
          const audio = Buffer.from(msg.media.payload, "base64");
          if (session.deepgramWs.readyState === WebSocket.OPEN) {
            session.deepgramWs.send(audio);
            // SCRUM-594 gate M4b: speech Flux reports no turns for (fast path only).
            if (session.fastPath === true) noteFastInboundAudio(session, audio);
          } else if (!session._sttDropWarned) {
            console.warn(`[STT] Dropping audio — Deepgram WebSocket not open (state=${session.deepgramWs.readyState}, callSid=${session.callSid})`);
            session._sttDropWarned = true;
          }
          break;
        }

        case "mark": {
          // TTS playback finished for a marked chunk
          if (session && msg.mark && msg.mark.name === "tts-done") {
            session.isSpeaking = false;
            // SCRUM-594 (R12d′): on the fast path, isSpeaking holds while other audio still plays.
            if (session.fastState) onFastRestMark(session);
          } else if (session?.fastState && typeof msg.mark?.name === "string" && msg.mark.name.startsWith("fast-")) {
            // SCRUM-594 (spec 4.8.6): the fast player's marks (and the disclosure's); isSpeaking follows what still plays.
            onFastMark(session, msg.mark.name);
          }
          break;
        }

        case "stop": {
          console.log(`[Twilio] Stream stopped — callSid=${session?.callSid}`);
          // SCRUM-587 (SF6): the caller ended the stream (hung up) — cleanup's owner-record page needs to know.
          if (session) session.streamStoppedByCaller = true;
          await cleanupSession();
          break;
        }
      }
    } catch (err) {
      console.error(`[Twilio] Error handling event="${msg.event}" callSid=${session?.callSid}:`, err);
      // If the start event failed, the session is in an unusable state — close the connection
      if (msg.event === "start") {
        console.error("[Twilio] Fatal error during call setup — closing connection");
        if (session) {
          session.callFailed = true;
          session.endedReason = "server-error";
        }
        twilioWs.close();
      }
    }
  });

  twilioWs.on("error", (err) => {
    console.error(`[Twilio] WebSocket error (callSid=${session?.callSid}):`, err);
  });

  twilioWs.on("close", (code, reason) => {
    // SCRUM-571: a demo call that ends naturally must not leave the cap timer
    // armed against a dead socket.
    if (demoLineTimer) {
      clearTimeout(demoLineTimer);
      demoLineTimer = null;
    }
    const reasonStr = reason ? reason.toString() : "";
    console.log(`[Twilio] WebSocket closed (code=${code}, reason="${reasonStr}", callSid=${session?.callSid}, duration=${session?.getDurationSeconds?.() || 0}s)`);
    cleanupSession().catch((err) => {
      console.error("[Cleanup] Unhandled error in session cleanup:", err);
    });
  });
});

// SCRUM-594: classic end_call hang-up timing (hangUpAfterEndCall). The turn's
// speech gets at most this long to play, then a short tail lets the last audio
// leave Twilio's buffer before the stream closes (which ends the call).
const END_CALL_PLAYBACK_CAP_MS = 8000;
const END_CALL_TAIL_MS = 500;

// SCRUM-594: the fast classic pipeline (spec 4.8). Out here, beside the
// end_call timings, so the tests that run server.js text inject their own.
// Flux, the Aura stream and the fast path's greeting pre-synthesis use
// Deepgram's Sydney host (~25 ms away vs ~335 ms for api.deepgram.com); the
// existing Nova and REST paths stay where they are.
const FAST_DEEPGRAM_HOST = process.env.FAST_DEEPGRAM_HOST || DEFAULT_HOST;
// The fast path's LLM: always Claude (services/claude-chat.js), whatever LLM_PROVIDER says.
const FAST_LLM_MODEL = process.env.FAST_LLM_MODEL || "claude-haiku-5-5";
// A live fast LLM call's limit. Passing a signal turns off claude-chat's own
// 15 s timeout, so the turn's signal carries this one.
const FAST_LLM_TIMEOUT_MS = 15_000;
// Flux must be open by then, or the call falls back to Nova.
const FLUX_OPEN_TIMEOUT_MS = 3000;
// What sendTTS returns for text on the Aura stream (estimated ms per character):
// the audio streams in later, so callers that wait on a duration get an estimate.
const FAST_TTS_MS_PER_CHAR = 70;
// The end_call hang-up waits at most this long for the Flushed that ends the goodbye's audio.
const FAST_FLUSHED_WAIT_MS = 3000;
// ... then for the player to go idle: its byte estimate of playback plus this.
const FAST_IDLE_CAP_MS = 2000;
// Aura silent this long ends the utterance even with no Flushed (a flush the budget refused).
const FAST_AUDIO_QUIET_MS = 500;
// A fast turn that starts while the AI is still speaking waits this long at most for it to finish (R12b″) ...
const FAST_TURN_START_WAIT_MS = 10_000;
// ... checking this often.
const FAST_TURN_START_POLL_MS = 20;
// A playback mark (the player's, a REST tts-done, the disclosure's) this overdue
// past the audio's estimated end is taken as lost: that audio counts as played.
const FAST_LOST_MARK_MS = 5000;
// A flush whose Flushed is this overdue, with no Aura audio either, means a stuck
// stream: REST for the rest of the call.
const FAST_FLUSH_WATCHDOG_MS = 3000;
// Flux answers audio with an Update about every 240 ms: this long without a single
// frame while audio goes out means a stuck stream, and Nova takes over ...
const FLUX_SILENCE_MS = 5000;
// ... checked this often.
const FLUX_WATCHDOG_TICK_MS = 1000;
// The mark after the recording disclosure's audio: until it is back, nothing cuts the disclosure.
const FAST_DISCLOSURE_MARK = "fast-disclosure";
// Gate M3: the Aura stream must open within this long (as Flux must), or the call speaks over REST.
const AURA_OPEN_TIMEOUT_MS = 3000;
// Phone test F9 (silent-failure review): another language's voice must open within this, or its
// sentences go to the assistant's voice. Shorter than FAST_FLUSH_WATCHDOG_MS, which watches the
// flush queued behind it: equal, the healthy base stream was blamed and the call went to REST.
// The probes opened every voice in 70-220 ms.
const AURA_VOICE_OPEN_TIMEOUT_MS = 1500;
// Gate C4: R14″'s estimate of the audio Aura still owes ahead of a question, at a slow speech rate:
// it errs late (an answer must clearly start after the question did), never early.
const FAST_QUESTION_MS_PER_CHAR = 95;
// Gate H2 (round 2, N3): a sentence counts as voiced by a failed Aura stream once this much audio
// a character was received. Near Aura's real rate (about 66) but above it, so in doubt the last
// sentence is said again over REST rather than lost; it may repeat a sentence that did play.
const FAST_RESPEAK_MS_PER_CHAR = 75;
// Gate M5 (ii): this long without the caller starting a turn after the AI's question, it asks again (once).
const FAST_REPROMPT_MS = 6000;
// Phone test F3/F5: how the fast path's Claude speaks. The owner's first call had replies of
// 12-15 s repeating the same offer, and a reschedule of a same-call booking that asked the
// caller for the name again (Flux misheard "Sorry?" as "Deville": refused as a mismatch).
const FAST_VOICE_ADDENDUM = [
  "VOICE STYLE (this is a phone call):",
  "- Speak in short turns: at most two short sentences (about 25 words), then stop and let the caller answer.",
  "- Ask one question at a time.",
  "- Never repeat an offer or question you already made in your last reply; if the caller didn't answer it, rephrase briefly or move on.",
  "- Don't ask for anything the caller already told you, and don't offer what they already asked for.",
  "- Ask \"anything else?\" once, when their request is done, not after every answer.",
  "- Say goodbye and end the call only after the caller says goodbye or that they're done.",
  // Phone test F6: the shared POST-CONFIRMATION CLOSE (written for Gemini) says goodbye and end_call on the
  // read-back's yes; this line holds that hang-up, so callers heard "Have a good day" then "anything else?".
  "- POST-CONFIRMATION CLOSE ON THIS LINE (this replaces the one above, and any line above that says goodbye once they confirm): a yes to your booking read-back, even \"yes, thanks\" or \"perfect, thanks\", means the details are right, not that the caller is done. Say no goodbye and don't call end_call: ask if there's anything else, then wait for their answer. If they also said goodbye or that's all, say a short goodbye and call end_call.",
  "NAMES:",
  "- Before you book, spell the caller's last name back to them letter by letter (for example \"That's S-M-I-T-H?\") and wait for a yes. Speech recognition often mishears surnames.",
  "BOOKINGS MADE ON THIS CALL:",
  "- If you booked an appointment earlier in this call, use the exact name and time you booked when calling reschedule_appointment or cancel_appointment (pass the full name on the booking as name); do not ask the caller to repeat them.",
  "- If the caller wants a different time for an appointment you booked on this call, move it with reschedule_appointment; book a second one only if they want two.",
  "- When they ask to move it to a day (\"how about Tuesday?\"), offer the times free that day and let them pick one before you move it.",
  "- When the caller asks to cancel, call cancel_appointment straight away, without checking their name again: it tells you when to read the booking back to them for a yes.",
  "TIMES:",
  "- Offer the earliest free time in the LIVE SCHEDULE: today first, if it still has times. Never give a reason a day is unavailable that the schedule doesn't show.",
  "- Say each time once: put the choices in your question (\"Today at 11, or tomorrow at 9:30?\"), not in a sentence first and then again in the question.",
].join("\n");
// Phone test F5: asked for Arabic, the model followed the shared prompt's LANGUAGE rule (written
// for Gemini, which speaks it), said yes, and sent Arabic text to an English voice. The fast path
// speaks what Flux Multilingual hears AND Aura-2 says (lib/fast-languages.js), nothing else.
// Phone test F9: no set_language. Each sentence is said in its own language's voice and the
// line follows the replies, so the model only has to answer in the right language.
const FAST_LANGUAGE_RULES = [
  "LANGUAGES ON THIS LINE (this replaces the LANGUAGE rule above):",
  "- This line speaks English, Spanish, French, German, Italian, Dutch and Japanese, nothing else.",
  "- Answer in the language the caller speaks, or the one they ask for, and keep to it until they change language. Nothing needs switching: the caller hears each sentence in a voice for its own language.",
  "- If the caller only asks, in English, whether you speak one of them, answer in English (\"Yes, I can. Would you like to continue in Spanish?\"), then speak the one they choose.",
  "- In another language, say everything in it, including any line this prompt gives you to say and what the tools tell you (translate them); keep names, numbers, dates, times and confirmation codes exactly as they are. Never mix two languages in one reply.",
  "- That includes the short line before you check or book something: in Spanish \"Un momento, lo compruebo.\" or \"Se lo reservo ahora.\"; never say \"Let me book that for you.\" to them in English.",
  "- For any other language (for example Arabic, Mandarin, Cantonese, Vietnamese, Hindi or Greek), say in English, in one short sentence, that this line can't speak it yet, and offer to have someone call them back. Never write words in a language this line can't speak.",
].join("\n");
/** FAST_LANGUAGES=off: the English-only rules (Flux English, the assistant's voice only). */
const FAST_ENGLISH_ONLY_RULES = [
  "LANGUAGE ON THIS LINE (this replaces the LANGUAGE rule above):",
  "- This line speaks English only. If the caller asks for another language, say so in English, in one short sentence, and offer to have someone call them back. Never write words in another language.",
].join("\n");
/** SCRUM-594 PHASE 2 (B1): the fast path's context window — the whole call (a 10-minute call is about 100 messages). */
const FAST_MAX_MESSAGES = 201;
/**
 * SCRUM-594: the fast path's conversation settings, applied when a call starts
 * on it: the voice-style prompt, the whole call in the model's context (B1),
 * and the booking guards (lib/booking-guards.js, B2–B4). One function, so the
 * simulated-call harness (scripts/sim-calls) gives its calls exactly these.
 * @param {CallSession} session
 */
function applyFastConversationSettings(session) {
  session.fastLanguages = fastLanguagesEnabled(); // F5: the kill switch FAST_LANGUAGES=off
  const languageRules = session.fastLanguages ? FAST_LANGUAGE_RULES : FAST_ENGLISH_ONLY_RULES;
  session.setSystemPrompt(`${session.messages[0]?.content || ""}\n${FAST_VOICE_ADDENDUM}\n${languageRules}`);
  session.maxMessages = FAST_MAX_MESSAGES;
  session.bookingGuards = true;
  session.fastLanguage = "en";
  session.baseDeepgramVoice = session.deepgramVoice || null; // the voice to come back to from another language
}
// Gate B: speculative drafts (each an LLM call) per Flux turn, and per call. Past either, turns are answered live.
const FAST_DRAFTS_PER_TURN = 2;
const FAST_DRAFTS_PER_CALL = 60;

/**
 * Build LLM options with tools based on session capabilities.
 * @param {CallSession} session
 * @param {{ includeTransfer?: boolean }} options
 * @returns {object}
 */
function buildLLMOptions(session, { includeTransfer = false } = {}) {
  if (session.ownerMode) return { tools: buildOwnerTools() }; // SCRUM-587: the owner tool set, nothing else
  const tools = [];
  // Service types imply scheduling capability — enable calendar tools even without Cal.com
  const hasScheduling = session.calendarEnabled || session.serviceTypes?.length > 0;
  if (hasScheduling) tools.push(...calendarToolDefinitions);
  if (session.serviceTypes?.length > 0) tools.push(listServiceTypesToolDefinition);
  // SCRUM-238: gate transfer_call on BOTH includeTransfer AND the org's
  // behaviors.transferToHuman flag. Having transfer_rules rows in the DB
  // alone should NOT enable transfers if the business has explicitly
  // disabled the behavior.
  const behaviorAllowsTransfer = session.behaviors?.transferToHuman !== false;
  // SCRUM-327: offer transfer_call when EITHER explicit rules exist (still
  // gated by the org's transferToHuman behavior) OR the org opted into the
  // forwarded-number fallback. The fallback opt-in is its own authorization and
  // bypasses transferToHuman (an industry default, off for dental/home_services)
  // so the toggle works for every vertical.
  if (
    includeTransfer &&
    ((behaviorAllowsTransfer && session.transferRules?.length > 0) ||
      forwardingFallbackEligible(session))
  ) {
    tools.push(transferToolDefinition);
  }
  // Always-available tools — callback (universal fallback) + end_call (terminate after goodbye)
  tools.push(callbackToolDefinition);
  tools.push(endCallToolDefinition);
  return tools.length > 0 ? { tools } : {};
}

// Single model for all responses — nano was tested and rejected (poor instruction following, not actually faster)
const FULL_MODEL = process.env.LLM_MODEL || DEFAULT_MODEL;

/**
 * Parse tool call arguments safely — returns empty object on parse failure.
 * @param {object} toolCall - OpenAI tool call object
 * @param {string} label - Log prefix for error messages
 * @returns {object}
 */
function parseToolArgs(toolCall, label) {
  const raw = toolCall.function.arguments;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[${label}] Failed to parse arguments for ${toolCall.function.name}:`, err);
    return {};
  }
}

const MAX_TOOL_ITERATIONS = 3;

/**
 * Handle final user transcript: stream LLM response sentence-by-sentence,
 * synthesizing and sending TTS for each sentence as it arrives.
 */
// Filler system: ONE filler per turn, only when the AI needs time to process.
// No stacking, no "Sure. Of course. One moment." — just one natural acknowledgment.
// Covers all languages supported by the prompt builder's LANGUAGE_NAMES map.
const FILLER_MESSAGES = {
  en: {
    waiting: "One moment.",                          // generic wait — LLM taking >1.5s
    checking: "One moment, let me check that.",      // tool: check_availability, get_current_datetime
    booking: "Let me book that for you.",             // tool: book_appointment
    tool: "One moment.",                              // other tool calls
  },
  es: {
    waiting: "Un momento.",
    checking: "Un momento, déjeme verificar.",
    booking: "Permítame reservar eso.",
    tool: "Un momento.",
  },
  ar: {
    waiting: "لحظة من فضلك.",
    checking: "لحظة، دعني أتحقق من ذلك.",
    booking: "دعني أحجز لك ذلك.",
    tool: "لحظة من فضلك.",
  },
  fr: {
    waiting: "Un instant.",
    checking: "Un instant, je vérifie cela.",
    booking: "Je vais réserver cela pour vous.",
    tool: "Un instant.",
  },
  de: {
    waiting: "Einen Moment bitte.",
    checking: "Einen Moment, ich prüfe das.",
    booking: "Ich buche das für Sie.",
    tool: "Einen Moment bitte.",
  },
  it: {
    waiting: "Un momento.",
    checking: "Un momento, lascia che controlli.",
    booking: "Lascia che lo prenoti per te.",
    tool: "Un momento.",
  },
  pt: {
    waiting: "Um momento.",
    checking: "Um momento, deixa eu verificar.",
    booking: "Deixa eu reservar isso para você.",
    tool: "Um momento.",
  },
  zh: {
    waiting: "请稍等。",
    checking: "请稍等，让我查一下。",
    booking: "让我为您预约。",
    tool: "请稍等。",
  },
  hi: {
    waiting: "एक क्षण।",
    checking: "एक क्षण, मुझे जांचने दें।",
    booking: "मैं आपके लिए बुक करता हूं।",
    tool: "एक क्षण।",
  },
  ja: {
    waiting: "少々お待ちください。",
    checking: "少々お待ちください、確認させていただきます。",
    booking: "ご予約いたします。",
    tool: "少々お待ちください。",
  },
  ko: {
    waiting: "잠시만 기다려 주세요.",
    checking: "잠시만요, 확인해 드릴게요.",
    booking: "예약해 드리겠습니다.",
    tool: "잠시만 기다려 주세요.",
  },
  ru: {
    waiting: "Одну минуту.",
    checking: "Одну минуту, я проверю.",
    booking: "Я забронирую это для вас.",
    tool: "Одну минуту.",
  },
  tr: {
    waiting: "Bir dakika.",
    checking: "Bir dakika, kontrol edeyim.",
    booking: "Sizin için rezerve edeyim.",
    tool: "Bir dakika.",
  },
  vi: {
    waiting: "Một chút ạ.",
    checking: "Một chút, để tôi kiểm tra.",
    booking: "Để tôi đặt cho bạn.",
    tool: "Một chút ạ.",
  },
  th: {
    waiting: "สักครู่นะคะ",
    checking: "สักครู่ ขอเช็คก่อนนะคะ",
    booking: "ขอจองให้นะคะ",
    tool: "สักครู่นะคะ",
  },
  id: {
    waiting: "Sebentar ya.",
    checking: "Sebentar, saya cek dulu.",
    booking: "Saya bookingkan untuk Anda.",
    tool: "Sebentar ya.",
  },
};

// Short/closing responses that don't need a filler.
// Language-agnostic heuristic: treat transcripts under ~12 characters (after trimming)
// as short utterances that should NOT trigger a filler. This covers "yes/no/ok/thanks/bye"
// and their equivalents in any language without maintaining per-language regex lists.
const NO_FILLER_MAX_LEN = 12;
const NO_FILLER_RE = /^(yeah?|yes|no|ok(ay)?|sure|thanks?( you)?|thank you|bye|goodbye|that'?s all|good|likewise)\s*[.!?]?$/i;

/**
 * SCRUM-594 (F5): the canned fillers for this call's language. On the fast path that is the
 * language the caller is speaking (fastTalkLanguage), and none for a language without canned
 * fillers — a French call never hears "One moment." in a French voice. Every other call: as before.
 * @param {any} session
 * @returns {Record<string, string>|null}
 */
function fillerMessagesFor(session) {
  if (typeof session.fastLanguage === "string") return FILLER_MESSAGES[fastTalkLanguage(session)] || null;
  return FILLER_MESSAGES[session.language] || FILLER_MESSAGES.en;
}

/**
 * SCRUM-594 (phone test F9): the language the caller is speaking on the fast path: theirs this
 * turn when their words say so clearly (beginReplyLanguage), else the line's.
 * @param {any} session
 * @returns {string}
 */
function fastTalkLanguage(session) {
  return session.fastTurnLanguage || session.fastLanguage || "en";
}

/**
 * SCRUM-594 (F5): the language the caller is hearing — the fast path's (switched) language,
 * else the assistant's — for the canned lines (getErrorMsg).
 * @param {any} session
 * @returns {string}
 */
function callLanguage(session) {
  return typeof session?.fastLanguage === "string" ? session.fastLanguage : session?.language;
}

/**
 * SCRUM-594 (phone test F9): the line follows the model. A reply clearly in another of the
 * line's languages (textLanguage, strict) moves the line there: Flux's hints, the fillers,
 * and the voice of the sentences whose own words don't say their language. The caller's
 * words never move it: the rules that read them (F5, F9) kept misreading them. Never to a
 * language the call gave up on (revertFastLanguageToEnglish); when the hearing can't follow
 * (Nova, or Flux not open), the model is told to keep to English.
 * @param {any} session
 * @param {string} reply - the model's reply this turn
 * @returns {boolean} whether the line moved
 */
function followReplyLanguage(session, reply) {
  if (!session.fastLanguages || typeof session.fastLanguage !== "string") return false;
  const code = textLanguage(reply, { strict: true });
  if (!code || code === session.fastLanguage || session.fastBlockedLanguages?.includes(code)) return false;
  const plan = planLanguageSwitch(session, code);
  if (!plan.changed) return false;
  if (!switchFastLanguageStreams(session, plan)) {
    // Told once: a language given up on before had its own note (revertFastLanguageToEnglish).
    if (!session.fastBlockedLanguages?.length) session.addMessage("system", LANGUAGE_UNHEARD_NOTE);
    session.fastBlockedLanguages = [...(session.fastBlockedLanguages || []), code];
    return false;
  }
  recordLanguageSwitch(session, plan);
  console.log(`[FastPath] The reply was in ${FAST_LANGUAGES[code].name}: the line follows it (callSid=${session.callSid})`);
  return true;
}

function getToolFiller(lang, toolNames) {
  const msgs = FILLER_MESSAGES[lang] || FILLER_MESSAGES.en;
  const names = Array.isArray(toolNames) ? toolNames : [toolNames];
  if (names.some((n) => n === "book_appointment")) return msgs.booking;
  if (names.some((n) => n === "check_availability" || n === "get_current_datetime")) return msgs.checking;
  return msgs.tool;
}

async function handleUserSpeech(session, twilioWs, transcript, inputTypeAtFlush) {
  // SCRUM-594: no turn on a closing or closed stream. After an end_call
  // hang-up (ws sets CLOSING inside close()), a late buffered final must not
  // start an LLM round nobody will hear.
  if (!session || twilioWs.readyState !== WebSocket.OPEN) return;
  session.isProcessing = true;

  // Barge-in: if assistant is speaking, clear Twilio's audio buffer. (On the
  // fast path with Nova after a fallback, this is still the only barge-in; a
  // Flux fast turn waits for the AI's audio instead, below.) SCRUM-594: when
  // nothing was cleared (the recording disclosure plays on), it is still speaking.
  // After a fallback, audio Aura still owes counts too (phone test F6, gate review):
  // the hold loop's stop used to cut it at the reply's first words, and fast turns
  // no longer run the hold loop.
  if (session.fastPath !== true && (session.isSpeaking || (session.fastPath === "degraded-stt" && fastAudioBusy(session)))) {
    if (sendClear(session, twilioWs)) session.isSpeaking = false;
  }

  // Play hold audio while AI processes. SCRUM-594: holdPlaying lets an end_call
  // hang-up stop hold audio that is still looping — and only then, because
  // every stop() sends a Twilio clear, which would cut speech already queued.
  // Never on the fast path (phone test F6): its replies start about a second
  // after the caller stops, so the loop was only ever a second of brown noise,
  // heard as wind, before every reply, and its stop sent a Twilio clear and an
  // Aura Clear at every turn's first words.
  /** @type {{ stop: () => void } | null} */
  const holdAudio = session.fastPath ? null : startHoldAudio(session, twilioWs, "twilio");
  let holdPlaying = holdAudio !== null;
  const hold = {
    stop: () => {
      if (session.fastPath && !holdPlaying) return;
      holdPlaying = false;
      holdAudio?.stop();
    },
  };
  // SCRUM-594 (spec 4.8.7): the fast path's turn: the draft it adopts, and the
  // abort a barge-in calls (session.currentTurn).
  /** @type {import("./call-session").FastTurn|null} */
  let fastTurn = null;

  try {
    // Decided BEFORE the user message is added: isAdoptable compares the
    // messages array the draft started from, length included.
    fastTurn = session.fastPath ? beginFastTurn(session, transcript) : null;
    session.addMessage("user", transcript);

    if (fastTurn && session.fastPath === true) {
      // SCRUM-594 (R12b″): a fast turn never cuts the AI off at its start. It waits
      // (at most FAST_TURN_START_WAIT_MS) for the AI's audio to finish: a caller
      // who really talks over it barges in (the turn engine). The wait is part of
      // the turn, so that barge-in aborts it: no reply to these words alone, which
      // stay in the conversation for the turn that follows.
      if (fastAudioBusy(session)) {
        const waitStarted = Date.now();
        await waitForFastTurnStart(session, fastTurn);
        fastTurn.record.waitedMs += Date.now() - waitStarted; // gate C5
        if (fastTurn.ctl.signal.aborted) throw fastAbortError(fastTurn.abortReason || "abort");
        if (twilioWs.readyState !== WebSocket.OPEN) return;
      }
    }

    // SCRUM-594 (phone test F9): the caller's language this turn, for the fillers and for the
    // reply's sentences whose own words don't say theirs. Nothing switches on it.
    if (session.fastLanguages) beginReplyLanguage(session, transcript);

    const llmOptions = buildLLMOptions(session, { includeTransfer: true });
    let reply = null;

    // Track whether a filler has been sent this turn — only ONE filler per turn
    let fillerSentThisTurn = false;

    // SCRUM-594: an allowed end_call (or an owner tool result carrying
    // __endCall) ends the turn and then the call; the model is not asked again.
    let endCall = false;
    // When the audio sent to TTS this turn will have finished playing. Twilio
    // plays what we queue in order and in real time (sendTTS returns each
    // send's length), so audio that has already played is not waited for
    // again. The hang-up waits until then before closing the stream.
    let playbackEndsAt = 0;
    /**
     * @param {string} text
     * @param {{ reply?: boolean }} [kind] - NOT_A_REPLY for a filler or an apology: not the turn's latency (gate H1)
     */
    const speak = async (text, kind) => {
      // SCRUM-594: a fast turn's REST audio (after an Aura fallback) is not sent once a barge-in has ended the turn.
      const ms = await sendTTS(session, twilioWs, text, fastTurn ? () => Boolean(fastTurn?.over) : undefined, kind);
      playbackEndsAt = Math.max(Date.now(), playbackEndsAt) + ms;
    };
    /** @type {Promise<void>[]} each tool round's TTS chain — the hang-up waits until all of it is sent */
    const turnTtsChains = [];

    // SCRUM-587 (SF5): an owner's normal list → availability → reschedule is
    // three tool rounds on its own, so owner turns get the owner tool cap. The
    // turn's last owner tool call is what the owner hears if even that runs out.
    const maxToolIterations = session.ownerMode ? OWNER_MAX_TOOL_CALLS : MAX_TOOL_ITERATIONS;
    /** @type {{ name: string, ret: { message: string, data?: unknown } } | null} */
    let lastOwnerTool = null;

    for (let i = 0; i < maxToolIterations; i++) {
      const t0 = Date.now();

      const sentenceQueue = [];
      // SCRUM-594: a barge-in during the last round's tools ends the turn here (never mid-tool).
      if (fastTurn) startFastRound(fastTurn, sentenceQueue);
      let ttsChain = Promise.resolve();
      let holdStopped = false;

      // Filler timer: if LLM hasn't started streaming in 1.5s, play "One moment."
      // Only fires once per turn (fillerSentThisTurn guard) and skips closing responses.
      // Short transcripts (< NO_FILLER_MAX_LEN chars) are treated as closings in any language.
      const trimmedTranscript = transcript.trim();
      const skipFiller = fillerSentThisTurn
        || NO_FILLER_RE.test(trimmedTranscript)
        || trimmedTranscript.length <= NO_FILLER_MAX_LEN
        || !fillerMessagesFor(session); // SCRUM-594 (F5): no canned fillers in this language
      const fillerTimer = skipFiller ? null : setTimeout(() => {
        // SCRUM-594: never after a barge-in (or the end) of the fast turn.
        if (!holdStopped && !fillerSentThisTurn && !fastTurn?.over) {
          fillerSentThisTurn = true;
          hold.stop();
          holdStopped = true;
          const msgs = /** @type {Record<string, string>} */ (fillerMessagesFor(session));
          console.log(`[Filler] "${msgs.waiting}"`);
          ttsChain = ttsChain.then(async () => {
            if (fastTurn?.over) return; // SCRUM-594: not after a barge-in
            await speak(msgs.waiting, NOT_A_REPLY);
            if (session.fastPath) fastFlush(session); // SCRUM-594: a flush point (spec 4.8.4)
          }).catch((err) => {
            console.error("[Filler] TTS error:", err.message);
          });
        }
      }, 1500);

      /** @param {string} sentence */
      const onSentence = (sentence) => {
        if (fastTurn) {
          // SCRUM-594: nothing more is said once a barge-in has ended the turn.
          if (fastTurn.over) return;
          noteFastLlmOutput(fastTurn);
        }
        if (fillerTimer) clearTimeout(fillerTimer);
        sentenceQueue.push(sentence);
        // Stop hold audio before first TTS sentence
        if (!holdStopped) {
          hold.stop();
          holdStopped = true;
        }
        // Chain TTS calls so they play in order
        ttsChain = ttsChain.then(async () => {
          if (fastTurn?.over) return;
          await speak(sentence);
          // SCRUM-587: a reply sentence reached the caller — this turn produced speech.
          if (session.ownerMode) noteAssistantSpeech(session);
        }).catch((err) => {
          session.isSpeaking = false;
          console.error("[StreamTTS] Error sending sentence:", err.message);
        });
      };
      // SCRUM-594 (spec 4.8.7): the fast path asks Claude (clause chunking, the
      // turn's signal), or adopts the turn's draft in round 0.
      const result = fastTurn
        ? await fastLlmResponse(session, fastTurn, i, llmOptions, onSentence)
        : await streamChatResponse(LLM_API_KEY, session.messages, { ...llmOptions, onSentence });
      if (fastTurn) {
        noteFastLlmOutput(fastTurn); // a tool call with no words before it
        if (session.fastStats) session.fastStats.llmErrorStreak = 0; // gate H1: Claude answered
      }

      if (fillerTimer) clearTimeout(fillerTimer);

      if (result.type === "content") {
        reply = result.content;
        // Wait for all queued TTS to finish playing
        await ttsChain;
        if (session.fastPath) fastFlush(session); // SCRUM-594: a flush point, the end of the reply (spec 4.8.4)
        if (session.fastLanguages) followReplyLanguage(session, reply); // SCRUM-594 (phone test F9): the line follows the model
        // SCRUM-587: the reply has been spoken — one assistant turn on the owner
        // confirmation gate's clock (an error apology or the loop-exhausted
        // fallback is not a read-back, so neither path below counts one).
        if (session.ownerMode) noteAssistantTurnEnd(session);
        const avgChunkLen = sentenceQueue.length > 0
          ? Math.round(sentenceQueue.reduce((s, c) => s + c.length, 0) / sentenceQueue.length)
          : 0;
        const shortChunks = sentenceQueue.filter((c) => c.length < 20).length;
        console.log(`[LLM] (${Date.now() - t0}ms) streamed ${sentenceQueue.length} chunks (avg=${avgChunkLen}ch, short=${shortChunks})`);
        logTranscript("[LLM] reply", reply);
        break;
      }

      // Tool call response — execute tools and loop (no streaming for tool calls)
      if (result.type === "tool_calls") {
        const toolCalls = result.toolCalls;
        console.log(`[LLM] (${Date.now() - t0}ms) Tool calls: ${toolCalls.map((tc) => tc.function.name).join(", ")}`);

        // Add the assistant's tool call message to conversation
        session.messages.push(result.message);
        // SCRUM-594: this response's words are in that message now: an abort
        // from here on has nothing new to record. And on the fast path, what it
        // said before the tool call (clause mode speaks it) is the turn's
        // filler: a canned one after it would say the same thing twice.
        if (fastTurn) {
          fastTurn.chunks = [];
          if (sentenceQueue.length > 0) fillerSentThisTurn = true;
        }

        // Play ONE tool-specific filler — only if no filler was sent yet this turn.
        // SCRUM-594: never in a batch that calls end_call: that response carries
        // the model's goodbye, and a filler ("One moment.", "Let me book that
        // for you.") would follow it. If the guard blocks the end_call, the next
        // round's waiting filler still covers the gap (fillerSentThisTurn stays false).
        const toolNames = toolCalls.map(tc => tc.function.name);
        // SCRUM-594 (F5): nor in a language without canned fillers.
        if (!fillerSentThisTurn && !toolNames.includes("end_call") && fillerMessagesFor(session)) {
          fillerSentThisTurn = true;
          if (!holdStopped) {
            hold.stop();
            holdStopped = true;
          }
          const toolFiller = getToolFiller(typeof session.fastLanguage === "string" ? fastTalkLanguage(session) : session.language || "en", toolNames);
          console.log(`[Filler] "${toolFiller}" (tools: ${toolNames.join(", ")})`);
          ttsChain = ttsChain.then(async () => {
            if (fastTurn?.over) return; // SCRUM-594: not after a barge-in
            await speak(toolFiller, NOT_A_REPLY);
          }).catch((err) => {
            console.error("[Filler] TTS error:", err.message);
          });
        }
        // SCRUM-594: a flush point (spec 4.8.4): this round's words and its filler
        // go out while the tools run.
        if (session.fastPath) ttsChain = ttsChain.then(() => { fastFlush(session); });
        turnTtsChains.push(ttsChain);

        // SCRUM-594: the nudge for an end_call blocked in this batch. A second
        // end_call in the same batch gets it too: asking the guard again would
        // count a nudge the model has not read yet, and let the call end.
        /** @type {string|null} */
        let blockedEndCallMessage = null;

        // Execute each tool call and add results
        for (const toolCall of toolCalls) {
          const fnName = toolCall.function.name;
          let fnArgs = parseToolArgs(toolCall, "ToolCall");

          // SCRUM-587: owner tools bypass the customer guards (see the Gemini
          // site). Parsed args (a bad JSON string arrives as {}); the runner's
          // message AND data go back to the model as the tool message.
          if (session.ownerMode) {
            const ownerRet = await runOwnerToolCall(session, { name: fnName, args: fnArgs }, { executeToolCall, scheduleCache });
            lastOwnerTool = { name: fnName, ret: ownerRet };
            session.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: ownerRet.data !== undefined ? JSON.stringify({ message: ownerRet.message, data: ownerRet.data }) : ownerRet.message,
            });
            // SCRUM-594: an owner's end_call hangs up like a customer's (the
            // customer booking guard below does not apply to owner calls).
            if (ownerRet.__endCall === true) endCall = true;
            continue;
          }

          // SCRUM-594: SCRUM-373's end_call booking guard, as on the Gemini path
          // (lib/end-call-guard.js). A blocked end_call gets the nudge as its
          // result and the model is asked again; an allowed one runs below.
          if (fnName === "end_call") {
            let verdict = blockedEndCallMessage !== null
              ? { allow: false, message: blockedEndCallMessage }
              : checkEndCallGuard(session, fnArgs?.reason);
            // SCRUM-594 PHASE 2 (B5): on the fast path the call also waits for the
            // caller's goodbye — the simulated calls hung up on "that's all correct, thanks".
            if (verdict.allow && session.bookingGuards) {
              const done = checkCallerDone(session);
              if (done && done.allow === false) {
                console.warn(`[BookingGuard] Holding end_call (caller not done, ${done.count}/${done.cap}). callSid=${session.callSid}`);
                verdict = done;
              } else if (done && done.allow === true) {
                noteBookingGuardCap(session, "end_call", "the caller never said goodbye");
              }
            }
            if (!verdict.allow) {
              blockedEndCallMessage = verdict.message;
              session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: verdict.message });
              continue;
            }
          }

          // SCRUM-594 PHASE 2 (B4/B6), the fast path: the CancelGate reads the
          // model's OWN arguments (so a cancel with no identifier is always held);
          // then a reschedule or cancel of a booking THIS call made carries the
          // name it was booked under — the handler would otherwise ask the caller
          // for it (phone test F1: "Sorry?" was heard as "Deville", the move was
          // refused) — and a cancel's phone defaults to caller ID (the handler
          // needs one to find the booking; the caller was asked for the number
          // they were calling from).
          const modelArgs = fnArgs;
          if ((fnName === "cancel_appointment" || fnName === "reschedule_appointment") && session.bookingGuards) {
            const named = withBookedName(fnArgs, session.confirmedBookings, normalizeDatetime);
            if (named !== fnArgs) console.log(`[BookingGuard] ${fnName}: passing the name this call booked under. callSid=${session.callSid}`);
            fnArgs = named;
          }
          if (fnName === "cancel_appointment" && session.bookingGuards) {
            fnArgs = applyCallerIdPhoneFallback(fnName, fnArgs, session.callerPhone, { cancel: true });
          }

          // SCRUM-372: cancel-confirmation gate (classic pipeline — mirrors Gemini path)
          /** @type {{ proceed: boolean, via: string|null, reason: string|null, dropped: number }} */
          const cancelGate = fnName !== "cancel_appointment"
            ? { proceed: true, via: null, reason: null, dropped: 0 }
            : session.bookingGuards
              ? fastCancelGate(session, modelArgs || {}, Date.now())
              : { proceed: session.confirmCancel(fnArgs || {}, Date.now()), via: null, reason: null, dropped: 0 };
          if (cancelGate.dropped > 0) {
            console.log(`[CancelGate] The caller declined — dropped ${cancelGate.dropped} held or confirmed cancel(s) (fast path). callSid=${session.callSid}`);
          }
          if (cancelGate.proceed && cancelGate.via) {
            console.log(`[CancelGate] Proceeding (fast path, via=${cancelGate.via}). callSid=${session.callSid}`);
          }
          if (!cancelGate.proceed) {
            const why = cancelGate.reason ? `fast path, reason=${cancelGate.reason}` : "classic";
            console.warn(`[CancelGate] Holding cancel_appointment pending confirmation (${why}). callSid=${session.callSid}`);
            session.toolCallAudit.push({ name: "cancel_appointment_held", successful: false, at: Date.now() });
            session.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "DO NOT CANCEL YET. Before cancelling, confirm with the caller: read back which appointment would be cancelled (its date and time) and ask them — in their language — to clearly confirm (yes/no). ONLY if they clearly say yes, call cancel_appointment again with the same details. If they say no or you are unsure, do NOT cancel.",
            });
            continue;
          }

          // SCRUM-594 PHASE 2 (B2/B3): the fast path's booking guards — a second
          // booking while this call holds one is redirected to a move (once), and
          // nothing is booked until the surname was spelled back and confirmed.
          if (fnName === "book_appointment" && session.bookingGuards) {
            const guard = checkBookingGuards(session, fnArgs || {}, bookingKey);
            if (guard && guard.hold === true) {
              const count = guard.count ? ` ${guard.count}/${guard.cap}` : "";
              console.warn(`[BookingGuard] Holding book_appointment (${guard.kind}${count}, reason=${guard.reason}). callSid=${session.callSid}`);
              // A redirect to a move is not an unfinished booking: this call's booking stands.
              session.toolCallAudit.push({ name: guard.kind === "second-booking" ? "book_appointment_redirected" : "book_appointment_held", successful: false, at: Date.now() });
              session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: guard.message });
              continue;
            }
            if (guard && guard.hold === false) noteBookingGuardCap(session, "spelling", `the surname spelling was never confirmed (reason=${guard.reason})`);
          }

          // SCRUM-257: rebook intercept (classic pipeline — mirrors Gemini path)
          // SCRUM-557: a re-book with a DIFFERENT surname is a name correction —
          // update the attendee in place instead of blocking (see the Gemini
          // site and lib/rebook-correction.js for the full story).
          if (fnName === "book_appointment" && session.confirmedBookings?.size > 0) {
            const reqKey = bookingKey(fnArgs);
            const existing = session.confirmedBookings.get(reqKey);
            if (existing) {
              const verdict = classifyRebookAttempt(existing, fnArgs);
              if (verdict.kind === "name-correction") {
                console.warn(`[RebookGuard] Name-corrected re-book (classic) — updating attendee in place. callSid=${session.callSid}`);
                let correctionMsg;
                try {
                  const corrected = await executeToolCall("update_appointment_attendee", {
                    datetime: fnArgs.datetime,
                    first_name: fnArgs.first_name,
                    last_name: fnArgs.last_name,
                  }, {
                    organizationId: session.organizationId,
                    assistantId: session.assistantId,
                    callSid: session.callSid,
                    callId: session.callRecordId,
                    sourceType: session.sourceType,
                    organization: session.organization,
                    callerPhone: session.callerPhone,
                  });
                  correctionMsg = typeof corrected === "string" ? corrected : corrected.message;
                } catch (corrErr) {
                  console.error(`[RebookGuard] attendee correction threw (classic): ${corrErr && corrErr.message} callSid=${session.callSid}`);
                  correctionMsg = CORRECTION_ERROR_MESSAGE;
                }
                const classicCorrectionOk = correctionMsg.startsWith("NAME CORRECTED");
                if (session.toolCallAudit) {
                  session.toolCallAudit.push({ name: "book_appointment_corrected", successful: classicCorrectionOk, at: Date.now() });
                }
                if (classicCorrectionOk) {
                  session.confirmedBookings.set(reqKey, {
                    ...existing,
                    name: `${fnArgs.first_name || ""} ${fnArgs.last_name || ""}`.trim(),
                  });
                } else {
                  Sentry.withScope((scope) => {
                    scope.setTag("service", "rebook_guard");
                    scope.setExtras({ callSid: session.callSid, attemptedDatetime: fnArgs.datetime });
                    Sentry.captureMessage("Name-corrected re-book: attendee update FAILED (classic)", "warning");
                  });
                }
                session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: correctionMsg });
                continue;
              }
              console.warn(`[RebookGuard] Blocking duplicate book_appointment (classic) — code=${existing.code} callSid=${session.callSid}`);
              session.messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: DUPLICATE_REBOOK_MESSAGE,
              });
              continue;
            }
          }

          session.rememberDetails(fnName, fnArgs); // SCRUM-506: carry caller details forward this call
          const toolResult = await executeToolCall(fnName, fnArgs, {
            organizationId: session.organizationId,
            collectedDetails: session.getCollectedDetails(), // SCRUM-506
            assistantId: session.assistantId,
            callSid: session.callSid,
            callId: session.callRecordId,
            transferRules: session.transferRules,
            userPhoneNumber: session.userPhoneNumber,
            forwardingStatus: session.forwardingStatus,
            sourceType: session.sourceType,
            transferToForwardedNumber: session.transferToForwardedNumber,
            organization: session.organization,
            callerPhone: session.callerPhone,
            orgPhoneNumber: session.orgPhoneNumber,
            telephonyProvider: session.telephonyProvider || "twilio",
            scheduleSnapshot: session.scheduleSnapshot,
          });

          let resultMessage = typeof toolResult === "string" ? toolResult : toolResult.message;
          console.log(`[ToolCall] ${fnName} result: "${resultMessage.slice(0, 100)}..."`);

          // SCRUM-559: classic pipeline audit parity (mirrors the Gemini site).
          // Without these entries classic calls have EMPTY audits — net-live 0 —
          // and the booking-state monitor would false-page every successful
          // classic booking while post-call phantom detection stays blind.
          if (session.toolCallAudit) {
            let auditSuccessful = !(typeof toolResult === "object" && (toolResult?.error || toolResult?.success === false));
            // SCRUM-594 PHASE 2 (gate re-review): on the fast path a cancel counts only
            // when the handler said so — a transport failure carries no success flag.
            if (session.bookingGuards && fnName === "cancel_appointment" && toolResult?.success !== true) auditSuccessful = false;
            if (auditSuccessful && fnName === "book_appointment") {
              const hasSuccessSignal = /\b(confirmation code|i've booked|you'?re all set|booked your|appointment (?:is|has been) (?:booked|confirmed))\b/i.test(resultMessage);
              if (!hasSuccessSignal) auditSuccessful = false;
            }
            const auditEntry = { name: fnName, successful: auditSuccessful, at: Date.now() };
            if (fnName === "book_appointment") {
              auditEntry.dt = normalizeDatetime(fnArgs?.datetime) || undefined;
              const codeM = resultMessage.match(/\b(\d{6})\b/);
              if (codeM) auditEntry.code = codeM[1];
            } else if (fnName === "reschedule_appointment") {
              auditEntry.dt = normalizeDatetime(fnArgs?.new_datetime) || undefined;
              auditEntry.oldDt = normalizeDatetime(fnArgs?.current_datetime || fnArgs?.current_date) || undefined;
            } else if (fnName === "cancel_appointment") {
              auditEntry.dt = normalizeDatetime(fnArgs?.datetime || fnArgs?.date) || undefined;
              auditEntry.codeArg = String(fnArgs?.confirmation_code || "").trim() || undefined;
            } else if (fnName === "lookup_appointment" && session.bookingGuards && toolResult?.success === true && /^I found (?:your appointment|\d+ upcoming appointments)\b/.test(resultMessage)) {
              auditEntry.found = true; // SCRUM-594 (F4): the caller has a booking — see hasUnfinishedBooking
            }
            session.toolCallAudit.push(auditEntry);
          }

          // SCRUM-257: track confirmed bookings (classic pipeline). SCRUM-594 PHASE 2:
          // on the fast path only a booking the handler confirmed (success === true)
          // — "That practitioner is already booked at this time" is a failure (B3,
          // B6 and the end_call nudge read this ledger)…
          const bookedWords = resultMessage.includes("confirmed") || resultMessage.includes("booked") || resultMessage.includes("confirmation");
          // (gate review 3) and a success that booked nothing — Cliniko's "Before I
          // check availability, what type of appointment…?" — is not a booking either.
          const bookedOk = session.bookingGuards ? toolResult?.success === true && bookedWords : bookedWords;
          if (fnName === "book_appointment" && bookedOk) {
            if (!session.confirmedBookings) session.confirmedBookings = new Map();
            const bookKey = bookingKey(fnArgs);
            const codeMatch = resultMessage.match(/\b(\d{6})\b/);
            session.confirmedBookings.set(bookKey, {
              code: codeMatch?.[1] || "unknown",
              datetime: fnArgs.datetime,
              name: `${fnArgs.first_name || ""} ${fnArgs.last_name || ""}`.trim(),
              practitioner_id: fnArgs.practitioner_id, // SCRUM-557: correction-vs-second-person discriminator
              at: Date.now(),
            });
          }
          // SCRUM-557 (review): authoritative success flag, same reasoning as the
          // Gemini site — the text heuristic nudged on failed cancels.
          const cancelOk = session.bookingGuards
            ? toolResult?.success === true // the fast path: never a transport failure's missing flag (gate re-review)
            : typeof toolResult === "object" && toolResult !== null && typeof toolResult.success === "boolean"
              ? toolResult.success
              : !resultMessage.toLowerCase().includes("error") && !resultMessage.toLowerCase().includes("not found");
          if (fnName === "cancel_appointment" && cancelOk) {
            // SCRUM-594 PHASE 2 (B4): the next cancel needs its own confirmation
            // (on the fast path, another booking's held cancel stands).
            session.clearCancelConfirmation(session.bookingGuards ? modelArgs || {} : undefined);
            if (session.bookingGuards) {
              // SCRUM-594 PHASE 2: the fast path forgets only the cancelled booking
              // (B3 and B6 read the rest), and says when another one still stands.
              const { remaining, clearedAll } = forgetCancelledBooking(session.confirmedBookings, fnArgs, normalizeDatetime);
              if (clearedAll) console.log(`[BookingGuard] A cancel no booking of this call could be matched to — forgot them all. callSid=${session.callSid}`);
              resultMessage += remaining > 0 ? CANCEL_KEPT_NUDGE : CANCEL_NUDGE;
            } else {
              if (session.confirmedBookings) session.confirmedBookings.clear();
              resultMessage += CANCEL_NUDGE; // SCRUM-557: nothing is booked now — say so in the tool result
            }
          }

          // SCRUM-563: move this call's ledger entry on a successful reschedule
          // (classic pipeline — mirrors the Gemini site; see it for the story,
          // including why the fallback requires the positive success signal).
          if (fnName === "reschedule_appointment") {
            const lastAudit = (session.toolCallAudit && session.toolCallAudit[session.toolCallAudit.length - 1]) || {};
            const rescheduleOk =
              typeof toolResult === "object" && toolResult !== null && typeof toolResult.success === "boolean"
                ? toolResult.success
                : lastAudit.successful === true && RESCHEDULE_SUCCESS_SIGNAL.test(resultMessage);
            if (rescheduleOk) {
              const move = applyRescheduleToLedger(session.confirmedBookings, fnArgs, Date.now());
              if (move.moved) {
                console.log(`[RebookGuard] Reschedule moved ledger entry ${move.fromKey} -> ${move.toKey} (classic). callSid=${session.callSid}`);
              } else if (move.ambiguous) {
                console.warn(`[RebookGuard] Reschedule ledger move ambiguous — entries left untouched (classic). callSid=${session.callSid}`);
                Sentry.withScope((scope) => {
                  scope.setTag("service", "rebook_guard");
                  scope.setExtras({ callSid: session.callSid, attemptedDatetime: fnArgs?.current_datetime || fnArgs?.current_date });
                  Sentry.captureMessage("Reschedule ledger move ambiguous — stale entry left (classic)", "warning");
                });
              } else if (session.confirmedBookings?.size > 0) {
                console.log(`[RebookGuard] Reschedule matched no this-call ledger entry (${session.confirmedBookings.size} held, classic). callSid=${session.callSid}`);
              }
              // Reschedule frees the old slot and takes the new one — the
              // snapshot cache is stale on both counts.
              if (session.scheduleSnapshot) {
                scheduleCache.invalidate(session.organizationId);
              }
            }
          }

          // Apply optimistic cache delta for write operations
          if (session.scheduleSnapshot) {
            if (fnName === "book_appointment" && bookedOk) {
              scheduleCache.applyDelta(session.organizationId, "book", {
                appointment: {
                  id: "pending-" + Date.now(),
                  start_time: fnArgs.datetime,
                  duration_minutes: session.serviceTypes?.find((st) => st.id === fnArgs.service_type_id)?.duration_minutes || 30,
                  status: "confirmed",
                },
                dateKey: fnArgs.datetime?.split("T")[0],
                slotTime: fnArgs.datetime,
              });
            }
            if (fnName === "cancel_appointment") {
              scheduleCache.invalidate(session.organizationId);
            }
          }

          // SCRUM-594 PHASE 2 (B6): a name fixed with update_appointment is the name
          // this call's booking now carries — the ledger follows it.
          if (fnName === "update_appointment" && session.bookingGuards && toolResult?.success === true) {
            noteNameCorrection(session.confirmedBookings, fnArgs, normalizeDatetime);
          }

          // Track transfer attempt on session for call metadata
          if (toolResult.transferAttempt) {
            session.transferAttempt = toolResult.transferAttempt;
          }

          // Handle transfer action — announce, save state for fallback, close STT
          if (toolResult.action === "transfer" && toolResult.transferTo) {
            hold.stop();
            await sendTTS(session, twilioWs, resultMessage);
            if (session.fastPath) fastFlush(session); // SCRUM-594: a flush point (spec 4.8.4)
            session.addMessage("assistant", resultMessage);

            // Save session for potential reconnection on no-answer
            session.pendingTransfer = true;
            saveForTransfer(session.callSid, {
              messages: [...session.messages],
              organizationId: session.organizationId,
              assistantId: session.assistantId,
              phoneNumberId: session.phoneNumberId,
              callerPhone: session.callerPhone,
              callRecordId: session.callRecordId,
              calendarEnabled: session.calendarEnabled,
              serviceTypes: session.serviceTypes || [],
              transferRules: session.transferRules,
              userPhoneNumber: session.userPhoneNumber,
              forwardingStatus: session.forwardingStatus,
              sourceType: session.sourceType,
              transferToForwardedNumber: session.transferToForwardedNumber,
              telephonyProvider: session.telephonyProvider,
              deepgramVoice: session.deepgramVoice,
              holdPreset: session.holdPreset,
              organization: session.organization,
              orgPhoneNumber: session.orgPhoneNumber,
              transferAttempt: toolResult.transferAttempt,
              transferTargetName: toolResult.transferTargetName || "the team member",
              allDestinations: toolResult.allDestinations || [],
              destinationIndex: toolResult.destinationIndex || 0,
              startedAt: session.startedAt,
              language: session.language || "en",
              // SCRUM-587: a transferred call is completed by finishTransferredCall
              // (or a reconnect's cleanup), not by this session's cleanup — the
              // PIN-gate stamp must ride along or a locked caller's
              // owner_auth="locked" is lost. (Owner sessions never get here:
              // their tool calls return above, and they have no transfer tool.)
              ownerAuth: session.ownerAuth || null,
              callType: session.ownerMode ? "owner" : null,
            });

            // Close Deepgram — stream will close when Twilio starts <Dial>
            if (session.deepgramWs) {
              session.deepgramWs.close();
              session.deepgramWs = null;
            }
            // Clear any queued speech so drainPending (in finally) is a no-op
            session._pendingTranscript = null;
            return;
          }

          session.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultMessage,
          });
          // SCRUM-594: the executor's end_call sentinel. Classic used to ignore
          // it, so the model kept talking and the line stayed open. The rest of
          // the batch still runs; the call ends after it.
          if (toolResult.__endCall === true) endCall = true;
        }

        if (endCall) {
          // SCRUM-594: no further LLM call. The caller last hears this
          // response's own words; when it said nothing, a short goodbye.
          if (fastTurn) fastTurn.ending = true; // a barge-in leaves the goodbye alone
          if (holdPlaying) hold.stop();
          await Promise.all(turnTtsChains); // every earlier round's audio goes out first
          reply = sentenceQueue.join(" ");
          if (!reply) {
            reply = getErrorMsg(callLanguage(session), "goodbye");
            try {
              await speak(reply);
            } catch (err) {
              console.error(`[EndCall] Goodbye TTS failed — hanging up without it (callSid=${session.callSid}):`, err.message);
            }
          }
          break;
        }

        // Continue loop — LLM will process tool results
        continue;
      }
    }

    if (!reply) {
      hold.stop();
      reply = getErrorMsg(callLanguage(session), "repeatRequest");
      console.warn(`[Pipeline] Tool call loop exhausted after ${maxToolIterations} iterations (callSid=${session.callSid})`);
      // SCRUM-587 (SF5): an owner never hears "could you repeat that?" — after
      // a change it invites a duplicate request — but the last tool's own words.
      if (session.ownerMode) reply = ownerToolLoopReply(session, lastOwnerTool);
      await sendTTS(session, twilioWs, reply, undefined, NOT_A_REPLY);
      if (session.fastPath) fastFlush(session); // SCRUM-594: a flush point (spec 4.8.4)
    }

    session.addMessage("assistant", reply);

    // SCRUM-594: recorded above BEFORE the close — cleanup reads the transcript
    // as soon as the socket closes.
    if (endCall) {
      await hangUpAfterEndCall(session, twilioWs, playbackEndsAt);
      return;
    }

    // Detect what input the AI is expecting next and adapt buffering
    const nextInputType = detectExpectedInput(reply);
    session.setExpectedInputType(nextInputType);
    if (nextInputType !== "general") {
      console.log(`[InputDetect] Next expected: ${nextInputType}`);
    }
  } catch (err) {
    // SCRUM-594 (spec 4.8.7): a barge-in ended the fast turn. No apology, the
    // caller's words stay, and so does what the AI had already said.
    if (fastTurn?.ctl.signal.aborted) {
      if (holdPlaying) hold.stop();
      recordAbortedFastTurn(session, fastTurn);
      return;
    }
    hold.stop();
    const errorSource = err.message?.includes("OpenAI") ? "llm"
      : err.message?.includes("Deepgram TTS") ? "tts"
      : "unknown";
    console.error(`[Pipeline] ${errorSource} error (callSid=${session.callSid}):`, err);
    // SCRUM-594 (gate H1): a fast turn that fails (Claude: a bad key or model, overload,
    // timeouts) pages, instead of every turn quietly apologising.
    if (fastTurn && errorSource !== "tts") noteFastTurnFailure(session, err);
    // Remove the user message that never got a reply
    if (session.messages.length > 0 && session.messages[session.messages.length - 1].role === "user") {
      session.messages.pop();
    }
    try {
      await sendTTS(session, twilioWs, getErrorMsg(callLanguage(session), "troubleRepeat"), undefined, NOT_A_REPLY);
      if (session.fastPath) fastFlush(session); // SCRUM-594: a flush point (spec 4.8.4)
    } catch (ttsErr) {
      console.error("[Pipeline] Failed to send error message to caller:", ttsErr);
    }
  } finally {
    if (fastTurn) endFastTurn(session, fastTurn);
    session.isProcessing = false;
    session.drainPending((text) => handleUserSpeech(session, twilioWs, text));
  }
}

/**
 * SCRUM-594: end a classic call after an allowed end_call, once the turn's
 * speech has played. Twilio plays the media we push in real time, and closing
 * the media stream ends the call (<Connect><Stream>), so closing at once would
 * cut the goodbye off.
 *
 * The playback wait is `session.awaitPlaybackEnd()` when the session sets it,
 * otherwise until `playbackEndsAt`. The fast path sets the hook because its
 * streaming player needs its own flush/mark sequence to know its audio is out.
 * Either way the wait is capped at END_CALL_PLAYBACK_CAP_MS, then
 * END_CALL_TAIL_MS more before the close. Never throws.
 *
 * @param {CallSession} session
 * @param {WebSocket} twilioWs - the Twilio media-stream socket
 * @param {number} playbackEndsAt - when (Date.now() ms) the audio sent to TTS this turn finishes playing
 * @returns {Promise<void>}
 */
async function hangUpAfterEndCall(session, twilioWs, playbackEndsAt) {
  // Stamped before the wait: a caller who hangs up over the goodbye still
  // ended a call the AI was ending (cleanup reads this when the socket closes).
  session.endedReason = "end_call_tool";
  const startedAt = Date.now();
  let played = false;
  if (typeof session.awaitPlaybackEnd === "function") {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let capTimer;
    try {
      await Promise.race([
        session.awaitPlaybackEnd(),
        new Promise((resolve) => { capTimer = setTimeout(resolve, END_CALL_PLAYBACK_CAP_MS); }),
      ]);
      played = true;
    } catch (err) {
      console.warn(`[EndCall] Playback signal failed — waiting out the estimate instead (callSid=${session.callSid}): ${err?.message || err}`);
    } finally {
      clearTimeout(capTimer);
    }
  }
  const remainingMs = played ? 0 : Math.min(playbackEndsAt, startedAt + END_CALL_PLAYBACK_CAP_MS) - Date.now();
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
  await new Promise((resolve) => setTimeout(resolve, END_CALL_TAIL_MS));
  // Whatever the caller said over the goodbye is not answered: handleUserSpeech's
  // finally would otherwise dispatch it (drainPending) as the call closes.
  session._pendingTranscript = null;
  console.log(`[EndCall] Hanging up after end_call — waited ${Date.now() - startedAt}ms for playback (callSid=${session.callSid})`);
  try {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, "end_call");
  } catch (err) {
    console.warn(`[EndCall] Error closing the Twilio stream (callSid=${session.callSid}):`, err);
  }
}

/**
 * Synthesize text and stream mulaw chunks back to Twilio.
 */
// Strip markdown formatting that LLMs sometimes include (bold, headers, etc.)
function stripMarkdown(text) {
  let clean = text
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1") // *, **, *** → content (handles bold, italic, bold-italic)
    .replace(/^#{1,6}\s+/gm, "")              // ### headers → text
    .replace(/`([^`]+)`/g, "$1")              // `code` → code
    .replace(/~~([^~]+)~~/g, "$1")            // ~~strikethrough~~ → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // [link](url) → link
    .replace(/^[-*]\s+/gm, "")                // - bullet items → text
    .replace(/^\d+\.\s+/gm, "")               // 1. numbered items → text
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{200D}\u{20E3}]/gu, ""); // strip emojis
  clean = clean.trim();
  return clean || text.trim(); // fallback to original if stripping removed everything
}

/**
 * @param {any} session
 * @param {WebSocket} twilioWs
 * @param {string} text
 * @param {() => boolean} [isStale] - SCRUM-594: the fast turn checks this after
 *   REST synthesis, before any frame goes out (a barge-in during synthesis)
 * @param {{ reply?: boolean }} [kind] - SCRUM-594 gate H1: NOT_A_REPLY (a filler, an apology) is not the turn's latency
 * @returns {Promise<number>} the audio's playback ms (an estimate on the Aura stream)
 */
async function sendTTS(session, twilioWs, text, isStale, kind) {
  // SCRUM-594 (spec 4.8.3): the fast path speaks on its Aura stream while that
  // is open; REST otherwise, as on every other call.
  if (session?.fastTts?.isOpen()) return speakFast(session, text, kind);
  // Gate H2: what a failed Aura stream never voiced is said first.
  if (session?.fastState?.respeak) await session.fastState.respeak;
  return sendRestTTS(session, twilioWs, text, isStale);
}

/** SCRUM-594 gate H1: a filler or an apology, not the reply: kept out of the turn's latency. */
const NOT_A_REPLY = Object.freeze({ reply: false });

/**
 * REST TTS: synthesize the whole text, then send its frames and a "tts-done" mark.
 * @param {any} session
 * @param {WebSocket} twilioWs
 * @param {string} text
 * @param {() => boolean} [isStale] - true after synthesis: nothing is sent (SCRUM-594)
 * @returns {Promise<number>} the audio's playback ms (0 when nothing was sent because it went stale)
 */
async function sendRestTTS(session, twilioWs, text, isStale, options = {}) {
  const t0 = Date.now();
  // SCRUM-594 (F5): the speech guard — but a legal disclosure is spoken verbatim (security review).
  // Phone test F9: each sentence in its own language's voice (fastSpeech).
  const speech = options.verbatim ? { text, voice: session?.deepgramVoice || null } : fastSpeech(session, text);
  const cleanText = stripMarkdown(speech.text);
  if (!cleanText) return 0; // SCRUM-594 (F5): a second unspeakable sentence in the same turn says nothing
  // SCRUM-594 (phone test F4): only the words sent to TTS (harmless for classic too).
  const voice = speech.voice || undefined; // the voice THIS request used
  let audioBuffer;
  let spokenText = cleanText;
  try {
    audioBuffer = await synthesizeSpeech(DEEPGRAM_API_KEY, spellLettersForTts(cleanText), { voice });
  } catch (err) {
    // Gate review (F5): a language's voice the service refuses (a 4xx: not a timeout, 408, 429
    // or 5xx) would leave every later sentence in that language silent. That voice is given
    // up on for the call (noteFastVoiceFailed), and this sentence is said again, through the
    // speech guard, in the assistant's own voice.
    const status = Number(/Deepgram TTS error (\d{3})/.exec(String(err?.message || ""))?.[1]);
    const refused = status >= 400 && status < 500 && status !== 408 && status !== 429;
    if (!session?.fastState || !session.baseDeepgramVoice || !voice || voice === session.baseDeepgramVoice || !refused) throw err;
    noteFastVoiceFailed(session, voice, "aura-rest", `REST TTS refused the voice ${voice}`, err);
    // What this request was saying, through the guard again (the apology stays the apology).
    const again = options.verbatim ? { text: cleanText, voice: session.baseDeepgramVoice } : fastSpeech(session, cleanText);
    spokenText = stripMarkdown(again.text);
    if (!spokenText) return 0;
    audioBuffer = await synthesizeSpeech(DEEPGRAM_API_KEY, spellLettersForTts(spokenText), { voice: again.voice || undefined });
  }
  console.log(`[TTS] (${Date.now() - t0}ms) ${audioBuffer.length} bytes`);
  // SCRUM-594: the fast turn this was for was barged in on while it synthesised.
  if (isStale?.()) return 0;

  const chunks = chunkAudioForTwilio(audioBuffer);
  session.isSpeaking = true;
  // Safety timeout: reset isSpeaking even if the mark event is lost (prevents permanent echo suppression)
  clearTimeout(session._speakingTimeout);
  session._speakingTimeout = setTimeout(() => { if (session) session.isSpeaking = false; }, 20000);

  for (const chunk of chunks) {
    if (twilioWs.readyState !== WebSocket.OPEN) break;
    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: chunk },
      })
    );
  }

  // Mark end of TTS so we know when playback completes
  if (twilioWs.readyState === WebSocket.OPEN) {
    twilioWs.send(
      JSON.stringify({
        event: "mark",
        streamSid: session.streamSid,
        mark: { name: "tts-done" },
      })
    );
    // SCRUM-594 (R12d′): REST audio on the fast path (after an Aura fallback):
    // the echo filter hears its words, and isSpeaking holds until its mark is back.
    if (session?.fastState) noteFastRestSpeech(session, spokenText, audioBuffer.length / 8);
  }

  // Playback duration in ms (8kHz mulaw = 8 bytes/ms). Chunks are pushed
  // into the WS immediately, but Twilio plays them in real time — callers
  // that close the stream early must wait this long or the tail is cut off
  // (SCRUM-424: the setup-timeout apology was truncated mid-sentence by a
  // fixed 2s close).
  return audioBuffer.length / 8;
}

/**
 * SCRUM-594 (phone test F4): Aura drops letters of a hyphenated spelling ("M-A-K-H-O-U-L"
 * was voiced "m a k h o"); with commas it says every one. Only the text sent to TTS is
 * rewritten: a run of 2 or more single letters joined by hyphens becomes the letters
 * joined by ", ". Words with longer parts ("co-op", "re-book"), digits ("9-5",
 * "0414-141-883") and mixed runs are left alone.
 * @param {string} text
 * @returns {string}
 */
function spellLettersForTts(text) {
  return text.replace(/\b[A-Za-z](?:-[A-Za-z])+\b/g, (run) => run.split("-").join(", "));
}

/**
 * Send clear event to flush Twilio's audio buffer (barge-in).
 * @param {any} session
 * @param {WebSocket} twilioWs
 * @returns {boolean} whether anything was cleared: classic always is (on an open stream); the fast path keeps the recording disclosure
 */
function sendClear(session, twilioWs) {
  if (twilioWs.readyState !== WebSocket.OPEN) return false;
  if (session.fastPlayer) {
    // SCRUM-594 (spec 4.8.5): the fast path stops its player (which sends the
    // Twilio clear) and the Aura stream too; never the recording disclosure (R12d′).
    if (!stopFastAudio(session)) {
      console.log("[FastPath] Kept the recording disclosure playing (no clear)");
      return false;
    }
  } else {
    twilioWs.send(
      JSON.stringify({
        event: "clear",
        streamSid: session.streamSid,
      })
    );
  }
  console.log("[Barge-in] Cleared Twilio audio buffer");
  return true;
}

/**
 * Start playing subtle hold audio in a loop while the AI processes.
 * Returns a stop function. Audio is sent as Twilio media events (production)
 * or raw binary (test calls).
 *
 * @param {CallSession} session
 * @param {WebSocket} ws - Twilio WS or browser WS
 * @param {"twilio"|"browser"} mode
 * @returns {{ stop: () => void }}
 */
function startHoldAudio(session, ws, mode) {
  // Generate 2 seconds of hold audio to loop
  const holdBuf = generateHoldAudio(2000, session.holdPreset || "neutral");
  if (!holdBuf) return { stop: () => {} }; // silent preset

  let stopped = false;
  let timer = null;

  function sendLoop() {
    if (stopped || ws.readyState !== WebSocket.OPEN) return;

    try {
      if (mode === "twilio") {
        const chunks = chunkAudioForTwilio(holdBuf);
        for (const chunk of chunks) {
          if (stopped || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            event: "media",
            streamSid: session.streamSid,
            media: { payload: chunk },
          }));
        }
      } else {
        // Browser test call — send raw binary
        if (!stopped && ws.readyState === WebSocket.OPEN) {
          ws.send(holdBuf);
        }
      }
    } catch (err) {
      console.error("[HoldAudio] Error sending hold audio:", err.message);
      stopped = true;
      return;
    }

    // Loop every 2 seconds
    if (!stopped) {
      timer = setTimeout(sendLoop, 2000);
    }
  }

  sendLoop();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Clear any queued hold audio from Twilio buffer
      if (mode === "twilio") {
        sendClear(session, ws);
      }
    },
  };
}

// ── Fast classic pipeline (SCRUM-594, spec 4.8) ──────────────────────────────
// The demo line's DEMO_LINE_PIPELINE=classic-fast variant of the classic
// handler. Flux and its turn engine hear the caller (instead of Nova and the
// debounce buffer), and the Aura WebSocket stream speaks through a player that
// tracks Twilio's marks (instead of a REST request per sentence). Every part
// degrades to today's component on failure: Flux to Nova, the stream to REST.
// The clients report failures through callbacks; this section logs them and
// captures them with a `service` tag (never a reason tag).

/**
 * Write one message to the Twilio media stream. A stream that is no longer
 * open drops it (the caller is gone), so this never throws for that.
 * @param {WebSocket} twilioWs
 * @param {object} message
 */
function sendTwilioJson(twilioWs, message) {
  if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(message));
}

/**
 * Report a fast-path failure to Sentry, tagged with the service that failed.
 * The caller logs its own line. No caller words: `what` is ours.
 * @param {CallSession} session
 * @param {string} service - "flux-stt" | "aura-stream" | "fast-turns"
 * @param {string} what
 * @param {unknown} err
 */
function captureFastFailure(session, service, what, err, level) {
  const error = err instanceof Error ? err : new Error(String(err));
  Sentry.withScope((scope) => {
    scope.setTag("service", service);
    if (level) scope.setLevel(level);
    scope.setExtras({ callSid: session.callSid, organizationId: session.organizationId, what });
    Sentry.captureException(error);
  });
}

/**
 * SCRUM-594 gate H1: a fast turn failed (an apology instead of a reply). Each one is
 * counted ([FastCall] llm_errors, calls.metadata.fastPath) and reported: the first of
 * a run at warning level, the second in a row and on at error level, which pages.
 * @param {CallSession} session
 * @param {unknown} err
 */
function noteFastTurnFailure(session, err) {
  const stats = session.fastStats || (session.fastStats = newFastCallStats());
  stats.llmErrors += 1;
  stats.llmErrorStreak += 1;
  const level = stats.llmErrorStreak >= 2 ? "error" : "warning";
  captureFastFailure(session, "claude-chat", `fast turn failed (${stats.llmErrorStreak} in a row)`, err, level);
}

/** @returns {import("./call-session").FastPathState} */
function newFastPathState() {
  return {
    speakingText: "",
    unmarked: false,
    unflushed: false,
    pendingFlushSeq: null,
    flushedSeq: -1,
    flushWaiters: [],
    quietWaiters: [],
    quietTimer: null,
    fluxOpenTimer: null,
    ttsFellBack: false,
    flushRefusalLogged: false,
    flushRefused: false,
    flushSentAt: 0,
    flushWatchdog: null,
    lastAudioAt: 0,
    markSeq: 0,
    presumedIdle: false,
    lostMarkLogged: false,
    restMarks: 0,
    restPlaybackEndsAt: 0,
    restTimer: null,
    disclosureActive: false,
    disclosureTimer: null,
    fluxWatchdog: null,
    auraSentChars: 0,
    auraReceivedMs: 0,
    questionAudioStartAt: null,
    bargeInDeclined: null,
    twilioWs: null,
    auraSegments: [],
    auraHeardSinceFlushedMs: 0,
    respeak: null,
    clearCount: 0,
    auraOpenTimer: null,
    noTurnWatchdog: null,
    fluxFallBack: null,
    repromptTimer: null,
    repromptedQuestion: null,
    repromptAwaitingAudio: null,
    noTurnMode: "log",
    noTurnLogged: false,
    notReplyOwed: false,
    notReplyFlushSeq: null,
    closed: false,
  };
}

/** @returns {import("./call-session").FastCallStats} */
function newFastCallStats() {
  return {
    turns: 0, specAdopted: 0, specDiscarded: 0, eotToAudioMs: [], eager: null, pending: null, current: null,
    llmErrors: 0, llmErrorStreak: 0, draftsInCall: 0, draftTurnIndex: null, draftsForTurn: 0, draftCapLogged: false,
  };
}

/**
 * Spec 4.8.1: start the fast path's STT and TTS at the top of the classic
 * block, instead of Nova. The Aura stream and its player open beside Flux, and
 * each half degrades on its own: the STT to Nova with today's callbacks
 * (`openClassicStt`), the TTS to REST.
 *
 * @param {CallSession} session
 * @param {WebSocket} twilioWs
 * @param {() => void} openClassicStt - opens Nova-3 with today's callbacks into session.deepgramWs
 */
function startFastPath(session, twilioWs, openClassicStt) {
  session.fastState = newFastPathState();
  session.fastState.twilioWs = twilioWs;
  session.fastStats = newFastCallStats();
  // The end_call hang-up waits on this instead of its sendTTS estimate.
  session.awaitPlaybackEnd = () => awaitFastPlaybackEnd(session);
  console.log(`[FastPath] Flux STT and the Aura stream on ${FAST_DEEPGRAM_HOST} (callSid=${session.callSid})`);
  try {
    openFastTts(session, twilioWs);
  } catch (err) {
    fallBackToRestTts(session, "setup failed", err);
  }
  try {
    openFastStt(session, twilioWs, openClassicStt);
  } catch (err) {
    fallBackToNova(session, twilioWs, openClassicStt, "setup failed", err);
  }
}

/**
 * The Aura streams (spec 4.2; phone test F9: one per voice, services/aura-router.js)
 * and the player that carries their audio to Twilio (spec 4.3). Warnings are logged
 * only: CLEARED_TIMEOUT is the client's own backstop doing its job, EXCESSIVE_FLUSH a
 * refused flush, VOICE_CLOSED an idle voice's stream that opens again for its next sentence (all tolerated).
 * @param {CallSession} session
 * @param {WebSocket} twilioWs
 */
function openFastTts(session, twilioWs) {
  session.fastPlayer = createFastPlayer({ sendJson: (message) => sendTwilioJson(twilioWs, message), streamSid: session.streamSid });
  session.fastTts = createAuraRouter(DEEPGRAM_API_KEY, {
    voice: session.deepgramVoice || undefined,
    host: FAST_DEEPGRAM_HOST,
    openStream: openAuraStream,
    openTimeoutMs: AURA_VOICE_OPEN_TIMEOUT_MS,
    quietMs: FAST_AUDIO_QUIET_MS,
    handoverWaitMs: FAST_FLUSHED_WAIT_MS,
    // Each voice's audio is boosted for that voice (phone test F9).
    onAudio: (audio, voice) => onFastAudio(session, audio, voice),
    onFlushed: (seq) => onFastFlushed(session, seq),
    onWarning: (warning) => {
      console.warn(`[FastPath] Aura warning ${warning.code || "-"} (${warning.voice}): ${String(warning.message).slice(0, 120)} (callSid=${session.callSid})`);
    },
    onError: (err) => fallBackToRestTts(session, "stream error", err),
    onClose: (code, reason, info) => {
      if (info.initiatedByUs) return;
      fallBackToRestTts(session, `stream closed (${code})`, new Error(`Aura stream closed unexpectedly: ${code} ${String(reason).slice(0, 80)}`));
    },
    onVoiceFailed: (voice, err) => noteFastVoiceFailed(session, voice, "aura-stream", `Aura voice ${voice} did not open`, err),
    // Security review: what waited for that voice goes through the speech guard again (kana → the apology).
    rerouteText: (text) => fastSpeech(session, text).text,
  });
  // Gate M3: a stream that never opens (no error, no close) must not go unnoticed.
  const state = session.fastState;
  const tts = session.fastTts;
  if (!state || !tts) return;
  state.auraOpenTimer = setTimeout(() => {
    state.auraOpenTimer = null;
    if (!state.closed && session.fastTts === tts && !tts.isOpen()) {
      fallBackToRestTts(session, `no open within ${AURA_OPEN_TIMEOUT_MS} ms`, new Error(`Aura stream did not open within ${AURA_OPEN_TIMEOUT_MS} ms`));
    }
  }, AURA_OPEN_TIMEOUT_MS);
  tts.ready.then(
    () => {
      if (state.auraOpenTimer) clearTimeout(state.auraOpenTimer);
      state.auraOpenTimer = null;
      if (!state.closed && session.fastTts === tts) console.log(`[FastPath] Aura connected (callSid=${session.callSid})`);
    },
    () => {}, // a stream that fails to open reports through onError/onClose
  );
}

/**
 * Spec 4.8.3: the Aura stream failed. The rest of the call speaks over REST
 * (sendTTS's classic path): one log line and one capture, however many errors
 * and closes follow. The hang-up goes back to its sendTTS estimate.
 * @param {CallSession} session
 * @param {string} reason - for the log, never caller words
 * @param {unknown} err
 */
function fallBackToRestTts(session, reason, err) {
  const state = session.fastState;
  if (!state || state.closed || state.ttsFellBack) return;
  state.ttsFellBack = true;
  const tts = session.fastTts;
  if (tts) state.voicesUsed = tts.voicesUsed(); // for the [FastCall] line
  session.fastTts = null;
  session.awaitPlaybackEnd = null;
  if (state.auraOpenTimer) clearTimeout(state.auraOpenTimer);
  state.auraOpenTimer = null;
  // Gate H2: what the stream was given and never voiced is said again over REST.
  const unvoiced = fastUnvoicedText(state);
  state.auraSegments = [];
  state.auraHeardSinceFlushedMs = 0;
  state.notReplyOwed = false;
  state.notReplyFlushSeq = null;
  // Nothing more will come from it.
  state.unflushed = false;
  state.flushRefused = false;
  state.pendingFlushSeq = null;
  if (state.flushWatchdog) clearTimeout(state.flushWatchdog);
  state.flushWatchdog = null;
  for (const waiter of [...state.flushWaiters]) waiter.done();
  if (tts) {
    try {
      tts.close();
    } catch (closeErr) {
      console.warn(`[FastPath] Closing the failed Aura stream threw (callSid=${session.callSid}): ${closeErr.message}`);
    }
  }
  console.warn(`[FastPath] Aura stream unavailable — falling back to REST TTS (${reason}, callSid=${session.callSid})`);
  captureFastFailure(session, "aura-stream", `Aura stream unavailable: ${reason}`, err);
  if (unvoiced) respeakFastUnvoiced(session, unvoiced);
}

/**
 * SCRUM-594 (phone test F5): the line moves to another language. Flux Multilingual's
 * hints follow it (a Configure, no reconnect). Phone test F9: the voices stay on their
 * streams (services/aura-router.js) — the line's voice is only the one for sentences
 * whose words don't say their language — and the new language's stream opens now,
 * before its first sentence. Until F9 the rest of the call spoke over REST: every
 * reply 4-4.5 s late.
 * @param {CallSession} session
 * @param {{ from?: string, to?: string, voice?: string, hints?: string[] }} sw - planLanguageSwitch's result
 * @returns {boolean} false when the hearing can't follow: the line stays where it is
 */
function switchFastLanguageStreams(session, sw) {
  const stt = session.deepgramWs;
  const hearing = session.fastPath === true && Boolean(stt) && typeof stt.configure === "function";
  if (sw.to !== "en") {
    // Gate review: no switch the hearing can't follow — the model would speak Spanish to a
    // recogniser still listening for English.
    if (!hearing) {
      console.warn(`[FastPath] Language ${sw.to} not switched: ${session.fastPath === "degraded-stt" ? "Nova (the Flux fallback) only hears English" : "no Flux stream"} (callSid=${session.callSid})`);
      return false;
    }
    if (!stt.configure({ language_hints: sw.hints })) {
      console.warn(`[FastPath] Language ${sw.to} not switched: Flux is not open (callSid=${session.callSid})`);
      return false;
    }
  } else if (hearing) {
    stt.configure({ language_hints: sw.hints }); // back to English: best effort (Nova hears English anyway)
  }
  session.deepgramVoice = sw.voice;
  if (sw.voice) session.fastTts?.prepare(sw.voice);
  console.log(`[FastPath] Language ${sw.from} → ${sw.to}, voice ${sw.voice} (callSid=${session.callSid})`);
  return true;
}

/**
 * Gate review: the call can't go on in its language — Flux refused the hints, Flux fell
 * back to Nova (English only), or the language's voice failed. Back to English (the hints
 * when Flux still hears, the assistant's own voice), and the model is told what to say.
 * @param {CallSession} session
 * @param {string} why - for the log, never caller words
 * @returns {boolean} whether the call was in another language
 */
function revertFastLanguageToEnglish(session, why) {
  if (typeof session.fastLanguage !== "string" || session.fastLanguage === "en") return false;
  const plan = planLanguageSwitch(session, "en");
  if (!plan.changed) return false;
  // Phone test F9: the line never follows the model back into it (followReplyLanguage).
  session.fastBlockedLanguages = [...(session.fastBlockedLanguages || []), plan.from];
  const stt = session.deepgramWs;
  if (session.fastPath === true && stt && typeof stt.configure === "function") stt.configure({ language_hints: plan.hints });
  session.deepgramVoice = plan.voice || session.deepgramVoice;
  recordLanguageSwitch(session, plan);
  console.warn(`[FastPath] Back to English: ${why} (callSid=${session.callSid})`);
  session.addMessage("system", LANGUAGE_STOPPED_NOTE);
  return true;
}

/** The model's note when the call can't go on in the caller's language. */
const LANGUAGE_STOPPED_NOTE = "The line can only continue in English now: the caller's language stopped working. Tell the caller, in English, that you can only continue in English, and offer to have someone call them back.";

/**
 * Gate H2: the text a failed Aura stream was given and, as far as its audio tells, never
 * voiced: the segments since its last Flushed, less those the audio received since then
 * covers (FAST_RESPEAK_MS_PER_CHAR, a slow rate: in doubt a sentence is said again).
 * @param {import("./call-session").FastPathState} state
 * @returns {string}
 */
function fastUnvoicedText(state) {
  let heardMs = state.auraHeardSinceFlushedMs;
  const owed = [];
  for (const segment of state.auraSegments) {
    const ms = segment.text.length * FAST_RESPEAK_MS_PER_CHAR;
    if (owed.length === 0 && heardMs >= ms) {
      heardMs -= ms;
      continue;
    }
    owed.push(segment.text);
  }
  return owed.join(" ").trim();
}

/**
 * Gate H2: say over REST what the Aura stream never voiced, ahead of anything else the
 * call says over REST (sendTTS waits for it). A barge-in while it synthesises stops it.
 * When it cannot be said (the stream is closing, or REST fails too), the next turn is
 * told the caller did not hear it.
 * @param {CallSession} session
 * @param {string} text
 */
function respeakFastUnvoiced(session, text) {
  const state = session.fastState;
  if (!state) return;
  const ws = state.twilioWs;
  const note = () => session.addMessage("system", "The caller did not hear your last reply; repeat the key point briefly.");
  if (!ws || ws.readyState !== WebSocket.OPEN || state.closed) {
    note();
    return;
  }
  const clears = state.clearCount;
  console.log(`[FastPath] Saying again over REST the ${text.length} characters the Aura stream never voiced (callSid=${session.callSid})`);
  state.respeak = sendRestTTS(session, /** @type {any} */ (ws), text, () => state.closed || state.clearCount !== clears)
    .then(
      () => {},
      (err) => {
        console.error(`[FastPath] Saying the unvoiced reply again failed (callSid=${session.callSid}): ${err?.message || err}`);
        note();
      },
    )
    .finally(() => {
      state.respeak = null;
    });
}

/**
 * Flux with the turn engine on its events (spec 4.1, 4.6, 4.8.1): a fresh
 * engine for this connection, reset again when it opens. Flux must open within
 * FLUX_OPEN_TIMEOUT_MS; an error, or a close we did not ask for, before or
 * after that, hands the call to Nova.
 * @param {CallSession} session
 * @param {WebSocket} twilioWs
 * @param {() => void} openClassicStt
 */
function openFastStt(session, twilioWs, openClassicStt) {
  const state = /** @type {import("./call-session").FastPathState} */ (session.fastState);
  const config = fluxConfigFromEnv();
  const engine = createFastTurnEngine({
    getState: () => fastTurnState(session),
    actions: fastTurnActions(session, twilioWs),
    // FLUX_EAGER_EOT_THRESHOLD=off asks Flux for no EagerEndOfTurn: no drafts.
    speculationEnabled: config.eagerEotThreshold !== null,
  });
  session.fastTurns = engine;
  let opened = false;
  /** @type {(reason: string, err: unknown, options?: { callerSpoke?: boolean, captureLevel?: string }) => void} */
  const fallBack = (reason, err, options) => fallBackToNova(session, twilioWs, openClassicStt, reason, err, options);
  state.fluxFallBack = fallBack;
  state.noTurnWatchdog = createNoTurnWatchdog();
  state.noTurnMode = noTurnWatchdogMode();
  session.deepgramWs = openFluxStream(DEEPGRAM_API_KEY, {
    onOpen: () => {
      opened = true;
      if (state.fluxOpenTimer) clearTimeout(state.fluxOpenTimer);
      state.fluxOpenTimer = null;
      engine.reset(); // turn indexes start again at 0 on a new connection
      startFluxWatchdog(session, fallBack);
      console.log(`[FastPath] Flux connected (callSid=${session.callSid})`);
    },
    // R14″: when each event arrived (the engine reads the turn's start from it).
    onTurnInfo: (evt) => {
      state.noTurnWatchdog?.onTurn(); // gate M4b: Flux hears the caller
      if (evt?.event === "StartOfTurn") cancelFastReprompt(session); // gate M5 (ii)
      engine.onTurnInfo({ ...evt, receivedAt: Date.now() });
    },
    onError: (err) => fallBack(opened ? "error" : "error before open", err),
    onClose: (code, reason, info) => {
      if (info.initiatedByUs) return;
      fallBack(opened ? `closed mid-call (${code})` : `closed before open (${code})`, new Error(`Flux closed unexpectedly: ${code} ${String(reason).slice(0, 80)}`));
    },
    onWarning: (warning) => {
      console.warn(`[FastPath] Flux ${warning.type} ${warning.code || "-"}: ${String(warning.message).slice(0, 120)} (callSid=${session.callSid})`);
      // Gate review: the only Configure the fast path sends is a language switch's hints.
      if (warning.type === "ConfigureFailure" && revertFastLanguageToEnglish(session, "Flux refused the language hints")) {
        captureFastFailure(session, "flux-stt", "Flux refused the language hints", new Error(`Flux ConfigureFailure ${warning.code || ""}`.trim()));
      }
    },
  }, {
    host: FAST_DEEPGRAM_HOST,
    industry: session.organization?.industry,
    ...config,
    // SCRUM-594 (F5): with languages on, Flux Multilingual hinted to English (as accurate as the
    // English model when locked to one language); the line's moves move the hints (no reconnect).
    ...(session.fastLanguages ? { model: FLUX_MULTI_MODEL, languageHints: ["en"] } : {}),
  });
  state.fluxOpenTimer = setTimeout(() => {
    state.fluxOpenTimer = null;
    if (!opened) fallBack(`no open within ${FLUX_OPEN_TIMEOUT_MS} ms`, new Error(`Flux did not open within ${FLUX_OPEN_TIMEOUT_MS} ms`));
  }, FLUX_OPEN_TIMEOUT_MS);
}

/**
 * Spec 4.8.1: Flux cannot serve the call. Open Nova with today's callbacks
 * and mark the call degraded: the Aura stream stays, and turns now come
 * through Nova and the debounce buffer. Once per call, and never after
 * cleanup or once the Twilio stream is going away.
 * @param {CallSession} session
 * @param {WebSocket} twilioWs
 * @param {() => void} openClassicStt
 * @param {string} reason - for the log, never caller words
 * @param {unknown} err
 * @param {{ callerSpoke?: boolean, captureLevel?: string }} [options] - callerSpoke: the caller was
 *   talking (gate M4b): ask them to say it again; captureLevel: the capture's Sentry level (default error)
 */
function fallBackToNova(session, twilioWs, openClassicStt, reason, err, options) {
  const state = session.fastState;
  if (session.fastPath !== true || !state || state.closed || twilioWs.readyState !== WebSocket.OPEN) return;
  // Gate M4a: the turn Flux had open (the caller mid-sentence) is not lost with it, unless
  // the engine would have dropped it (gate N4): a backchannel while the AI is busy, or the
  // AI's own words coming back while it speaks.
  const open = session.fastTurns?.openTurn() ?? null;
  const aiSpeaking = fastPlayerPlaying(session) || session.isSpeaking;
  const openIsNoTurn = Boolean(open?.transcript) && (
    ((aiSpeaking || session.isProcessing) && isBackchannel(open?.transcript))
    || (aiSpeaking && isLikelyEcho(open?.transcript, state.speakingText))
  );
  cancelFastReprompt(session); // gate N1: no re-prompt on the Nova path
  session.fastPath = "degraded-stt";
  revertFastLanguageToEnglish(session, "Flux fell back to Nova, which hears English only"); // gate review (F5)
  state.fluxFallBack = null;
  state.noTurnWatchdog = null;
  if (state.fluxOpenTimer) clearTimeout(state.fluxOpenTimer);
  state.fluxOpenTimer = null;
  if (state.fluxWatchdog) clearInterval(state.fluxWatchdog);
  state.fluxWatchdog = null;
  const flux = session.deepgramWs;
  session.deepgramWs = null;
  session.fastTurns = null;
  dropFastDraft(session, "stt-fallback"); // Nova turns never adopt one
  if (flux) {
    try {
      flux.close();
    } catch (closeErr) {
      console.warn(`[FastPath] Closing Flux threw (callSid=${session.callSid}): ${closeErr.message}`);
    }
  }
  console.warn(`[FastPath] Flux unavailable — falling back to Nova (${reason}, callSid=${session.callSid})`);
  captureFastFailure(session, "flux-stt", `Flux unavailable: ${reason}`, err, options?.captureLevel);
  openClassicStt();
  if (open?.transcript && openIsNoTurn) {
    logTranscript("[STT] Dropped (a backchannel or echo Flux left open)", open.transcript);
  } else if (open?.transcript) {
    console.log(`[FastPath] Answering the turn Flux left open (callSid=${session.callSid})`);
    commitFastTurn(session, twilioWs, open.transcript, open.turnIndex, "stt-fallback");
  } else if ((open || options?.callerSpoke) && !session.isProcessing && !fastAudioBusy(session)) {
    // The caller was talking and none of it reached us: ask, rather than leave them in silence.
    const again = getErrorMsg(callLanguage(session), "sayAgain");
    console.log(`[FastPath] Asking the caller to say it again after the Flux fallback (callSid=${session.callSid})`);
    session.addMessage("assistant", again);
    sendTTS(session, twilioWs, again, undefined, NOT_A_REPLY).then(
      () => { if (session.fastPath) fastFlush(session); },
      (ttsErr) => console.error(`[FastPath] Asking the caller to say it again failed (callSid=${session.callSid}): ${ttsErr?.message || ttsErr}`),
    );
  }
}

/**
 * What the turn engine reads on every Flux event (spec 4.6). aiSpeaking is the
 * player OR session.isSpeaking, which covers the REST greeting and disclosure;
 * processing never counts a draft. aiRemainingMs (R14′) is the player's audio
 * still to play; REST audio is not in the player, so while it plays that is
 * unknown (null).
 * @param {CallSession} session
 * @returns {import("./lib/fast-turns").FastTurnState}
 */
function fastTurnState(session) {
  return {
    aiSpeaking: fastPlayerPlaying(session) || session.isSpeaking,
    processing: session.isProcessing,
    expectedInputType: session._expectedInputType,
    aiSpeakingText: session.fastState?.speakingText ?? "",
    aiRemainingMs: fastRestPlaying(session) ? null : (session.fastPlayer?.remainingMs(Date.now()) ?? null),
    questionAudioStartAt: session.fastState?.questionAudioStartAt ?? null,
  };
}

/**
 * The turn engine's actions (spec 4.6). Each one catches its own errors: one
 * thrown back into the engine would reach Flux's onError, and that hands the
 * call to Nova for nothing.
 * @param {CallSession} session
 * @param {WebSocket} twilioWs
 * @returns {import("./lib/fast-turns").FastTurnActions}
 */
function fastTurnActions(session, twilioWs) {
  /**
   * @param {string} name
   * @param {(...args: any[]) => any} action
   * @returns {(...args: any[]) => any} what the action returned (undefined when it threw)
   */
  const guarded = (name, action) => (...args) => {
    try {
      return action(...args);
    } catch (err) {
      console.error(`[FastTurn] ${name} failed (callSid=${session.callSid}): ${err?.message || err}`);
      captureFastFailure(session, "fast-turns", `turn action ${name} failed`, err);
    }
  };
  return {
    speculate: guarded("speculate", (transcript, turnIndex) => startFastDraft(session, transcript, turnIndex)),
    cancelSpeculation: guarded("cancelSpeculation", (reason) => dropFastDraft(session, reason)),
    commit: guarded("commit", (transcript, turnIndex, trigger) => commitFastTurn(session, twilioWs, transcript, turnIndex, trigger)),
    bargeIn: guarded("bargeIn", () => fastBargeIn(session)),
    dropEcho: guarded("dropEcho", (transcript, reason) => logTranscript(FAST_DROP_LABELS[reason], transcript)),
    bufferStructured: guarded("bufferStructured", (transcript) => bufferFastTurn(session, twilioWs, transcript)),
  };
}

/** What the turn engine's dropEcho(transcript, reason) logs, by reason (no caller words: logTranscript). */
const FAST_DROP_LABELS = {
  "echo-like": "[STT] Dropped (echo-like: the AI's own words coming back)",
  backchannel: "[STT] Dropped (backchannel while the AI is busy)",
};

/**
 * Spec 4.5: start a draft reply on Flux's EagerEndOfTurn, replacing any the
 * session still holds. The draft reads the conversation and never writes it,
 * and never runs a tool; it is asked with the turn's own tools and model, so
 * the turn can adopt its result.
 * @param {CallSession} session
 * @param {string} transcript
 * @param {number} turnIndex
 */
function startFastDraft(session, transcript, turnIndex) {
  dropFastDraft(session, "replaced");
  // Gate B: each draft is an LLM call. A turn that keeps resuming, or a call that runs
  // long, stops drafting: its turns are answered live, as without speculation.
  const stats = session.fastStats || (session.fastStats = newFastCallStats());
  if (stats.draftTurnIndex !== turnIndex) {
    stats.draftTurnIndex = turnIndex;
    stats.draftsForTurn = 0;
  }
  if (stats.draftsForTurn >= FAST_DRAFTS_PER_TURN || stats.draftsInCall >= FAST_DRAFTS_PER_CALL) {
    if (!stats.draftCapLogged) {
      stats.draftCapLogged = true;
      console.log(`[FastTurn] Draft cap reached (${stats.draftsForTurn} for this turn, ${stats.draftsInCall} in the call) — answering live (callSid=${session.callSid})`);
    }
    return;
  }
  stats.draftsForTurn += 1;
  stats.draftsInCall += 1;
  session.speculation = startSpeculativeReply({
    llm: streamClaudeResponse,
    messages: session.messages,
    transcript,
    llmOptions: { ...buildLLMOptions(session, { includeTransfer: true }), model: FAST_LLM_MODEL },
    turnKey: turnIndex,
  });
  if (session.fastStats) session.fastStats.eager = { turnIndex, at: Date.now() };
}

/**
 * Abort the session's draft, if it holds one (spec 4.5: resumed, a new turn,
 * echo, structured input, a commit for other words, barge-in, cleanup).
 * @param {CallSession} session
 * @param {string} reason
 */
function dropFastDraft(session, reason) {
  const draft = session.speculation;
  if (!draft) return;
  session.speculation = null;
  draft.abort(reason);
  if (session.fastStats) session.fastStats.specDiscarded += 1;
}

/**
 * A turn's latency record, stamped as it goes ([FastTurn]).
 * @param {string} trigger
 * @param {number|null} eagerAt
 * @returns {import("./call-session").FastTurnRecord}
 */
function newFastTurnRecord(trigger, eagerAt) {
  return { eotAt: Date.now(), trigger, eagerAt, drafted: eagerAt !== null, spec: "none", llmAt: null, speakAt: null, audioAt: null, queued: false, waitedMs: 0, logged: false };
}

/**
 * A Flux turn is over: answer it, or queue it behind the turn in flight
 * (CallSession.queueOrProcess). A draft for other words, or another turn, can
 * never be adopted: it is aborted now. One for these words waits for the turn,
 * which makes the final call (isAdoptable, before the user message is added).
 * @param {CallSession} session
 * @param {WebSocket} twilioWs
 * @param {string} transcript
 * @param {number} turnIndex
 * @param {string|null} trigger
 */
function commitFastTurn(session, twilioWs, transcript, turnIndex, trigger) {
  cancelFastReprompt(session);
  if (session.fastState) session.fastState.repromptedQuestion = null;
  const stats = session.fastStats;
  const eager = stats?.eager && stats.eager.turnIndex === turnIndex ? stats.eager : null;
  if (stats) {
    stats.pending = newFastTurnRecord(trigger || "model", eager ? eager.at : null);
    // Gate C5: committed behind a turn in flight, it waits in the queue (its waited= says how long).
    stats.pending.queued = session.isProcessing;
  }
  const draft = session.speculation;
  if (draft && (draft.turnKey !== turnIndex || draft.transcript !== transcript)) dropFastDraft(session, "other words");
  logTranscript("[STT] Final", transcript);
  session.queueOrProcess(transcript, (text) => handleUserSpeech(session, twilioWs, text, "general"));
}

/**
 * A final while structured input is expected (a phone number, a spelled name):
 * through the classic debounce buffer, which merges what Flux splits into turns.
 * @param {CallSession} session
 * @param {WebSocket} twilioWs
 * @param {string} transcript
 */
function bufferFastTurn(session, twilioWs, transcript) {
  cancelFastReprompt(session);
  // The turn's clock starts at the caller's last piece, so the debounce counts.
  if (session.fastStats) session.fastStats.pending = newFastTurnRecord("buffered", null);
  logTranscript("[STT] Final", transcript);
  session.bufferTranscript(transcript, (combined, inputType) => {
    logTranscript("[STT] Buffered", combined);
    // Gate C5 (phone test F8 review): flushed behind a turn in flight, it waits in the queue too
    // (its waited= runs from the caller's last piece, the debounce included).
    if (session.fastStats?.pending) session.fastStats.pending.queued = session.isProcessing;
    session.queueOrProcess(combined, (text) => handleUserSpeech(session, twilioWs, text, inputType));
  }, { wholeTurn: true }); // Flux's model ended this turn; a Nova final can stop mid-sentence
}

/**
 * Spec 4.8.8: the caller talks over the AI. Its audio stops (the player and
 * Aura), the turn in flight is aborted (never mid-tool: the turn checks before
 * its next LLM round) and so is any draft, adopted or not. A turn that is
 * ending the call keeps its goodbye: what the caller says over it would not be
 * answered anyway (the hang-up drops it).
 * @param {CallSession} session
 * @returns {boolean} false when declined (the disclosure plays, or the call is ending): the turn may barge in later
 */
function fastBargeIn(session) {
  const turn = session.currentTurn;
  const state = session.fastState;
  // Declined (false): the turn engine leaves the turn free to barge in later, e.g. over
  // the greeting once the disclosure has played. Each reason is logged once in a row:
  // a caller talking over the disclosure asks on every Update.
  const decline = (/** @type {string} */ reason) => {
    if (state && state.bargeInDeclined !== reason) {
      state.bargeInDeclined = reason;
      console.log(`[Barge-in] (fast) ignored — ${reason} (callSid=${session.callSid})`);
    }
    return false;
  };
  if (state?.disclosureActive) return decline("the recording disclosure is playing");
  if (turn?.ending) return decline("the AI is ending the call");
  if (state) state.bargeInDeclined = null;
  stopFastAudio(session);
  turn?.abort("barge-in");
  dropFastDraft(session, "barge-in");
  console.log(`[Barge-in] (fast) Stopped the AI's audio${turn ? " and its reply" : ""} (callSid=${session.callSid})`);
  return true;
}

/**
 * Spec 4.8.7: open the fast path's turn in handleUserSpeech, BEFORE the user
 * message is added: a draft is adopted only if it answers this very
 * conversation (the same messages array, at the same length) and these very
 * words (isAdoptable). Any other draft is aborted. The turn is exposed as
 * session.currentTurn so a barge-in can abort it.
 * @param {CallSession} session
 * @param {string} transcript - what the turn answers
 * @returns {import("./call-session").FastTurn}
 */
function beginFastTurn(session, transcript) {
  const stats = session.fastStats || (session.fastStats = newFastCallStats());
  // The turn before ended without audio (aborted, an error, REST): its line now.
  if (stats.current && !stats.current.logged) logFastTurn(session, stats.current);
  // A Nova turn (after a fallback) or a drained queue has no Flux commit: its clock starts here.
  const record = stats.pending || newFastTurnRecord("buffered", null);
  stats.pending = null;
  if (record.queued) record.waitedMs += Math.max(0, Date.now() - record.eotAt);
  stats.current = record;
  stats.turns += 1;
  /** @type {import("./lib/speculative-reply").SpeculativeReply|null} */
  let draft = session.speculation;
  session.speculation = null;
  if (draft && draft.isAdoptable(session.messages, transcript)) {
    record.spec = "adopted";
    stats.specAdopted += 1;
  } else {
    if (draft) {
      draft.abort("not adoptable");
      stats.specDiscarded += 1;
    }
    if (record.drafted) record.spec = "discarded";
    draft = null;
  }
  const ctl = new AbortController();
  /** @type {import("./call-session").FastTurn} */
  const turn = {
    ctl,
    draft,
    record,
    chunks: [],
    ending: false,
    over: false,
    abortReason: null,
    abort(reason = "abort") {
      turn.over = true;
      if (!ctl.signal.aborted) {
        turn.abortReason = reason;
        ctl.abort(fastAbortError(reason));
      }
      turn.draft?.abort(reason); // an adopted draft streams on its own signal
    },
  };
  session.currentTurn = turn;
  return turn;
}

/**
 * An AbortError naming why the turn was stopped.
 * @param {string} [reason]
 * @returns {Error}
 */
function fastAbortError(reason) {
  return Object.assign(new Error(`fast turn aborted: ${reason || "abort"}`), { name: "AbortError" });
}

/**
 * Spec 4.8.7: the top of each round of the fast turn's tool loop. A barge-in
 * that came while the last round's tools ran ends the turn here, never during
 * a tool, and the round's chunks start afresh.
 * @param {import("./call-session").FastTurn} turn
 * @param {string[]} chunks - the round's sentence queue
 */
function startFastRound(turn, chunks) {
  if (turn.ctl.signal.aborted) throw fastAbortError("barge-in");
  turn.chunks = chunks;
}

/**
 * Spec 4.8.7: the fast path's LLM response for one round: in round 0 the
 * adopted draft (its buffered chunks replay through onSentence at once), else
 * a live Claude call with clause chunking on the turn's signal. A signal
 * replaces claude-chat's own 15 s timeout, so the turn's carries one too.
 * @param {CallSession} session
 * @param {import("./call-session").FastTurn} turn
 * @param {number} round
 * @param {Record<string, any>} llmOptions
 * @param {(sentence: string) => void} onSentence
 * @returns {Promise<any>} { type: "content" } or { type: "tool_calls" }; rejects with an AbortError when the turn was aborted
 */
async function fastLlmResponse(session, turn, round, llmOptions, onSentence) {
  const result = round === 0 && turn.draft
    ? await turn.draft.adopt(onSentence)
    : await streamClaudeResponse(session.messages, {
      ...llmOptions,
      onSentence,
      chunking: "clause",
      signal: AbortSignal.any([turn.ctl.signal, AbortSignal.timeout(FAST_LLM_TIMEOUT_MS)]),
      model: FAST_LLM_MODEL,
    });
  if (result.type === "aborted") throw fastAbortError("draft aborted");
  return result;
}

/**
 * The LLM's first output for the fast turn (eot_to_llm): its first text, or a
 * tool call that came with none.
 * @param {import("./call-session").FastTurn} turn
 */
function noteFastLlmOutput(turn) {
  if (turn.record.llmAt === null) turn.record.llmAt = Date.now();
}

/**
 * Spec 4.8.7: a barge-in ended the turn. No apology, and the caller's words
 * stay. What the LLM response in flight had already sent to TTS is recorded,
 * plus "…", so the next turn knows what the caller heard. A response that had
 * said nothing records nothing (its round's tool_use / tool_result messages
 * are already in the conversation).
 * @param {CallSession} session
 * @param {import("./call-session").FastTurn} turn
 */
function recordAbortedFastTurn(session, turn) {
  const heard = turn.chunks.join(" ").trim();
  if (heard) session.addMessage("assistant", `${heard}…`);
  console.log(`[FastTurn] Reply stopped (${turn.abortReason || "abort"}) — ${heard ? "kept what was said" : "nothing was said yet"} (callSid=${session.callSid})`);
}

/**
 * The fast turn is over (finally): no more fillers or chunks from it, and the
 * session's abort handle is cleared.
 * @param {CallSession} session
 * @param {import("./call-session").FastTurn} turn
 */
function endFastTurn(session, turn) {
  turn.over = true;
  if (session.currentTurn === turn) session.currentTurn = null;
}

/**
 * Spec 4.8.9: one committed turn's latency line, once. No words: ids, times
 * and enums only. eot_to_llm runs to the reply's first text, eot_to_audio to
 * its first audio handed to the player, eager_lead from the EagerEndOfTurn
 * whose draft the turn could adopt to the EndOfTurn.
 * @param {CallSession} session
 * @param {import("./call-session").FastTurnRecord} record
 */
function logFastTurn(session, record) {
  if (record.logged) return;
  record.logged = true;
  /** @type {(from: number|null, to: number|null) => string} */
  const span = (from, to) => (from === null || to === null ? "-" : String(Math.max(0, Math.round(to - from))));
  // Gate C5: a turn that waited (in the queue, or for the AI's audio) measured that wait, not
  // the pipeline: logged, but no p50/p90 sample.
  if (record.audioAt !== null && record.waitedMs === 0 && session.fastStats) session.fastStats.eotToAudioMs.push(Math.max(0, record.audioAt - record.eotAt));
  console.log(`[FastTurn] callSid=${session.callSid} trigger=${record.trigger} spec=${record.spec} eot_to_llm=${span(record.eotAt, record.llmAt)} eot_to_audio=${span(record.eotAt, record.audioAt)} eager_lead=${span(record.eagerAt, record.eotAt)} waited=${Math.round(record.waitedMs)}`);
}

/**
 * Spec 4.8.9: the call's [FastCall] line at cleanup, and the same summary for
 * calls.metadata.fastPath.
 * @param {CallSession} session
 * @returns {{ turns: number, eotToAudioP50: number|null, eotToAudioP90: number|null, specAdopted: number, specDiscarded: number, llmErrors: number, stt: "flux"|"nova-fallback", tts: "stream"|"rest-fallback", languages?: string[], voices?: string[] }}
 */
function summarizeFastCall(session) {
  const stats = session.fastStats || newFastCallStats();
  if (stats.current && !stats.current.logged) logFastTurn(session, stats.current);
  const samples = [...stats.eotToAudioMs].sort((a, b) => a - b);
  /** @type {(p: number) => number|null} the nearest-rank percentile */
  const percentile = (p) => (samples.length === 0 ? null : Math.round(samples[Math.ceil((p / 100) * samples.length) - 1]));
  const voices = session.fastTts?.voicesUsed() || session.fastState?.voicesUsed || [];
  // Phone test F9: listed when any voice besides the assistant's own spoke.
  const otherVoices = voices.some((voice) => voice !== (session.baseDeepgramVoice || session.deepgramVoice));
  const summary = {
    turns: stats.turns,
    eotToAudioP50: percentile(50),
    eotToAudioP90: percentile(90),
    specAdopted: stats.specAdopted,
    specDiscarded: stats.specDiscarded,
    llmErrors: stats.llmErrors,
    stt: /** @type {"flux"|"nova-fallback"} */ (session.fastPath === "degraded-stt" ? "nova-fallback" : "flux"),
    tts: /** @type {"stream"|"rest-fallback"} */ (session.fastState?.ttsFellBack ? "rest-fallback" : "stream"),
    // SCRUM-594 (F5): the languages a call used besides English (retranscribe leaves such calls alone).
    ...(Array.isArray(session.languagesUsed) && session.languagesUsed.length > 1 ? { languages: [...session.languagesUsed] } : {}),
    ...(otherVoices ? { voices } : {}),
  };
  console.log(`[FastCall] callSid=${session.callSid} turns=${summary.turns} eot_to_audio_p50=${summary.eotToAudioP50 ?? "-"} p90=${summary.eotToAudioP90 ?? "-"} spec_adopted=${summary.specAdopted} spec_discarded=${summary.specDiscarded} llm_errors=${summary.llmErrors} stt=${summary.stt} tts=${summary.tts}${otherVoices ? ` voices=${voices.join(",")}` : ""}`);
  return summary;
}

/**
 * SCRUM-594 (phone test F5): a fast-path voice is never handed letters it can't
 * say (the F5 Arabic reply came out as letters). The first such sentence in a
 * caller turn becomes the apology, and the model is told; later ones in the same
 * turn say nothing. Phone test F9: and each sentence is said in its own language's
 * voice (sentenceVoice). Calls off the fast path (no fastLanguage) are untouched.
 * @param {any} session
 * @param {string} text
 * @returns {{ text: string, voice: string|null }} what to speak ("" for nothing), and in which voice (null: the assistant's own)
 */
function fastSpeech(session, text) {
  if (typeof session?.fastLanguage !== "string") return { text, voice: session?.deepgramVoice || null };
  const { language, voice } = sentenceVoice(session, text);
  // The assistant's own voice reads Latin script only, Japanese text included when Japanese's voice failed.
  if (!unspeakableText(text, voice === (session.baseDeepgramVoice || null) ? "en" : language)) return { text, voice };
  const turn = (session.fullTranscriptMessages || []).filter((/** @type {{ role: string }} */ m) => m.role === "user").length;
  if (session.unspeakableTurn === turn) return { text: "", voice };
  session.unspeakableTurn = turn;
  console.warn(`[FastPath] Replaced a reply this voice can't speak (language ${language}, callSid=${session.callSid})`);
  session.addMessage("system", "The caller did not hear your last reply: it was in a language or script this line can't speak, so they heard an apology instead. Answer in a language this line speaks.");
  return { text: UNSPEAKABLE_APOLOGY, voice: session.baseDeepgramVoice || null };
}

/**
 * SCRUM-594 (phone test F9): a language's voice failed (its stream never opened, or REST
 * refused it). It is given up on for the call — its sentences go to the assistant's voice
 * (sentenceVoice) — and captured once. A line in that language goes back to English, and
 * the model is told (revertFastLanguageToEnglish).
 * @param {CallSession} session
 * @param {string} voice
 * @param {string} service - "aura-stream" | "aura-rest"
 * @param {string} what - for the capture, never caller words
 * @param {unknown} err
 */
function noteFastVoiceFailed(session, voice, service, what, err) {
  if (session.fastFailedVoices?.includes(voice)) return;
  session.fastFailedVoices = [...(session.fastFailedVoices || []), voice];
  console.warn(`[FastPath] The voice ${voice} failed: its sentences go to the assistant's voice (callSid=${session.callSid})`);
  captureFastFailure(session, service, what, err);
  const code = Object.keys(FAST_LANGUAGES).find((c) => FAST_LANGUAGES[c].voice === voice);
  if (!code || session.fastBlockedLanguages?.includes(code)) return;
  if (session.fastLanguage === code) {
    revertFastLanguageToEnglish(session, what); // the line, and the model told
    return;
  }
  // The line never follows the model into it; the model is told when the caller is speaking it.
  session.fastBlockedLanguages = [...(session.fastBlockedLanguages || []), code];
  if (session.fastTurnLanguage === code || session.fastReplyLanguage === code) session.addMessage("system", LANGUAGE_STOPPED_NOTE);
}

/**
 * Spec 4.8.3: speak on the Aura stream. The text goes out at once, with a
 * trailing space, so Aura releases each finished sentence without waiting for
 * a flush (the next flush point releases the rest).
 * @param {CallSession} session
 * @param {string} text
 * @param {{ reply?: boolean }} [kind] - NOT_A_REPLY: a filler or an apology, kept out of the turn's latency (gate H1)
 * @returns {number} estimated playback ms (FAST_TTS_MS_PER_CHAR per character); 0 when nothing was sent
 */
function speakFast(session, text, kind) {
  const speech = fastSpeech(session, text);
  const clean = stripMarkdown(speech.text);
  const state = session.fastState;
  // Phone test F4: Aura drops letters of a hyphenated spelling; the echo filter, the
  // transcript and the segments keep `clean`. Phone test F9: in the sentence's own voice.
  if (!clean || !state || !session.fastTts?.speak(spellLettersForTts(clean), speech.voice)) return 0;
  cancelFastReprompt(session); // the AI is talking again
  if (endsWithQuestion(clean)) noteFastQuestion(session, clean);
  state.auraSentChars += clean.length;
  state.auraSegments.push({ text: clean, seq: null }); // gate H2: owed until its Flushed
  state.speakingText = state.speakingText ? `${state.speakingText} ${clean}` : clean;
  state.unflushed = true;
  const record = session.fastStats?.current;
  if (record && record.speakAt === null && kind?.reply !== false) record.speakAt = Date.now();
  if (kind?.reply === false) {
    state.notReplyOwed = true; // gate N5: its audio is not the reply's
    state.notReplyFlushSeq = null;
  }
  return clean.length * FAST_TTS_MS_PER_CHAR;
}

/**
 * Spec 4.8.4: flush the Aura stream at a flush point. A refusal (the client's
 * budget of 18 a minute) is tolerated: finished sentences are released by
 * their trailing space anyway, and the audio-quiet timer ends the utterance.
 * Never throws.
 * @param {CallSession} session
 * @returns {number|null} the sequence id of the Flushed to expect; null when refused or not streaming
 */
function fastFlush(session) {
  const state = session.fastState;
  const tts = session.fastTts;
  if (!state || state.closed || !tts?.isOpen()) return null;
  let seq = null;
  try {
    seq = tts.flush();
  } catch (err) {
    console.warn(`[FastPath] Aura flush threw (callSid=${session.callSid}): ${err.message}`);
    // As a refusal: no Flushed will answer for this text; it stays owed until Aura goes quiet.
    state.flushRefused = true;
    armFastQuietTimer(session);
    return null;
  }
  if (seq === null) {
    if (!state.flushRefusalLogged) {
      state.flushRefusalLogged = true;
      console.warn(`[FastPath] Aura flush refused (${tts.flushesInLastMinute()} in the last minute) — relying on sentence release (callSid=${session.callSid})`);
    }
    // No Flushed will answer for this text: it stays owed until Aura goes quiet.
    state.flushRefused = true;
    armFastQuietTimer(session);
    return null;
  }
  state.unflushed = false;
  state.flushRefused = false;
  state.pendingFlushSeq = seq;
  for (const segment of state.auraSegments) if (segment.seq === null) segment.seq = seq;
  if (state.notReplyOwed && state.notReplyFlushSeq === null) state.notReplyFlushSeq = seq;
  state.flushSentAt = Date.now();
  armFastFlushWatchdog(session, FAST_FLUSH_WATCHDOG_MS);
  return seq;
}

/**
 * Minor 6: a flush whose Flushed is FAST_FLUSH_WATCHDOG_MS overdue, with no Aura
 * audio in that time either, means a stuck stream: REST for the rest of the call.
 * Audio still arriving (a long reply) pushes the deadline on.
 * @param {CallSession} session
 * @param {number} delayMs
 */
function armFastFlushWatchdog(session, delayMs) {
  const state = session.fastState;
  if (!state || state.closed) return;
  if (state.flushWatchdog) clearTimeout(state.flushWatchdog);
  state.flushWatchdog = setTimeout(() => {
    state.flushWatchdog = null;
    if (state.closed || state.pendingFlushSeq === null || !session.fastTts) return;
    const quietMs = Date.now() - Math.max(state.lastAudioAt, state.flushSentAt);
    if (quietMs < FAST_FLUSH_WATCHDOG_MS) {
      armFastFlushWatchdog(session, FAST_FLUSH_WATCHDOG_MS - quietMs);
      return;
    }
    fallBackToRestTts(session, `no Flushed and no audio for ${quietMs} ms`, new Error(`Aura stream stuck: no Flushed and no audio for ${quietMs} ms after a flush`));
  }, delayMs);
}

/**
 * Aura audio for the caller: through the player to Twilio.
 * @param {CallSession} session
 * @param {Buffer} audio
 * @param {string} [voice] - the stream's voice
 */
function onFastAudio(session, audio, voice) {
  const state = session.fastState;
  if (!state || state.closed || !session.fastPlayer) return;
  session.fastPlayer.push(boostAura(audio, voice)); // phone tests F7/F9: Aura is quieter than line level, by voice (lib/aura-gain.js)
  session.isSpeaking = true;
  state.unmarked = true;
  state.presumedIdle = false;
  state.lastAudioAt = Date.now();
  state.auraReceivedMs += audio.length / 8; // 8 kHz mulaw: 8 bytes a ms
  state.auraHeardSinceFlushedMs += audio.length / 8;
  armFastQuietTimer(session);
  if (state.repromptAwaitingAudio) {
    session.addMessage("assistant", state.repromptAwaitingAudio); // gate N1: it is being heard
    state.repromptAwaitingAudio = null;
  }
  // The turn's first audio: its [FastTurn] line has everything now. Gate N5: not while a
  // filler's or an apology's audio may still be arriving (it comes before the reply's).
  const record = session.fastStats?.current;
  if (record && record.speakAt !== null && record.audioAt === null && !state.notReplyOwed) {
    record.audioAt = Date.now();
    logFastTurn(session, record);
  }
}

/**
 * Aura finished the audio of one flush: the player marks it (spec 4.3), and
 * whoever waits for that flush (the hang-up) goes on.
 * @param {CallSession} session
 * @param {number|null} seq
 */
function onFastFlushed(session, seq) {
  const state = session.fastState;
  if (!state || state.closed) return;
  if (state.unmarked) endFastUtterance(session);
  const done = Number.isInteger(seq) ? /** @type {number} */ (seq) : state.pendingFlushSeq;
  if (done !== null) state.flushedSeq = Math.max(state.flushedSeq, done);
  // Gate H2: Aura sends a Flushed after the audio of the text before it: that text is voiced.
  state.auraSegments = state.auraSegments.filter((segment) => segment.seq === null || segment.seq > state.flushedSeq);
  state.auraHeardSinceFlushedMs = 0;
  // Gate N5: and a filler's or an apology's audio has all arrived.
  if (state.notReplyFlushSeq !== null && state.flushedSeq >= state.notReplyFlushSeq) {
    state.notReplyOwed = false;
    state.notReplyFlushSeq = null;
  }
  if (state.pendingFlushSeq !== null && state.flushedSeq >= state.pendingFlushSeq) {
    state.pendingFlushSeq = null;
    if (state.flushWatchdog) clearTimeout(state.flushWatchdog);
    state.flushWatchdog = null;
  }
  for (const waiter of [...state.flushWaiters]) {
    if (waiter.seq <= state.flushedSeq) waiter.done();
  }
  // A Flushed may come back after the player's last mark: once nothing plays
  // and Aura owes nothing, the echo filter's text starts afresh then.
  refreshFastSpeaking(session);
}

/**
 * The player marks what it has sent; Twilio echoes the mark once it has played.
 * Minor 3, the lost-mark backstop: if the latest mark is still out
 * FAST_LOST_MARK_MS past the audio's estimated end (the player's byte
 * estimate), that audio counts as played (logged once per call). Classic has
 * a 20 s backstop for its tts-done.
 * @param {CallSession} session
 */
function endFastUtterance(session) {
  const player = session.fastPlayer;
  const state = session.fastState;
  if (!player || !state) return;
  player.endUtterance();
  state.unmarked = false;
  state.markSeq += 1;
  const mark = state.markSeq;
  player.whenIdle(FAST_LOST_MARK_MS).then(() => {
    if (state.closed || state.markSeq !== mark || state.unmarked || state.presumedIdle || !player.isPlaying()) return;
    state.presumedIdle = true;
    noteLostMark(session, "player");
    refreshFastSpeaking(session);
  });
}

/**
 * @param {CallSession} session
 * @param {string} what
 */
function noteLostMark(session, what) {
  const state = session.fastState;
  if (!state || state.lostMarkLogged) return;
  state.lostMarkLogged = true;
  console.warn(`[FastPath] A playback mark (${what}) never came back — treating that audio as played (callSid=${session.callSid})`);
}

/**
 * The player has audio out that Twilio has not played yet (its marks), unless a
 * lost mark made us give up on it.
 * @param {CallSession} session
 * @returns {boolean}
 */
function fastPlayerPlaying(session) {
  return Boolean(session.fastPlayer?.isPlaying()) && !session.fastState?.presumedIdle;
}

/**
 * REST audio (the greeting, the disclosure, sendTTS after an Aura fallback) not
 * yet played: its tts-done marks are not all back. Lost marks are given up on
 * FAST_LOST_MARK_MS past its estimated end.
 * @param {CallSession} session
 * @returns {boolean}
 */
function fastRestPlaying(session) {
  const state = session.fastState;
  if (!state || state.restMarks === 0) return false;
  if (Date.now() > state.restPlaybackEndsAt + FAST_LOST_MARK_MS) {
    state.restMarks = 0;
    noteLostMark(session, "tts-done");
    return false;
  }
  return true;
}

/**
 * The IMPORTANT fix of the Task 5 review: Aura may still send audio for text it
 * was given (not flushed yet, or flushed and its Flushed not back). "The player
 * is idle" does not say that: a reply sent to Aura has no audio for its first
 * ~50-100 ms.
 * @param {import("./call-session").FastPathState|null} state
 * @returns {boolean}
 */
function fastAuraOwes(state) {
  return !!state && (state.unflushed || state.pendingFlushSeq !== null);
}

/**
 * isSpeaking on the fast path: the player's audio, or REST audio, still playing.
 * Once nothing plays and Aura owes nothing, the echo filter's text starts afresh.
 * @param {CallSession} session
 */
function refreshFastSpeaking(session) {
  const state = session.fastState;
  session.isSpeaking = fastPlayerPlaying(session) || fastRestPlaying(session);
  if (state && !session.isSpeaking && !fastAuraOwes(state)) {
    if (state.speakingText) onFastAiIdle(session); // the AI has just finished what it said
    clearFastSpeakingText(state);
  }
}

/**
 * Gate M4b: the caller's audio, as it goes to Flux. Speech energy with no Flux turn
 * event for long enough (lib/no-turn-watchdog.js) means Flux cannot hear this caller,
 * e.g. another language: Nova takes over (one log, one flux-stt capture) and the
 * caller is asked to say it again. Audio is counted only while the AI is silent.
 * @param {CallSession} session
 * @param {Buffer} audio - mulaw, as Twilio sent it
 */
function noteFastInboundAudio(session, audio) {
  const state = session.fastState;
  const watchdog = state?.noTurnWatchdog;
  if (!state || !watchdog || state.closed || session.fastPath !== true) return;
  // Gate N2: nothing counts while the AI speaks (its echo) or works (hold audio, thinking).
  const aiBusy = fastPlayerPlaying(session) || session.isSpeaking || session.isProcessing;
  if (!watchdog.onAudio(audio, Date.now(), aiBusy)) return;
  const err = new Error("Flux reported no turns for the caller's speech (a language it does not transcribe?)");
  if (state.noTurnMode === "act") {
    // A false trip (a noisy line) must not page: the fallback is captured at warning level.
    state.fluxFallBack?.("speech but no turns", err, { callerSpoke: true, captureLevel: "warning" });
    return;
  }
  if (state.noTurnLogged) return;
  state.noTurnLogged = true;
  console.warn(`[FastPath] no-turn watchdog would fall back (speech but no turns) — log only, NO_TURN_WATCHDOG=act to act (callSid=${session.callSid})`);
  captureFastFailure(session, "flux-stt", "no-turn watchdog would fall back (speech but no turns)", err, "warning");
}

/** Gate N2: NO_TURN_WATCHDOG values already reported as not recognised (once each). */
const warnedNoTurnModes = new Set();

/**
 * Gate N2: what a no-turn watchdog trip does, from NO_TURN_WATCHDOG, read when the fast
 * path starts: "log" (the default: log and capture at warning level, once a call) or
 * "act" (hand the call to Nova). Anything else warns once and logs.
 * @param {string|undefined} [raw]
 * @returns {"log"|"act"}
 */
function noTurnWatchdogMode(raw = process.env.NO_TURN_WATCHDOG) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "" || value === "log") return "log";
  if (value === "act") return "act";
  if (!warnedNoTurnModes.has(value)) {
    warnedNoTurnModes.add(value);
    console.warn(`[FastPath] NO_TURN_WATCHDOG "${value.slice(0, 20)}" not recognised — logging only (expected log or act)`);
  }
  return "log";
}

/**
 * Gate M5: the AI has finished speaking (just before the echo filter's text clears).
 * (i) A short answer dropped while it asked a long question is committed now (the
 * turn engine decides). (ii) Otherwise, after a question, the caller gets
 * FAST_REPROMPT_MS to start talking before the AI asks again, once per question.
 * @param {CallSession} session
 */
function onFastAiIdle(session) {
  const state = session.fastState;
  if (!state || state.closed || session.fastPath !== true) return;
  const committed = session.fastTurns?.onAiIdle({ aiSpeakingText: state.speakingText, questionAudioStartAt: state.questionAudioStartAt }) ?? false;
  // Gate N1: a caller already talking (a turn Flux has open) is answering.
  if (committed || session.isProcessing || !endsWithQuestion(state.speakingText) || session.fastTurns?.openTurn()) return;
  const question = lastFastQuestion(state.speakingText);
  // Once per question: the re-prompt ends with the question it asked again.
  if (!question || (state.repromptedQuestion && question.endsWith(state.repromptedQuestion))) return;
  cancelFastReprompt(session);
  state.repromptTimer = setTimeout(() => repromptFast(session, question), FAST_REPROMPT_MS);
}

/**
 * Gate M5 (ii): "Sorry, I didn't catch that." and the AI's question again.
 * @param {CallSession} session
 * @param {string} question
 */
function repromptFast(session, question) {
  const state = session.fastState;
  if (!state) return;
  state.repromptTimer = null;
  const ws = state.twilioWs;
  if (state.closed || session.fastPath !== true || session.isProcessing || fastAudioBusy(session) || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (session.fastTurns?.openTurn()) return; // gate N1: the caller has started talking
  state.repromptedQuestion = question;
  const text = `${getErrorMsg(callLanguage(session), "didntCatch")} ${question}`;
  console.log(`[FastTurn] No answer ${FAST_REPROMPT_MS} ms after the AI's question — asking it again (callSid=${session.callSid})`);
  // Gate N1: recorded once heard, as an aborted turn keeps only what was said. On the Aura
  // stream, at its first audio (a barge-in before that clears it); over REST, once its frames
  // went out (a barge-in during the synthesis sends none).
  const viaAura = Boolean(session.fastTts?.isOpen());
  if (viaAura) state.repromptAwaitingAudio = text;
  const clears = state.clearCount;
  sendTTS(session, /** @type {any} */ (ws), text, () => state.closed || state.clearCount !== clears, NOT_A_REPLY).then(
    (ms) => {
      if (!viaAura && ms > 0) session.addMessage("assistant", text);
      if (session.fastPath && ms > 0) fastFlush(session);
    },
    (err) => console.error(`[FastTurn] Asking the question again failed (callSid=${session.callSid}): ${err?.message || err}`),
  );
}

/**
 * Gate M5 (ii): the caller started a turn, a turn was committed, a barge-in, the AI
 * spoke again, or the call ended: no re-prompt.
 * @param {CallSession} session
 */
function cancelFastReprompt(session) {
  const state = session.fastState;
  if (!state?.repromptTimer) return;
  clearTimeout(state.repromptTimer);
  state.repromptTimer = null;
}

/**
 * The last sentence of `text`, which ends with a question mark ("…ten. Shall I book it?"
 * → "Shall I book it?").
 * @param {string} text
 * @returns {string}
 */
function lastFastQuestion(text) {
  const body = text.replace(/["'\u201D\u2019\u00BB\s]+$/u, "");
  return body.slice(fastQuestionLeadChars(body)).trim();
}

/**
 * The echo filter's text starts afresh, and with it what R14″ knows about the AI's
 * last question.
 * @param {import("./call-session").FastPathState} state
 */
function clearFastSpeakingText(state) {
  state.speakingText = "";
  state.auraSentChars = 0;
  state.auraReceivedMs = 0;
  state.questionAudioStartAt = null;
}

/**
 * R14″: the AI just sent a question to Aura (the chunk ends with "?"). Its audio starts
 * once the audio already in the player has played (now + remainingMs) and the audio Aura
 * still owes for the text before it has played too. The player cannot know that part
 * yet: Aura delivers audio at about twice real time, so a reply's question is usually
 * sent while its first sentence is still being synthesised. It is estimated at
 * FAST_QUESTION_MS_PER_CHAR (a slow rate: late rather than early), never making the
 * estimate earlier than the player's figure.
 * @param {CallSession} session
 * @param {string} text - the chunk, its question last
 */
function noteFastQuestion(session, text) {
  const state = session.fastState;
  if (!state) return;
  const now = Date.now();
  const queuedMs = session.fastPlayer?.remainingMs(now) ?? 0;
  const charsBefore = state.auraSentChars + fastQuestionLeadChars(text);
  const owedMs = Math.max(0, charsBefore * FAST_QUESTION_MS_PER_CHAR - state.auraReceivedMs);
  state.questionAudioStartAt = now + queuedMs + owedMs;
}

/**
 * The characters of a chunk before its last sentence ("Tuesday works. Shall I book it?"
 * → 15): the question is that last sentence.
 * @param {string} text
 * @returns {number}
 */
function fastQuestionLeadChars(text) {
  const body = text.replace(/["'\u201D\u2019\u00BB\s]+$/u, "");
  let lead = 0;
  for (const m of body.matchAll(/[.!?]["'\u201D\u2019\u00BB]*\s+/gu)) lead = (m.index ?? 0) + m[0].length;
  return lead;
}

/**
 * R12d′: REST audio went to Twilio on the fast path (the greeting, the
 * disclosure, sendTTS after an Aura fallback). Its words join the echo filter's
 * text, and isSpeaking holds until its tts-done mark is back.
 * @param {CallSession} session
 * @param {string} text
 * @param {number} ms - its playback length
 */
function noteFastRestSpeech(session, text, ms) {
  const state = session.fastState;
  if (!state || state.closed) return;
  cancelFastReprompt(session);
  state.speakingText = state.speakingText ? `${state.speakingText} ${text}` : text;
  state.restMarks += 1;
  state.restPlaybackEndsAt = Math.max(Date.now(), state.restPlaybackEndsAt) + ms;
  session.isSpeaking = true;
  // Minor 3: if its tts-done is lost, isSpeaking (and the echo filter's text)
  // still recover FAST_LOST_MARK_MS past its estimated end.
  if (state.restTimer) clearTimeout(state.restTimer);
  state.restTimer = setTimeout(() => {
    state.restTimer = null;
    if (!state.closed) refreshFastSpeaking(session);
  }, state.restPlaybackEndsAt + FAST_LOST_MARK_MS - Date.now() + 1);
}

/**
 * A tts-done mark is back on the fast path: one REST audio less. (The classic
 * handler has already set isSpeaking = false; this puts it back while other
 * audio still plays: the disclosure's mark returns before the greeting's.)
 * @param {CallSession} session
 */
function onFastRestMark(session) {
  const state = session.fastState;
  if (!state) return;
  state.restMarks = Math.max(0, state.restMarks - 1);
  refreshFastSpeaking(session);
}

/**
 * R12d′: the recording disclosure is going out (either path). Until its audio
 * has played nothing may cut it: no barge-in, no clear (stopFastAudio), and a
 * turn that starts meanwhile waits (waitForFastTurnStart).
 * @param {CallSession} session
 */
function beginFastDisclosure(session) {
  const state = session.fastState;
  if (!state || state.closed) return;
  state.disclosureActive = true;
}

/**
 * The disclosure's frames are all at Twilio: a mark after them says when it has
 * played, with a backstop in case the mark is lost.
 * @param {CallSession} session
 * @param {WebSocket} twilioWs
 * @param {number} ms - its playback length
 */
function armFastDisclosureEnd(session, twilioWs, ms) {
  const state = session.fastState;
  if (!state || state.closed) return;
  sendTwilioJson(twilioWs, { event: "mark", streamSid: session.streamSid, mark: { name: FAST_DISCLOSURE_MARK } });
  if (state.disclosureTimer) clearTimeout(state.disclosureTimer);
  state.disclosureTimer = setTimeout(() => {
    if (state.disclosureActive) noteLostMark(session, "disclosure");
    endFastDisclosure(session);
  }, ms + FAST_LOST_MARK_MS);
}

/**
 * @param {CallSession} session
 */
function endFastDisclosure(session) {
  const state = session.fastState;
  if (!state) return;
  if (state.disclosureTimer) clearTimeout(state.disclosureTimer);
  state.disclosureTimer = null;
  state.disclosureActive = false;
}

/**
 * Anything of the AI's still to be heard: playing (the player, REST audio), owed
 * by Aura, or the disclosure.
 * @param {CallSession} session
 * @returns {boolean}
 */
function fastAudioBusy(session) {
  const state = session.fastState;
  return fastPlayerPlaying(session) || session.isSpeaking || fastRestPlaying(session) || fastAuraOwes(state) || Boolean(state?.disclosureActive);
}

/**
 * R12b″: a fast turn starts only once the AI has finished speaking, waiting at
 * most FAST_TURN_START_WAIT_MS. Nothing is cleared: the turn answers after the
 * AI's words, never over them. (A turn that waited is one committed while the AI
 * spoke without a barge-in: a short answer, or one queued behind a reply.) The
 * wait is part of the turn: its user message is already recorded, and a barge-in
 * (the turn's abort) ends the wait at once, without an answer to these words.
 * @param {CallSession} session
 * @param {import("./call-session").FastTurn} turn - the turn waiting; its abort signal ends the wait
 * @returns {Promise<void>}
 */
async function waitForFastTurnStart(session, turn) {
  const started = Date.now();
  const signal = turn.ctl.signal;
  while (!signal.aborted && fastAudioBusy(session) && !session.fastState?.closed && Date.now() - started < FAST_TURN_START_WAIT_MS) {
    // Polled, but a barge-in (the turn's abort) ends the wait at once (R12b″).
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve(undefined);
      };
      const timer = setTimeout(done, FAST_TURN_START_POLL_MS);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  if (signal.aborted) return; // the turn's abort path logs it
  const waited = Date.now() - started;
  if (fastAudioBusy(session)) console.warn(`[FastTurn] The AI was still speaking after ${waited} ms — answering anyway (callSid=${session.callSid})`);
  else console.log(`[FastTurn] Waited ${waited} ms for the AI to finish before answering (callSid=${session.callSid})`);
}

/**
 * Minor 6: Flux answers audio with an Update about every 240 ms. No frame at all
 * for FLUX_SILENCE_MS while audio still goes out means a stuck stream: Nova.
 * @param {CallSession} session
 * @param {(reason: string, err: unknown) => void} fallBack
 */
function startFluxWatchdog(session, fallBack) {
  const state = session.fastState;
  if (!state || state.closed) return;
  if (state.fluxWatchdog) clearInterval(state.fluxWatchdog);
  // Since when audio has been going out without a break: after a pause in the
  // caller's audio, Flux gets a fair chance to answer the first new frames.
  let sendingSince = 0;
  state.fluxWatchdog = setInterval(() => {
    const flux = session.deepgramWs;
    if (session.fastPath !== true || state.closed || !flux) {
      if (state.fluxWatchdog) clearInterval(state.fluxWatchdog);
      state.fluxWatchdog = null;
      return;
    }
    if (flux.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - flux.lastSendAt > 2 * FLUX_WATCHDOG_TICK_MS) {
      sendingSince = 0; // no audio going out: nothing to judge
      return;
    }
    if (sendingSince === 0) sendingSince = now;
    const silentMs = now - flux.lastMessageAt;
    if (silentMs > FLUX_SILENCE_MS && now - sendingSince > FLUX_SILENCE_MS) {
      fallBack(`no frames for ${silentMs} ms while audio went out`, new Error(`Flux stuck: no frames for ${silentMs} ms while audio went out`));
    }
  }, FLUX_WATCHDOG_TICK_MS);
}

/**
 * (Re)start the audio-quiet timer: no Aura audio for FAST_AUDIO_QUIET_MS ends
 * the utterance even when its Flushed never comes (a flush the budget refused).
 * Without that, isPlaying() would stay true and the turn engine would take
 * every short answer for echo.
 * @param {CallSession} session
 */
function armFastQuietTimer(session) {
  const state = session.fastState;
  if (!state || state.closed) return;
  if (state.quietTimer) clearTimeout(state.quietTimer);
  state.quietTimer = setTimeout(() => {
    state.quietTimer = null;
    if (state.closed) return;
    if (state.unmarked) endFastUtterance(session);
    // A refused flush's audio has stopped arriving: Aura owes nothing more for it.
    if (state.flushRefused) {
      state.flushRefused = false;
      state.unflushed = false;
      // Gate H2: its sentences were voiced (released by their trailing space).
      state.auraSegments = state.auraSegments.filter((segment) => segment.seq !== null);
      state.auraHeardSinceFlushedMs = 0;
      if (state.notReplyFlushSeq === null) state.notReplyOwed = false; // gate N5
    }
    for (const resolve of state.quietWaiters.splice(0)) resolve();
  }, FAST_AUDIO_QUIET_MS);
}

/**
 * Spec 4.8.6: Twilio echoed one of the player's marks. isSpeaking follows what
 * the player still has playing, and once it is idle the echo filter's text
 * starts afresh.
 * @param {CallSession} session
 * @param {string} name
 */
function onFastMark(session, name) {
  if (name === FAST_DISCLOSURE_MARK) endFastDisclosure(session);
  else session.fastPlayer?.onMark(name);
  // Never just the player's state: REST audio may still play, and text sent to
  // Aura may have no audio yet (the echo filter keeps hearing it: the IMPORTANT fix).
  refreshFastSpeaking(session);
}

/**
 * Stop the AI's audio now: the player (a Twilio `clear`, and its marks) and,
 * while Aura may still owe audio for text already sent, the Aura stream (a
 * Clear; on an idle stream it was never probed, and a Cleared that never came
 * would drop the next reply's first audio). Never throws.
 * @param {CallSession} session
 * @returns {boolean} false when it refused: the recording disclosure is playing (R12d′)
 */
function stopFastAudio(session) {
  const state = session.fastState;
  const player = session.fastPlayer;
  // R12d′: never the recording disclosure.
  if (state?.disclosureActive) return false;
  // Anything the AI was saying (still playing, or still owed by Aura for text
  // it was given: the IMPORTANT fix) gets an Aura Clear.
  const owed = fastAuraOwes(state) || Boolean(state?.speakingText) || Boolean(player?.isPlaying());
  session.isSpeaking = false;
  cancelFastReprompt(session);
  if (state) {
    clearFastSpeakingText(state);
    state.clearCount += 1;
    state.auraSegments = [];
    state.auraHeardSinceFlushedMs = 0;
    state.repromptAwaitingAudio = null; // gate N1: cut before any of it played: not recorded
    state.notReplyOwed = false;
    state.notReplyFlushSeq = null;
    state.unmarked = false;
    state.unflushed = false;
    state.flushRefused = false;
    state.presumedIdle = false;
    state.restMarks = 0; // the Twilio clear drops REST audio too
    // A Clear discards pending flushes: their Flushed never comes.
    state.pendingFlushSeq = null;
    if (state.flushWatchdog) clearTimeout(state.flushWatchdog);
    state.flushWatchdog = null;
    for (const waiter of [...state.flushWaiters]) waiter.done();
  }
  if (player) {
    try {
      player.stop();
    } catch (err) {
      console.warn(`[FastPath] Stopping the player threw (callSid=${session.callSid}): ${err.message}`);
    }
  }
  if (owed && session.fastTts?.isOpen()) {
    try {
      session.fastTts.clear();
    } catch (err) {
      console.warn(`[FastPath] Clearing the Aura stream threw (callSid=${session.callSid}): ${err.message}`);
    }
  }
  return true;
}

/**
 * Wait (at most FAST_FLUSHED_WAIT_MS) for the Flushed with sequence id `seq`.
 * @param {CallSession} session
 * @param {number} seq
 * @returns {Promise<void>}
 */
function waitForFastFlushed(session, seq) {
  const state = session.fastState;
  if (!state || state.closed || state.flushedSeq >= seq) return Promise.resolve();
  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const waiter = {
      seq,
      done: () => {
        clearTimeout(timer);
        state.flushWaiters = state.flushWaiters.filter((w) => w !== waiter);
        resolve();
      },
    };
    timer = setTimeout(waiter.done, FAST_FLUSHED_WAIT_MS);
    state.flushWaiters.push(waiter);
  });
}

/**
 * Wait (at most FAST_FLUSHED_WAIT_MS) until no Aura audio has arrived for
 * FAST_AUDIO_QUIET_MS: the end of the audio when there is no Flushed to wait for.
 * @param {CallSession} session
 * @returns {Promise<void>}
 */
function waitForFastAudioQuiet(session) {
  const state = session.fastState;
  if (!state || state.closed) return Promise.resolve();
  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let cap;
    const finish = () => {
      clearTimeout(cap);
      state.quietWaiters = state.quietWaiters.filter((w) => w !== finish);
      resolve();
    };
    cap = setTimeout(finish, FAST_FLUSHED_WAIT_MS);
    state.quietWaiters.push(finish);
    armFastQuietTimer(session); // quiet from now on, if no audio comes at all
  });
}

/**
 * Wait until the audio for everything sent to the Aura stream has reached the
 * player: flush, then that flush's Flushed (a flush the budget refused has
 * none: then until Aura goes quiet), and mark it. Both waits are bounded by
 * FAST_FLUSHED_WAIT_MS. Resolves at once when not streaming; never rejects.
 * @param {CallSession} session
 * @returns {Promise<void>}
 */
async function settleFastAudio(session) {
  const state = session.fastState;
  if (!state || state.closed || !session.fastTts?.isOpen()) return;
  let seq = state.pendingFlushSeq;
  let refused = false;
  if (state.unflushed) {
    const flushed = fastFlush(session);
    if (flushed === null) refused = true;
    else seq = flushed;
  }
  if (refused) await waitForFastAudioQuiet(session);
  else if (seq !== null) await waitForFastFlushed(session, seq);
  if (state.unmarked && !state.closed) endFastUtterance(session);
}

/**
 * session.awaitPlaybackEnd on the fast path (the end_call hang-up's playback
 * signal): every word is out (settleFastAudio), then the player has played it
 * (its marks; at most its byte estimate plus FAST_IDLE_CAP_MS). Rejects when
 * the stream is not open: the hang-up then waits out its sendTTS estimate.
 * @param {CallSession} session
 * @returns {Promise<void>}
 */
async function awaitFastPlaybackEnd(session) {
  const player = session.fastPlayer;
  if (!player || !session.fastTts?.isOpen()) throw new Error("the Aura stream is not open");
  await settleFastAudio(session);
  await player.whenIdle(FAST_IDLE_CAP_MS);
}

/**
 * Spec 4.8.10: end the fast path at cleanup. Flux is closed whatever its state
 * (a CONNECTING handle would leak: our pings keep it alive), then the Aura
 * stream, the player (releasing its whenIdle timers) and every wait still
 * pending. Idempotent; never throws.
 * @param {CallSession} session
 */
function closeFastPath(session) {
  const state = session.fastState;
  if (!state || state.closed) return;
  state.closed = true;
  for (const timer of [state.fluxOpenTimer, state.quietTimer, state.flushWatchdog, state.disclosureTimer, state.restTimer, state.auraOpenTimer, state.repromptTimer]) {
    if (timer) clearTimeout(timer);
  }
  state.auraOpenTimer = null;
  state.repromptTimer = null;
  if (state.fluxWatchdog) clearInterval(state.fluxWatchdog);
  state.fluxOpenTimer = null;
  state.quietTimer = null;
  state.flushWatchdog = null;
  state.disclosureTimer = null;
  state.restTimer = null;
  state.fluxWatchdog = null;
  /** @type {Array<[string, () => void]>} */
  const steps = [];
  // After a fallback, deepgramWs is Nova: destroy() closes it, as on any classic call.
  if (session.fastPath === true && session.deepgramWs) {
    const flux = session.deepgramWs;
    steps.push(["Flux", () => flux.close()]);
  }
  const tts = session.fastTts;
  if (tts) steps.push(["the Aura stream", () => tts.close()]);
  const player = session.fastPlayer;
  if (player) steps.push(["the player", () => player.stop()]);
  for (const [what, step] of steps) {
    try {
      step();
    } catch (err) {
      console.warn(`[FastPath] Closing ${what} threw at cleanup (callSid=${session.callSid}): ${err?.message || err}`);
    }
  }
  for (const waiter of [...state.flushWaiters]) waiter.done();
  for (const resolve of state.quietWaiters.splice(0)) resolve();
  // Nobody will hear them: stop paying for them.
  dropFastDraft(session, "cleanup");
  session.currentTurn?.abort("cleanup");
}

// --- Test Call WebSocket (/ws/test) ---
// Browser-to-server voice pipeline for test calls (no Twilio, no cost)
const testWss = new WebSocketServer({ noServer: true });

// --- Outbound caller persona WebSocket (/ws/outbound) ---
// Gemini Live session that ACTS AS the caller when the outbound calling service
// dials a target number. Paired with the /outbound/* REST endpoints.
const outboundWss = new WebSocketServer({ noServer: true });
outboundWss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // /ws/outbound/<token> — strip prefix, decode.
  const rawToken = url.pathname.replace(/^\/ws\/outbound\/?/, "");
  // Malformed percent-encoding makes decodeURIComponent throw URIError — an
  // unhandled throw in the upgrade path. Leave token null so it falls through
  // to the same invalid-token rejection below (verifyOutboundToken(null) → null).
  let token = null;
  try {
    token = rawToken ? decodeURIComponent(rawToken) : null;
  } catch {
    // rejected below with tokenLen=0 — never log the raw token
  }
  // SCRUM-449: this verify CONSUMES the token's single-use jti — a replayed
  // token (e.g. a second WS connect while the pendingCall is live) returns
  // null and hits the same rejection path below.
  const tokenData = verifyOutboundToken(token, INTERNAL_API_SECRET);
  if (!tokenData) {
    // SCRUM-430 (finding #42): req.url carries the full presented token in
    // the path — never write it to Fly/Loki. Length is enough to triage.
    console.warn(`[Outbound] Rejected /ws/outbound — invalid token (tokenLen=${token?.length || 0})`);
    ws.close(1008, "invalid token");
    return;
  }
  // handleOutboundConnection looks up pendingCalls.get(tokenData._token)
  tokenData._token = token;
  handleOutboundConnection(ws, tokenData);
});

// SCRUM-378 eval spike: ConversationRelay + Claude WebSocket (/ws/conversationrelay).
// JSON protocol (Twilio does Deepgram STT + ElevenLabs TTS), NOT the μ-law media
// stream. Reached only for a TEST number routed to "conversationrelay" via
// TEST_PIPELINE_OVERRIDES. consumeStreamToken is passed for /ws/audio auth parity.
const crWss = new WebSocketServer({ noServer: true });
crWss.on("connection", (ws, req) => {
  handleConversationRelayConnection(ws, req, { consumeStreamToken });
});

// Route WebSocket upgrades by path — ws library doesn't support multiple
// WebSocketServer instances with { server, path } on the same HTTP server.
server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  // SCRUM-430 (finding #42): NEVER log request.url here — /ws/outbound carries
  // the (single-use since SCRUM-449, 5-min TTL) HMAC token in the PATH and
  // /ws/test carries its token in the QUERY. A pre-consumption token in logs
  // is still usable once, so log only a redacted route name.
  const redactedPath = pathname.startsWith("/ws/outbound") ? "/ws/outbound/<redacted>" : pathname;
  console.log(`[Upgrade] path=${redactedPath}`);

  if (pathname === "/ws/audio") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else if (pathname === "/ws/test") {
    testWss.handleUpgrade(request, socket, head, (ws) => {
      testWss.emit("connection", ws, request);
    });
  } else if (pathname.startsWith("/ws/outbound")) {
    outboundWss.handleUpgrade(request, socket, head, (ws) => {
      outboundWss.emit("connection", ws, request);
    });
  } else if (pathname === "/ws/conversationrelay") {
    crWss.handleUpgrade(request, socket, head, (ws) => {
      crWss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});
// SCRUM-363: session-duration caps moved to ./lib/session-limits — the public
// demo (DEMO_ORG_ID) gets a tighter cap than authed dashboard test calls.

// SCRUM-341: concurrency caps on /ws/test. Each session is a PAID Gemini Live
// call, so bound concurrent sessions globally, per-IP, and per-token. The voice
// server is a single long-running process (one Fly machine), so in-memory
// tracking is authoritative — no distributed store needed. Tokens minted before
// the jti rollout have no jti and skip the single-use check, but are still
// bounded by the IP + global caps (backward compatible). Logic + IP resolution
// live in ./lib/test-session-caps so they're unit-tested.
const MAX_TEST_SESSIONS_GLOBAL = 50;
const MAX_TEST_SESSIONS_PER_IP = 3;
const testSessionCaps = createTestSessionCaps({
  maxGlobal: MAX_TEST_SESSIONS_GLOBAL,
  maxPerIp: MAX_TEST_SESSIONS_PER_IP,
});

/**
 * Verify a test call token (HMAC-SHA256 signed by TEST_CALL_SECRET).
 * Token format: base64url(payload).signature
 */
function verifyTestCallToken(token) {
  if (!TEST_CALL_SECRET || !token) return null;
  try {
    const [payloadB64, sig] = token.split(".");
    if (!payloadB64 || !sig) return null;

    const expected = crypto.createHmac("sha256", TEST_CALL_SECRET).update(payloadB64).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;

    return payload;
  } catch (err) {
    console.error("[Auth] Test call token verification threw unexpectedly:", err);
    return null;
  }
}

testWss.on("connection", (ws, req) => {
  if (!TEST_CALL_SECRET) {
    ws.close(4001, "Test calls not configured");
    return;
  }

  // Extract token from query string
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  const tokenData = verifyTestCallToken(token);

  if (!tokenData || !tokenData.assistantId || !tokenData.organizationId) {
    ws.close(4003, "Invalid or expired token");
    return;
  }

  const { assistantId, organizationId, simulateAfterHours, jti } = tokenData;

  // SCRUM-341: enforce concurrency caps BEFORE allocating a (paid) Gemini Live
  // session. tryReserve is a synchronous check-and-reserve (no await → race-free
  // on Node's single-threaded loop). A token without a jti (pre-rollout) skips
  // only the single-use check; the IP + global caps still apply.
  const clientIp = getTestClientIp(req);
  const reservation = testSessionCaps.tryReserve(jti, clientIp);
  if (!reservation.ok) {
    const msg =
      reservation.reason === "jti-reuse"
        ? "This test token is already in use"
        : reservation.reason === "per-ip"
          ? "Too many active test sessions from your network"
          : "Too many active test sessions, try again shortly";
    console.warn(`[TestCap] Rejected /ws/test (${reservation.reason}, ip=${maskPhone(clientIp)})`);
    ws.close(4029, msg);
    return;
  }

  // Release the reserved slot exactly once, on any teardown path. Wired into
  // cleanupTestSession (ws close/error + the max-duration timer below).
  let testSlotReleased = false;
  function releaseTestSlot() {
    if (testSlotReleased) return;
    testSlotReleased = true;
    testSessionCaps.release(jti, clientIp);
  }

  let session = null;
  let cleaningUp = false;
  let autoEndTimer = null;

  async function cleanupTestSession() {
    if (cleaningUp) return;
    cleaningUp = true;

    // SCRUM-341: free the concurrency slot (jti + per-IP + global) on every
    // teardown path. Idempotent via testSlotReleased.
    releaseTestSlot();

    if (autoEndTimer) {
      clearTimeout(autoEndTimer);
      autoEndTimer = null;
    }

    if (session) {
      // Unsubscribe from schedule cache events
      if (session._cacheUnsub) {
        session._cacheUnsub();
        session._cacheUnsub = null;
      }
      // Close Gemini session if active
      if (session.geminiSession) {
        try { session.geminiSession.close(); } catch (err) {
          console.warn("[TestGeminiLive] Error closing Gemini session during cleanup:", err.message);
        }
        session.geminiSession = null;
      }
      session.destroy();
      session = null;
    }
  }

  // Auto-disconnect after max duration. SCRUM-363: the public demo
  // (organizationId === DEMO_ORG_ID) gets a tighter cap than authed test calls.
  const maxSessionDurationMs = getMaxSessionDurationMs(organizationId);
  autoEndTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ended", reason: "max-duration" }));
      ws.close(1000, "Max duration reached");
    }
  }, maxSessionDurationMs);

  // Initialize session
  (async () => {
    try {
      const context = await loadTestCallContext(assistantId, organizationId);
      if (!context) {
        ws.send(JSON.stringify({ type: "error", message: "Assistant not found or inactive" }));
        ws.close(4004, "Assistant not found");
        return;
      }

      session = new CallSession(`test_${Date.now()}`);
      session.organizationId = organizationId;
      session.assistantId = assistantId;
      session.transferRules = context.transferRules || [];
      session.language = context.assistant.language || "en";
      session.deepgramVoice = getDeepgramVoice(context.assistant.voiceId);
      session.holdPreset = getHoldPreset(context.organization.industry);
      session.organization = {
        timezone: context.organization.timezone,
        businessHours: context.organization.businessHours,
      };
      session.orgPhoneNumber = null; // no real phone number in test mode

      // After-hours detection
      let { isAfterHours, afterHoursConfig, effectiveCalendarEnabled } = resolveAfterHoursState(context);

      // Override: simulate after-hours if requested via token
      if (simulateAfterHours === true && !isAfterHours) {
        const afterHoursEnabled = !!(context.assistant.promptConfig?.behaviors?.afterHoursHandling);
        if (afterHoursEnabled) {
          isAfterHours = true;
          afterHoursConfig = context.afterHoursConfig || null;
          // Calendar tools stay available so callers can book for business hours
          effectiveCalendarEnabled = context.calendarEnabled || false;
        } else {
          console.warn(`[TestAfterHours] simulateAfterHours requested but afterHoursHandling is disabled — ignoring`);
        }
      }

      session.calendarEnabled = effectiveCalendarEnabled;
      session.serviceTypes = context.serviceTypes || [];

      if (isAfterHours) {
        const reason = simulateAfterHours ? "SIMULATED" : "DETECTED";
        console.log(`[TestAfterHours] After-hours mode ${reason} (calendar=${effectiveCalendarEnabled})`);
      }

      // Build system prompt
      const systemPrompt = buildSystemPrompt(
        context.assistant,
        context.organization,
        context.knowledgeBase,
        {
          calendarEnabled: effectiveCalendarEnabled,
          transferRules: session.transferRules,
          isAfterHours,
          afterHoursConfig,
          serviceTypes: context.serviceTypes,
        }
      );
      session.setSystemPrompt(systemPrompt);

      // ── Schedule cache: pre-fetch availability snapshot for test calls ──
      let scheduleSnapshot = null;
      if (session.calendarEnabled || session.serviceTypes?.length > 0) {
        try {
          scheduleSnapshot = scheduleCache.getSchedule(context.organizationId);
          if (!scheduleSnapshot) {
            scheduleSnapshot = await loadScheduleSnapshot(
              context.organizationId,
              context.organization,
              context.serviceTypes
            );
            if (scheduleSnapshot) {
              scheduleCache.setSchedule(context.organizationId, scheduleSnapshot);
              console.log(`[ScheduleCache] Test call: loaded snapshot for org=${context.organizationId} (${Object.keys(scheduleSnapshot.slots).length} days, ${Object.values(scheduleSnapshot.slots).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : (v?._any?.length || 0)), 0)} total slots)`);
            }
          } else {
            console.log(`[ScheduleCache] Test call: cache hit for org=${context.organizationId}`);
          }

          if (scheduleSnapshot) {
            const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: context.organization.timezone }).format(new Date());
            const liveSection = buildLiveScheduleSection(scheduleSnapshot, todayStr);
            if (liveSection) {
              const currentPrompt = session.messages[0]?.content || "";
              session.setSystemPrompt(currentPrompt + "\n" + liveSection);
            }
          }
        } catch (err) {
          console.warn("[ScheduleCache] Test call: failed to load snapshot (non-fatal):", err.message);
        }
      }
      session.scheduleSnapshot = scheduleSnapshot;

      // Subscribe to cache changes from other sessions (same org)
      if (scheduleSnapshot) {
        session._cacheUnsub = scheduleCache.onScheduleChanged(context.organizationId, async () => {
          // Guard: session may have been cleaned up between invalidation and this callback
          if (!session) return;
          try {
            let fresh = scheduleCache.getSchedule(context.organizationId);
            if (!fresh && (session.calendarEnabled || session.serviceTypes?.length > 0)) {
              fresh = await loadScheduleSnapshot(context.organizationId, session.organization, session.serviceTypes);
              if (fresh) scheduleCache.setSchedule(context.organizationId, fresh);
            }
            // Re-check session after await — it may have been cleaned up during the fetch
            if (fresh && session) {
              session.scheduleSnapshot = fresh;
              console.log(`[ScheduleCache] Test session ${session.callSid || "test"} refreshed from cache event`);
            }
          } catch (err) {
            console.warn("[ScheduleCache] Test call: failed to refresh session:", err.message);
          }
        });
      }

      // ── Pipeline selection: Gemini Live vs Classic ──────────────
      const useGeminiLive = VOICE_PIPELINE === "gemini-live" && process.env.GEMINI_API_KEY;

      if (useGeminiLive) {
        // ── Gemini Live pipeline for test/demo calls ──────────────
        console.log(`[TestGeminiLive] Initializing Gemini Live (${GEMINI_MODEL}) for test call`);

        // Build tool definitions using the same function as production
        const llmOptions = buildLLMOptions(session);
        const allTools = llmOptions.tools || [];

        // Build Gemini-specific system prompt with greeting instruction
        const greeting = getGreeting(context.assistant, context.organization.name, {
          isAfterHours,
          afterHoursConfig,
        });

        let geminiSystemPrompt = systemPrompt;

        // Gemini Live is natively multilingual — always remove English-only restrictions.
        // For demo/test calls, we always enable multilingual since we promote 90+ language support.
        geminiSystemPrompt = geminiSystemPrompt
          .replace(/ENGLISH ONLY:.*?Do NOT respond in their language\./gs, "LANGUAGE: You are multilingual. Respond in the caller's language naturally.")
          .replace(/You MUST ONLY respond in English\..*?Do NOT use any non-English words\./gs, "Respond in the caller's language naturally.")
          .replace(/You must respond in English\..*?Do NOT respond in their language\./gs, "Respond in the caller's language naturally.")
          .replace(/I can only assist in English/g, "I can assist in multiple languages")
          .replace(/I'm sorry, I can only assist in English[^"']*/g, "I can assist in multiple languages");

        geminiSystemPrompt += `\n\nIMPORTANT — YOUR FIRST MESSAGE: When the call connects, you will receive a short text message. Immediately respond by speaking the following greeting (word for word, naturally and warmly): "${greeting}" — Then wait for the caller to respond. Do NOT add anything extra. Do NOT invent a receptionist name — you are an AI assistant.`;

        geminiSystemPrompt += `\n\nCRITICAL RULES FOR THIS CONVERSATION:`;
        geminiSystemPrompt += `\n- ABSOLUTELY NEVER FABRICATE ACTIONS: This is the most important rule. You have tools (book_appointment, schedule_callback, check_availability, lookup_appointment, cancel_appointment, etc). You MUST call the tool AND receive a SUCCESS response BEFORE telling the caller the action was done. NEVER say "I've booked", "I've scheduled", "I've checked", "I've cancelled" UNLESS the tool already returned success.`;
        geminiSystemPrompt += `\n- 🔎 UNDERSTAND BEFORE YOU ACT (be a real receptionist): Acting on a misheard request is worse than asking again. If a caller's turn is garbled, cuts in and out, is only fragments, suddenly switches to a language they weren't using, or doesn't form a clear request, do NOT guess what they meant and do NOT act on it — warmly say you didn't catch it and ask them to repeat, in the language they are using (e.g. "Sorry, I didn't quite catch that — could you say it again?"). If you DID hear the request clearly, just proceed — do NOT tack on an extra "is that right?". Only when you genuinely couldn't hear, or you'd be guessing a name / date / time, restate it and get a clear "yes" before booking, cancelling, rescheduling, or taking a message. A caller who is upset or in a hurry is NOT a reason to make them repeat — if the words are clear, help right away. After a couple of unclear tries, offer a callback rather than guessing. NEVER book, cancel, reschedule, or record details based on a guess or an unclear turn.`;
        geminiSystemPrompt += `\n- ALWAYS COLLECT REAL NAME: Before calling book_appointment or schedule_callback, you MUST ask for and receive the caller's actual name. NEVER use placeholder names like "Caller Name", "Unknown", or "Guest".`;
        geminiSystemPrompt += `\n- ALWAYS SAY FILLER BEFORE EVERY TOOL CALL: Before EVERY tool call, you MUST say a short filler phrase in the caller's language (the equivalent of "one moment" / "let me check" / "just a sec"). NEVER go silent during a tool call.`;
        geminiSystemPrompt += `\n- LANGUAGE — conduct the ENTIRE call in the caller's language: fillers, tool acknowledgements, transfer/hold messages, confirmations and closings included. Any English phrase quoted in these instructions is an ENGLISH SAMPLE — say its equivalent in the caller's language, never the literal English unless the caller is speaking English. When a tool returns an English message, translate it before speaking, keeping names, numbers, dates, times and codes exactly as given.`;
        geminiSystemPrompt += buildLanguageLockDirective(session.language);
        geminiSystemPrompt += `\n- RESCHEDULING: When a caller wants to move or change the time of an existing appointment, you MUST call the reschedule_appointment tool — ONE call that books the new time and removes the old one atomically. Identify it by the caller's phone plus its current date (look it up first with lookup_appointment if needed) and pass new_datetime. NEVER reschedule by calling cancel_appointment and book_appointment separately — that can leave a duplicate.`;
        // SCRUM-294: test/demo calls never have transfer rules (transferRules: []
        // is passed to executeToolCall a few lines below), so transfer_call is
        // never in the tool list. If we told the model to call it, Gemini would
        // hallucinate the invocation. Use the no-rules variant: capture the
        // request via schedule_callback so the demo gracefully handles the
        // intent instead of either arguing or fabricating a transfer.
        geminiSystemPrompt += `\n- TRANSFERS — MUST OBEY: If the caller asks to be transferred, asks to speak to a human / person / manager / somebody / an actual human / a real person / staff, says 'transfer me' / 'put me through' / 'I want to talk to someone' / 'can I speak to a human' / 'get me a person' or any equivalent intent — this is a demo/test call so a live transfer isn't available. You MUST IMMEDIATELY acknowledge the request and call schedule_callback to capture their name and number. Do NOT argue. Do NOT claim you can help instead. Do NOT redirect to booking.`;

        // Transcript buffering for test calls
        let pendingUserTranscript = "";
        let pendingAiTranscript = "";

        session.geminiSession = createGeminiSession(
          {
            systemPrompt: geminiSystemPrompt,
            tools: allTools,
            voiceName: getGeminiVoice(context.assistant.voiceId),
          },
          {
            onAudio: (twilioBase64) => {
              // Convert Twilio-format base64 mulaw → raw Buffer → send as binary to browser
              if (ws.readyState === WebSocket.OPEN) {
                const audioBuffer = Buffer.from(twilioBase64, "base64");
                ws.send(audioBuffer);
              }
            },
            onToolCall: async (toolCall) => {
              // Guard: session may be null if Gemini delivers buffered tool calls after cleanup
              if (!session) {
                console.warn(`[TestGeminiLive] Ignoring tool call ${toolCall.name} — session already cleaned up`);
                return { message: "" };
              }
              logToolCall("[TestGeminiLive] Tool call", toolCall.name, toolCall.args);
              // SCRUM-372: cancel-confirmation gate (test/demo path — parity with production)
              if (toolCall.name === "cancel_appointment" && !session.confirmCancel(toolCall.args || {}, Date.now())) {
                console.warn(`[CancelGate] Holding cancel_appointment pending confirmation (test). callSid=${session.callSid}`);
                return {
                  message:
                    "DO NOT CANCEL YET. Before cancelling, confirm with the caller: read back which appointment would be cancelled (its date and time) and ask them — in their language — to clearly confirm (yes/no). ONLY if they clearly say yes, call cancel_appointment again with the same details. If they say no or you are unsure, do NOT cancel.",
                };
              }
              session.rememberDetails(toolCall.name, toolCall.args); // SCRUM-506
              const result = await executeToolCall(toolCall.name, toolCall.args, {
                organizationId: session.organizationId,
                collectedDetails: session.getCollectedDetails(), // SCRUM-506
                assistantId: session.assistantId,
                callSid: session.callSid,
                transferRules: [],
                testMode: true,
                organization: session.organization,
                scheduleSnapshot: session.scheduleSnapshot,
              });
              const message = typeof result === "string" ? result : result.message;
              console.log(`[TestGeminiLive] Tool result: "${message.slice(0, 100)}"`);
              return { message };
            },
            onTranscriptIn: (text) => {
              pendingUserTranscript += text;
            },
            onTranscriptOut: (text) => {
              pendingAiTranscript += text;
              // Send partial AI transcript to browser for display
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "speaking", speaking: true }));
              }
            },
            onInterrupted: () => {
              // Barge-in: tell the browser to drop audio it has buffered ahead so
              // the assistant stops the instant the caller interrupts (mirrors the
              // Twilio "clear" event on the phone path).
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "clear" }));
              }
              // Guard: session may be null if Gemini delivers buffered events after cleanup
              if (!session) {
                pendingAiTranscript = "";
                return;
              }
              if (pendingAiTranscript.trim()) {
                session.addMessage("assistant", pendingAiTranscript.trim());
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "transcript", role: "assistant", content: pendingAiTranscript.trim(), isFinal: true }));
                  ws.send(JSON.stringify({ type: "speaking", speaking: false }));
                }
                pendingAiTranscript = "";
              }
            },
            onTurnComplete: () => {
              // Guard: session may be null if Gemini delivers buffered events after cleanup
              if (!session) {
                pendingUserTranscript = "";
                pendingAiTranscript = "";
                return;
              }
              if (pendingUserTranscript.trim()) {
                session.addMessage("user", pendingUserTranscript.trim());
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "transcript", role: "user", content: pendingUserTranscript.trim(), isFinal: true }));
                }
                pendingUserTranscript = "";
              }
              if (pendingAiTranscript.trim()) {
                session.addMessage("assistant", pendingAiTranscript.trim());
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "transcript", role: "assistant", content: pendingAiTranscript.trim(), isFinal: true }));
                  ws.send(JSON.stringify({ type: "speaking", speaking: false }));
                }
                pendingAiTranscript = "";
              }
            },
            onError: (err) => {
              console.error("[TestGeminiLive] Session error:", err.message);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "error", message: "AI session error" }));
                ws.close(4500, "Gemini session error");
              }
            },
            onClose: (code) => {
              console.log(`[TestGeminiLive] Session closed (code=${code})`);
              if (ws.readyState === WebSocket.OPEN && !cleaningUp) {
                ws.send(JSON.stringify({ type: "ended", reason: "ai-session-closed" }));
                ws.close(1000, "Gemini session closed");
              }
            },
          }
        );

        // Gemini handles greeting via system prompt — no manual TTS needed
        console.log("[TestGeminiLive] Gemini session created — greeting will be spoken by Gemini");

      } else {
        // ── Classic pipeline (Deepgram STT + OpenAI + Deepgram TTS) ──
        console.log("[TestClassic] Using classic pipeline for test call");

      // Open Deepgram STT
      session.deepgramWs = openDeepgramStream(DEEPGRAM_API_KEY, {
        language: session.language,
        onTranscript: ({ transcript, isFinal }) => {
          // Send partial transcripts to browser
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "transcript",
              role: "user",
              content: transcript,
              isFinal,
            }));
          }
          if (!isFinal) return;
          logTranscript("[TestSTT] Final", transcript);
          session.bufferTranscript(transcript, (combined, inputType) => {
            logTranscript("[TestSTT] Buffered", combined);
            session.queueOrProcess(combined, (text) => handleTestUserSpeech(session, ws, text));
          });
        },
        onUtteranceEnd: () => {
          session.flushBuffer();
        },
        onError: (err) => {
          console.error("[TestSTT] Error:", err);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: "Speech recognition error" }));
          }
        },
        onClose: (code) => {
          if (code !== 1000 && code !== 1005) {
            console.error(`[TestSTT] Deepgram connection closed unexpectedly (code=${code})`);
          }
        },
      }, { industry: session.organization?.industry });

      // Play recording disclosure if required by jurisdiction (test calls too)
      let disclosurePrefix = "";
      const testConsentResult = requiresRecordingDisclosureHybrid(
        context.organization.country,
        context.organization.businessState,
        context.organization.recordingConsentMode,
        null // test calls have no real caller phone
      );
      session.callerState = testConsentResult.callerState;
      session.consentReason = testConsentResult.reason;
      console.log(`[TestRecording] Consent: required=${testConsentResult.required}, callerState=${testConsentResult.callerState}, reason=${testConsentResult.reason}`);
      if (testConsentResult.required) {
        const disclosureText = getRecordingDisclosureText(
          context.organization.country,
          context.organization.recording_disclosure_text,
          context.organization.name
        );
        try {
          const disclosureAudio = await synthesizeSpeech(DEEPGRAM_API_KEY, disclosureText, {
            voice: session.deepgramVoice,
          });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "transcript", role: "assistant", content: disclosureText, isFinal: true }));
            ws.send(JSON.stringify({ type: "speaking", speaking: true }));
            ws.send(disclosureAudio);
            ws.send(JSON.stringify({ type: "speaking", speaking: false }));
          }
          session.recordingDisclosurePlayed = true;
          // Add to conversation history so LLM knows disclosure was played
          session.addMessage("assistant", disclosureText);
        } catch (err) {
          // Fallback: prepend disclosure to greeting so it's always delivered
          console.error("[TestRecording] Disclosure TTS failed — prepending to greeting as fallback:", err);
          disclosurePrefix = disclosureText + " ";
          session.recordingDisclosureFailed = true;
        }
      }

      // Send greeting (with disclosure prepended if standalone TTS failed)
      const greeting = disclosurePrefix + getGreeting(context.assistant, context.organization.name, {
        isAfterHours,
        afterHoursConfig,
      });
      try {
        const audioBuffer = await synthesizeSpeech(DEEPGRAM_API_KEY, greeting, {
          voice: session.deepgramVoice,
        });
        // Send greeting transcript
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "transcript",
            role: "assistant",
            content: greeting,
            isFinal: true,
          }));
          ws.send(JSON.stringify({ type: "speaking", speaking: true }));
          // Send audio as binary
          ws.send(audioBuffer);
          ws.send(JSON.stringify({ type: "speaking", speaking: false }));
        }
        // Mark disclosure as played only after TTS succeeds (when greeting carries it)
        if (disclosurePrefix) {
          session.recordingDisclosurePlayed = true;
        }
      } catch (err) {
        console.error("[TestTTS] Failed to send greeting:", err);
      }
      session.addMessage("assistant", greeting);
      const testGreetingInputType = detectExpectedInput(greeting);
      session.setExpectedInputType(testGreetingInputType);
      console.log(`[TestInputDetect] After greeting: ${testGreetingInputType}`);

      } // end classic pipeline else block

      // Signal ready (both pipelines)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ready" }));
      }
    } catch (err) {
      console.error("[TestCall] Init error:", err);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: "Failed to initialize test call" }));
        ws.close(4500, "Init error");
      }
    }
  })();

  ws.on("message", (data, isBinary) => {
    if (!session) return;

    if (isBinary) {
      // Raw mulaw audio from browser
      if (session.geminiSession) {
        // Gemini Live pipeline — convert raw mulaw to base64 and send
        const base64Audio = data.toString("base64");
        session.geminiSession.sendAudio(base64Audio);
      } else if (session.deepgramWs && session.deepgramWs.readyState === WebSocket.OPEN) {
        // Classic pipeline — forward raw mulaw to Deepgram
        session.deepgramWs.send(data);
      }
    } else {
      // JSON control message
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // Non-JSON text message — ignore
      }
      try {
        if (msg.type === "stop") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ended", reason: "user-ended" }));
          }
          ws.close(1000, "User ended call");
        }
      } catch (err) {
        console.error("[TestCall] Error handling control message:", err);
      }
    }
  });

  ws.on("close", () => {
    cleanupTestSession();
  });

  ws.on("error", (err) => {
    console.error("[TestCall] WebSocket error:", err);
    cleanupTestSession();
  });
});

/**
 * Handle user speech in a test call — streams LLM sentence-by-sentence,
 * sends TTS audio chunks to browser as each sentence is synthesized.
 */
async function handleTestUserSpeech(session, ws, transcript) {
  if (!session) return;
  session.isProcessing = true;

  // Play hold audio while AI processes
  const hold = startHoldAudio(session, ws, "browser");

  try {
    session.addMessage("user", transcript);

    const llmOptions = buildLLMOptions(session);
    let reply = null;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const t0 = Date.now();
      let sentenceCount = 0;
      let ttsChain = Promise.resolve();
      let holdStopped = false;

      const result = await streamChatResponse(LLM_API_KEY, session.messages, {
        ...llmOptions,
        onSentence: (sentence) => {
          sentenceCount++;
          if (!holdStopped) {
            hold.stop();
            holdStopped = true;
          }
          ttsChain = ttsChain.then(async () => {
            const audioBuffer = await synthesizeSpeech(DEEPGRAM_API_KEY, sentence, {
              voice: session?.deepgramVoice,
            });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "speaking", speaking: true }));
              ws.send(audioBuffer);
            }
          }).catch((err) => {
            session.isSpeaking = false;
            console.error("[TestStreamTTS] Error sending sentence:", err.message);
          });
        },
      });

      if (result.type === "content") {
        reply = result.content;
        await ttsChain;
        // Send final speaking=false and full transcript
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "speaking", speaking: false }));
          ws.send(JSON.stringify({
            type: "transcript",
            role: "assistant",
            content: reply,
            isFinal: true,
          }));
        }
        console.log(`[TestLLM] (${Date.now() - t0}ms) streamed ${sentenceCount} chunks`);
        logTranscript("[TestLLM] reply", reply);
        break;
      }

      if (result.type === "tool_calls") {
        console.log(`[TestLLM] (${Date.now() - t0}ms) Tool calls: ${result.toolCalls.map((tc) => tc.function.name).join(", ")}`);
        session.messages.push(result.message);

        for (const toolCall of result.toolCalls) {
          const fnName = toolCall.function.name;
          const fnArgs = parseToolArgs(toolCall, "TestToolCall");

          // SCRUM-372: cancel-confirmation gate (test/demo classic path — parity)
          if (fnName === "cancel_appointment" && !session.confirmCancel(fnArgs || {}, Date.now())) {
            console.warn(`[CancelGate] Holding cancel_appointment pending confirmation (test classic). callSid=${session.callSid}`);
            session.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "DO NOT CANCEL YET. Before cancelling, confirm with the caller: read back which appointment would be cancelled (its date and time) and ask them — in their language — to clearly confirm (yes/no). ONLY if they clearly say yes, call cancel_appointment again with the same details. If they say no or you are unsure, do NOT cancel.",
            });
            continue;
          }

          session.rememberDetails(fnName, fnArgs); // SCRUM-506
          const toolResult = await executeToolCall(fnName, fnArgs, {
            organizationId: session.organizationId,
            collectedDetails: session.getCollectedDetails(), // SCRUM-506
            assistantId: session.assistantId,
            callSid: session.callSid,
            transferRules: [],
            testMode: true,
            organization: session.organization,
            scheduleSnapshot: session.scheduleSnapshot,
          });

          const resultMessage = typeof toolResult === "string" ? toolResult : toolResult.message;
          session.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultMessage,
          });
        }
        continue;
      }
    }

    if (!reply) {
      hold.stop();
      reply = getErrorMsg(session.language, "repeatRequest");
      console.warn(`[TestPipeline] Tool call loop exhausted after ${MAX_TOOL_ITERATIONS} iterations (assistantId=${session.assistantId})`);
      const audioBuffer = await synthesizeSpeech(DEEPGRAM_API_KEY, reply, { voice: session?.deepgramVoice });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "speaking", speaking: true }));
        ws.send(audioBuffer);
        ws.send(JSON.stringify({ type: "speaking", speaking: false }));
        ws.send(JSON.stringify({ type: "transcript", role: "assistant", content: reply, isFinal: true }));
      }
    }

    session.addMessage("assistant", reply);

    // Detect what input the AI is expecting next and adapt buffering
    const testNextInputType = detectExpectedInput(reply);
    session.setExpectedInputType(testNextInputType);
    if (testNextInputType !== "general") {
      console.log(`[TestInputDetect] Next expected: ${testNextInputType}`);
    }
  } catch (err) {
    hold.stop();
    console.error("[TestPipeline] Error:", err);
    try {
      if (ws.readyState === WebSocket.OPEN) {
        const fallback = getErrorMsg(session?.language, "troubleRepeat");
        const audioBuffer = await synthesizeSpeech(DEEPGRAM_API_KEY, fallback, {
          voice: session?.deepgramVoice,
        });
        ws.send(JSON.stringify({ type: "transcript", role: "assistant", content: fallback, isFinal: true }));
        ws.send(audioBuffer);
      }
    } catch (fallbackErr) {
      console.error("[TestPipeline] Fallback TTS also failed — user heard nothing:", fallbackErr.message || fallbackErr);
    }
  } finally {
    session.isProcessing = false;
    session.drainPending((text) => handleTestUserSpeech(session, ws, text));
  }
}

// Warm the Gemini Live path on boot so the FIRST real call doesn't eat a cold
// start. The first Gemini Live session in a fresh process is slow to produce its
// first audio (auth/DNS/connection + first-generation warmup); later sessions
// are fast. A throwaway mini-turn at startup pays that cost before any caller is
// on the line — fire-and-forget, non-blocking, ~1 cheap generation per process
// boot. SCRUM-579: whenever min_machines_running=0 (it is 1 while outreach or a
// pilot runs, SCRUM-580) this runs on EVERY autostart, not once per deploy, and the first
// caller after an idle period races it — the
// warm-up is fire-and-forget, so a call arriving mid-warm-up still works, it just
// doesn't get the benefit. The post-deploy warm curl in the runbook is what
// actually keeps a real caller off the cold path.
function warmUpGeminiLive() {
  if (VOICE_PIPELINE !== "gemini-live" || !process.env.GEMINI_API_KEY) return;
  const t0 = Date.now();
  let settled = false;
  let sess = null;
  /**
   * Terminal for the warmup. EVERY path closes the throwaway session — the
   * error path used to disarm the timeout without closing, leaving the socket's
   * closure to the remote end (gemini-live's `goAway` fires onError without
   * closing). `warmed` distinguishes "produced audio, path is hot" from
   * "gave up": logging a timeout as "warmed" hid the very cold start this
   * function exists to kill.
   */
  const settle = (how, warmed) => {
    if (settled) return;
    settled = true;
    try { sess && sess.close(); } catch {}
    const ms = Date.now() - t0;
    if (warmed) {
      console.log(`[GeminiWarmup] Gemini Live path warmed in ${ms}ms (${how})`);
    } else {
      console.warn(`[GeminiWarmup] gave up after ${ms}ms (${how}) — the first call may be slow`);
    }
  };
  try {
    sess = createGeminiSession(
      {
        systemPrompt: "Warmup session — reply with the single word 'ready'.",
        tools: [],
        voiceName: getGeminiVoice(),
        triggerGreeting: true,
      },
      {
        onAudio: () => settle("first-audio", true), // generation path is warm
        onTurnComplete: () => settle("turn-complete", true),
        onError: (err) => settle(`error: ${err && err.message ? err.message : err}`, false),
        onClose: () => settle("closed before audio", false),
      }
    );
  } catch (err) {
    console.warn(`[GeminiWarmup] failed to start: ${err.message}`);
    return;
  }
  // Safety net — never hang or hold the warmup session open. Unref'd so a
  // pending warmup can never keep the process alive on its own.
  const timer = setTimeout(() => settle("timeout", false), 20000);
  if (typeof timer.unref === "function") timer.unref();
}

// SCRUM-555: load the RNNoise wasm before we take calls so the first call
// gets the front-end. Never blocks startup — on failure calls use the legacy
// audio path and Sentry gets one warning.
initAudioFrontend().then(({ enabled, reason }) => {
  console.log(`[AudioFrontend] ${enabled ? "enabled" : "disabled"} (${reason})`);
  if (!enabled && reason !== "AUDIO_FRONTEND=off") {
    Sentry.captureMessage(`AudioFrontend disabled: ${reason}`, "warning");
  }
});

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Voice server listening on port ${PORT}`);
  console.log(`Voice pipeline: ${VOICE_PIPELINE}${VOICE_PIPELINE === "gemini-live" ? ` (Gemini Live: ${GEMINI_MODEL})` : ` (LLM: ${LLM_PROVIDER}/${FULL_MODEL})`}`);
  console.log(`TwiML endpoint: ${PUBLIC_URL}/twiml`);
  console.log(`WebSocket endpoint: ${WS_URL}`);
  if (TEST_CALL_SECRET) {
    console.log(`Test call WebSocket: ${PUBLIC_URL.replace(/^http/, "ws")}/ws/test`);
  }
  if (process.env.OUTBOUND_CALLER_NUMBER) {
    console.log(`Outbound call endpoint: ${PUBLIC_URL}/outbound/call`);
    console.log(`Outbound caller number: ${process.env.OUTBOUND_CALLER_NUMBER}`);
  }

  // Pre-warm Gemini so the first caller after a (re)boot gets a fast response.
  warmUpGeminiLive();
});

// ── Graceful shutdown on SIGTERM / SIGINT ──
// Fly.io sends SIGINT when deploying, auto-stopping, or restarting a machine.
// Give active calls a grace period to wind down cleanly instead of abruptly
// dropping callers mid-sentence.
let isShuttingDown = false;
const SHUTDOWN_GRACE_MS = 15_000; // 15s — enough for current LLM turn + brief "please hold" message

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Shutdown] Received ${signal} — draining active calls (grace=${SHUTDOWN_GRACE_MS}ms)`);

  // Stop accepting new HTTP/WS connections
  server.close(() => {
    console.log("[Shutdown] HTTP server stopped accepting new connections");
  });

  // Snapshot active sessions so the Map doesn't mutate under us
  const activeSessionEntries = Array.from(sessions.entries());
  console.log(`[Shutdown] ${activeSessionEntries.length} active call session(s) to drain`);

  // Hard cutoff — if calls haven't wound down in 15s, force exit
  const hardCutoff = setTimeout(() => {
    console.warn("[Shutdown] Grace period exceeded — forcing exit");
    Sentry.flush(1000).catch(() => {}).finally(() => process.exit(0));
  }, SHUTDOWN_GRACE_MS);
  hardCutoff.unref();

  // SCRUM-432 (finding #47): record why these calls ended. NOTE: nothing
  // consults a per-session "shutting down" flag (a previous comment claimed
  // the pipelines did — they don't). The drain works by (1) server.close()
  // refusing new connections, (2) the poll below waiting for live sessions
  // to end naturally, (3) the hard cutoff forcing exit after the grace
  // period. In-flight calls run to completion or cutoff, unmodified.
  for (const [, sess] of activeSessionEntries) {
    if (sess) {
      sess.endedReason = sess.endedReason || "server-shutdown";
    }
  }

  // Poll until no active sessions remain, then flush Sentry and exit clean
  const pollInterval = setInterval(async () => {
    if (sessions.size === 0) {
      clearInterval(pollInterval);
      clearTimeout(hardCutoff);
      console.log("[Shutdown] All sessions drained — exiting cleanly");
      await Sentry.flush(2000).catch(() => {});
      process.exit(0);
    }
  }, 500);
  pollInterval.unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
