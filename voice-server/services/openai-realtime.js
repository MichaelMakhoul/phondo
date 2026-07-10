/**
 * Realtime voice adapter — WebSocket client for real-time voice AI (SCRUM-378).
 *
 * Serves TWO OpenAI-Realtime-protocol providers for the EVALUATION test path:
 *   - OpenAI gpt-realtime (the original adapter, unchanged behavior)
 *   - xAI Grok (grok-voice-think-fast-1.0) — wire-compatible with the OpenAI
 *     Realtime API (same client events, session.update handshake, response
 *     lifecycle), so it reuses this battle-tested state machine instead of
 *     forking it. Provider differences are isolated in PROVIDERS + the
 *     provider-specific buildSessionConfig (see buildGrokSessionConfig).
 *
 * A drop-in alternative to gemini-live.js. Exposes the SAME session interface
 * as createGeminiSession (sendAudio, getTranscripts, sendText, close,
 * readyState + the same callbacks), so the server's media-stream handler
 * branches with a one-line swap. Ingests/emits G.711 μ-law 8 kHz natively
 * (audio/pcmu) — no resampling. Tools route through the SAME executeToolCall as
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
 *      interrupted turn), then flush Twilio via onInterrupted. Grok documents no
 *      discrete speech_started event (its server VAD interrupts silently), so a
 *      response.done with status "cancelled" ALSO drops captured tools + flushes
 *      Twilio — the same invariant from the other end.
 *   5. end_call closes only after the GOODBYE response's own response.done.
 *   6. Benign error codes are logged, not propagated (they used to drop the call);
 *      real errors go to Sentry.
 *   7. A watchdog force-resets the gate if a response.done never arrives, so the
 *      call can never hang in silence.
 *   8. Caller transcripts: OpenAI sends a terminal `input_audio_transcription.completed`
 *      per utterance; Grok sends CUMULATIVE `...transcription.updated` snapshots
 *      with no documented terminal event. createInputTranscriptTracker handles
 *      both without double-committing an utterance.
 */

const WebSocket = require("ws");
const { Sentry } = require("../lib/sentry");
const { mulawToPcm16, pcm16ToMulaw, normalizeGainPcm16 } = require("../lib/audio-converter");

// BCP-47 hint for the input transcription side. session.language is "en"/"ar".
const LANG_TO_BCP47 = { en: "en", ar: "ar", es: "es", fr: "fr", de: "de" };

// If no response.created/done is seen within this window while the gate is busy,
// force-reset it so the call can't hang silently (see watchdog below).
const RESPONSE_WATCHDOG_MS = 15000;

// If session.updated never arrives after we send session.update (provider
// silently rejecting a field, acking under an unknown event name, …), `ready`
// would stay false forever: every caller frame discarded, no greeting, and the
// response watchdog never armed — an indefinite dead-air call recorded as
// "completed". Same failure class the Gemini path guards with its setup
// watchdog (SCRUM-424); Grok's unproven handshake makes it load-bearing here.
const SETUP_WATCHDOG_MS = 10000;

// GA server events that are part of the normal turn lifecycle but need no action.
// Anything NOT handled AND not in this set logs once at debug level (no flood).
const KNOWN_IGNORED = new Set([
  "session.created",
  "conversation.created", // xAI: carries the resumable conversation id (resumption unused here)
  "ping", // xAI: app-level keepalive every ~10s — flooded the logs on the first real calls
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
  // speech_stopped/committed also fire at INTRA-utterance pauses — flushing
  // transcripts on them stuttered the stored transcript (see the note at the
  // response.created handler). Deliberately ignored.
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
 * SCRUM-378: boost a quiet caller's audio BEFORE the provider's STT hears it —
 * the same +gain the Gemini path applies (normalizeGainPcm16). The OpenAI path
 * was forwarding Twilio's raw μ-law untouched, so low-volume callers were
 * transcribed as poorly as raw (offline tests showed gain is what makes the
 * audio legible). In/out are both μ-law 8 kHz (audio/pcmu) — no resample. Never
 * drop audio: on any processing hiccup, fall back to the original frame.
 * @param {string} b64 - base64 Twilio μ-law frame
 * @returns {string} base64 μ-law frame, gain-normalized
 */
let boostFailureWarned = false; // once per process — a converter failure is systematic, not per-frame noise
function boostMulawBase64(b64) {
  try {
    const mulaw = Buffer.from(b64, "base64");
    const pcm = normalizeGainPcm16(mulawToPcm16(mulaw));
    return pcm16ToMulaw(pcm).toString("base64");
  } catch (e) {
    // Never drop audio — but a converter that's failing means quiet callers are
    // back to raw (mis-transcribed) frames, which must not stay invisible.
    if (!boostFailureWarned) {
      boostFailureWarned = true;
      console.warn("[RealtimeAdapter] gain-boost failed — forwarding raw μ-law from now on:", e.message);
      try { Sentry.captureException(e); } catch { /* best-effort */ }
    }
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
 * Build the OpenAI session.update payload.
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
 * Build the Grok (xAI) session.update payload — the xAI-DOCUMENTED schema, not
 * a clone of the OpenAI one:
 *   - `voice` sits at the session top level (API voices: ara/eve/leo/rex/sal)
 *   - transcription takes a BCP-47 `language_hint` (no model field)
 *   - no noise_reduction option
 *   - `turn_detection` sits at the session top level; create_response /
 *     interrupt_response are not documented fields, so they're omitted — xAI's
 *     server VAD drives turns by default, which is what the response gate assumes
 *   - audio formats take an explicit `rate` (pcmu is 8000-only)
 * @param {{systemPrompt:string, tools?:object[], voiceName?:string, language?:string}} opts
 */
const GROK_API_VOICES = new Set(["ara", "eve", "leo", "rex", "sal"]);

function buildGrokSessionConfig({ systemPrompt, tools, voiceName, language }) {
  const langCode = LANG_TO_BCP47[String(language || "en").toLowerCase().slice(0, 2)] || "en";
  const voice = voiceName || "eve";
  if (!GROK_API_VOICES.has(voice)) {
    // Could be a legit custom voice id, so pass it through — but a typo'd
    // GROK_REALTIME_VOICE would otherwise only surface as a rejected
    // session.update at call time (dead air, then the setup watchdog).
    console.warn(`[GrokRealtime] voice "${voice}" is not a documented xAI API voice (${[...GROK_API_VOICES].join("/")}) — passing through as a custom id`);
  }
  return {
    type: "session.update",
    session: {
      instructions: systemPrompt,
      voice,
      tools: toRealtimeTools(tools),
      tool_choice: "auto",
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
      },
      audio: {
        input: {
          format: { type: "audio/pcmu", rate: 8000 }, // G.711 μ-law — Twilio-native, no resample
          transcription: { language_hint: langCode },
        },
        output: {
          format: { type: "audio/pcmu", rate: 8000 },
        },
      },
    },
  };
}

/**
 * The two OpenAI-Realtime-protocol providers this adapter can drive. URLs are
 * resolved at session-creation time so a model env change doesn't need a
 * process restart (the eval workflow flips these between test calls).
 */
const PROVIDERS = {
  openai: {
    tag: "OpenAIRealtime",
    apiKeyEnv: "OPENAI_API_KEY",
    // SCRUM-535: this default also serves as the Gemini Live failover model,
    // so keep it current — a stale default here means outages are handled by
    // a superseded model and the SCRUM-378 A/B benchmarks against it too.
    url: () => `wss://api.openai.com/v1/realtime?model=${process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1"}`,
    buildSessionConfig,
  },
  grok: {
    tag: "GrokRealtime",
    apiKeyEnv: "XAI_API_KEY",
    url: () => `wss://api.x.ai/v1/realtime?model=${process.env.GROK_REALTIME_MODEL || "grok-voice-think-fast-1.0"}`,
    buildSessionConfig: buildGrokSessionConfig,
  },
};

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
 * Caller-transcript accumulator that supports BOTH transcription event styles
 * without double-committing an utterance:
 *   - OpenAI: one terminal `input_audio_transcription.completed` per utterance.
 *   - Grok (xAI): CUMULATIVE `input_audio_transcription.updated` snapshots per
 *     utterance, with no documented terminal event.
 * `.updated` text is held as provisional and committed by flush() when the model
 * starts answering (response.created — the utterance is over) or at session
 * close. A `.completed` arriving for an utterance that was already flushed is
 * skipped: by item id when the events carry one, by exact-text as a fallback.
 * @param {(text: string) => void} commit - receives each finalized utterance once
 */
function createInputTranscriptTracker(commit) {
  let provisionalId = null; // item id of the utterance currently held provisionally
  let provisionalText = ""; // latest cumulative snapshot for that utterance
  let lastCommitted = ""; // text-equality dedup fallback for id-less events
  const flushedIds = new Set(); // utterances committed via flush(), awaiting a possible late `.completed`

  function flushProvisional() {
    if (!provisionalText) return;
    if (provisionalId) flushedIds.add(provisionalId);
    lastCommitted = provisionalText;
    commit(provisionalText);
    provisionalText = "";
    provisionalId = null;
  }

  return {
    /** Cumulative snapshot (Grok) — hold as provisional, newest wins. A snapshot
     *  for a NEW utterance item while another is held marks a segment boundary:
     *  commit the held one (in order) before tracking the new one, so multi-item
     *  caller turns don't lose their earlier segments to the single slot. */
    updated(itemId, transcript) {
      if (typeof transcript !== "string" || !transcript) return;
      if (itemId && flushedIds.has(itemId)) return; // this utterance was already committed
      if (provisionalText && provisionalId && itemId && itemId !== provisionalId) flushProvisional();
      provisionalId = itemId || null;
      provisionalText = transcript;
    },
    /** Terminal transcript for one utterance (OpenAI always; Grok if compat-mode sends it). */
    completed(itemId, transcript) {
      // One-shot skip: this utterance was already committed via flush().
      if (itemId && flushedIds.delete(itemId)) {
        if (itemId === provisionalId) { provisionalId = null; provisionalText = ""; }
        return;
      }
      if (!itemId && !!transcript && transcript === lastCommitted) return; // id-less dedup fallback
      // Attribution: an id-less terminal can only claim an id-less provisional —
      // never wipe a DIFFERENT utterance's snapshot (review F3).
      const sameUtterance = itemId ? itemId === provisionalId : provisionalId === null;
      if (transcript) {
        if (sameUtterance) { provisionalId = null; provisionalText = ""; }
        lastCommitted = transcript;
        commit(transcript);
        return;
      }
      // Terminal event with an EMPTY transcript (blank/failed transcription): the
      // cumulative snapshot is the best record of the utterance — commit it
      // instead of wiping it (review F3).
      if (sameUtterance) flushProvisional();
    },
    /** Commit a held provisional — at end-of-utterance (speech_stopped/committed),
     *  on a server-initiated response.created (fallback), or at session close. */
    flush: flushProvisional,
  };
}

/**
 * Create a Realtime session against one of PROVIDERS. Mirrors createGeminiSession.
 * @param {{systemPrompt:string, tools:object[], voiceName?:string, language?:string, triggerGreeting?:boolean}} config
 * @param {object} callbacks - onAudio, onToolCall, onTranscriptIn, onTranscriptOut, onInterrupted, onTurnComplete, onError, onClose
 * @param {{tag: string, apiKeyEnv: string, url: () => string, buildSessionConfig: (config: object) => object}} [provider] - one of PROVIDERS
 */
function createRealtimeSession(config, callbacks, provider = PROVIDERS.openai) {
  const P = provider;
  const apiKey = process.env[P.apiKeyEnv];
  if (!apiKey) throw new Error(`${P.apiKeyEnv} is required for ${P.tag}`);

  const ws = new WebSocket(P.url(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const startedAt = Date.now();

  let ready = false;
  let transcriptIn = "";
  let transcriptOut = "";
  let intentionalClose = null;
  let closeTimer = null;
  let watchdogTimer = null;
  let setupTimer = null;
  let parseFailures = 0;
  let transcriptionFailureReported = false;

  // True between input_audio_buffer.speech_started and the next response —
  // i.e. "the interruption cleanup (tool drop + Twilio flush) already ran".
  // Keeps the cancel-ACK paths from double-cleaning on providers that DO send
  // speech_started (OpenAI), while providers that cancel silently (Grok VAD)
  // still get their only cleanup there.
  let bargedIn = false;

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

  const inputTranscripts = createInputTranscriptTracker((text) => {
    transcriptIn += text + " ";
    callbacks.onTranscriptIn?.(text);
  });

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
      console.error(`[${P.tag}] response watchdog fired — no response.done in time; forcing gate reset`);
      // The response.done that would have executed these never came — never run
      // them a turn late, out of conversational context (esp. booking writes).
      if (pendingTools.length) {
        console.error(`[${P.tag}] watchdog — dropped ${pendingTools.length} captured tool call(s) from the stuck response`);
        pendingTools = [];
      }
      try { Sentry.captureMessage(`${P.tag} response gate stuck — forced reset`, "warning"); } catch { /* best-effort */ }
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
    console.log(`[${P.tag}] WS connected, sending session.update…`);
    send(P.buildSessionConfig(config));
    // Setup watchdog: if the provider never acks with session.updated, fail the
    // call LOUDLY instead of leaving the caller in unrecorded dead air.
    setupTimer = setTimeout(() => {
      setupTimer = null;
      if (ready) return;
      console.error(`[${P.tag}] no session.updated within ${SETUP_WATCHDOG_MS}ms — treating as setup failure`);
      try { Sentry.captureMessage(`${P.tag} session setup timeout — session.update never acked`, "error"); } catch { /* best-effort */ }
      callbacks.onError?.(new Error(`${P.tag} session setup timeout`));
    }, SETUP_WATCHDOG_MS);
  });

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      // A dropped frame here can be a swallowed response.done (15s dead air +
      // stale tools) or session.updated (silent hang) — never discard invisibly.
      parseFailures += 1;
      if (parseFailures === 1) {
        console.warn(`[${P.tag}] dropped unparseable WS frame: ${e.message}`);
        try { Sentry.captureMessage(`${P.tag} unparseable WS frame`, "warning"); } catch { /* best-effort */ }
      } else if (parseFailures % 50 === 0) {
        console.warn(`[${P.tag}] ${parseFailures} unparseable WS frames so far`);
      }
      return;
    }
    const type = msg.type || "";

    switch (type) {
      // Config APPLIED. (session.created arrives BEFORE the audio format is set, so
      // marking ready there would let μ-law audio be decoded as the default
      // pcm16/24k → garbled call start.) Mark ready + greet here.
      case "session.updated":
        if (!ready) {
          ready = true;
          if (setupTimer) { clearTimeout(setupTimer); setupTimer = null; }
          console.log(`[${P.tag}] Session ready in ${Date.now() - startedAt}ms`);
          if (config.triggerGreeting !== false) gate.request(); // gated greeting
        }
        return;

      case "response.created":
        // A create we did NOT request (gate not pending) is the server's VAD
        // answering the caller — that utterance is over; commit its provisional
        // transcript. This is the PRIMARY commit boundary (one commit per turn).
        // Our OWN creates (greeting / tool-followup / sendText) say nothing
        // about the caller's speech, which may still be in flight — flushing
        // there would truncate a mid-air utterance (review F4).
        if (!gate.snapshot.pending) inputTranscripts.flush();
        bargedIn = false; // a new response starts fresh interruption bookkeeping
        gate.created();
        armWatchdog();
        if (armEndOnNextCreate) { endAfterResponseId = msg.response?.id || null; armEndOnNextCreate = false; }
        return;

      // NOTE (2026-07-03, from the first real Grok calls): speech_stopped /
      // committed fire at INTRA-utterance pauses too, and Grok's cumulative
      // `.updated` snapshots get REVISED across those pauses — flushing here
      // committed overlapping partials and stuttered the stored transcript
      // ("Are youAre you"). Commit once per turn instead: on the server's own
      // response.created (it answers when the turn is truly over), on a new
      // utterance item superseding a held one (see the tracker), and at close.

      // The server acknowledges a barge-in cancel with response.done(status=cancelled)
      // OR a bare response.cancelled — handle BOTH so `active` always clears.
      case "response.cancelled":
        gate.done();
        clearWatchdog();
        callbacks.onTurnComplete?.(); // flush partial transcripts of the interrupted turn (parity with response.done)
        resetTurnAudio();
        // A cancelled response's tool calls belong to an interrupted turn —
        // never execute a write the caller talked over. Its buffered audio is
        // stale too, BUT only flush Twilio if speech_started didn't already
        // (keeps the OpenAI barge-in path behavior-identical); on a silent
        // server-side cancel (Grok VAD) this is the only cleanup the turn gets.
        if (pendingTools.length) {
          console.log(`[${P.tag}] cancelled response — dropped ${pendingTools.length} un-executed tool call(s)`);
          pendingTools = [];
        }
        if (!bargedIn) callbacks.onInterrupted?.();
        bargedIn = false;
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

      // Caller speech transcript — terminal event per utterance (OpenAI).
      case "conversation.item.input_audio_transcription.completed":
        inputTranscripts.completed(msg.item_id, msg.transcript);
        return;

      // Caller speech transcript — CUMULATIVE snapshot (Grok/xAI extension).
      case "conversation.item.input_audio_transcription.updated":
        inputTranscripts.updated(msg.item_id, msg.transcript);
        return;

      // The provider could NOT transcribe an utterance — the transcript feeding
      // post-call analysis just lost a turn. This must not hide in debug logs.
      case "conversation.item.input_audio_transcription.failed":
        console.warn(`[${P.tag}] input transcription FAILED for item=${msg.item_id || "?"} — utterance missing from transcript`);
        if (!transcriptionFailureReported) {
          transcriptionFailureReported = true;
          try { Sentry.captureMessage(`${P.tag} input transcription failed`, "warning"); } catch { /* best-effort */ }
        }
        return;

      // BARGE-IN. On a WebSocket the client must stop generation AND trim the
      // model's memory of audio the caller never heard, THEN flush Twilio's buffer.
      // (Grok documents server-VAD interruption without this event — that path is
      // covered by the cancelled-response handling above/below.)
      case "input_audio_buffer.speech_started":
        bargedIn = true; // interruption cleanup happens HERE — cancel-ACKs must not repeat it
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
          console.log(`[${P.tag}] barge-in — dropped ${pendingTools.length} un-executed tool call(s)`);
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
          console.error(`[${P.tag}] tool args JSON.parse failed for ${msg.name}: ${e.message}`);
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

        // A response the server cancelled mid-generation (Grok's silent VAD
        // interruption, or the ack of our own barge-in cancel): its captured
        // tool calls belong to an interrupted turn — ALWAYS drop them (a
        // function_call_arguments.done can land after speech_started's drop and
        // would otherwise execute below) — and only flush Twilio if
        // speech_started didn't already handle this interruption.
        if (msg.response?.status === "cancelled") {
          if (pendingTools.length) {
            console.log(`[${P.tag}] cancelled response — dropped ${pendingTools.length} un-executed tool call(s)`);
            pendingTools = [];
          }
          if (!bargedIn) callbacks.onInterrupted?.();
          bargedIn = false;
          gate.flushQueued();
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
              console.error(`[${P.tag}] tool ${t.name} error:`, err.message);
            }
            let out = typeof result === "string" ? result : (result?.message || "");
            if (!out) { console.warn(`[${P.tag}] empty tool output for ${t.name}`); out = "(no result)"; }
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
          console.warn(`[${P.tag}] benign:`, code);
          gate.resync(); // state desync — a response really is active; re-queue our create
          return;
        }
        if (isBenignError(code)) { console.warn(`[${P.tag}] benign:`, code); return; }
        // Grok reports the benign cancel race with a GENERIC code where OpenAI
        // uses response_cancel_not_active: our barge-in response.cancel crossed
        // a response that had already finished server-side. Dropped BOTH
        // 2026-07-03 eval calls (one right after a successful booking) before
        // this was treated as the non-event it is.
        if (code === "invalid_request_error" && /cancel/i.test(msg.error?.message || "") && /no active response/i.test(msg.error?.message || "")) {
          console.warn(`[${P.tag}] benign cancel race:`, msg.error?.message);
          return;
        }
        // Genuinely fatal — surface to Sentry HERE (the provider's error detail)
        // before the downstream onError loses it, then propagate.
        console.error(`[${P.tag}] server error event:`, JSON.stringify(msg.error || msg).slice(0, 500));
        try { Sentry.captureMessage(`${P.tag} error: ${code || "unknown"} — ${msg.error?.message || ""}`.slice(0, 300), "error"); } catch { /* best-effort */ }
        callbacks.onError?.(new Error(msg.error?.message || `${P.tag} error`));
        return;
      }

      default:
        if (!KNOWN_IGNORED.has(type)) console.debug(`[${P.tag}] unhandled event:`, type);
        return;
    }
  });

  ws.on("error", (err) => { console.error(`[${P.tag}] WS error:`, err.message); Sentry.captureException(err); callbacks.onError?.(err); });
  ws.on("close", (code, reason) => {
    clearWatchdog();
    if (setupTimer) { clearTimeout(setupTimer); setupTimer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    // Best-effort: a caller utterance still held provisionally (Grok) is
    // committed via onTranscriptIn; reaching the STORED transcript relies on
    // the server's onClose flushing its pending buffer (server.js does). On
    // caller hang-up, cleanup runs before this event fires — that residual gap
    // is pre-existing and shared with the Gemini/OpenAI paths.
    inputTranscripts.flush();
    const r = intentionalClose || (reason ? reason.toString() : "");
    console.log(`[${P.tag}] WS closed (code=${code}, reason="${r}")`);
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

/** OpenAI Realtime session (original SCRUM-378 test path — unchanged interface). */
function createOpenAIRealtimeSession(config, callbacks) {
  return createRealtimeSession(config, callbacks, PROVIDERS.openai);
}

/** Grok (xAI) Realtime session — grok-voice-think-fast-1.0 via the same adapter. */
function createGrokRealtimeSession(config, callbacks) {
  return createRealtimeSession(config, callbacks, PROVIDERS.grok);
}

module.exports = {
  createOpenAIRealtimeSession,
  createGrokRealtimeSession,
  _test: {
    toRealtimeTools,
    buildSessionConfig,
    buildGrokSessionConfig,
    createResponseGate,
    createInputTranscriptTracker,
    isBenignError,
    boostMulawBase64,
    KNOWN_IGNORED,
    BENIGN_ERROR_CODES,
    PROVIDERS,
  },
};
