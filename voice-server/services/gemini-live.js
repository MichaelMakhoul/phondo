/**
 * Gemini 3.1 Flash Live — WebSocket client for real-time voice AI.
 *
 * Replaces the Deepgram STT → OpenAI LLM → Deepgram TTS pipeline with
 * a single audio-to-audio model. Handles session setup, audio streaming,
 * tool calls, barge-in, and transcription.
 */

const WebSocket = require("ws");
const { twilioToGemini, geminiToTwilio } = require("../lib/audio-converter");
const { Sentry } = require("../lib/sentry");

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
 * @param {function} callbacks.onClose - (code: number, reason: string) => void — reason is "end_call" when closed via end_call tool, empty otherwise
 * @returns {{ sendAudio, close, ws }}
 */
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
  let sessionHandle = null;
  let transcriptIn = "";
  let transcriptOut = "";
  let audioErrorCount = 0;
  let intentionalCloseReason = null; // Set when we close via end_call tool
  const preSetupBuffer = []; // Buffer audio before setup completes

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
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
            silenceDurationMs: 800,
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
      setupComplete = true;
      console.log(`[GeminiLive] Session ready in ${Date.now() - sessionStartTime}ms (${preSetupBuffer.length} buffered chunks)`);

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
            console.error("[GeminiLive] Malformed tool call — missing name:", JSON.stringify(call).slice(0, 200));
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
        console.log("[GeminiLive] end_call invoked — closing session in 400ms");
        intentionalCloseReason = "end_call";
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.close(1000, "end_call"); } catch {}
          }
        }, 400);
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
    console.error("[GeminiLive] WebSocket error:", err.message);
    Sentry.captureException(err);
    callbacks.onError?.(err);
  });

  ws.on("close", (code, reason) => {
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
        const geminiAudio = twilioToGemini(twilioBase64);
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

module.exports = { createGeminiSession, convertToolsToGemini };
