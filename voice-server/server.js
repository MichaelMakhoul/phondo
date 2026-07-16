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
const { loadCallContext, loadTestCallContext, loadScheduleSnapshot } = require("./lib/call-context");
const { buildSystemPrompt, getGreeting, buildLiveScheduleSection } = require("./lib/prompt-builder");
const scheduleCache = require("./lib/schedule-cache");
const { bookingKey } = require("./lib/booking-key");
const { createCallRecord, completeCallRecord, notifyCallCompleted, applyReanalysis } = require("./lib/call-logger");
const { calendarToolDefinitions, listServiceTypesToolDefinition, transferToolDefinition, callbackToolDefinition, endCallToolDefinition, executeToolCall } = require("./services/tool-executor");
const { createGeminiSession } = require("./services/gemini-live");
const { createOpenAIRealtimeSession, createGrokRealtimeSession } = require("./services/openai-realtime"); // SCRUM-378 eval spike (OpenAI + Grok share the adapter)
const { createSessionWithFailover, isFailoverEnabled } = require("./services/gemini-failover"); // SCRUM-535
const { resolveTestPipeline, KNOWN_TEST_PIPELINES } = require("./lib/pipeline-routing"); // SCRUM-378 per-number test override
const { handleConversationRelayConnection, buildConversationRelayTwiml } = require("./services/conversationrelay"); // SCRUM-378 eval spike (ConversationRelay + Claude)
const { validateToolResponse } = require("./services/turn-validator");
const { detectPhantomAction, detectPostCallPhantoms, summarizePhantoms } = require("./lib/action-claim-detector"); // SCRUM-381 live + SCRUM-383 post-call phantom-action detection
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
const { detectAndRedact, redactObject } = require("./lib/pii-detector");
const { maskPhone } = require("./lib/mask-phone");
const { getTestClientIp, createTestSessionCaps } = require("./lib/test-session-caps");
const { getMaxSessionDurationMs } = require("./lib/session-limits");
const { timingSafeEqualStr } = require("./lib/timing-safe");
const { buildFallbackDisclosureSay } = require("./lib/fallback-dial-consent");
const { getPollyVoice } = require("./lib/polly-voice");
const killSwitch = require("./lib/route-handlers/kill-switch");

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
  },
  es: {
    notConfigured: "Lo sentimos, este número no está configurado actualmente. Por favor intente más tarde.",
    technicalDifficulty: "Lo siento, estoy experimentando dificultades técnicas. Por favor llame de nuevo.",
    repeatRequest: "Disculpe, tuve problemas procesando eso. ¿Podría repetirlo?",
    troubleRepeat: "Lo siento, estoy teniendo un pequeño problema. ¿Podría repetir eso?",
    transferFailed: (name) => `Lo siento, ${name} no está disponible en este momento. ¿Le gustaría dejar un mensaje, o hay algo más en lo que pueda ayudarle?`,
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

// Pending tokens: issued at /twiml, consumed at WebSocket start. Expire after 30s.
// Stores { issuedAt, calledNumber, callerPhone } so the WebSocket handler uses
// server-side values instead of trusting client-provided parameters.
const pendingTokens = new Map();
const TOKEN_TTL_MS = 30_000;

function issueStreamToken(calledNumber, callerPhone, reconnectCallSid, phoneRecord) {
  const ts = Date.now().toString();
  const hmac = crypto.createHmac("sha256", WS_SECRET).update(ts).digest("hex");
  const token = `${ts}.${hmac}`;
  pendingTokens.set(token, { issuedAt: Date.now(), calledNumber, callerPhone, reconnectCallSid, phoneRecord });
  return token;
}

/**
 * Verify and consume a stream token. Returns the stored call metadata
 * (calledNumber, callerPhone) or null if invalid/expired.
 */
function consumeStreamToken(token) {
  try {
    if (!pendingTokens.has(token)) return null;
    const entry = pendingTokens.get(token);
    pendingTokens.delete(token); // single-use
    if (Date.now() - entry.issuedAt > TOKEN_TTL_MS) return null;
    const [ts, hmac] = token.split(".");
    if (!ts || !hmac) return null;
    const expected = crypto.createHmac("sha256", WS_SECRET).update(ts).digest("hex");
    const hmacBuf = Buffer.from(hmac);
    const expectedBuf = Buffer.from(expected);
    if (hmacBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(hmacBuf, expectedBuf)) return null;
    return { calledNumber: entry.calledNumber, callerPhone: entry.callerPhone, reconnectCallSid: entry.reconnectCallSid, phoneRecord: entry.phoneRecord };
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

  async function cleanupSession() {
    if (!session || cleaningUp) return;
    cleaningUp = true;
    const s = session;
    session = null;
    sessions.delete(s.streamSid);

    // Unsubscribe from schedule cache events
    if (s._cacheUnsub) {
      s._cacheUnsub();
      s._cacheUnsub = null;
    }

    // If a transfer is pending, don't run post-call processing yet —
    // the /twiml/transfer-status callback or TTL cleanup will handle it.
    if (s.pendingTransfer) {
      console.log(`[Cleanup] Transfer pending for callSid=${s.callSid} — deferring post-call processing`);
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
    const phantomActions = detectPostCallPhantoms(s.fullTranscriptMessages, s.toolCallAudit);
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
    if (transcript && durationSeconds > 5) {
      try {
        analysis = await analyzeCallTranscript(transcript, { language: s.language });
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
        }
      } catch (err) {
        console.error("[PostCall] Analysis failed:", err);
      }
    }

    // PII redaction — runs after analysis, before anything is persisted
    let piiRedacted = false;
    if (s.piiRedactionEnabled) {
      const transcriptResult = detectAndRedact(transcript);
      if (transcriptResult.piiFound) {
        transcript = transcriptResult.redacted;
        piiRedacted = true;
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
    if (s.callRecordId) {
      try {
        await completeCallRecord(s.callRecordId, {
          status: callStatus,
          durationSeconds,
          transcript,
          summary: analysis?.summary || null,
          callerName: analysis?.callerName || null,
          collectedData: analysis?.collectedData || null,
          successEvaluation: analysis?.successEvaluation || null,
          recordingDisclosurePlayed: s.recordingDisclosurePlayed || false,
          recordingDisclosureFailed: s.recordingDisclosureFailed || false,
          transferAttempt: s.transferAttempt || null,
          callerState: s.callerState || null,
          consentReason: s.consentReason || null,
          pipelineFailover: s.pipelineFailover || null,
          sentiment: analysis?.sentiment || null,
          piiRedacted,
          cleanedTranscript: analysis?.cleanedTranscript ?? null,
          // SCRUM-498: daily summary + analytics count
          // action_taken="appointment_booked". The tool audit is the ground
          // truth on the Gemini/realtime paths (reschedules deliberately
          // excluded); the CLASSIC pipeline's tool loop doesn't write the
          // audit, so fall back to its confirmedBookings map (review P2 —
          // classic bookings were otherwise silently uncounted).
          actionTaken:
            (s.toolCallAudit || []).some(
              (t) => t.name === "book_appointment" && t.successful === true
            ) || (s.confirmedBookings?.size ?? 0) > 0
              ? "appointment_booked"
              : null,
        });
      } catch (err) {
        console.error("[Cleanup] Failed to complete call record:", err);
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
    if (INTERNAL_API_URL && INTERNAL_API_SECRET && s.organizationId) {
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

          // Build system prompt (guided or legacy)
          const systemPrompt = buildSystemPrompt(
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
          if (callerPhone) {
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
          if (!clinikoOwnsAvailability && (session.calendarEnabled || session.serviceTypes?.length > 0)) {
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
          if (VOICE_PIPELINE === "gemini-live" && !process.env.GEMINI_API_KEY) {
            console.error("[GeminiLive] VOICE_PIPELINE=gemini-live but GEMINI_API_KEY not set — falling back to classic pipeline");
          }
          if (VOICE_PIPELINE === "gemini-live" && process.env.GEMINI_API_KEY) {
            // Gemini Live pipeline — single model handles STT + LLM + TTS
            const geminiT0 = Date.now();
            console.log(`[GeminiLive] Starting session for callSid=${callSid}`);

            const llmOptions = buildLLMOptions(session, { includeTransfer: true });
            const allTools = llmOptions.tools || [];

            // ── Build greeting text for Gemini to speak ──
            // Gemini speaks the disclosure + greeting as its FIRST utterance.
            // This gives ONE consistent voice throughout the call and eliminates
            // the Deepgram TTS delay + voice mismatch.
            const consentResult = requiresRecordingDisclosureHybrid(
              context.organization.country,
              context.organization.businessState,
              context.organization.recordingConsentMode,
              session.callerPhone
            );
            const greeting = getGreeting(context.assistant, context.organization.name, {
              isAfterHours,
              afterHoursConfig,
            });

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

            // Transcript buffering — accumulate fragments, flush on turn complete
            let pendingUserTranscript = "";
            let pendingAiTranscript = "";

            // SCRUM-378: non-destructive eval override — a dedicated TEST number
            // can run OpenAI Realtime or Grok Realtime instead of Gemini (same
            // session interface, same callbacks/tools/guards). Unset env → null
            // → unchanged Gemini.
            const _testPipeline = resolveTestPipeline(session.orgPhoneNumber);
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
            const _failoverModel = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
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
                  }
                },
                onToolCall: async (toolCall) => {
                  // Guard: session may be null if Gemini delivers buffered tool calls after cleanup
                  if (!session) {
                    console.warn(`[GeminiLive] Ignoring tool call ${toolCall.name} — session already cleaned up`);
                    return { message: "" };
                  }
                  logToolCall("[GeminiLive] Tool call", toolCall.name, toolCall.args);

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
                  if (toolCall.name === "book_appointment" && session.confirmedBookings?.size > 0) {
                    const reqKey = bookingKey(toolCall.args);
                    const existing = session.confirmedBookings.get(reqKey);
                    if (existing) {
                      console.warn(`[RebookGuard] Blocking duplicate book_appointment — already booked code=${existing.code} callSid=${session.callSid}`);
                      session.toolCallAudit.push({ name: "book_appointment_blocked", successful: false, at: Date.now() });
                      Sentry.withScope((scope) => {
                        scope.setTag("service", "rebook_guard");
                        scope.setExtras({ callSid: session.callSid, existingCode: existing.code, attemptedDatetime: toolCall.args.datetime });
                        Sentry.captureMessage("Duplicate book_appointment intercepted", "warning");
                      });
                      return {
                        message: `CRITICAL: You already booked this exact appointment in this call. The booking is LOCKED in the database. DO NOT call book_appointment again. If the caller wants to change the appointment, call the reschedule_appointment tool (it moves it atomically in one step) — do NOT call book_appointment again.`,
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
                  const message = typeof result === "string" ? result : result.message;
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
                    session.toolCallAudit.push({ name: toolCall.name, successful, at: Date.now() });
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
                      at: Date.now(),
                    });
                  }
                  // SCRUM-257: clear confirmedBookings entry on successful cancel so
                  // the reschedule flow (cancel → book) still works.
                  if (session && toolCall.name === "cancel_appointment" && !message.toLowerCase().includes("error") && !message.toLowerCase().includes("not found")) {
                    if (session.confirmedBookings) session.confirmedBookings.clear();
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
                },
                onTranscriptOut: (text) => {
                  // Buffer AI transcript fragments — flush on turn complete.
                  // Goodbye-loop detection moved to onTurnComplete so the counter
                  // increments once per TURN, not once per streaming fragment.
                  pendingAiTranscript += text;
                },
                onInterrupted: () => {
                  // Guard: session may be null if Gemini delivers buffered events after cleanup
                  if (!session) {
                    pendingAiTranscript = "";
                    return;
                  }
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
                onTurnComplete: () => {
                  // Guard: session may be null if Gemini delivers buffered events after cleanup
                  if (!session) {
                    pendingUserTranscript = "";
                    pendingAiTranscript = "";
                    return;
                  }
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
                    const phantom = detectPhantomAction(aiTurnText, session.toolCallAudit);
                    if (phantom) {
                      const { action, primaryTool } = phantom;
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
                        session.geminiSession.sendText(
                          `CRITICAL ERROR: You just told the caller the ${action} was done, but you did NOT call ${primaryTool}. ` +
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
                    if (session._lastToolResult && !session._phantomActionCount) {
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

          // Recording disclosure + greeting — pre-synthesize disclosure while STT connects
          const consentResult = requiresRecordingDisclosureHybrid(
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
            }).catch((err) => {
              console.error("[Recording] Disclosure pre-synthesis failed:", err);
              return null;
            });
          }

          // Pre-synthesize greeting in parallel too
          const greeting = getGreeting(context.assistant, context.organization.name, {
            isAfterHours,
            afterHoursConfig,
          });
          const greetingAudioPromise = synthesizeSpeech(DEEPGRAM_API_KEY, stripMarkdown(greeting), {
            voice: session.deepgramVoice,
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
              for (const chunk of chunks) {
                if (twilioWs.readyState !== WebSocket.OPEN) break;
                twilioWs.send(JSON.stringify({ event: "media", streamSid: session.streamSid, media: { payload: chunk } }));
              }
              twilioWs.send(JSON.stringify({ event: "mark", streamSid: session.streamSid, mark: { name: "tts-done" } }));
              console.log(`[TTS] Disclosure (pre-synth, ${Date.now() - t0}ms send) ${disclosureAudio.length} bytes`);
              session.recordingDisclosurePlayed = true;
              session.addMessage("assistant", disclosureText);
            } else {
              // Pre-synthesis failed — MUST fall back to synchronous TTS for legal compliance
              // In two-party consent jurisdictions, skipping disclosure is illegal
              console.warn("[Recording] Disclosure pre-synthesis failed — falling back to synchronous TTS");
              try {
                await sendTTS(session, twilioWs, disclosureText);
                session.recordingDisclosurePlayed = true;
                session.addMessage("assistant", disclosureText);
              } catch (fallbackErr) {
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
            // Safety timeout: reset isSpeaking even if mark event is lost
            setTimeout(() => { if (session) session.isSpeaking = false; }, 20000);
            console.log(`[TTS] Greeting (pre-synth, ${Date.now() - t0}ms send) ${greetingAudio.length} bytes`);
            session.addMessage("assistant", greeting);
          } else {
            // Fallback: synthesize greeting normally if pre-synth failed
            try {
              await sendTTS(session, twilioWs, greeting);
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
          }
          break;
        }

        case "stop": {
          console.log(`[Twilio] Stream stopped — callSid=${session?.callSid}`);
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
    const reasonStr = reason ? reason.toString() : "";
    console.log(`[Twilio] WebSocket closed (code=${code}, reason="${reasonStr}", callSid=${session?.callSid}, duration=${session?.getDurationSeconds?.() || 0}s)`);
    cleanupSession().catch((err) => {
      console.error("[Cleanup] Unhandled error in session cleanup:", err);
    });
  });
});

/**
 * Build LLM options with tools based on session capabilities.
 * @param {CallSession} session
 * @param {{ includeTransfer?: boolean }} options
 * @returns {object}
 */
function buildLLMOptions(session, { includeTransfer = false } = {}) {
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

function getToolFiller(lang, toolNames) {
  const msgs = FILLER_MESSAGES[lang] || FILLER_MESSAGES.en;
  const names = Array.isArray(toolNames) ? toolNames : [toolNames];
  if (names.some((n) => n === "book_appointment")) return msgs.booking;
  if (names.some((n) => n === "check_availability" || n === "get_current_datetime")) return msgs.checking;
  return msgs.tool;
}

async function handleUserSpeech(session, twilioWs, transcript, inputTypeAtFlush) {
  if (!session) return;
  session.isProcessing = true;

  // Barge-in: if assistant is speaking, clear Twilio's audio buffer
  if (session.isSpeaking) {
    sendClear(session, twilioWs);
    session.isSpeaking = false;
  }

  // Play hold audio while AI processes
  const hold = startHoldAudio(session, twilioWs, "twilio");

  try {
    session.addMessage("user", transcript);

    const llmOptions = buildLLMOptions(session, { includeTransfer: true });
    let reply = null;

    // Track whether a filler has been sent this turn — only ONE filler per turn
    let fillerSentThisTurn = false;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const t0 = Date.now();

      const sentenceQueue = [];
      let ttsChain = Promise.resolve();
      let holdStopped = false;

      // Filler timer: if LLM hasn't started streaming in 1.5s, play "One moment."
      // Only fires once per turn (fillerSentThisTurn guard) and skips closing responses.
      // Short transcripts (< NO_FILLER_MAX_LEN chars) are treated as closings in any language.
      const trimmedTranscript = transcript.trim();
      const skipFiller = fillerSentThisTurn
        || NO_FILLER_RE.test(trimmedTranscript)
        || trimmedTranscript.length <= NO_FILLER_MAX_LEN;
      const fillerTimer = skipFiller ? null : setTimeout(() => {
        if (!holdStopped && !fillerSentThisTurn) {
          fillerSentThisTurn = true;
          hold.stop();
          holdStopped = true;
          const msgs = FILLER_MESSAGES[session.language] || FILLER_MESSAGES.en;
          console.log(`[Filler] "${msgs.waiting}"`);
          ttsChain = ttsChain.then(async () => { await sendTTS(session, twilioWs, msgs.waiting); }).catch((err) => {
            console.error("[Filler] TTS error:", err.message);
          });
        }
      }, 1500);

      const result = await streamChatResponse(LLM_API_KEY, session.messages, {
        ...llmOptions,
        onSentence: (sentence) => {
          if (fillerTimer) clearTimeout(fillerTimer);
          sentenceQueue.push(sentence);
          // Stop hold audio before first TTS sentence
          if (!holdStopped) {
            hold.stop();
            holdStopped = true;
          }
          // Chain TTS calls so they play in order
          ttsChain = ttsChain.then(async () => { await sendTTS(session, twilioWs, sentence); }).catch((err) => {
            session.isSpeaking = false;
            console.error("[StreamTTS] Error sending sentence:", err.message);
          });
        },
      });

      if (fillerTimer) clearTimeout(fillerTimer);

      if (result.type === "content") {
        reply = result.content;
        // Wait for all queued TTS to finish playing
        await ttsChain;
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

        // Play ONE tool-specific filler — only if no filler was sent yet this turn
        if (!fillerSentThisTurn) {
          fillerSentThisTurn = true;
          if (!holdStopped) {
            hold.stop();
            holdStopped = true;
          }
          const toolNames = toolCalls.map(tc => tc.function.name);
          const toolFiller = getToolFiller(session.language || "en", toolNames);
          console.log(`[Filler] "${toolFiller}" (tools: ${toolNames.join(", ")})`);
          // (async wrapper discards sendTTS's duration return — ttsChain is Promise<void>)
          ttsChain = ttsChain.then(async () => { await sendTTS(session, twilioWs, toolFiller); }).catch((err) => {
            console.error("[Filler] TTS error:", err.message);
          });
        }

        // Execute each tool call and add results
        for (const toolCall of toolCalls) {
          const fnName = toolCall.function.name;
          const fnArgs = parseToolArgs(toolCall, "ToolCall");

          // SCRUM-372: cancel-confirmation gate (classic pipeline — mirrors Gemini path)
          if (fnName === "cancel_appointment" && !session.confirmCancel(fnArgs || {}, Date.now())) {
            console.warn(`[CancelGate] Holding cancel_appointment pending confirmation (classic). callSid=${session.callSid}`);
            session.toolCallAudit.push({ name: "cancel_appointment_held", successful: false, at: Date.now() });
            session.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "DO NOT CANCEL YET. Before cancelling, confirm with the caller: read back which appointment would be cancelled (its date and time) and ask them — in their language — to clearly confirm (yes/no). ONLY if they clearly say yes, call cancel_appointment again with the same details. If they say no or you are unsure, do NOT cancel.",
            });
            continue;
          }

          // SCRUM-257: rebook intercept (classic pipeline — mirrors Gemini path)
          if (fnName === "book_appointment" && session.confirmedBookings?.size > 0) {
            const reqKey = bookingKey(fnArgs);
            const existing = session.confirmedBookings.get(reqKey);
            if (existing) {
              console.warn(`[RebookGuard] Blocking duplicate book_appointment (classic) — code=${existing.code} callSid=${session.callSid}`);
              session.messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: `CRITICAL: You already booked this exact appointment in this call. The booking is LOCKED in the database. DO NOT call book_appointment again.`,
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

          const resultMessage = typeof toolResult === "string" ? toolResult : toolResult.message;
          console.log(`[ToolCall] ${fnName} result: "${resultMessage.slice(0, 100)}..."`);

          // SCRUM-257: track confirmed bookings (classic pipeline)
          if (fnName === "book_appointment" && (resultMessage.includes("confirmed") || resultMessage.includes("booked") || resultMessage.includes("confirmation"))) {
            if (!session.confirmedBookings) session.confirmedBookings = new Map();
            const bookKey = bookingKey(fnArgs);
            const codeMatch = resultMessage.match(/\b(\d{6})\b/);
            session.confirmedBookings.set(bookKey, {
              code: codeMatch?.[1] || "unknown",
              datetime: fnArgs.datetime,
              name: `${fnArgs.first_name || ""} ${fnArgs.last_name || ""}`.trim(),
              at: Date.now(),
            });
          }
          if (fnName === "cancel_appointment" && !resultMessage.toLowerCase().includes("error") && !resultMessage.toLowerCase().includes("not found")) {
            if (session.confirmedBookings) session.confirmedBookings.clear();
          }

          // Apply optimistic cache delta for write operations
          if (session.scheduleSnapshot) {
            if (fnName === "book_appointment" && (resultMessage.includes("confirmed") || resultMessage.includes("booked") || resultMessage.includes("confirmation"))) {
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

          // Track transfer attempt on session for call metadata
          if (toolResult.transferAttempt) {
            session.transferAttempt = toolResult.transferAttempt;
          }

          // Handle transfer action — announce, save state for fallback, close STT
          if (toolResult.action === "transfer" && toolResult.transferTo) {
            hold.stop();
            await sendTTS(session, twilioWs, resultMessage);
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
        }

        // Continue loop — LLM will process tool results
        continue;
      }
    }

    if (!reply) {
      hold.stop();
      reply = getErrorMsg(session.language, "repeatRequest");
      console.warn(`[Pipeline] Tool call loop exhausted after ${MAX_TOOL_ITERATIONS} iterations (callSid=${session.callSid})`);
      await sendTTS(session, twilioWs, reply);
    }

    session.addMessage("assistant", reply);

    // Detect what input the AI is expecting next and adapt buffering
    const nextInputType = detectExpectedInput(reply);
    session.setExpectedInputType(nextInputType);
    if (nextInputType !== "general") {
      console.log(`[InputDetect] Next expected: ${nextInputType}`);
    }
  } catch (err) {
    hold.stop();
    const errorSource = err.message?.includes("OpenAI") ? "llm"
      : err.message?.includes("Deepgram TTS") ? "tts"
      : "unknown";
    console.error(`[Pipeline] ${errorSource} error (callSid=${session.callSid}):`, err);
    // Remove the user message that never got a reply
    if (session.messages.length > 0 && session.messages[session.messages.length - 1].role === "user") {
      session.messages.pop();
    }
    try {
      await sendTTS(session, twilioWs, getErrorMsg(session.language, "troubleRepeat"));
    } catch (ttsErr) {
      console.error("[Pipeline] Failed to send error message to caller:", ttsErr);
    }
  } finally {
    session.isProcessing = false;
    session.drainPending((text) => handleUserSpeech(session, twilioWs, text));
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

async function sendTTS(session, twilioWs, text) {
  const t0 = Date.now();
  const cleanText = stripMarkdown(text);
  const audioBuffer = await synthesizeSpeech(DEEPGRAM_API_KEY, cleanText, {
    voice: session?.deepgramVoice,
  });
  console.log(`[TTS] (${Date.now() - t0}ms) ${audioBuffer.length} bytes`);

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
  }

  // Playback duration in ms (8kHz mulaw = 8 bytes/ms). Chunks are pushed
  // into the WS immediately, but Twilio plays them in real time — callers
  // that close the stream early must wait this long or the tail is cut off
  // (SCRUM-424: the setup-timeout apology was truncated mid-sentence by a
  // fixed 2s close).
  return audioBuffer.length / 8;
}

/**
 * Send clear event to flush Twilio's audio buffer (barge-in).
 */
function sendClear(session, twilioWs) {
  if (twilioWs.readyState !== WebSocket.OPEN) return;
  twilioWs.send(
    JSON.stringify({
      event: "clear",
      streamSid: session.streamSid,
    })
  );
  console.log("[Barge-in] Cleared Twilio audio buffer");
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
        console.log("[TestGeminiLive] Initializing Gemini 3.1 Flash Live for test call");

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
// boot. With min_machines_running=1 on Fly this runs once and the path stays warm.
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

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Voice server listening on port ${PORT}`);
  console.log(`Voice pipeline: ${VOICE_PIPELINE}${VOICE_PIPELINE === "gemini-live" ? " (Gemini 3.1 Flash Live)" : ` (LLM: ${LLM_PROVIDER}/${FULL_MODEL})`}`);
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
