require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { CallSession } = require("./call-session");
const { openDeepgramStream } = require("./services/deepgram-stt");
const { getChatResponse, streamChatResponse } = require("./services/openai-llm");
const { synthesizeSpeech, chunkAudioForTwilio } = require("./services/deepgram-tts");
const { loadCallContext, loadTestCallContext } = require("./lib/call-context");
const { buildSystemPrompt, getGreeting } = require("./lib/prompt-builder");
const { createCallRecord, completeCallRecord, notifyCallCompleted } = require("./lib/call-logger");
const { calendarToolDefinitions, transferToolDefinition, callbackToolDefinition, executeToolCall } = require("./services/tool-executor");
const { analyzeCallTranscript } = require("./services/post-call-analysis");
const { getDeepgramVoice } = require("./lib/voice-mapping");
const { generateHoldAudio, getHoldPreset } = require("./lib/hold-audio");
const { detectExpectedInput } = require("./lib/input-type-detector");
const { requiresRecordingDisclosureHybrid, getRecordingDisclosureText } = require("./lib/recording-consent");
const { getSupabase } = require("./lib/supabase");
const { saveForTransfer, getTransfer, consumeTransfer, finishTransferredCall } = require("./lib/pending-transfers");

// Validate required env vars before deriving any constants
const REQUIRED_ENV = [
  "DEEPGRAM_API_KEY",
  "OPENAI_API_KEY",
  "PUBLIC_URL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3001;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WS_SECRET = process.env.TWILIO_AUTH_TOKEN;
const WS_URL = PUBLIC_URL.replace(/^http/, "ws") + "/ws/audio";
const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const TEST_CALL_SECRET = process.env.TEST_CALL_SECRET;

if (!INTERNAL_API_URL || !INTERNAL_API_SECRET) {
  console.warn("[Startup] INTERNAL_API_URL or INTERNAL_API_SECRET not set — post-call notifications will be skipped");
}

if (!TEST_CALL_SECRET) {
  console.warn("[Startup] TEST_CALL_SECRET not set — browser test calls will be disabled");
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
 * to gate calendar tools and customize prompts/greetings.
 */
function resolveAfterHoursState(context) {
  const isAfterHours = context.isAfterHours || false;
  const afterHoursConfig = context.afterHoursConfig || null;
  const afterHoursEnabled = !!(context.assistant.promptConfig?.behaviors?.afterHoursHandling);
  const isActive = isAfterHours && afterHoursEnabled;

  // Disable scheduling after hours unless disableScheduling is explicitly false
  const effectiveCalendarEnabled = (isActive && (afterHoursConfig?.disableScheduling ?? true))
    ? false
    : (context.calendarEnabled || false);

  return { isAfterHours: isActive, afterHoursConfig, effectiveCalendarEnabled };
}

// Global error handlers to prevent silent crashes
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
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

function issueStreamToken(calledNumber, callerPhone, reconnectCallSid) {
  const ts = Date.now().toString();
  const hmac = crypto.createHmac("sha256", WS_SECRET).update(ts).digest("hex");
  const token = `${ts}.${hmac}`;
  pendingTokens.set(token, { issuedAt: Date.now(), calledNumber, callerPhone, reconnectCallSid });
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
    return { calledNumber: entry.calledNumber, callerPhone: entry.callerPhone, reconnectCallSid: entry.reconnectCallSid };
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
app.post("/twiml", (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn("[TwiML] Rejected request — invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }

  const called = req.body.Called || "";
  const from = req.body.From || "";
  // Store call metadata server-side with the token — NOT in the TwiML response
  const token = issueStreamToken(called, from);
  console.log(`[TwiML] Incoming call from=${from} to=${called}, streaming to ${WS_URL}`);

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

    const transcript = s.getTranscript();
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
        });
      } catch (err) {
        console.error("[Cleanup] Failed to complete call record:", err);
      }
    } else if (durationSeconds > 0) {
      console.error("[Cleanup] Call completed with no database record — call data is lost:", {
        callSid: s.callSid,
        organizationId: s.organizationId,
        callerPhone: s.callerPhone,
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

          const { calledNumber, callerPhone, reconnectCallSid } = tokenData;

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
                  console.log(`[STT] Final: "${transcript}"`);
                  session.bufferTranscript(transcript, (combined) => {
                    console.log(`[STT] Buffered: "${combined}"`);
                    session.queueOrProcess(combined, (text) => handleUserSpeech(session, twilioWs, text));
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
                  if (code !== 1000 && code !== 1005 && session) {
                    console.error(`[STT] Connection lost during active call (callSid=${session.callSid})`);
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
          console.log(`[Twilio] Stream started — callSid=${callSid} streamSid=${streamSid} called=${calledNumber} from=${callerPhone}`);

          // Load call context from database
          let context = null;
          if (calledNumber) {
            try {
              context = await loadCallContext(calledNumber);
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

          // After-hours detection
          const { isAfterHours, afterHoursConfig, effectiveCalendarEnabled } = resolveAfterHoursState(context);
          session.calendarEnabled = effectiveCalendarEnabled;

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
            }
          );
          session.setSystemPrompt(systemPrompt);

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

          // Open Deepgram STT WebSocket
          session.deepgramWs = openDeepgramStream(DEEPGRAM_API_KEY, {
            language: session.language,
            onTranscript: ({ transcript, isFinal }) => {
              if (!isFinal) return;
              console.log(`[STT] Final: "${transcript}"`);
              session.bufferTranscript(transcript, (combined) => {
                console.log(`[STT] Buffered: "${combined}"`);
                session.queueOrProcess(combined, (text) => handleUserSpeech(session, twilioWs, text));
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
              if (code !== 1000 && code !== 1005 && session) {
                console.error(`[STT] Connection lost during active call (callSid=${session.callSid})`);
              }
            },
          }, { industry: session.organization?.industry });

          // Play recording disclosure if required by jurisdiction (hybrid: checks both org + caller state)
          let disclosurePrefix = "";
          const consentResult = requiresRecordingDisclosureHybrid(
            context.organization.country,
            context.organization.businessState,
            context.organization.recordingConsentMode,
            session.callerPhone
          );
          session.callerState = consentResult.callerState;
          session.consentReason = consentResult.reason;
          console.log(`[Recording] Consent: required=${consentResult.required}, callerState=${consentResult.callerState}, reason=${consentResult.reason}`);

          if (consentResult.required) {
            const disclosureText = getRecordingDisclosureText(context.organization.country);
            try {
              await sendTTS(session, twilioWs, disclosureText);
              session.recordingDisclosurePlayed = true;
              // Add to conversation history so LLM knows disclosure was played
              session.addMessage("assistant", disclosureText);
            } catch (err) {
              // Fallback: prepend disclosure to greeting so it's always delivered.
              // In two-party consent jurisdictions, proceeding without disclosure is illegal.
              console.error("[Recording] Disclosure TTS failed — prepending to greeting as fallback:", err);
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
            await sendTTS(session, twilioWs, greeting);
            // Mark disclosure as played only after TTS succeeds (when greeting carries it)
            if (disclosurePrefix) {
              session.recordingDisclosurePlayed = true;
            }
          } catch (err) {
            console.error("[TTS] Failed to send greeting — caller will hear silence until they speak:", err);
          }
          // Always add greeting to history so LLM context is consistent
          session.addMessage("assistant", greeting);
          const greetingInputType = detectExpectedInput(greeting);
          session.setExpectedInputType(greetingInputType);
          console.log(`[InputDetect] After greeting: ${greetingInputType}`);
          break;
        }

        case "media": {
          if (!session || !session.deepgramWs) break;
          // Forward raw mulaw audio to Deepgram (no conversion needed)
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

  twilioWs.on("close", () => {
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
  if (session.calendarEnabled) tools.push(...calendarToolDefinitions);
  if (includeTransfer && session.transferRules?.length > 0) tools.push(transferToolDefinition);
  // Callback tool is always available — universal fallback
  tools.push(callbackToolDefinition);
  return tools.length > 0 ? { tools } : {};
}

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
async function handleUserSpeech(session, twilioWs, transcript) {
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

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const t0 = Date.now();

      // Stream sentence-by-sentence for text responses, accumulate for tool calls
      const sentenceQueue = [];
      let ttsChain = Promise.resolve();
      let holdStopped = false;

      const result = await streamChatResponse(OPENAI_API_KEY, session.messages, {
        ...llmOptions,
        onSentence: (sentence) => {
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

      if (result.type === "content") {
        reply = result.content;
        // Wait for all queued TTS to finish playing
        await ttsChain;
        console.log(`[LLM] (${Date.now() - t0}ms) streamed ${sentenceQueue.length} chunks: "${reply}"`);
        break;
      }

      // Tool call response — execute tools and loop (no streaming for tool calls)
      if (result.type === "tool_calls") {
        const toolCalls = result.toolCalls;
        console.log(`[LLM] (${Date.now() - t0}ms) Tool calls: ${toolCalls.map((tc) => tc.function.name).join(", ")}`);

        // Add the assistant's tool call message to conversation
        session.messages.push(result.message);

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
async function sendTTS(session, twilioWs, text) {
  const t0 = Date.now();
  const audioBuffer = await synthesizeSpeech(DEEPGRAM_API_KEY, text, {
    voice: session?.deepgramVoice,
  });
  console.log(`[TTS] (${Date.now() - t0}ms) ${audioBuffer.length} bytes`);

  const chunks = chunkAudioForTwilio(audioBuffer);
  session.isSpeaking = true;

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
          effectiveCalendarEnabled = (afterHoursConfig?.disableScheduling ?? true)
            ? false
            : (context.calendarEnabled || false);
        } else {
          console.warn(`[TestAfterHours] simulateAfterHours requested but afterHoursHandling is disabled — ignoring`);
        }
      }

      session.calendarEnabled = effectiveCalendarEnabled;

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
        }
      );
      session.setSystemPrompt(systemPrompt);

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
          session.bufferTranscript(transcript, (combined) => {
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
        const disclosureText = getRecordingDisclosureText(context.organization.country);
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

      // Signal ready
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
      // Raw mulaw audio from browser — forward to Deepgram
      if (session.deepgramWs && session.deepgramWs.readyState === WebSocket.OPEN) {
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

      const result = await streamChatResponse(OPENAI_API_KEY, session.messages, {
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

server.listen(PORT, () => {
  console.log(`Voice server listening on port ${PORT}`);
  console.log(`TwiML endpoint: ${PUBLIC_URL}/twiml`);
  console.log(`WebSocket endpoint: ${WS_URL}`);
  if (TEST_CALL_SECRET) {
    console.log(`Test call WebSocket: ${PUBLIC_URL.replace(/^http/, "ws")}/ws/test`);
  }
});
