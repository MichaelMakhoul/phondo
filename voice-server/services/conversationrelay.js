/**
 * Twilio ConversationRelay + Claude — evaluation pipeline (SCRUM-378 spike).
 *
 * THE THIRD, OPTIONAL pipeline, selected ONLY for a number listed in
 * TEST_PIPELINE_OVERRIDES as "<number>:conversationrelay" (see lib/pipeline-
 * routing.js). Production numbers keep Gemini Live — this file is never reached
 * for them, and unsetting the env removes it entirely.
 *
 * Unlike Gemini Live / OpenAI Realtime (which both speak Twilio's raw μ-law
 * <Stream> protocol on /ws/audio), ConversationRelay has Twilio do STT + TTS
 * server-side and exchanges JSON with us on /ws/conversationrelay:
 *   Twilio → us : { type:"setup" | "prompt" | "interrupt" | "dtmf" | "error" }
 *   us → Twilio : { type:"text", token, last } | { type:"end" }
 * So this handler is a TEXT-in / TEXT-out tool-use loop — the same shape as the
 * classic pipeline's handleUserSpeech, but the LLM is forced to Claude (Haiku)
 * and STT/TTS are Twilio's (Deepgram + ElevenLabs, configured in the TwiML).
 *
 * It reuses the production building blocks unchanged — loadCallContext,
 * buildSystemPrompt, the tool DEFINITIONS, executeToolCall, the CallSession
 * guard methods (confirmCancel / hasUnfinishedBooking / registerBookOutcome),
 * post-call analysis + call-record persistence — so the eval is apples-to-apples
 * on everything except the swapped STT/LLM/TTS. The guard SEQUENCE is replicated
 * here (not shared) on purpose: keeping the live Gemini path untouched is worth
 * more than de-duplication for a temporary spike.
 */

const { WebSocket } = require("ws");
const { Sentry } = require("../lib/sentry");
const { DEBUG_TRANSCRIPTS, logTranscript, logToolCall } = require("../lib/log-transcript");
const { maskPhone } = require("../lib/mask-phone");
const { CallSession } = require("../call-session");
const { loadCallContext } = require("../lib/call-context");
const { buildSystemPrompt, getGreeting } = require("../lib/prompt-builder");
const { forwardingFallbackEligible } = require("../lib/transfer-eligibility");
const { createCallRecord, completeCallRecord, notifyCallCompleted } = require("../lib/call-logger");
const { analyzeCallTranscript } = require("./post-call-analysis");
const { streamClaudeResponse } = require("./claude-chat");
const { requiresRecordingDisclosureHybrid, getRecordingDisclosureText } = require("../lib/recording-consent");
const {
  calendarToolDefinitions,
  listServiceTypesToolDefinition,
  transferToolDefinition,
  callbackToolDefinition,
  endCallToolDefinition,
  executeToolCall,
} = require("./tool-executor");

const MAX_TOOL_ITERATIONS = 5;

// ── Pure helpers (unit-tested via _test) ────────────────────────────────────

/** A ConversationRelay text frame. `last:true` finalizes the speaking turn. */
function crTextFrame(token, last) {
  return { type: "text", token: String(token == null ? "" : token), last: !!last };
}

/** A ConversationRelay end frame — ends the session (Twilio hangs up). */
function crEndFrame(handoffData) {
  const frame = { type: "end" };
  if (handoffData != null) frame.handoffData = typeof handoffData === "string" ? handoffData : JSON.stringify(handoffData);
  return frame;
}

const LANG_NAMES = {
  en: "English", ar: "Arabic", es: "Spanish", fr: "French", de: "German",
  it: "Italian", pt: "Portuguese", zh: "Chinese", hi: "Hindi",
};

/**
 * Build the <Connect><ConversationRelay> TwiML for the eval. Tunable per test
 * run via env (so the user can flip STT model / TTS provider / language without
 * a redeploy) — all optional, with safe defaults that connect out of the box:
 *   CR_LANGUAGE              BCP-47 language          (default "en-US"; set "ar-SA" for Arabic)
 *   CR_TRANSCRIPTION_PROVIDER STT provider            (default "Deepgram")
 *   CR_SPEECH_MODEL          Deepgram model           (optional, e.g. "nova-3-general")
 *   CR_TTS_PROVIDER          TTS provider             (optional, e.g. "ElevenLabs")
 *   CR_VOICE                 TTS voice id             (optional; required for ElevenLabs)
 * @param {{wsUrl:string, token:string, escapeXml:(s:string)=>string, env?:object}} opts
 */
function buildConversationRelayTwiml({ wsUrl, token, escapeXml, env = process.env }) {
  const esc = escapeXml || ((s) => String(s));
  const language = env.CR_LANGUAGE || "en-US";
  const transcriptionProvider = env.CR_TRANSCRIPTION_PROVIDER || "Deepgram";
  const attrs = [
    `url="${esc(wsUrl)}"`,
    `language="${esc(language)}"`,
    `transcriptionProvider="${esc(transcriptionProvider)}"`,
    `interruptible="true"`,
  ];
  if (env.CR_SPEECH_MODEL) attrs.push(`speechModel="${esc(env.CR_SPEECH_MODEL)}"`);
  if (env.CR_TTS_PROVIDER) attrs.push(`ttsProvider="${esc(env.CR_TTS_PROVIDER)}"`);
  if (env.CR_VOICE) attrs.push(`voice="${esc(env.CR_VOICE)}"`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay ${attrs.join(" ")}>
      <Parameter name="auth_token" value="${esc(token)}" />
    </ConversationRelay>
  </Connect>
</Response>`;
}

/**
 * Tool gating — mirrors server.js#buildLLMOptions(session, {includeTransfer:true})
 * (inbound always allows transfer). Tool DEFINITIONS are imported, so only the
 * gating is replicated.
 */
function buildCrTools(session) {
  const tools = [];
  const hasScheduling = session.calendarEnabled || (session.serviceTypes?.length > 0);
  if (hasScheduling) tools.push(...calendarToolDefinitions);
  if (session.serviceTypes?.length > 0) tools.push(listServiceTypesToolDefinition);
  const behaviorAllowsTransfer = session.behaviors?.transferToHuman !== false;
  if ((behaviorAllowsTransfer && session.transferRules?.length > 0) || forwardingFallbackEligible(session)) {
    tools.push(transferToolDefinition);
  }
  tools.push(callbackToolDefinition);
  tools.push(endCallToolDefinition);
  return tools;
}

/** Extract the fields we need from the Twilio `setup` message. */
function parseSetup(msg) {
  const cp = msg.customParameters || {};
  return {
    callSid: msg.callSid || msg.sessionId || null,
    from: msg.from || null,
    to: msg.to || null,
    token: cp.auth_token || null,
  };
}

/** Replicates server.js#buildLanguageLockDirective (which lives in server.js, not a module). */
function buildLanguageLockDirective(langCode) {
  const lang = LANG_NAMES[String(langCode || "en").toLowerCase().slice(0, 2)] || "English";
  const langsPhrase = lang === "English" ? "English" : `${lang} and English`;
  const langOrEnglish = lang === "English" ? "English" : `${lang} or English`;
  return (
    `\n\n🌐 LANGUAGE LOCK (read carefully): This business serves callers in ${langsPhrase}. ` +
    `Detect the caller's language from their first clear turn and stay in it for the WHOLE call. ` +
    `Do NOT assume an unrelated language from unclear, quiet, or noisy audio — ` +
    `if a turn sounds like a language the caller has not clearly used, treat it as ${langOrEnglish} mis-heard on a noisy line and continue in the language they have been using. ` +
    `If you genuinely cannot understand a turn, ask them to repeat — in the language they are using. ` +
    `If after ONE repeat the turn is still COMPLETELY unintelligible (not merely a strong accent or one unclear word), do NOT guess and do NOT book, cancel, or change anything: ` +
    `tell the caller you're having trouble hearing them and use schedule_callback to take their name and number so a person can call them back.`
  );
}

/**
 * Critical behavioral rules — a faithful snapshot of the Gemini path's
 * invariants (server.js ~1917-1975) so Claude is held to the SAME standard the
 * eval is comparing against. The biggest one — never claim an action without a
 * successful tool result — is what we're most testing Claude on.
 */
function buildCriticalRulesSuffix(session) {
  const transferAvailable =
    (session.behaviors?.transferToHuman !== false && (session.transferRules?.length || 0) > 0) ||
    forwardingFallbackEligible(session);
  let s = `\n\nCRITICAL RULES FOR THIS CONVERSATION:`;
  s += `\n- NEVER FABRICATE ACTIONS: It is IMPOSSIBLE to book, cancel, or schedule anything without calling the corresponding tool (book_appointment, cancel_appointment, schedule_callback). If you say "I've booked / cancelled / scheduled" without a SUCCESSFUL tool result, the caller has NO actual appointment — a catastrophic failure. Sequence is ALWAYS: (1) brief filler in the caller's language, (2) CALL THE TOOL, (3) WAIT for the result, (4) ONLY THEN tell the caller what happened based on the result. NEVER say "booked", "confirmed", "cancelled", or "all set" before a tool returns success.`;
  s += `\n- 🔎 UNDERSTAND BEFORE YOU ACT (be a real receptionist): Acting on a misheard request is worse than asking again. If a caller's turn is garbled, cuts in and out, is only fragments, suddenly switches to a language they weren't using, or doesn't form a clear request, do NOT guess what they meant and do NOT act on it — warmly say you didn't catch it and ask them to repeat, in the language they are using ("Sorry, I didn't quite catch that — could you say it again?"). If you DID hear the request clearly, just proceed — do NOT tack on an extra "is that right?" (the name read-back and post-booking confirmation already cover that). Only when you genuinely couldn't hear, or you'd be guessing a name / date / time / which person they want, restate it and get a clear "yes" before transferring, booking, cancelling, rescheduling, or taking a message. A caller who is upset or in a hurry is NOT a reason to make them repeat — if the words are clear, help right away. After a couple of unclear tries, offer a callback rather than guessing. NEVER transfer, book, cancel, reschedule, or record details based on a guess or an unclear turn.`;
  s += `\n- NAME COLLECTION BEFORE BOOKING: Before book_appointment you MUST have the caller's FIRST and LAST name, each repeated back and confirmed. Names MUST be in English letters. If unsure of spelling, ask again. Never book with only one name.`;
  s += `\n- CONFIRM BOOKING DETAILS: AFTER book_appointment returns success, read back name, date, time, and practitioner, then ask "Is everything correct?". NEVER promise a confirmation text or email — none are sent; the read-back is the only confirmation.`;
  s += `\n- RESCHEDULING: To move/change the time of an existing appointment, call the reschedule_appointment tool — ONE call that books the new time and cancels the old one atomically (verified server-side). Identify the existing appointment by the caller's phone + its current date (use lookup_appointment first if you don't know it) and pass new_datetime. NEVER reschedule with separate cancel_appointment + book_appointment calls — that can leave a duplicate.`;
  s += `\n- POST-CONFIRMATION CLOSE: When the caller confirms the details are correct (or says goodbye), say ONE brief warm closing in their language and IMMEDIATELY call end_call with reason="booking_complete" in the same turn. Do not keep talking after they confirm.`;
  if (transferAvailable) {
    s += `\n- TRANSFERS: If the caller asks for a human / person / manager / to be transferred, say a brief "one moment, let me connect you" in their language and call transfer_call immediately. Do NOT ask what they want to discuss first; do NOT offer a message before attempting the transfer. Only after the tool reports no-answer/error may you offer schedule_callback. (This applies to a request you CLEARLY heard; if the line was unclear and you're not sure they asked for a person, re-check what they said first rather than transferring on a guess.)`;
  } else {
    s += `\n- TRANSFERS: This business has not configured a transfer destination. If the caller asks for a human, acknowledge and call schedule_callback to capture their name and number — do not claim you can transfer.`;
  }
  s += buildLanguageLockDirective(session.language);
  return s;
}

/**
 * Run ONE tool call through the production guard sequence, then execute it.
 * Pure-ish + dependency-injected (executeToolCall via `deps`) so it's unit-
 * testable with a fake session. Does NOT push messages — the caller appends the
 * returned `content` as the tool-result message.
 *
 * @returns {Promise<{content:string, held:boolean, endCall:boolean}>}
 *   held=true  → a guard intercepted; `content` is the instruction to feed back
 *   held=false → executed; `content` is the tool result, endCall set for end_call
 */
async function runGuardedToolCall(session, toolCall, deps = {}) {
  const exec = deps.executeToolCall || executeToolCall;
  const now = deps.now || Date.now;
  const name = toolCall.name;
  const args = toolCall.args || {};

  // SCRUM-373: don't end the call on an unfinished booking (language-agnostic).
  if (name === "end_call" && session.hasUnfinishedBooking(args.reason)) {
    const alreadyNudged = (session.toolCallAudit || []).some((t) => t.name === "end_call_blocked");
    if (!alreadyNudged) {
      session.toolCallAudit.push({ name: "end_call_blocked", successful: false, at: now() });
      return {
        held: true,
        endCall: false,
        content:
          "CANNOT END CALL YET: a booking was started but book_appointment never returned success, so the caller has NO appointment. Do NOT say it is booked or 'all set'. Either call book_appointment now with the collected details, OR tell the caller — in their language — that you could not finish it and call schedule_callback. Only call end_call AFTER one of those succeeds.",
      };
    }
    // Already nudged once — let the caller leave rather than trap them, but
    // alert loudly (SCRUM-373 parity): the call is ending on an unfinished
    // booking, so the caller may have been misinformed. This is the exact
    // signal the eval exists to measure.
    console.error(`[CR][HallucinationGuard] Allowing end_call on unfinished booking AFTER a prior nudge. callSid=${session.callSid}`);
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "hallucination_guard");
        scope.setTag("pipeline", "conversationrelay");
        scope.setExtras({ callSid: session.callSid, endCallReason: args.reason || "" });
        Sentry.captureMessage("end_call allowed on unfinished booking after nudge (CR)", "error");
      });
    } catch { /* Sentry best-effort */ }
  }

  // SCRUM-372: cancel-confirmation gate — never cancel on a single (possibly
  // misheard) request; require a second matching confirmation.
  if (name === "cancel_appointment" && !session.confirmCancel(args, now())) {
    session.toolCallAudit.push({ name: "cancel_appointment_held", successful: false, at: now() });
    return {
      held: true,
      endCall: false,
      content:
        "DO NOT CANCEL YET. Read back which appointment would be cancelled (its date and time) and ask the caller — in their language — to clearly confirm (yes/no). ONLY if they clearly say yes, call cancel_appointment again with the same details. If they say no or you are unsure, do NOT cancel.",
    };
  }

  // SCRUM-257: block a duplicate book of an already-confirmed appointment.
  if (name === "book_appointment" && session.confirmedBookings?.size > 0) {
    const reqKey = `${args.datetime}|${(args.first_name || "").toLowerCase()}|${(args.last_name || "").toLowerCase()}`;
    if (session.confirmedBookings.get(reqKey)) {
      session.toolCallAudit.push({ name: "book_appointment_blocked", successful: false, at: now() });
      return {
        held: true,
        endCall: false,
        content:
          "CRITICAL: You already booked this exact appointment in this call. It is LOCKED in the database. DO NOT call book_appointment again. To change it, call the reschedule_appointment tool (it moves it atomically in one step).",
      };
    }
  }

  const result = await exec(name, args, {
    organizationId: session.organizationId,
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

  const message = typeof result === "string" ? result : (result?.message || "");

  // SCRUM-227/257 audit — record whether the tool ACTUALLY succeeded.
  // finalize() and hasUnfinishedBooking() read this to detect hallucinated
  // actions, so a false positive here re-opens the silent-failure hole the
  // spike exists to test. Trust the structured `result.success` boolean when
  // the tool provides one (book/cancel/callback do, via executeCalendarCall);
  // only fall back to text inference otherwise — and a booking requires a
  // POSITIVE confirmation signal, never mere absence of an error word.
  let successful;
  if (typeof result === "object" && typeof result.success === "boolean") {
    successful = result.success;
  } else if (typeof result === "object" && result?.error) {
    successful = false;
  } else {
    const failSignal = /\b(error|not found|couldn'?t|could not|unable|failed|no longer available|already booked|fully booked|no available slot|not configured)\b/i.test(message);
    successful = !failSignal;
    if (name === "book_appointment") {
      const ok = /\b(confirmation code \d{3,8}|i'?ve booked|you'?re all set|appointment (?:is|has been) (?:booked|confirmed))\b/i.test(message);
      successful = successful && ok;
    }
  }
  session.toolCallAudit.push({ name, successful, at: now() });

  // SCRUM-367: deterministic book-loop cap directive.
  let directive = "";
  if (name === "book_appointment") {
    const succeeded = (typeof result === "object" && typeof result.success === "boolean") ? result.success : successful;
    const isAvailabilityReject = /no longer available|already booked|currently blocked|not available for this service|fully booked|no available slot/i.test(message);
    directive = session.registerBookOutcome({ successful: succeeded, isAvailabilityReject }) || "";
  }

  // SCRUM-257: track confirmed bookings (dedupe) and clear on a successful
  // cancel (so reschedule = cancel→book works). Keyed off the authoritative
  // `successful` flag above — NOT raw message text — so a failure message that
  // happens to contain "booked"/"cancelled" can't poison the dedupe map.
  if (name === "book_appointment" && successful) {
    if (!session.confirmedBookings) session.confirmedBookings = new Map();
    const bookKey = `${args.datetime}|${(args.first_name || "").toLowerCase()}|${(args.last_name || "").toLowerCase()}`;
    const codeMatch = message.match(/\b(\d{6})\b/);
    session.confirmedBookings.set(bookKey, { code: codeMatch?.[1] || "unknown", at: now() });
  }
  if (name === "cancel_appointment" && successful) {
    if (session.confirmedBookings) session.confirmedBookings.clear();
  }

  return { content: message + directive, held: false, endCall: !!(typeof result === "object" && result?.__endCall) };
}

// ── WebSocket handler ────────────────────────────────────────────────────────

/**
 * Handle one ConversationRelay WebSocket connection.
 * @param {WebSocket} ws
 * @param {object} req
 * @param {object} [injected] - override deps for tests / pass server-scoped fns
 *   (notably `consumeStreamToken` from server.js).
 */
function handleConversationRelayConnection(ws, req, injected = {}) {
  const d = {
    loadCallContext, buildSystemPrompt, getGreeting, executeToolCall, streamClaudeResponse,
    createCallRecord, completeCallRecord, notifyCallCompleted, analyzeCallTranscript,
    requiresRecordingDisclosureHybrid, getRecordingDisclosureText,
    consumeStreamToken: null,
    internalApiUrl: process.env.INTERNAL_API_URL,
    internalApiSecret: process.env.INTERNAL_API_SECRET,
    ...injected,
  };

  let session = null;
  let context = null;
  let processing = false;
  let finished = false;
  let currentAbort = null;

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function speak(token, last) {
    send(crTextFrame(token, last));
  }

  async function finalize(endedReason) {
    if (finished || !session) return;
    finished = true;
    const s = session;
    session = null;

    const transcript = s.getTranscript();
    const durationSeconds = s.getDurationSeconds();
    let callStatus = s.callFailed ? "failed" : "completed";
    let reason = s.endedReason || endedReason || "caller-hangup";

    // SCRUM-227: flag a transcript that CLAIMS a booking with no successful tool call.
    const bookingClaimRe = /\b(i've booked|you'?re all set|your appointment (?:is|has been) (?:booked|confirmed)|confirmation code (?:is )?\d{3,8})\b/i;
    const hadSuccessfulBook = (s.toolCallAudit || []).some((t) => t.name === "book_appointment" && t.successful);
    if (bookingClaimRe.test(transcript || "") && !hadSuccessfulBook) {
      console.error(`[CR][HallucinatedBooking] callSid=${s.callSid} claimed a booking with no successful book_appointment. audit=${JSON.stringify(s.toolCallAudit || [])}`);
      try {
        Sentry.withScope((scope) => {
          scope.setTag("service", "voice-server");
          scope.setTag("pipeline", "conversationrelay");
          scope.setTag("bug", "hallucinated_booking");
          scope.setExtras({ callSid: s.callSid, organizationId: s.organizationId, toolCallAudit: s.toolCallAudit || [] });
          Sentry.captureMessage("Hallucinated booking detected (CR/Claude eval)", "error");
        });
      } catch { /* Sentry best-effort */ }
      callStatus = "failed";
      reason = "hallucinated_booking";
    }

    let analysis = null;
    if (transcript && durationSeconds > 5) {
      try {
        analysis = await d.analyzeCallTranscript(transcript, { language: s.language });
        if (analysis) {
          const callerForLog = DEBUG_TRANSCRIPTS ? (analysis.callerName || "unknown") : "[redacted]";
          console.log(`[CR][PostCall] caller=${callerForLog}, success=${analysis.successEvaluation}`);
        }
      } catch (err) {
        console.error("[CR][PostCall] Analysis failed:", err.message);
      }
    }

    if (s.callRecordId) {
      try {
        await d.completeCallRecord(s.callRecordId, {
          status: callStatus,
          durationSeconds,
          transcript,
          summary: analysis?.summary || null,
          callerName: analysis?.callerName || null,
          collectedData: analysis?.collectedData || null,
          successEvaluation: analysis?.successEvaluation || null,
          recordingDisclosurePlayed: s.recordingDisclosurePlayed || false,
          sentiment: analysis?.sentiment || null,
          cleanedTranscript: analysis?.cleanedTranscript ?? null,
        });
      } catch (err) {
        console.error("[CR][Cleanup] Failed to complete call record:", err.message);
      }
    } else if (durationSeconds > 0) {
      console.error(`[CR][Cleanup] Call completed with no DB record — data lost. callSid=${s.callSid}`);
      try {
        Sentry.withScope((scope) => {
          scope.setTag("service", "voice-server");
          scope.setTag("pipeline", "conversationrelay");
          scope.setExtras({ callSid: s.callSid, organizationId: s.organizationId, durationSeconds });
          Sentry.captureMessage("CR call completed with no DB record — data lost", "error");
        });
      } catch { /* Sentry best-effort */ }
    }

    if (d.internalApiUrl && d.internalApiSecret && s.organizationId) {
      d.notifyCallCompleted(d.internalApiUrl, d.internalApiSecret, {
        callId: s.callRecordId,
        organizationId: s.organizationId,
        assistantId: s.assistantId,
        callerPhone: s.callerPhone,
        status: callStatus,
        durationSeconds,
        transcript,
        endedReason: reason,
        summary: analysis?.summary || undefined,
        callerName: analysis?.callerName || undefined,
        collectedData: analysis?.collectedData || undefined,
        successEvaluation: analysis?.successEvaluation || undefined,
        unansweredQuestions: analysis?.unansweredQuestions || undefined,
      }).catch((err) => console.error("[CR][Cleanup] notifyCallCompleted failed:", err.message));
    }

    s.destroy();
  }

  async function onSetup(msg) {
    const { callSid, from, to, token } = parseSetup(msg);

    // Auth parity with /ws/audio: prefer the server-side token (carries the
    // called number + caller phone + phoneRecord). Fall back to setup.to/from
    // only if no token mechanism was injected (e.g. unit tests).
    let calledNumber = to;
    let callerPhone = from;
    let phoneRecord = null;
    if (d.consumeStreamToken) {
      const tokenData = token ? d.consumeStreamToken(token) : null;
      if (!tokenData) {
        console.warn(`[CR] Rejected — invalid/missing auth_token (callSid=${callSid})`);
        send(crEndFrame());
        try { ws.close(); } catch { /* already closing */ }
        return;
      }
      calledNumber = tokenData.calledNumber || to;
      callerPhone = tokenData.callerPhone || from;
      phoneRecord = tokenData.phoneRecord || null;
    }

    session = new CallSession(callSid);
    session.callerPhone = callerPhone;
    console.log(`[CR] setup — callSid=${callSid} to=${calledNumber} from=${maskPhone(callerPhone)}`);

    try {
      context = await d.loadCallContext(calledNumber, phoneRecord);
    } catch (err) {
      console.error("[CR] loadCallContext failed:", err.message);
      context = null;
    }
    if (!context) {
      console.warn(`[CR] No context for ${calledNumber} — ending`);
      speak("I'm sorry, this number isn't set up to take calls right now. Goodbye.", true);
      send(crEndFrame());
      try { ws.close(); } catch { /* already closing */ }
      finished = true;
      session = null;
      return;
    }

    // Populate session (mirror server.js ~1611-1637).
    session.organizationId = context.organizationId;
    session.assistantId = context.assistantId;
    session.phoneNumberId = context.phoneNumberId;
    session.transferRules = context.transferRules || [];
    session.userPhoneNumber = context.userPhoneNumber || null;
    session.forwardingStatus = context.forwardingStatus || null;
    session.sourceType = context.sourceType || null;
    session.behaviors = context.assistant?.promptConfig?.behaviors || {};
    session.language = context.assistant.language || "en";
    session.organization = context.organization;
    session.orgPhoneNumber = calledNumber;
    session.telephonyProvider = context.telephonyProvider || "twilio";
    session.calendarEnabled = context.calendarEnabled;
    session.serviceTypes = context.serviceTypes || [];
    session.transferToForwardedNumber = context.assistant?.settings?.transferToForwardedNumber === true;
    session.piiRedactionEnabled = !!(context.assistant.settings?.piiRedactionEnabled);

    // System prompt = production builder + faithful critical-rules snapshot.
    const basePrompt = d.buildSystemPrompt(context.assistant, context.organization, context.knowledgeBase, {
      calendarEnabled: context.calendarEnabled,
      transferRules: session.transferRules,
      isAfterHours: context.isAfterHours,
      afterHoursConfig: context.afterHoursConfig,
      serviceTypes: context.serviceTypes,
    });
    let callerContext = "";
    if (callerPhone) {
      const phoneForPrompt = session.piiRedactionEnabled ? maskPhone(callerPhone) : callerPhone;
      callerContext = `\n\nCALLER CONTEXT:\nThe caller's phone number is ${phoneForPrompt}. If they say "use the number I'm calling from", use this number — do NOT ask them to repeat it.`;
    }
    session.setSystemPrompt(basePrompt + callerContext + buildCriticalRulesSuffix(session));

    // Best-effort call record (so the eval is verifiable from the DB afterward).
    try {
      session.callRecordId = await d.createCallRecord({
        orgId: context.organizationId,
        assistantId: context.assistantId,
        phoneNumberId: context.phoneNumberId,
        callerPhone,
        callSid,
      });
    } catch (err) {
      console.error("[CR] createCallRecord failed (non-fatal):", err.message);
    }

    // Greeting (+ recording disclosure if required) — spoken as the first turn.
    let firstMessage = d.getGreeting(context.assistant, context.organization.name, {
      isAfterHours: context.isAfterHours,
      afterHoursConfig: context.afterHoursConfig,
    });
    try {
      const consent = d.requiresRecordingDisclosureHybrid(
        context.organization.country,
        context.organization.businessState,
        context.organization.recordingConsentMode,
        callerPhone,
      );
      if (consent?.required) {
        const disclosure = d.getRecordingDisclosureText(
          context.organization.country,
          context.organization.recording_disclosure_text,
          context.organization.name,
        );
        firstMessage = `${disclosure} ${firstMessage}`;
        session.recordingDisclosurePlayed = true;
      }
    } catch (err) {
      console.warn("[CR] recording-disclosure check failed (non-fatal):", err.message);
    }
    if (!firstMessage || !firstMessage.trim()) {
      firstMessage = "Hello, thanks for calling. How can I help you today?";
      console.warn(`[CR] Empty greeting from getGreeting — using fallback. callSid=${session.callSid}`);
    }
    speak(firstMessage, true);
    session.addMessage("assistant", firstMessage);
    logTranscript("[CR] greeting", firstMessage);
  }

  async function onPrompt(msg) {
    const text = (msg.voicePrompt || "").trim();
    if (!session || !text) return;
    if (processing) {
      // ConversationRelay shouldn't overlap turns, but guard anyway.
      console.warn(`[CR] Dropping overlapping prompt while processing. callSid=${session.callSid}`);
      return;
    }
    processing = true;
    currentAbort = new AbortController();
    logTranscript("[CR] user", text);
    session.addMessage("user", text);

    const WRITE_TOOLS = /^(book_appointment|cancel_appointment|schedule_callback)$/;

    try {
      const tools = buildCrTools(session);
      let ended = false;
      let producedContent = false;

      for (let i = 0; i < MAX_TOOL_ITERATIONS && !ended; i++) {
        const t0 = Date.now();
        // Per-call safety timeout: a stalled Claude call must never wedge the
        // turn (processing would stay true → every later prompt is dropped).
        // Aborting currentAbort also unblocks an in-flight stream read.
        const callGuard = setTimeout(() => { try { currentAbort?.abort(); } catch { /* noop */ } }, 15_000);
        let result;
        try {
          result = await d.streamClaudeResponse(session.messages, {
            tools,
            signal: currentAbort.signal,
            onSentence: (sentence) => speak(sentence, false),
          });
        } finally {
          clearTimeout(callGuard);
        }
        if (!session) return; // caller hung up mid-call → finalize already ran

        if (result.type === "content") {
          speak("", true); // finalize the speaking turn
          session.addMessage("assistant", result.content);
          logTranscript("[CR] AI", result.content);
          producedContent = true;
          console.log(`[CR] (${Date.now() - t0}ms) reply`);
          break;
        }

        // tool_calls — any streamed text was the filler; now run the tools.
        console.log(`[CR] (${Date.now() - t0}ms) tools: ${result.toolCalls.map((tc) => tc.function.name).join(", ")}`);
        session.messages.push(result.message);

        for (const tc of result.toolCalls) {
          const name = tc.function.name;
          let args = {};
          let parseFailed = false;
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch (e) {
            parseFailed = true;
            console.error(`[CR] tool-arg JSON parse failed for ${name}: ${e.message}`);
          }
          // Never execute a WRITE tool with silently-empty args — a truncated
          // tool-call stream → {} could book/cancel with missing fields. Feed a
          // corrective result so the model re-collects and retries instead.
          if (parseFailed && WRITE_TOOLS.test(name)) {
            session.messages.push({
              role: "tool", tool_call_id: tc.id,
              content: "Your tool-call arguments were malformed or incomplete. Do NOT claim the action happened. Re-collect the details and call the tool again with complete arguments.",
            });
            continue;
          }
          logToolCall("[CR] tool", name, args);
          const guarded = await runGuardedToolCall(session, { name, args }, d);
          if (!session) return; // caller hung up during tool execution
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: guarded.content });
          if (guarded.endCall) ended = true;
        }
      }

      if (ended) {
        speak("", true);
        send(crEndFrame());
        await finalize("assistant-ended");
        try { ws.close(); } catch { /* already closing */ }
      } else if (!producedContent) {
        // Tool loop exhausted with no final reply — NEVER leave the caller in
        // silence (the exact silent-failure class this project forbids; the
        // classic pipeline speaks a recovery line here too — server.js ~3084).
        console.warn(`[CR] Tool loop exhausted after ${MAX_TOOL_ITERATIONS} iterations without a final reply. callSid=${session.callSid}`);
        try {
          Sentry.withScope((scope) => {
            scope.setTag("service", "voice-server");
            scope.setTag("pipeline", "conversationrelay");
            scope.setExtras({ callSid: session.callSid });
            Sentry.captureMessage("CR tool loop exhausted without a final reply", "warning");
          });
        } catch { /* Sentry best-effort */ }
        speak("I'm sorry, I got a bit stuck there. Could you say that again?", true);
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        logTranscript("[CR] turn aborted (barge-in or timeout)", "");
      } else {
        console.error(`[CR] turn error (callSid=${session?.callSid}):`, err.message);
        try { Sentry.captureException(err); } catch { /* best-effort */ }
        speak("I'm sorry, I'm having a little trouble. Could you say that again?", true);
      }
    } finally {
      processing = false;
      currentAbort = null;
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      switch (msg.type) {
        case "setup": await onSetup(msg); break;
        case "prompt": await onPrompt(msg); break;
        case "interrupt":
          // Caller barged in — abort the in-flight turn; Twilio already stopped TTS.
          if (currentAbort) { try { currentAbort.abort(); } catch { /* noop */ } }
          break;
        case "dtmf": break;
        case "error":
          console.error("[CR] Twilio error event:", JSON.stringify(msg).slice(0, 400));
          break;
        default:
          logTranscript("[CR] unhandled event", msg.type || "");
          break;
      }
    } catch (err) {
      console.error("[CR] message handler error:", err.message);
    }
  });

  ws.on("close", () => { finalize("caller-hangup").catch(() => {}); });
  ws.on("error", (err) => {
    console.error("[CR] WS error:", err.message);
    try { Sentry.captureException(err); } catch { /* best-effort */ }
  });
}

module.exports = {
  handleConversationRelayConnection,
  buildConversationRelayTwiml,
  _test: {
    crTextFrame, crEndFrame, buildCrTools, parseSetup, buildConversationRelayTwiml,
    buildLanguageLockDirective, buildCriticalRulesSuffix, runGuardedToolCall,
  },
};
