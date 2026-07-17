/**
 * Gemini 3.1 Flash Live — WebSocket client for real-time voice AI.
 *
 * Replaces the Deepgram STT → OpenAI LLM → Deepgram TTS pipeline with
 * a single audio-to-audio model. Handles session setup, audio streaming,
 * tool calls, barge-in, and transcription.
 */

const WebSocket = require("ws");
const { twilioToGemini, geminiToTwilio } = require("../lib/audio-converter");
const { createSessionFrontend } = require("../lib/audio-frontend");
const { TurnGate, customVadEnabled } = require("../lib/turn-gate");
const { Sentry } = require("../lib/sentry");
const { logTranscript } = require("../lib/log-transcript");

const GEMINI_MODEL = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Convert OpenAI-style tool definitions to Gemini's functionDeclarations format.
 */
function convertToolsToGemini(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: convertSchemaToGemini(t.function.parameters),
    }));
}

function convertSchemaToGemini(schema) {
  if (!schema) return { type: "OBJECT", properties: {} };
  const result = { type: (schema.type || "object").toUpperCase() };
  if (schema.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      result.properties[key] = {
        type: (val.type || "string").toUpperCase(),
        description: val.description || "",
        ...(val.enum && { enum: val.enum }),
      };
    }
  }
  if (schema.required) result.required = schema.required;
  return result;
}

/**
 * Create a Gemini Live session.
 *
 * @param {object} config
 * @param {string} config.systemPrompt - Full system prompt
 * @param {object[]} config.tools - OpenAI-format tool definitions
 * @param {string} [config.voiceName] - Gemini voice name (default: "Kore")
 * @param {boolean} [config.triggerGreeting=true] - Send realtimeInput.text to nudge AI to speak first. Disable for outbound caller personas that should wait for the other side.
 * @param {object} callbacks
 * @param {function} callbacks.onAudio - (base64MulawChunk: string) => void — Twilio-ready audio
 * @param {function} callbacks.onToolCall - (toolCall: {id, name, args}) => Promise<any> — execute tool
 * @param {function} callbacks.onTranscriptIn - (text: string) => void — user's speech transcription
 * @param {function} callbacks.onTranscriptOut - (text: string) => void — AI's speech transcription
 * @param {function} callbacks.onInterrupted - () => void — user barged in
 * @param {function} callbacks.onTurnComplete - () => void — AI finished speaking
 * @param {function} callbacks.onError - (err: Error) => void
 * @param {function} [callbacks.onSetupComplete] - () => void — Gemini acked setup; the failover window (SCRUM-535) is closed
 * @param {function} [callbacks.onSetupTimeout] - (err: Error) => void — setup
 *   handshake never completed within the deadline (caller stranded in
 *   silence). Optional: when absent, the timeout is routed to onError so
 *   existing call sites are covered without changes (SCRUM-424).
 * @param {function} callbacks.onClose - (code: number, reason: string) => void — reason is "end_call" when closed via end_call tool, empty otherwise
 * @returns {{
 *   sendAudio: (twilioBase64: string) => void,
 *   getTranscripts: () => { input: string, output: string },
 *   sendText: (text: string) => void,
 *   close: () => void,
 *   readyState: number
 * }} Session handle. Note `ws` is intentionally NOT exposed (its URL
 *   carries the API key) — use `readyState` instead.
 */
/**
 * Default deadline for the Gemini setup handshake (WS connect + setup →
 * setupComplete). Normal setup completes in well under 2s; 10s means
 * something is genuinely stuck, not slow.
 */
const DEFAULT_SETUP_TIMEOUT_MS = 10_000;

/**
 * Arm a one-shot watchdog for the setup handshake (SCRUM-424, finding #10).
 * Without it, a stalled Gemini connect/setup strands the caller in silence
 * indefinitely — Twilio just keeps streaming into a session that never
 * answers. Pure helper so the timing logic is unit-testable.
 *
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {() => boolean} opts.isSetupComplete
 * @param {() => void} opts.onTimeout - invoked once iff setup never completed
 * @returns {{ clear: () => void }}
 */
function armSetupWatchdog({ timeoutMs, isSetupComplete, onTimeout }) {
  const timer = setTimeout(() => {
    if (!isSetupComplete()) onTimeout();
  }, timeoutMs);
  // Never keep the process alive just for a watchdog.
  if (typeof timer.unref === "function") timer.unref();
  return { clear: () => clearTimeout(timer) };
}

/**
 * Resolve the setup deadline from config/env with a sanity floor. A negative
 * or sub-second override (env typo, seconds-instead-of-ms) would otherwise
 * arm a watchdog that fires before any setup could complete — turning ONE
 * misconfigured Fly secret into a 100% inbound-call outage (SCRUM-424
 * review). Out-of-range values fall back to the default, loudly.
 */
function resolveSetupTimeoutMs(configValue, envValue) {
  const raw = Number(configValue) || Number(envValue) || DEFAULT_SETUP_TIMEOUT_MS;
  if (raw >= 1000) return raw;
  console.warn(`[GeminiLive] Ignoring out-of-range setup timeout ${raw}ms — using default ${DEFAULT_SETUP_TIMEOUT_MS}ms`);
  return DEFAULT_SETUP_TIMEOUT_MS;
}

function createGeminiSession(config, callbacks) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for Gemini Live");
  }

  // Note: API key in URL is Google's only auth method for this endpoint.
  // Do NOT expose the ws object — use readyState getter only.
  const url = `${GEMINI_ENDPOINT}?key=${apiKey}`;
  const ws = new WebSocket(url);
  const sessionStartTime = Date.now();

  let setupComplete = false;

  // Setup watchdog: armed from creation (covers a stalled TCP/WS connect as
  // well as a stalled setup exchange). Cleared on setupComplete / error /
  // close. On fire: surface via onSetupTimeout when provided, else onError —
  // every existing call site already implements onError, so this is
  // backward-compatible — then close the socket. The server-side handler is
  // responsible for ending the Twilio call (it already does for onError).
  //
  // watchdogFired makes the timeout ONE-SHOT end-to-end: closing a still-
  // CONNECTING socket makes ws emit a synthetic 'error' ("closed before the
  // connection was established") on the next tick, which would otherwise
  // re-enter callbacks.onError — overwriting the recorded endedReason and
  // racing the in-flight apology (SCRUM-424 review P1). After the watchdog
  // fires, the self-inflicted error/close events are swallowed.
  let watchdogFired = false;
  const setupTimeoutMs = resolveSetupTimeoutMs(config.setupTimeoutMs, process.env.GEMINI_SETUP_TIMEOUT_MS);
  const setupWatchdog = armSetupWatchdog({
    timeoutMs: setupTimeoutMs,
    isSetupComplete: () => setupComplete,
    onTimeout: () => {
      watchdogFired = true;
      const err = new Error(`Gemini Live setup timed out after ${setupTimeoutMs}ms (caller would be stranded in silence)`);
      console.error(`[GeminiLive] ${err.message}`);
      Sentry.captureException(err);
      try {
        if (callbacks.onSetupTimeout) callbacks.onSetupTimeout(err);
        else callbacks.onError?.(err);
      } finally {
        try {
          ws.close(1000, "setup-timeout");
        } catch {
          /* socket may already be dead — nothing else to do */
        }
      }
    },
  });
  let sessionHandle = null;
  let transcriptIn = "";
  let transcriptOut = "";
  let audioErrorCount = 0;
  let intentionalCloseReason = null; // Set when we close via end_call tool
  const preSetupBuffer = []; // Buffer audio before setup completes

  // SCRUM-556: custom turn-taking (DARK by default — CUSTOM_VAD env flag).
  // The gate consumes per-block voice probability + RMS from the front-end
  // and drives manual activityStart/activityEnd markers with Gemini's
  // automatic VAD disabled. Decided per session, never mid-call.
  const wantCustomVad = customVadEnabled();
  let turnGate = null;
  const sendActivityMarker = (event) => {
    if (ws.readyState !== WebSocket.OPEN || !setupComplete) return;
    const marker = event === "start" ? { activityStart: {} } : { activityEnd: {} };
    try {
      ws.send(JSON.stringify({ realtimeInput: marker }));
    } catch (err) {
      console.error(`[GeminiLive] activity marker send failed (${event}):`, err && err.message);
    }
  };

  // SCRUM-555: per-session denoise + AGC front-end (null → legacy path for
  // this whole session; processTwilioFrame itself also fails open per frame).
  const audioFrontend = createSessionFrontend(
    wantCustomVad
      ? {
          onBlock: (prob, rms) => {
            const event = turnGate && turnGate.push(prob, rms);
            if (event) sendActivityMarker(event);
          },
          // With automatic VAD disabled, a dead front-end means no more turn
          // markers — the call would hang silently. Fail LOUD instead: the
          // onError path runs the existing teardown/failover machinery.
          onDead: () => {
            callbacks.onError?.(new Error("audio front-end died while CUSTOM_VAD was driving turn-taking"));
          },
        }
      : undefined
  );
  // Custom VAD is only safe WITH the front-end (it supplies the gate's
  // inputs). No front-end → keep Gemini's automatic VAD.
  const customVadActive = wantCustomVad && !!audioFrontend;
  if (customVadActive) turnGate = new TurnGate();
  if (wantCustomVad && !audioFrontend) {
    console.warn("[GeminiLive] CUSTOM_VAD requested but the audio front-end is unavailable — keeping Gemini automatic VAD");
  }
  console.log(
    `[GeminiLive] Inbound audio path: ${audioFrontend ? "front-end (RNNoise + AGC)" : "legacy"}${customVadActive ? " + custom VAD (manual turn markers)" : ""}`
  );

  // Audio-drain bookkeeping for end_call.
  // Gemini Live emits tool calls in the SAME turn as the closing audio
  // ("Have a great day!" + call end_call). Without waiting for the audio
  // to actually finish streaming to Twilio, the closing phrase is cut off
  // mid-word. We wait for the next `turnComplete` event (= Gemini finished
  // streaming audio for this turn), then add a fixed drain buffer for
  // Twilio's playback. Fixed timeout as a backstop in case turnComplete
  // never arrives.
  let pendingEndCallClose = false;

  ws.on("open", () => {
    console.log("[GeminiLive] WebSocket connected, sending setup...");

    // Convert OpenAI tools to Gemini format
    const geminiTools = convertToolsToGemini(config.tools);

    const setupMsg = {
      setup: {
        model: GEMINI_MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          temperature: 0.7,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: config.voiceName || "Kore",
              },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: config.systemPrompt }],
        },
        // SCRUM-556: when custom VAD is active, Gemini's automatic detection is
        // fully disabled and the voice server delimits turns with manual
        // activityStart/activityEnd markers (noise-floor dominance gate in
        // lib/turn-gate.js). Otherwise the SCRUM-554 tuned automatic config.
        realtimeInputConfig: customVadActive
          ? {
              automaticActivityDetection: { disabled: true },
              activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
            }
          : {
              automaticActivityDetection: {
                // SCRUM-554: onset LOW + prefix padding. SCRUM-375 set onset HIGH so a
                // quiet caller triggers turns readily, but with
                // START_OF_ACTIVITY_INTERRUPTS that let train announcements and
                // background voices open "caller turns" and cut the AI off
                // mid-sentence — real calls on 2026-07-15/16 show background audio
                // transcribed as German/Japanese/Spanish turns on an English call.
                // LOW onset + ~250ms of sustained speech before a start commits means
                // brief noise bursts and faint background chatter no longer open or
                // interrupt turns. The quiet-caller case SCRUM-375 tuned for is
                // covered by end-of-speech staying LOW (their turns aren't cut off)
                // and by the inbound AGC front-end (SCRUM-555).
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                prefixPaddingMs: 250,
                silenceDurationMs: 1000,
              },
              activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
            },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    };

    // Add tools if any
    if (geminiTools.length > 0) {
      setupMsg.setup.tools = [{ functionDeclarations: geminiTools }];
    }

    ws.send(JSON.stringify(setupMsg));
  });

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error("[GeminiLive] Failed to parse message");
      return;
    }

    // Setup complete
    if (msg.setupComplete) {
      const firstAck = !setupComplete;
      setupComplete = true;
      setupWatchdog.clear();
      console.log(`[GeminiLive] Session ready in ${Date.now() - sessionStartTime}ms (${preSetupBuffer.length} buffered chunks)`);
      // SCRUM-535: tells the failover wrapper the window for swapping
      // providers has closed — from here, a failure is the call site's.
      // Edge-triggered: the window closes ONCE; a duplicate ack must not
      // re-fire consumers.
      if (firstAck) {
        try {
          callbacks.onSetupComplete?.();
        } catch (cbErr) {
          console.error("[GeminiLive] onSetupComplete callback threw:", cbErr && cbErr.message);
        }
      }

      // Trigger Gemini to speak the greeting immediately.
      // NOTE: clientContent is BLOCKED on gemini-3.1-flash-live-preview (causes 1007).
      // Use realtimeInput.text instead — this is the correct way to send text on 3.1.
      // Ref: https://ai.google.dev/api/live (realtimeInput.text field)
      // Outbound caller personas disable this — they should wait for the receptionist to greet.
      if (config.triggerGreeting !== false) {
        try {
          ws.send(JSON.stringify({
            realtimeInput: {
              text: "Call connected.",
            },
          }));
          console.log("[GeminiLive] Sent realtimeInput.text trigger for greeting");
        } catch (err) {
          console.error("[GeminiLive] Greeting trigger failed:", err.message);
        }
      } else {
        console.log("[GeminiLive] Greeting trigger skipped (triggerGreeting=false)");
      }

      // SCRUM-259: Do NOT flush pre-setup buffered audio. This audio is
      // phone-line silence/noise captured before the Gemini WebSocket was
      // ready. Flushing it after the text greeting trigger causes Gemini to
      // interpret the audio as a new user turn and speak the greeting TWICE.
      // Real caller audio will arrive fresh after setupComplete — no loss.
      if (preSetupBuffer.length > 0) {
        console.log(`[GeminiLive] Discarding ${preSetupBuffer.length} pre-setup audio chunks (would cause double greeting)`);
        preSetupBuffer.length = 0;
      }
      return;
    }

    // Server content (audio, transcription, interruption)
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Audio response
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) {
            try {
              const twilioAudio = geminiToTwilio(part.inlineData.data);
              callbacks.onAudio(twilioAudio);
            } catch (err) {
              console.error("[GeminiLive] Audio conversion error:", err.message);
            }
          }
        }
      }

      // User speech transcription
      if (sc.inputTranscription?.text) {
        transcriptIn += sc.inputTranscription.text;
        callbacks.onTranscriptIn?.(sc.inputTranscription.text);
      }

      // AI speech transcription
      if (sc.outputTranscription?.text) {
        transcriptOut += sc.outputTranscription.text;
        callbacks.onTranscriptOut?.(sc.outputTranscription.text);
      }

      // Barge-in / interruption
      if (sc.interrupted) {
        console.log("[GeminiLive] User interrupted (barge-in)");
        callbacks.onInterrupted?.();
      }

      // Turn complete
      if (sc.turnComplete) {
        callbacks.onTurnComplete?.();
        // If end_call fired during this turn, Gemini has now finished
        // streaming the closing audio. Schedule the WS close after a short
        // drain window so Twilio finishes playing what's buffered.
        if (pendingEndCallClose) {
          pendingEndCallClose = false;
          console.log("[GeminiLive] Turn complete after end_call — closing in 800ms drain");
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              try { ws.close(1000, "end_call"); } catch {}
            }
          }, 800);
        }
      }

      return;
    }

    // Tool call from Gemini
    if (msg.toolCall) {
      const functionCalls = msg.toolCall.functionCalls || [];
      console.log(`[GeminiLive] Tool calls: ${functionCalls.map((c) => c.name).join(", ")}`);

      // Execute tool calls in parallel for lower latency
      const responses = await Promise.all(
        functionCalls.map(async (call) => {
          // Validate tool call structure
          if (!call.name || typeof call.name !== "string") {
            // SCRUM-357: never JSON.stringify the whole call — call.args carries
            // caller PII (name/phone/email/dob) and would bypass SCRUM-339's
            // DEBUG_TRANSCRIPTS gating straight to stdout/Loki. Log a non-PII
            // breadcrumb (id + arg-key count) instead.
            const argKeys = call?.args && typeof call.args === "object" ? Object.keys(call.args).length : 0;
            console.error(`[GeminiLive] Malformed tool call — missing name (id=${call?.id ?? "unknown"}, argKeys=${argKeys})`);
            return { id: call.id || "unknown", name: "unknown", response: { error: "Malformed tool call" } };
          }
          try {
            const result = await callbacks.onToolCall({
              id: call.id || `auto_${Date.now()}`,
              name: call.name,
              args: (call.args && typeof call.args === "object") ? call.args : {},
            });
            return {
              id: call.id,
              name: call.name,
              response: { result: typeof result === "string" ? { message: result } : result },
              _rawResult: result,
            };
          } catch (err) {
            console.error(`[GeminiLive] Tool ${call.name} error:`, err.message);
            return {
              id: call.id,
              name: call.name,
              response: { error: err.message },
            };
          }
        })
      );

      // Detect end_call sentinel before stripping it from the wire payload.
      // IMPORTANT: only close when the tool's RESULT carries __endCall=true.
      // Checking by tool NAME would also close on an intercepted end_call (e.g.
      // the SCRUM-227 HallucinationGuard returns a scolding message without
      // __endCall=true to keep the session alive for Gemini to recover).
      const shouldEnd = responses.some((r) => r._rawResult?.__endCall === true);

      // Send tool responses back (without internal _rawResult helper).
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          toolResponse: {
            functionResponses: responses.map(({ id, name, response }) => ({ id, name, response })),
          },
        }));
      }

      if (shouldEnd) {
        // Don't close immediately. Gemini Live emits tool calls in the same
        // turn as audio output, so the closing phrase ("Have a great day!")
        // may still be streaming. Mark a pending close — the actual close
        // is triggered by the next turnComplete event (above) plus a short
        // drain window. The fixed 4 s timer below is a backstop in case
        // turnComplete never arrives.
        intentionalCloseReason = "end_call";
        pendingEndCallClose = true;
        console.log("[GeminiLive] end_call invoked — waiting for turnComplete + drain before close");

        setTimeout(() => {
          if (!pendingEndCallClose) return; // turnComplete already closed us
          pendingEndCallClose = false;
          if (ws.readyState === WebSocket.OPEN) {
            console.log("[GeminiLive] Backstop timer fired — closing after end_call (no turnComplete in 4 s)");
            try { ws.close(1000, "end_call"); } catch {}
          }
        }, 4_000);
      }
      return;
    }

    // Tool call cancellation (user interrupted during tool execution)
    if (msg.toolCallCancellation) {
      console.log(`[GeminiLive] Tool calls cancelled: ${msg.toolCallCancellation.ids?.join(", ")}`);
      return;
    }

    // Session about to end — notify caller so server can handle gracefully
    if (msg.goAway) {
      console.warn(`[GeminiLive] Session ending in ${msg.goAway.timeLeft}`);
      callbacks.onError?.(new Error(`Gemini session expiring in ${msg.goAway.timeLeft}`));
      return;
    }

    // Session resumption
    if (msg.sessionResumptionUpdate) {
      sessionHandle = msg.sessionResumptionUpdate.newHandle;
      return;
    }
  });

  ws.on("error", (err) => {
    setupWatchdog.clear(); // error path takes over — don't double-fire
    if (watchdogFired) {
      // Self-inflicted: our own close of a CONNECTING socket emits a
      // synthetic error. The timeout was already surfaced — swallow it.
      console.log("[GeminiLive] Ignoring post-watchdog socket error:", err.message);
      return;
    }
    console.error("[GeminiLive] WebSocket error:", err.message);
    Sentry.captureException(err);
    callbacks.onError?.(err);
  });

  ws.on("close", (code, reason) => {
    setupWatchdog.clear();
    audioFrontend?.destroy(); // free the wasm denoise state (both close branches)
    if (watchdogFired) {
      // The watchdog handler owns call teardown — don't double-report.
      console.log(`[GeminiLive] Post-watchdog socket close (code=${code}) — already handled`);
      return;
    }
    const wireReason = reason ? reason.toString() : "";
    const effectiveReason = intentionalCloseReason || wireReason;
    console.log(`[GeminiLive] WebSocket closed (code=${code}, reason="${effectiveReason}")`);
    callbacks.onClose?.(code, effectiveReason);
  });

  return {
    /**
     * Send Twilio audio (base64 mulaw 8kHz) to Gemini.
     * @param {string} twilioBase64
     */
    sendAudio(twilioBase64) {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!setupComplete) {
        // Buffer audio until setup completes — don't lose the caller's first words
        if (preSetupBuffer.length < 200) preSetupBuffer.push(twilioBase64); // ~4s max buffer
        return;
      }
      try {
        const geminiAudio = audioFrontend
          ? audioFrontend.processTwilioFrame(twilioBase64)
          : twilioToGemini(twilioBase64);
        if (!geminiAudio) return; // front-end buffered a sub-block — nothing to send yet
        ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: geminiAudio,
              mimeType: "audio/pcm;rate=16000",
            },
          },
        }));
        audioErrorCount = 0; // Reset on success
      } catch (err) {
        audioErrorCount++;
        if (audioErrorCount <= 3) {
          console.error(`[GeminiLive] Audio send error (${audioErrorCount}):`, err.message);
        }
        if (audioErrorCount === 5) {
          console.error("[GeminiLive] Persistent audio conversion failure — triggering error");
          callbacks.onError?.(new Error("Persistent audio conversion failure"));
        }
      }
    },

    /** Get accumulated transcripts */
    getTranscripts() {
      return { input: transcriptIn, output: transcriptOut };
    },

    /**
     * Inject a text message into Gemini's context mid-conversation.
     * Used by the phantom action detector to nudge Gemini to call a
     * tool it skipped, and by the Tier 2 validator for corrections.
     * @param {string} text — the correction/instruction text
     */
    sendText(text) {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ realtimeInput: { text } }));
        // SCRUM-339: injected text can carry the Tier-2 discrepancy (caller
        // name / appointment details) — gate behind DEBUG_TRANSCRIPTS.
        logTranscript("[GeminiLive] Injected text", text);
      } catch (err) {
        console.error("[GeminiLive] sendText failed:", err.message);
      }
    },

    /** Close the session */
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "Call ended");
      }
    },

    /** WebSocket readyState (do NOT expose ws directly — URL contains API key) */
    get readyState() { return ws.readyState; },
  };
}

module.exports = {
  createGeminiSession,
  convertToolsToGemini,
  // Exposed for unit tests only (no network needed).
  _test: { armSetupWatchdog, resolveSetupTimeoutMs, DEFAULT_SETUP_TIMEOUT_MS },
};
