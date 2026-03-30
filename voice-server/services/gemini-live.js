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
 * @param {object} callbacks
 * @param {function} callbacks.onAudio - (base64MulawChunk: string) => void — Twilio-ready audio
 * @param {function} callbacks.onToolCall - (toolCall: {id, name, args}) => Promise<any> — execute tool
 * @param {function} callbacks.onTranscriptIn - (text: string) => void — user's speech transcription
 * @param {function} callbacks.onTranscriptOut - (text: string) => void — AI's speech transcription
 * @param {function} callbacks.onInterrupted - () => void — user barged in
 * @param {function} callbacks.onTurnComplete - () => void — AI finished speaking
 * @param {function} callbacks.onError - (err: Error) => void
 * @param {function} callbacks.onClose - (code: number) => void
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

      // IMPORTANT: Send clientContent trigger FIRST, BEFORE any audio.
      // Mixing realtimeInput (audio) with clientContent (text) causes
      // "invalid argument" crashes. Send text trigger alone, then flush audio.
      // Ref: https://ai.google.dev/gemini-api/docs/live#first-message
      try {
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: "Call connected." }] }],
            turnComplete: true,
          },
        }));
        console.log("[GeminiLive] Sent clientContent trigger for greeting");
      } catch (err) {
        console.error("[GeminiLive] clientContent trigger failed:", err.message);
      }

      // Flush buffered audio AFTER the clientContent trigger.
      // Small delay to ensure clientContent is processed first.
      setTimeout(() => {
        for (const buffered of preSetupBuffer) {
          try {
            const geminiAudio = twilioToGemini(buffered);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ realtimeInput: { audio: { data: geminiAudio, mimeType: "audio/pcm;rate=16000" } } }));
            }
          } catch {}
        }
        preSetupBuffer.length = 0;
      }, 100);

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

      // Send tool responses back
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          toolResponse: { functionResponses: responses },
        }));
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
    const reasonStr = reason ? reason.toString() : "";
    console.log(`[GeminiLive] WebSocket closed (code=${code}, reason="${reasonStr}")`);
    callbacks.onClose?.(code);
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
