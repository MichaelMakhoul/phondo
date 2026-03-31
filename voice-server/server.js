require("dotenv").config();

const { initSentry, Sentry } = require("./lib/sentry");
initSentry();

const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { CallSession } = require("./call-session");
const { openDeepgramStream } = require("./services/deepgram-stt");
const { getChatResponse, streamChatResponse, LLM_PROVIDER, DEFAULT_MODEL } = require("./services/openai-llm");
const { synthesizeSpeech, chunkAudioForTwilio } = require("./services/deepgram-tts");
const { loadCallContext, loadTestCallContext } = require("./lib/call-context");
const { buildSystemPrompt, getGreeting } = require("./lib/prompt-builder");
const { createCallRecord, completeCallRecord, notifyCallCompleted } = require("./lib/call-logger");
const { calendarToolDefinitions, listServiceTypesToolDefinition, transferToolDefinition, callbackToolDefinition, executeToolCall } = require("./services/tool-executor");
const { createGeminiSession } = require("./services/gemini-live");

const VOICE_PIPELINE = process.env.VOICE_PIPELINE || "classic"; // "classic" or "gemini-live"

// Audio caches — used by classic pipeline only (Gemini Live uses native TTS)
const disclosureAudioCache = new Map();
const { analyzeCallTranscript } = require("./services/post-call-analysis");
const { getDeepgramVoice, getGeminiVoice } = require("./lib/voice-mapping");
const { generateHoldAudio, getHoldPreset } = require("./lib/hold-audio");
const { detectExpectedInput } = require("./lib/input-type-detector");
const { requiresRecordingDisclosureHybrid, getRecordingDisclosureText } = require("./lib/recording-consent");
const { getSupabase } = require("./lib/supabase");
const { saveForTransfer, getTransfer, consumeTransfer, finishTransferredCall } = require("./lib/pending-transfers");

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

/**
 * Mask a phone number for safe logging — keeps first 3 and last 3 chars.
 * e.g. "+61412345678" → "+61***678"
 */
function maskPhone(phone) {
  if (!phone || phone.length < 6) return phone || "unknown";
  return phone.slice(0, 3) + "***" + phone.slice(-3);
}

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
const WS_SECRET = process.env.TWILIO_AUTH_TOKEN;
const WS_URL = PUBLIC_URL.replace(/^http/, "ws") + "/ws/audio";
const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const TEST_CALL_SECRET = process.env.TEST_CALL_SECRET;

if (!INTERNAL_API_URL || !INTERNAL_API_SECRET) {
  console.warn("[Startup] INTERNAL_API_URL or INTERNAL_API_SECRET not set — post-call notifications will not work (spam analysis, billing, webhooks skipped)");
}

if (!TEST_CALL_SECRET) {
  console.warn("[Startup] TEST_CALL_SECRET not set — browser test calls will be disabled (token validation will reject all requests)");
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

// Global error handlers to prevent silent crashes
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason);
  Sentry.captureException(reason);
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

  // Single phone number lookup — shared across isAiEnabled, getAnswerMode, and loadCallContext
  const phoneRecord = await lookupPhoneNumber(called);

  // Check if AI answering is disabled for this number (emergency shutoff)
  try {
    const aiEnabled = await isAiEnabled(called, phoneRecord);
    if (!aiEnabled) {
      const callSid = req.body.CallSid || `ai_disabled_${Date.now()}`;
      console.log(`[TwiML] AI disabled for ${called} — returning voicemail TwiML (callSid=${callSid})`);

      // Log call so owner sees it in dashboard (uses createCallRecord for correct schema)
      let ctx = null;
      try {
        ctx = await getPhoneNumberContext(called, phoneRecord);
        if (ctx) {
          const callId = await createCallRecord({
            orgId: ctx.organizationId,
            assistantId: ctx.assistantId,
            phoneNumberId: ctx.phoneNumberId,
            callerPhone: from,
            callSid,
          });
          if (callId) {
            await completeCallRecord(callId, {
              status: "completed",
              durationSeconds: 0,
              outcome: "voicemail",
            });
          }
        }
      } catch (logErr) {
        console.warn("[TwiML] Failed to log AI-disabled call (non-fatal):", logErr.message);
      }

      const businessName = typeof ctx?.organizationName === "string" ? ctx.organizationName : null;
      const greeting = businessName
        ? `Thank you for calling ${escapeXml(businessName)}. We are unable to take your call right now. Please leave a message after the beep and we will get back to you as soon as possible.`
        : `Thank you for calling. We are unable to take your call right now. Please leave a message after the beep and we will get back to you as soon as possible.`;

      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${greeting}</Say>
  <Record maxLength="120" playBeep="true" action="${escapeXml(PUBLIC_URL + '/twiml/ai-disabled-recording-done')}" />
  <Say voice="Polly.Joanna">Thank you for your message. Goodbye.</Say>
</Response>`);
    }
  } catch (err) {
    // Fail-open: if the check itself throws, let AI answer
    console.error("[TwiML] isAiEnabled check threw (fail-open):", err.message);
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
    // Non-fatal — fall through to default AI-first behavior
    console.error("[TwiML] getAnswerMode failed (falling back to AI):", err.message);
  }

  // Default: AI answers immediately — pass phoneRecord to avoid re-querying in loadCallContext
  const token = issueStreamToken(called, from, undefined, phoneRecord);
  console.log(`[TwiML] Incoming call from=${maskPhone(from)} to=${called}, streaming to ${WS_URL}`);

  // Recording is started via Twilio REST API in the WebSocket handler (not TwiML)
  // because <Connect record="record-from-answer"> doesn't work with <Stream>.

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
      const crypto = require("crypto");
      const headerSecret = req.headers["x-telnyx-secret"] || req.query?.secret;
      if (!headerSecret || headerSecret.length !== secret.length) return false;
      return crypto.timingSafeEqual(Buffer.from(headerSecret), Buffer.from(secret));
    }
    // No verification configured — reject in production, allow in dev
    if (process.env.NODE_ENV === "production") {
      console.error("[TeXML] No TELNYX_PUBLIC_KEY or TELNYX_WEBHOOK_SECRET configured — rejecting");
      return false;
    }
    return true;
  }

  try {
    const crypto = require("crypto");
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

  const phoneRecord = await lookupPhoneNumber(called);

  // AI enabled check
  try {
    const aiEnabled = await isAiEnabled(called, phoneRecord);
    if (!aiEnabled) {
      const callSid = req.body.CallSid || `ai_disabled_${Date.now()}`;
      console.log(`[TeXML] AI disabled for ${called} — returning voicemail TeXML`);

      let ctx = null;
      try {
        ctx = await getPhoneNumberContext(called, phoneRecord);
        if (ctx) {
          const callId = await createCallRecord({ orgId: ctx.organizationId, assistantId: ctx.assistantId, phoneNumberId: ctx.phoneNumberId, callerPhone: from, callSid });
          if (callId) {
            await completeCallRecord(callId, { status: "completed", durationSeconds: 0, outcome: "voicemail" });
          }
        }
      } catch (logErr) {
        console.warn("[TeXML] Failed to log AI-disabled call (non-fatal):", logErr.message);
      }

      const businessName = typeof ctx?.organizationName === "string" ? ctx.organizationName : null;
      const greeting = businessName
        ? `Thank you for calling ${escapeXml(businessName)}. We are unable to take your call right now. Please leave a message after the beep and we will get back to you as soon as possible.`
        : `Thank you for calling. We are unable to take your call right now. Please leave a message after the beep and we will get back to you as soon as possible.`;

      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${greeting}</Say>
  <Record maxLength="120" playBeep="true" action="${escapeXml(PUBLIC_URL + '/texml/recording-done')}" />
  <Say voice="Polly.Joanna">Thank you for your message. Goodbye.</Say>
</Response>`);
    }
  } catch (err) {
    console.error("[TeXML] isAiEnabled check threw (fail-open):", err.message);
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
    console.error("[TeXML] getAnswerMode failed (falling back to AI):", err.message);
  }

  // Default: AI answers
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
  const ringFirstShouldRecord = ringFirstRecordingMode !== "never";
  const ringFirstConnectAttrs = ringFirstShouldRecord
    ? ` record="record-from-answer" recordingStatusCallback="${escapeXml(PUBLIC_URL + '/twiml/recording-status')}" recordingStatusCallbackMethod="POST"`
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

// Recording status callback — Twilio POSTs here after <Connect record="record-from-answer"> finishes.
// Saves the recording URL to the call record for dashboard playback.
app.post("/twiml/recording-status", async (req, res) => {
  // Validate Twilio signature to prevent spoofed recording URLs
  if (!validateTwilioSignature(req)) {
    console.warn("[Recording] Rejected recording-status callback — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }

  try {
    const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;

    if (!CallSid || !RecordingUrl) {
      console.warn("[Recording] Missing required fields in status callback:", {
        hasCallSid: !!CallSid, hasRecordingUrl: !!RecordingUrl,
      });
      return res.status(400).send("Missing required fields");
    }

    // Validate recording URL is from Twilio (defense in depth)
    if (!RecordingUrl.startsWith("https://api.twilio.com/")) {
      console.warn("[Recording] Rejected non-Twilio recording URL:", RecordingUrl.slice(0, 100));
      return res.status(400).send("Invalid recording URL");
    }

    // Twilio recording URLs need .mp3 appended for direct playback
    const playbackUrl = `${RecordingUrl}.mp3`;

    const supabase = getSupabase();

    // Call records use "sh_<CallSid>" as vapi_call_id (legacy naming from Vapi migration)
    const { error } = await supabase
      .from("calls")
      .update({ recording_url: playbackUrl })
      .eq("vapi_call_id", `sh_${CallSid}`);

    if (error) {
      console.error("[Recording] Failed to save recording URL:", {
        CallSid, RecordingSid, error: error.message,
      });
    } else {
      console.log("[Recording] Saved recording URL:", {
        CallSid, RecordingSid, duration: RecordingDuration,
      });
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("[Recording] Status callback error:", err);
    res.status(500).send("Error");
  }
});

// Recording callback for AI-disabled voicemail — Twilio POSTs here after recording ends.
app.post("/twiml/ai-disabled-recording-done", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn("[RecordingDone] Rejected request — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }

  // Best-effort: store recording URL in the call record
  const recordingUrl = req.body.RecordingUrl;
  const callSid = req.body.CallSid;
  if (recordingUrl && callSid) {
    try {
      const supabase = getSupabase();
      const { error } = await supabase
        .from("calls")
        .update({ recording_url: recordingUrl })
        .eq("vapi_call_id", `sh_${callSid}`);
      if (error) {
        console.warn("[RecordingDone] Failed to save recording URL:", {
          callSid, code: error.code, message: error.message,
        });
      }
    } catch (err) {
      console.warn("[RecordingDone] Error saving recording (non-fatal):", err.message);
    }
  }

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for your message. Goodbye.</Say>
  <Hangup/>
</Response>`);
});

// Health check with Supabase connectivity test
app.get("/health", async (req, res) => {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("organizations").select("id").limit(1);
    if (error) throw error;
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    res.status(503).json({ status: "degraded", db: "error", message: err.message });
  }
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

    // If a transfer is pending, don't run post-call processing yet —
    // the /twiml/transfer-status callback or TTL cleanup will handle it.
    if (s.pendingTransfer) {
      console.log(`[Cleanup] Transfer pending for callSid=${s.callSid} — deferring post-call processing`);
      s.destroy();
      return;
    }

    let transcript = s.getTranscript();
    const durationSeconds = s.getDurationSeconds();
    const callStatus = s.callFailed ? "failed" : "completed";
    const endedReason = s.endedReason || "caller-hangup";

    // Run post-call analysis (best-effort, awaited because results feed into the call record)
    let analysis = null;
    if (transcript && durationSeconds > 5) {
      try {
        analysis = await analyzeCallTranscript(transcript);
        if (analysis) {
          console.log(`[PostCall] Analysis complete: caller=${analysis.callerName || "unknown"}, reason=${analysis.callerPhoneReason || "unknown"}, success=${analysis.successEvaluation}`);
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
          sentiment: analysis?.sentiment || null,
          piiRedacted,
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
      msg = JSON.parse(raw);
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
              session.messages = savedState.messages;
              session.organizationId = savedState.organizationId;
              session.assistantId = savedState.assistantId;
              session.phoneNumberId = savedState.phoneNumberId;
              session.callerPhone = savedState.callerPhone;
              session.callRecordId = savedState.callRecordId;
              session.calendarEnabled = savedState.calendarEnabled;
              session.serviceTypes = savedState.serviceTypes || [];
              session.transferRules = savedState.transferRules;
              session.deepgramVoice = savedState.deepgramVoice;
              session.holdPreset = savedState.holdPreset;
              session.organization = savedState.organization;
              session.orgPhoneNumber = savedState.orgPhoneNumber;
              session.transferAttempt = savedState.transferAttempt;
              session.startedAt = savedState.startedAt;
              session.language = savedState.language || "en";
              sessions.set(streamSid, session);

              // Re-open Deepgram STT
              session.deepgramWs = openDeepgramStream(DEEPGRAM_API_KEY, {
                language: session.language,
                onTranscript: ({ transcript, isFinal }) => {
                  if (!isFinal) return;
                  const INTERRUPT_RE_RECONNECT = /^(stop|wait|hold on|no|cancel|nevermind|never mind|excuse me|hello|hey)\b/i;
                  if (session.isSpeaking && transcript.trim().split(/\s+/).length <= 2 && !INTERRUPT_RE_RECONNECT.test(transcript.trim())) {
                    console.log(`[STT] Dropped (echo suppression while AI speaking): "${transcript}"`);
                    return;
                  }
                  console.log(`[STT] Final: "${transcript}"`);
                  session.bufferTranscript(transcript, (combined, inputType) => {
                    console.log(`[STT] Buffered: "${combined}"`);
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
          session.language = context.assistant.language || "en";
          session.deepgramVoice = getDeepgramVoice(context.assistant.voiceId, session.language);
          session.holdPreset = getHoldPreset(context.organization.industry);
          session.organization = {
            timezone: context.organization.timezone,
            businessHours: context.organization.businessHours,
            industry: context.organization.industry,
          };
          session.orgPhoneNumber = calledNumber;
          session.telephonyProvider = context.telephonyProvider || "twilio";
          session.piiRedactionEnabled = !!(context.assistant.settings?.piiRedactionEnabled);

          // Start call recording via Twilio REST API if consent mode allows
          // (Connect record= doesn't work with Stream — must use REST API)
          const recordingConsentMode = context.organization.recordingConsentMode || "auto";
          if (recordingConsentMode !== "never" && callSid) {
            try {
              const recording = await getTwilioRestClient().calls(callSid).recordings.create({
                recordingStatusCallback: `${PUBLIC_URL}/twiml/recording-status`,
                recordingStatusCallbackMethod: "POST",
                recordingChannels: "dual",
              });
              console.log(`[Recording] Started recording for callSid=${callSid} recordingSid=${recording.sid}`);
            } catch (recErr) {
              // Non-fatal — call continues without recording
              console.warn("[Recording] Failed to start recording (non-fatal):", recErr.message);
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
              calendarEnabled: effectiveCalendarEnabled,
              transferRules: session.transferRules,
              isAfterHours,
              afterHoursConfig,
              serviceTypes: context.serviceTypes,
            }
          );
          // Append caller context so the AI knows the caller's phone number
          // If PII redaction is enabled, mask the phone in the prompt
          const phoneForPrompt = session.piiRedactionEnabled ? maskPhone(callerPhone) : callerPhone;
          const callerContext = callerPhone
            ? `\n\nCALLER CONTEXT:\nThe caller's phone number is ${phoneForPrompt}. If they say "use the number I'm calling from" or "it's the same number", use this number. Do NOT ask them to repeat it.`
            : "";
          session.setSystemPrompt(systemPrompt + callerContext);

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
            if (consentResult.required) {
              const disclosureText = getRecordingDisclosureText(
                context.organization.country,
                context.organization.recording_disclosure_text,
                context.organization.name
              );
              // Weave disclosure naturally into the greeting
              firstMessage = `${disclosureText} ${greeting}`;
              session.recordingDisclosurePlayed = true;
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

            geminiSystemPrompt += `\n\nIMPORTANT — YOUR FIRST MESSAGE: When the call connects, you will receive a short text message. Immediately respond by speaking the following greeting (word for word, naturally and warmly): "${firstMessage}" — Then wait for the caller to respond. Do NOT add anything extra. Do NOT invent a receptionist name — you are an AI assistant.`;

            // CRITICAL — tool calling, filler words, and name enforcement
            geminiSystemPrompt += `\n\nCRITICAL RULES FOR THIS CONVERSATION:`;
            geminiSystemPrompt += `\n- ABSOLUTELY NEVER FABRICATE ACTIONS: This is the most important rule. You have tools (book_appointment, schedule_callback, check_availability, lookup_appointment, cancel_appointment, etc). You MUST call the tool AND receive a SUCCESS response BEFORE telling the caller the action was done. NEVER say "I've booked", "I've scheduled", "I've checked", "I've cancelled" UNLESS the tool already returned success. If you need to book, say "Let me book that for you" then call the tool, then ONLY after success say "Done, your appointment is booked." NEVER confirm an action before the tool responds.`;
            // Build name verification instruction based on business config
            // Check verification method for name fields (first_name or legacy full_name)
            const nameField = context.assistant.promptConfig?.fields?.find((f) => f.id === "first_name" || f.id === "full_name");
            const nameVerification = nameField?.verification || "repeat-confirm";
            let nameInstruction = "";
            if (nameVerification === "spell-out") {
              nameInstruction = "Ask them to spell it out letter by letter using the English alphabet (e.g., 'M-I-C-H-A-E-L'). If the caller spells it in another language, ask them to use English letters.";
            } else if (nameVerification === "read-back-characters") {
              nameInstruction = "Read back the name character by character to confirm.";
            } else {
              nameInstruction = "Repeat the name back and ask them to confirm it's correct.";
            }

            geminiSystemPrompt += `\n- NAME COLLECTION IS MANDATORY — ZERO EXCEPTIONS: Before calling book_appointment, you MUST: (1) Ask for FIRST NAME — wait for answer, (2) ${nameInstruction}, (3) Ask for LAST NAME — wait for answer, (4) ${nameInstruction}, (5) ONLY after you have BOTH confirmed names, call book_appointment with first_name and last_name. Names MUST be in English letters. If you are unsure of the spelling, ask again. NEVER call book_appointment until the caller has fully spelled and confirmed BOTH names. If you only have one name, ask for the other BEFORE booking.`;
            geminiSystemPrompt += `\n- CONFIRM BOOKING DETAILS: After book_appointment succeeds, read back ALL details to the caller: name, date, time, practitioner, and confirmation code. Then ask "Is everything correct?" If the caller says something is wrong, fix it (cancel and rebook with the correct details). Do NOT end the booking conversation without confirmation.`;
            geminiSystemPrompt += `\n- FILLER WORDS — SPEAK FIRST, THEN CALL TOOL: When you need to call a tool, you MUST speak a filler phrase FIRST as a separate response BEFORE making the tool call. Say something like "One moment, let me check that" or "Just a sec" and WAIT for the audio to play. THEN make the tool call in the next step. NEVER bundle the filler and tool result into one response. The caller must hear the filler DURING the silence, not after. Example flow: (1) caller asks for availability → (2) you say "Let me check that for you" → (3) you call check_availability → (4) you say "We have slots on Wednesday...". Steps 2 and 4 must be SEPARATE speech outputs.`;
            geminiSystemPrompt += `\n- RESCHEDULING: When a caller asks to reschedule, you MUST: (1) look up their existing appointment with lookup_appointment, (2) cancel the old appointment with cancel_appointment, (3) then book the new one with book_appointment. Do NOT book a new appointment without cancelling the old one first.`;

            // Transcript buffering — accumulate fragments, flush on turn complete
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
                  if (twilioWs.readyState === WebSocket.OPEN) {
                    twilioWs.send(JSON.stringify({
                      event: "media",
                      streamSid: session.streamSid,
                      media: { payload: twilioBase64 },
                    }));
                  }
                },
                onToolCall: async (toolCall) => {
                  console.log(`[GeminiLive] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.args).slice(0, 80)})`);
                  const result = await executeToolCall(toolCall.name, toolCall.args, {
                    organizationId: session.organizationId,
                    assistantId: session.assistantId,
                    callSid: session.callSid,
                    callId: session.callRecordId,
                    transferRules: session.transferRules,
                    organization: session.organization,
                    callerPhone: session.callerPhone,
                    orgPhoneNumber: session.orgPhoneNumber,
                    telephonyProvider: session.telephonyProvider || "twilio",
                  });
                  const message = typeof result === "string" ? result : result.message;
                  console.log(`[GeminiLive] Tool result: "${message.slice(0, 100)}"`);
                  return { message };
                },
                onTranscriptIn: (text) => {
                  // Buffer user transcript fragments — flush on turn complete
                  pendingUserTranscript += text;
                },
                onTranscriptOut: (text) => {
                  // Buffer AI transcript fragments — flush on turn complete
                  pendingAiTranscript += text;
                },
                onInterrupted: () => {
                  // Flush any pending AI transcript before interruption
                  if (pendingAiTranscript.trim()) {
                    session.addMessage("assistant", pendingAiTranscript.trim());
                    console.log(`[GeminiLive] AI: "${pendingAiTranscript.trim().slice(0, 100)}"`);
                    pendingAiTranscript = "";
                  }
                  if (twilioWs.readyState === WebSocket.OPEN) {
                    twilioWs.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));
                  }
                },
                onTurnComplete: () => {
                  // Flush accumulated transcripts as complete messages
                  if (pendingUserTranscript.trim()) {
                    session.addMessage("user", pendingUserTranscript.trim());
                    console.log(`[GeminiLive] User (turn): "${pendingUserTranscript.trim()}"`);
                    pendingUserTranscript = "";
                  }
                  if (pendingAiTranscript.trim()) {
                    session.addMessage("assistant", pendingAiTranscript.trim());
                    console.log(`[GeminiLive] AI (turn): "${pendingAiTranscript.trim().slice(0, 100)}"`);
                    pendingAiTranscript = "";
                  }
                },
                onError: (err) => {
                  console.error("[GeminiLive] Session error:", err.message);
                  if (session) {
                    session.callFailed = true;
                    session.endedReason = "gemini-error";
                  }
                  // Close the Twilio call — caller would be stuck in silence otherwise
                  if (twilioWs.readyState === WebSocket.OPEN) {
                    setTimeout(() => twilioWs.close(1000, "Gemini session error"), 1000);
                  }
                },
                onClose: (code) => {
                  console.log(`[GeminiLive] Session closed (code=${code})`);
                  // If Gemini closes unexpectedly mid-call, end the Twilio call too
                  if (session && !session.callFailed && twilioWs.readyState === WebSocket.OPEN) {
                    console.warn("[GeminiLive] Unexpected session close — ending Twilio call");
                    session.callFailed = true;
                    session.endedReason = "gemini-session-closed";
                    setTimeout(() => twilioWs.close(1000, "Gemini session closed"), 1000);
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
                console.log(`[STT] Dropped (echo suppression while AI speaking): "${transcript}"`);
                return;
              }
              console.log(`[STT] Final: "${transcript}"`);
              session.bufferTranscript(transcript, (combined, inputType) => {
                console.log(`[STT] Buffered: "${combined}"`);
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
  if (includeTransfer && session.transferRules?.length > 0) tools.push(transferToolDefinition);
  // Callback tool is always available — universal fallback
  tools.push(callbackToolDefinition);
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
};

// Short/closing responses that don't need a filler (the AI should respond quickly to these)
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
      // Only fires once per turn (fillerSentThisTurn guard) and skips closing responses
      const skipFiller = fillerSentThisTurn || NO_FILLER_RE.test(transcript.trim());
      const fillerTimer = skipFiller ? null : setTimeout(() => {
        if (!holdStopped && !fillerSentThisTurn) {
          fillerSentThisTurn = true;
          hold.stop();
          holdStopped = true;
          const msgs = FILLER_MESSAGES[session.language] || FILLER_MESSAGES.en;
          console.log(`[Filler] "${msgs.waiting}"`);
          ttsChain = ttsChain.then(() => sendTTS(session, twilioWs, msgs.waiting)).catch((err) => {
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
          ttsChain = ttsChain.then(() => sendTTS(session, twilioWs, sentence)).catch((err) => {
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
        console.log(`[LLM] (${Date.now() - t0}ms) streamed ${sentenceQueue.length} chunks (avg=${avgChunkLen}ch, short=${shortChunks}): "${reply}"`);
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
          ttsChain = ttsChain.then(() => sendTTS(session, twilioWs, toolFiller)).catch((err) => {
            console.error("[Filler] TTS error:", err.message);
          });
        }

        // Execute each tool call and add results
        for (const toolCall of toolCalls) {
          const fnName = toolCall.function.name;
          const fnArgs = parseToolArgs(toolCall, "ToolCall");

          const toolResult = await executeToolCall(fnName, fnArgs, {
            organizationId: session.organizationId,
            assistantId: session.assistantId,
            callSid: session.callSid,
            callId: session.callRecordId,
            transferRules: session.transferRules,
            organization: session.organization,
            callerPhone: session.callerPhone,
            orgPhoneNumber: session.orgPhoneNumber,
            telephonyProvider: session.telephonyProvider || "twilio",
          });

          const resultMessage = typeof toolResult === "string" ? toolResult : toolResult.message;
          console.log(`[ToolCall] ${fnName} result: "${resultMessage.slice(0, 100)}..."`);

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

// Route WebSocket upgrades by path — ws library doesn't support multiple
// WebSocketServer instances with { server, path } on the same HTTP server.
server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === "/ws/audio") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else if (pathname === "/ws/test") {
    testWss.handleUpgrade(request, socket, head, (ws) => {
      testWss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});
const MAX_TEST_CALL_DURATION_MS = 5 * 60 * 1000; // 5 minutes

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

  const { assistantId, organizationId, simulateAfterHours } = tokenData;
  let session = null;
  let cleaningUp = false;
  let autoEndTimer = null;

  async function cleanupTestSession() {
    if (cleaningUp) return;
    cleaningUp = true;

    if (autoEndTimer) {
      clearTimeout(autoEndTimer);
      autoEndTimer = null;
    }

    if (session) {
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

  // Auto-disconnect after max duration
  autoEndTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ended", reason: "max-duration" }));
      ws.close(1000, "Max duration reached");
    }
  }, MAX_TEST_CALL_DURATION_MS);

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
      session.deepgramVoice = getDeepgramVoice(context.assistant.voiceId, session.language);
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
        geminiSystemPrompt += `\n- ALWAYS COLLECT REAL NAME: Before calling book_appointment or schedule_callback, you MUST ask for and receive the caller's actual name. NEVER use placeholder names like "Caller Name", "Unknown", or "Guest".`;
        geminiSystemPrompt += `\n- ALWAYS SAY FILLER BEFORE EVERY TOOL CALL: Before EVERY tool call, you MUST say a short filler phrase like "One moment", "Let me check", "Just a sec", "Bear with me". NEVER go silent during a tool call.`;
        geminiSystemPrompt += `\n- RESCHEDULING: When a caller asks to reschedule, you MUST: (1) look up their existing appointment with lookup_appointment, (2) cancel the old appointment with cancel_appointment, (3) then book the new one with book_appointment.`;

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
              console.log(`[TestGeminiLive] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.args).slice(0, 80)})`);
              const result = await executeToolCall(toolCall.name, toolCall.args, {
                organizationId: session.organizationId,
                assistantId: session.assistantId,
                callSid: session.callSid,
                transferRules: [],
                testMode: true,
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
          console.log(`[TestSTT] Final: "${transcript}"`);
          session.bufferTranscript(transcript, (combined, inputType) => {
            console.log(`[TestSTT] Buffered: "${combined}"`);
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
        console.log(`[TestLLM] (${Date.now() - t0}ms) streamed ${sentenceCount} chunks: "${reply}"`);
        break;
      }

      if (result.type === "tool_calls") {
        console.log(`[TestLLM] (${Date.now() - t0}ms) Tool calls: ${result.toolCalls.map((tc) => tc.function.name).join(", ")}`);
        session.messages.push(result.message);

        for (const toolCall of result.toolCalls) {
          const fnName = toolCall.function.name;
          const fnArgs = parseToolArgs(toolCall, "TestToolCall");

          const toolResult = await executeToolCall(fnName, fnArgs, {
            organizationId: session.organizationId,
            assistantId: session.assistantId,
            callSid: session.callSid,
            transferRules: [],
            testMode: true,
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Voice server listening on port ${PORT}`);
  console.log(`Voice pipeline: ${VOICE_PIPELINE}${VOICE_PIPELINE === "gemini-live" ? " (Gemini 3.1 Flash Live)" : ` (LLM: ${LLM_PROVIDER}/${FULL_MODEL})`}`);
  console.log(`TwiML endpoint: ${PUBLIC_URL}/twiml`);
  console.log(`WebSocket endpoint: ${WS_URL}`);
  if (TEST_CALL_SECRET) {
    console.log(`Test call WebSocket: ${PUBLIC_URL.replace(/^http/, "ws")}/ws/test`);
  }

});
