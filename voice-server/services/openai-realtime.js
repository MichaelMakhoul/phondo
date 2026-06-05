/**
 * OpenAI Realtime — WebSocket client for real-time voice AI (SCRUM-378 spike).
 *
 * A drop-in alternative to gemini-live.js for the EVALUATION test path only.
 * Exposes the SAME session interface as createGeminiSession (sendAudio,
 * getTranscripts, sendText, close, readyState + the same callbacks), so the
 * server's media-stream handler can branch with a one-line swap.
 *
 * Why it's promising for our failure mode: OpenAI Realtime ingests G.711 μ-law
 * 8 kHz natively (audio/pcmu) — NO resampling (Twilio mulaw goes straight in and
 * out) — and exposes two levers Gemini native-audio lacks: server-side
 * `noise_reduction` (far_field, for low-SNR phone audio) and an input
 * transcription `language` hint. Tools route through the SAME executeToolCall as
 * Gemini, so the SCRUM-372/373/377 guardrails apply unchanged.
 *
 * ⚠️ VERIFY ON FIRST SMOKE TEST: the GA Realtime session schema + a couple of
 * event names changed from preview and aren't fully nailed in public docs
 * (audio format must be "audio/pcmu"; session.audio.{input,output} nesting;
 * noise_reduction is an OBJECT not a string). This handler logs every unknown
 * event and any `error` event verbatim so the first test call surfaces exact
 * mismatches fast. Tune SESSION_CONFIG / the event switch from those logs.
 */

const WebSocket = require("ws");
const { Sentry } = require("../lib/sentry");
const { logTranscript } = require("../lib/log-transcript");

const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`;

// BCP-47 hint for the input transcription side. session.language is "en"/"ar".
const LANG_TO_BCP47 = { en: "en", ar: "ar", es: "es", fr: "fr", de: "de" };

/**
 * Convert OpenAI Chat-style tool defs (what buildLLMOptions produces, nested
 * under `.function`) to the FLAT shape the Realtime API expects.
 * @param {Array<{type:string, function:{name:string,description:string,parameters:object}}>} tools
 */
function toRealtimeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && t.type === "function" && t.function)
    .map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters || { type: "object", properties: {} },
    }));
}

/**
 * Build the session.update payload. Kept as one function so the schema is easy
 * to tweak from smoke-test logs.
 * @param {{systemPrompt:string, tools?:object[], voiceName?:string, language?:string}} opts
 */
function buildSessionConfig({ systemPrompt, tools, voiceName, language }) {
  const langCode = LANG_TO_BCP47[String(language || "en").toLowerCase().slice(0, 2)] || "en";
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: systemPrompt,
      tools: toRealtimeTools(tools),
      tool_choice: "auto",
      audio: {
        input: {
          format: { type: "audio/pcmu" }, // G.711 μ-law 8 kHz — Twilio-native, no resample
          noise_reduction: { type: "far_field" }, // low-SNR phone audio
          transcription: { model: "gpt-4o-mini-transcribe", language: langCode },
          turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: voiceName || "marin",
        },
      },
    },
  };
}

/**
 * Create an OpenAI Realtime session. Mirrors createGeminiSession.
 * @param {{systemPrompt:string, tools:object[], voiceName?:string, language?:string, triggerGreeting?:boolean}} config
 * @param {object} callbacks - onAudio, onToolCall, onTranscriptIn, onTranscriptOut, onInterrupted, onTurnComplete, onError, onClose
 */
function createOpenAIRealtimeSession(config, callbacks) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI Realtime");

  const ws = new WebSocket(OPENAI_REALTIME_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const startedAt = Date.now();

  let ready = false;
  let transcriptIn = "";
  let transcriptOut = "";
  let intentionalClose = null;
  let pendingEndClose = false;

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  ws.on("open", () => {
    console.log("[OpenAIRealtime] WS connected, sending session.update…");
    send(buildSessionConfig(config));
  });

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const type = msg.type || "";

    switch (type) {
      case "session.created":
      case "session.updated":
        if (!ready) {
          ready = true;
          console.log(`[OpenAIRealtime] Session ready in ${Date.now() - startedAt}ms`);
          // Trigger the AI to speak the greeting first (the system prompt holds it).
          if (config.triggerGreeting !== false) send({ type: "response.create" });
        }
        return;

      // Output audio (μ-law base64) → straight to Twilio, no conversion.
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (msg.delta) callbacks.onAudio?.(msg.delta);
        return;

      // AI speech transcript
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (msg.delta) { transcriptOut += msg.delta; callbacks.onTranscriptOut?.(msg.delta); }
        return;

      // Caller speech transcript (input transcription)
      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript) { transcriptIn += msg.transcript + " "; callbacks.onTranscriptIn?.(msg.transcript); }
        return;

      // Barge-in
      case "input_audio_buffer.speech_started":
        callbacks.onInterrupted?.();
        return;

      case "response.done":
        callbacks.onTurnComplete?.();
        if (pendingEndClose) {
          pendingEndClose = false;
          setTimeout(() => { if (ws.readyState === WebSocket.OPEN) { try { ws.close(1000, "end_call"); } catch {} } }, 800);
        }
        return;

      // Tool call — name + arguments complete.
      case "response.function_call_arguments.done": {
        let args = {};
        try { args = msg.arguments ? JSON.parse(msg.arguments) : {}; } catch {}
        let result;
        try {
          result = await callbacks.onToolCall?.({ id: msg.call_id || `auto_${msg.item_id || ""}`, name: msg.name, args });
        } catch (err) {
          result = { message: "I had trouble with that just now." };
          console.error(`[OpenAIRealtime] tool ${msg.name} error:`, err.message);
        }
        const message = typeof result === "string" ? result : (result?.message || "");
        // Feed the tool result back, then ask the model to respond.
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: msg.call_id, output: message } });
        if (result && typeof result === "object" && result.__endCall) {
          intentionalClose = "end_call";
          pendingEndClose = true;
          send({ type: "response.create" });
          setTimeout(() => { if (pendingEndClose && ws.readyState === WebSocket.OPEN) { pendingEndClose = false; try { ws.close(1000, "end_call"); } catch {} } }, 4000);
        } else {
          send({ type: "response.create" });
        }
        return;
      }

      case "error":
        // The GA schema is the main unknown — log the server's error verbatim.
        console.error("[OpenAIRealtime] server error event:", JSON.stringify(msg.error || msg).slice(0, 500));
        callbacks.onError?.(new Error(msg.error?.message || "OpenAI Realtime error"));
        return;

      default:
        // Surface anything we don't handle yet so the smoke test maps the GA schema.
        logTranscript("[OpenAIRealtime] unhandled event", type);
        return;
    }
  });

  ws.on("error", (err) => { console.error("[OpenAIRealtime] WS error:", err.message); Sentry.captureException(err); callbacks.onError?.(err); });
  ws.on("close", (code, reason) => {
    const r = intentionalClose || (reason ? reason.toString() : "");
    console.log(`[OpenAIRealtime] WS closed (code=${code}, reason="${r}")`);
    callbacks.onClose?.(code, r);
  });

  return {
    /** Forward Twilio μ-law base64 straight to the input buffer (no resample). */
    sendAudio(twilioBase64) {
      if (ws.readyState !== WebSocket.OPEN || !ready) return;
      send({ type: "input_audio_buffer.append", audio: twilioBase64 });
    },
    getTranscripts() { return { input: transcriptIn, output: transcriptOut }; },
    /** Inject a text instruction mid-call (parity with gemini-live sendText). */
    sendText(text) {
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      send({ type: "response.create" });
    },
    close() { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "Call ended"); },
    get readyState() { return ws.readyState; },
  };
}

module.exports = { createOpenAIRealtimeSession, _test: { toRealtimeTools, buildSessionConfig } };
