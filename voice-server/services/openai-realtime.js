/**
 * OpenAI Realtime — WebSocket client for real-time voice AI (SCRUM-378).
 *
 * A drop-in alternative to gemini-live.js for the EVALUATION test path. Exposes
 * the SAME session interface as createGeminiSession (sendAudio, getTranscripts,
 * sendText, close, readyState + the same callbacks), so the server's media-stream
 * handler branches with a one-line swap. Ingests/emits G.711 μ-law 8 kHz natively
 * (audio/pcmu) — no resampling — with far-field noise reduction + an input
 * transcription language hint. Tools route through the SAME executeToolCall as
 * Gemini (SCRUM-372/373/377 guardrails apply unchanged).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GA PROTOCOL CORRECTNESS (the hard part — researched + adversarially reviewed):
 * The GA Realtime API allows exactly ONE active response per conversation, and
 * with `turn_detection: server_vad` (create_response/interrupt_response default
 * true) the SERVER auto-creates a response at end-of-speech. Firing
 * `response.create` while a response is active → `conversation_already_has_active_response`,
 * which previously made the model double-fire and go haywire (it once erased an
 * appointment) and made the transfer throw "there was an issue in the system".
 *
 * Design:
 *   1. A response GATE (createResponseGate): never send response.create while a
 *      response is active/pending; a request made while busy is QUEUED and fired
 *      on the next response.done (survives the VAD race). The server drives normal
 *      user turns; we only create for greeting / tool-followup / goodbye / text.
 *   2. Tool calls are CAPTURED at function_call_arguments.done (an ARRAY — a single
 *      response may carry several parallel calls) and EXECUTED on response.done,
 *      submitting every function_call_output, then ONE gated response.create.
 *   3. transfer_call suppresses response.create (Twilio already redirected the
 *      call inside the tool); server.js forwards result.action so we can see it.
 *   4. Barge-in (WebSocket = client's job): response.cancel + conversation.item.
 *      truncate, drop any not-yet-executed tool calls (never run a write on an
 *      interrupted turn), then flush Twilio via onInterrupted.
 *   5. end_call closes only after the GOODBYE response's own response.done.
 *   6. Benign error codes are logged, not propagated (they used to drop the call);
 *      real errors go to Sentry.
 *   7. A watchdog force-resets the gate if a response.done never arrives, so the
 *      call can never hang in silence.
 */

const WebSocket = require("ws");
const { Sentry } = require("../lib/sentry");
const { mulawToPcm16, pcm16ToMulaw, normalizeGainPcm16 } = require("../lib/audio-converter");

const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`;

// BCP-47 hint for the input transcription side. session.language is "en"/"ar".
const LANG_TO_BCP47 = { en: "en", ar: "ar", es: "es", fr: "fr", de: "de" };

// If no response.created/done is seen within this window while the gate is busy,
// force-reset it so the call can't hang silently (see watchdog below).
const RESPONSE_WATCHDOG_MS = 15000;

// GA server events that are part of the normal turn lifecycle but need no action.
// Anything NOT handled AND not in this set logs once at debug level (no flood).
const KNOWN_IGNORED = new Set([
  "session.created",
  "response.output_item.done",
  "response.content_part.added", "response.content_part.done",
  "response.output_audio.done", "response.output_audio_transcript.done",
  "response.audio.done", "response.audio_transcript.done",
  // Streaming tool-arg chunks — many per tool call. We act on the terminal
  // ".done" (captured into pendingTools); the per-chunk ".delta" needs no
  // handling and would otherwise flood the logs (hundreds/call) and rotate the
  // real lines out of the buffer.
  "response.function_call_arguments.delta",
  "rate_limits.updated",
  "input_audio_buffer.speech_stopped", "input_audio_buffer.committed", "input_audio_buffer.cleared",
  "conversation.item.created", "conversation.item.added", "conversation.item.done",
  "conversation.item.truncated", "conversation.item.input_audio_transcription.delta",
]);

// Recoverable error codes — log but DO NOT tear down the call. Propagating these
// (the old behavior) set callFailed and dropped the call on a benign hiccup.
const BENIGN_ERROR_CODES = new Set([
  "conversation_already_has_active_response",
  "response_cancel_not_active",
  "input_audio_buffer_commit_empty",
]);

function isBenignError(code) {
  return BENIGN_ERROR_CODES.has(String(code || ""));
}

/**
 * SCRUM-378: boost a quiet caller's audio BEFORE OpenAI's STT hears it — the same
 * +gain the Gemini path applies (normalizeGainPcm16). The OpenAI path was
 * forwarding Twilio's raw μ-law untouched, so low-volume callers were transcribed
 * as poorly as raw (offline tests showed gain is what makes the audio legible).
 * In/out are both μ-law 8 kHz (audio/pcmu) — no resample. Never drop audio: on any
 * processing hiccup, fall back to the original frame.
 * @param {string} b64 - base64 Twilio μ-law frame
 * @returns {string} base64 μ-law frame, gain-normalized
 */
function boostMulawBase64(b64) {
  try {
    const mulaw = Buffer.from(b64, "base64");
    const pcm = normalizeGainPcm16(mulawToPcm16(mulaw));
    return pcm16ToMulaw(pcm).toString("base64");
  } catch {
    return b64;
  }
}

/**
 * Convert OpenAI Chat-style tool defs (nested under `.function`) to the FLAT
 * shape the Realtime API expects.
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
 * Build the session.update payload.
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
          // create_response/interrupt_response default true; set EXPLICITLY so the
          // gating + barge-in design doesn't silently depend on the default.
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
            create_response: true,
            interrupt_response: true,
          },
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
 * Response gate — enforces the Realtime API's ONE-active-response-at-a-time rule.
 *
 * `active`  is true strictly between `response.created` and `response.done`.
 * `pending` is true between SENDING response.create and receiving response.created
 *           (closes the create→created race).
 * `queued`  records that a create was WANTED while busy, to fire on the next done.
 *
 * @param {() => void} sendCreate - sends `{type:"response.create"}` on the wire
 */
function createResponseGate(sendCreate) {
  let active = false;
  let pending = false;
  let queued = false;

  function request() {
    if (active || pending) { queued = true; return false; }
    pending = true;
    queued = false; // this create satisfies any queued intent — don't let flushQueued re-fire it
    sendCreate();
    return true;
  }

  return {
    request,
    /** response.created received — a response is now generating. */
    created() { active = true; pending = false; },
    /** response.done / response.cancelled received — the response is over. */
    done() { active = false; pending = false; },
    /** After a `conversation_already_has_active_response` error: a response really
     *  IS active, and OUR rejected create still needs to fire — re-queue it so the
     *  next response.done re-sends it (otherwise the turn is silently dropped). */
    resync() { active = true; pending = false; queued = true; },
    /** Fire a queued create if one is waiting and we're now idle. */
    flushQueued() {
      if (queued && !active && !pending) { queued = false; return request(); }
      return false;
    },
    get active() { return active; },
    get snapshot() { return { active, pending, queued }; },
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
  let closeTimer = null;
  let watchdogTimer = null;

  // Barge-in / truncation tracking: the assistant audio item currently playing,
  // a wall-clock estimate of how long the caller has heard it, and the actual
  // generated duration (to clamp audio_end_ms so truncate never errors).
  let currentItemId = null;
  let audioStartMs = 0;
  let generatedMs = 0;

  // Tool calls captured at function_call_arguments.done, executed at response.done.
  // An ARRAY — one response can carry several parallel calls.
  let pendingTools = [];

  // end_call: close only after the GOODBYE response's own response.done.
  let armEndOnNextCreate = false;
  let endAfterResponseId = null;

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // Watchdog: a response must reach response.done. If it doesn't (dropped event,
  // never-finishing response), force-reset the gate so AI-initiated turns aren't
  // queued forever and the caller left in silence.
  function clearWatchdog() { if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; } }
  function armWatchdog() {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      console.error("[OpenAIRealtime] response watchdog fired — no response.done in time; forcing gate reset");
      try { Sentry.captureMessage("OpenAIRealtime response gate stuck — forced reset", "warning"); } catch { /* best-effort */ }
      gate.done();
      gate.flushQueued();
    }, RESPONSE_WATCHDOG_MS);
  }

  const gate = createResponseGate(() => { send({ type: "response.create" }); armWatchdog(); });

  /** Close the WS after `ms`, reschedulable (a later, shorter call wins). */
  function drainThenClose(ms, reason) {
    if (reason) intentionalClose = reason;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) { try { ws.close(1000, reason || "end"); } catch { /* already closing */ } }
    }, ms);
  }

  function resetTurnAudio() { currentItemId = null; audioStartMs = 0; generatedMs = 0; }

  ws.on("open", () => {
    console.log("[OpenAIRealtime] WS connected, sending session.update…");
    send(buildSessionConfig(config));
  });

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const type = msg.type || "";

    switch (type) {
      // Config APPLIED. (session.created arrives BEFORE the audio format is set, so
      // marking ready there would let μ-law audio be decoded as the default
      // pcm16/24k → garbled call start.) Mark ready + greet here.
      case "session.updated":
        if (!ready) {
          ready = true;
          console.log(`[OpenAIRealtime] Session ready in ${Date.now() - startedAt}ms`);
          if (config.triggerGreeting !== false) gate.request(); // gated greeting
        }
        return;

      case "response.created":
        gate.created();
        armWatchdog();
        if (armEndOnNextCreate) { endAfterResponseId = msg.response?.id || null; armEndOnNextCreate = false; }
        return;

      // The server acknowledges a barge-in cancel with response.done(status=cancelled)
      // OR a bare response.cancelled — handle BOTH so `active` always clears.
      case "response.cancelled":
        gate.done();
        clearWatchdog();
        resetTurnAudio();
        gate.flushQueued();
        return;

      // Track the assistant audio/message item so barge-in can truncate it.
      case "response.output_item.added":
        if (msg.item && (msg.item.type === "message" || msg.item.type === "audio")) {
          currentItemId = msg.item.id || currentItemId;
        }
        return;

      // Output audio (μ-law base64) → straight to Twilio, no conversion.
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (msg.delta) {
          if (!audioStartMs) audioStartMs = Date.now();
          generatedMs += Buffer.from(msg.delta, "base64").length / 8; // μ-law 8 kHz: 8 bytes = 1 ms
          callbacks.onAudio?.(msg.delta);
        }
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

      // BARGE-IN. On a WebSocket the client must stop generation AND trim the
      // model's memory of audio the caller never heard, THEN flush Twilio's buffer.
      case "input_audio_buffer.speech_started":
        if (gate.active) {
          send({ type: "response.cancel" });
          if (currentItemId) {
            const heardMs = audioStartMs ? Math.max(0, Date.now() - audioStartMs) : 0;
            // Clamp to generated duration so audio_end_ms can never exceed it
            // (an out-of-range value errors and would otherwise drop the call).
            const audioEndMs = Math.round(Math.min(heardMs, generatedMs || heardMs));
            send({ type: "conversation.item.truncate", item_id: currentItemId, content_index: 0, audio_end_ms: audioEndMs });
          }
        }
        // Never execute a tool the caller interrupted (esp. a write like book/cancel).
        if (pendingTools.length) {
          console.log(`[OpenAIRealtime] barge-in — dropped ${pendingTools.length} un-executed tool call(s)`);
          pendingTools = [];
        }
        callbacks.onInterrupted?.(); // media-stream handler sends Twilio `clear`
        return;

      // Tool call — CAPTURE only (one event per call; a response may carry several).
      // Execution + the gated follow-up happen on response.done.
      case "response.function_call_arguments.done": {
        let args = {};
        try {
          args = msg.arguments ? JSON.parse(msg.arguments) : {};
        } catch (e) {
          console.error(`[OpenAIRealtime] tool args JSON.parse failed for ${msg.name}: ${e.message}`);
          try { Sentry.captureException(e); } catch { /* best-effort */ }
        }
        pendingTools.push({ call_id: msg.call_id, name: msg.name, args });
        return;
      }

      case "response.done": {
        gate.done();
        clearWatchdog();
        callbacks.onTurnComplete?.();
        resetTurnAudio();

        // Close the call only after the GOODBYE response (not the tool-call one).
        if (endAfterResponseId && msg.response?.id === endAfterResponseId) {
          endAfterResponseId = null;
          drainThenClose(800, "end_call");
          return;
        }

        if (pendingTools.length) {
          const tools = pendingTools;
          pendingTools = [];
          let anyTransfer = false;
          let anyEndCall = false;
          // Execute sequentially — the CallSession guards (confirmCancel,
          // registerBookOutcome, …) are stateful and assume ordered calls.
          for (const t of tools) {
            let result;
            try {
              result = await callbacks.onToolCall?.({ id: t.call_id, name: t.name, args: t.args });
            } catch (err) {
              result = { message: "I had trouble with that just now." };
              console.error(`[OpenAIRealtime] tool ${t.name} error:`, err.message);
            }
            let out = typeof result === "string" ? result : (result?.message || "");
            if (!out) { console.warn(`[OpenAIRealtime] empty tool output for ${t.name}`); out = "(no result)"; }
            // Submitting the output never collides; only response.create does.
            send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: t.call_id, output: out } });
            if (result && typeof result === "object") {
              if (result.action === "transfer") anyTransfer = true;
              if (result.__endCall) anyEndCall = true;
            }
          }

          if (anyTransfer) {
            // Twilio already redirected the call inside the tool. Do NOT create a
            // response into a torn-down stream; let the redirect/teardown proceed.
            drainThenClose(1200, "transfer");
            return;
          }
          if (anyEndCall) {
            // Gated goodbye; arm the end-close ONLY if the create actually went out
            // (if it queued, the 6 s backstop ends the call).
            if (gate.request()) armEndOnNextCreate = true;
            drainThenClose(6000, "end_call");
            return;
          }
          gate.request(); // normal tool: gated follow-up response
          return;
        }

        gate.flushQueued(); // e.g. a sendText/create requested while busy
        return;
      }

      case "error": {
        const code = msg.error?.code || "";
        if (code === "conversation_already_has_active_response") {
          console.warn("[OpenAIRealtime] benign:", code);
          gate.resync(); // state desync — a response really is active; re-queue our create
          return;
        }
        if (isBenignError(code)) { console.warn("[OpenAIRealtime] benign:", code); return; }
        // Genuinely fatal — surface to Sentry HERE (the GA error detail) before the
        // downstream onError loses it, then propagate.
        console.error("[OpenAIRealtime] server error event:", JSON.stringify(msg.error || msg).slice(0, 500));
        try { Sentry.captureMessage(`OpenAIRealtime error: ${code || "unknown"} — ${msg.error?.message || ""}`.slice(0, 300), "error"); } catch { /* best-effort */ }
        callbacks.onError?.(new Error(msg.error?.message || "OpenAI Realtime error"));
        return;
      }

      default:
        if (!KNOWN_IGNORED.has(type)) console.debug("[OpenAIRealtime] unhandled event:", type);
        return;
    }
  });

  ws.on("error", (err) => { console.error("[OpenAIRealtime] WS error:", err.message); Sentry.captureException(err); callbacks.onError?.(err); });
  ws.on("close", (code, reason) => {
    clearWatchdog();
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    const r = intentionalClose || (reason ? reason.toString() : "");
    console.log(`[OpenAIRealtime] WS closed (code=${code}, reason="${r}")`);
    callbacks.onClose?.(code, r);
  });

  return {
    /** Forward Twilio μ-law to the input buffer, GAIN-NORMALIZED first (no resample). */
    sendAudio(twilioBase64) {
      if (ws.readyState !== WebSocket.OPEN || !ready) return;
      send({ type: "input_audio_buffer.append", audio: boostMulawBase64(twilioBase64) });
    },
    getTranscripts() { return { input: transcriptIn, output: transcriptOut }; },
    /** Inject a text instruction mid-call (parity with gemini-live sendText). */
    sendText(text) {
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      gate.request();
    },
    close() { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) { try { ws.close(1000, "Call ended"); } catch { /* already closing */ } } },
    get readyState() { return ws.readyState; },
  };
}

module.exports = {
  createOpenAIRealtimeSession,
  _test: { toRealtimeTools, buildSessionConfig, createResponseGate, isBenignError, boostMulawBase64, KNOWN_IGNORED, BENIGN_ERROR_CODES },
};
