const { WebSocket } = require("ws");
const { validateInput, getBufferConfig, extractSpokenDigits } = require("./lib/input-validators");
const { logTranscript } = require("./lib/log-transcript");

const MAX_MESSAGES = 21; // system prompt + up to 20 messages (user/assistant turns + tool call/result messages)

/**
 * SCRUM-594: the fast path's per-call audio bookkeeping. server.js owns it (the
 * "Fast classic pipeline" section); null on every other call.
 * @typedef {Object} FastPathState
 * @property {string} speakingText - every word sent to TTS since the player last went idle (the turn engine's echo filter reads it)
 * @property {boolean} unmarked - audio reached the player since its last mark
 * @property {boolean} unflushed - text went to the Aura stream since the last flush
 * @property {number|null} pendingFlushSeq - the latest flush still waiting for its Flushed
 * @property {number} flushedSeq - the highest Flushed sequence id seen (-1 before any)
 * @property {Array<{ seq: number, done: () => void }>} flushWaiters - waits for a Flushed (the end_call hang-up)
 * @property {Array<() => void>} quietWaiters - waits for Aura to go quiet (a refused flush)
 * @property {ReturnType<typeof setTimeout>|null} quietTimer - ends an utterance whose Flushed never comes
 * @property {ReturnType<typeof setTimeout>|null} fluxOpenTimer - Flux must open before it fires
 * @property {boolean} ttsFellBack - the Aura stream failed: REST for the rest of the call
 * @property {boolean} flushRefusalLogged - a refused flush is logged once per call
 * @property {boolean} flushRefused - the last flush was refused: its text is owed until Aura goes quiet
 * @property {number} flushSentAt - Date.now() of the last flush sent
 * @property {ReturnType<typeof setTimeout>|null} flushWatchdog - a Flushed overdue with no audio means a stuck stream
 * @property {number} lastAudioAt - Date.now() of the last Aura audio
 * @property {number} markSeq - utterances the player has marked (the lost-mark backstop acts for the latest)
 * @property {boolean} presumedIdle - the player's last mark never came back: its audio counts as played
 * @property {boolean} lostMarkLogged - a lost mark is logged once per call
 * @property {number} restMarks - REST audio (greeting, disclosure, after an Aura fallback) whose tts-done is not back
 * @property {number} restPlaybackEndsAt - Date.now() estimate of when that REST audio has played
 * @property {ReturnType<typeof setTimeout>|null} restTimer - gives up on REST tts-done marks still out FAST_LOST_MARK_MS past restPlaybackEndsAt
 * @property {boolean} disclosureActive - the recording disclosure is playing: nothing may cut it
 * @property {ReturnType<typeof setTimeout>|null} disclosureTimer - ends the disclosure window if its mark is lost
 * @property {ReturnType<typeof setInterval>|null} fluxWatchdog - no Flux frames while audio goes out means a stuck stream
 * @property {number} auraSentChars - R14″: characters sent to Aura since the echo filter's text last started afresh
 * @property {number} auraReceivedMs - R14″: ms of Aura audio received in that time
 * @property {number|null} questionAudioStartAt - R14″: Date.now() estimate of when the AI's last question starts playing; null when there is none
 * @property {string|null} bargeInDeclined - the reason the last barge-in was declined (logged once in a row); null after one that acted
 * @property {{ readyState: number, send: (data: string) => void }|null} twilioWs - the call's Twilio stream (gate H2 and M5 speak outside a turn)
 * @property {Array<{ text: string, seq: number|null }>} auraSegments - gate H2: text sent to Aura whose Flushed has not confirmed it (seq: the flush it went out with)
 * @property {number} auraHeardSinceFlushedMs - gate H2: ms of Aura audio received since the last Flushed
 * @property {Promise<void>|null} respeak - gate H2: the re-speak of text a failed Aura stream never voiced; later REST speech waits for it
 * @property {number} clearCount - barge-in Clears so far (a re-speak synthesised across one is not sent)
 * @property {ReturnType<typeof setTimeout>|null} auraOpenTimer - gate M3: falls back to REST if Aura does not open in time
 * @property {import("./lib/no-turn-watchdog").NoTurnWatchdog|null} noTurnWatchdog - gate M4b: speech energy with no Flux turn events
 * @property {((reason: string, err: unknown, options?: { callerSpoke?: boolean, captureLevel?: string }) => void)|null} fluxFallBack - hands the call to Nova (set while Flux serves it)
 * @property {ReturnType<typeof setTimeout>|null} repromptTimer - gate M5 (ii): asks the AI's question again after a silence
 * @property {string|null} repromptedQuestion - the question last asked again (once per question)
 * @property {string|null} repromptAwaitingAudio - a re-prompt sent to Aura: recorded in the conversation once its audio starts (a barge-in before that leaves nothing heard)
 * @property {"log"|"act"} noTurnMode - NO_TURN_WATCHDOG: what a no-turn watchdog trip does (gate N2)
 * @property {boolean} noTurnLogged - a log-only trip is logged and captured once per call
 * @property {boolean} notReplyOwed - a filler or an apology went to Aura and its audio may still arrive: no turn's latency (gate N5)
 * @property {number|null} notReplyFlushSeq - the flush that filler or apology went out with; its Flushed ends notReplyOwed
 * @property {boolean} closed - cleanup has run: late callbacks do nothing
 */

/**
 * SCRUM-594: one committed turn's latency stamps, for its [FastTurn] line.
 * Times are Date.now() ms; null until they happen.
 * @typedef {Object} FastTurnRecord
 * @property {number} eotAt - the caller's EndOfTurn (for a Nova or buffered turn: when it reached handleUserSpeech)
 * @property {string} trigger - Flux's EndOfTurn trigger ("model", "timeout", ...), or "buffered"
 * @property {number|null} eagerAt - the EagerEndOfTurn whose draft this turn could adopt
 * @property {boolean} drafted - a draft was started for this turn
 * @property {"adopted"|"discarded"|"none"} spec
 * @property {number|null} llmAt - the reply's first text from the LLM
 * @property {number|null} speakAt - the turn's first words sent to TTS
 * @property {number|null} audioAt - the turn's first audio handed to the player (its reply's: never a filler's or an apology's)
 * @property {boolean} queued - committed while another turn was in flight: it waited in the queue
 * @property {number} waitedMs - ms the turn waited before its LLM could start (the queue, and R12b″'s wait for the AI's audio); such a turn's eot_to_audio is no latency sample
 * @property {boolean} logged
 *
 * SCRUM-594: the fast path's per-call latency summary ([FastCall], calls.metadata.fastPath).
 * @typedef {Object} FastCallStats
 * @property {number} turns - turns answered
 * @property {number} specAdopted
 * @property {number} specDiscarded
 * @property {number[]} eotToAudioMs - one per turn that produced audio
 * @property {{ turnIndex: number, at: number }|null} eager - the latest draft's turn and start
 * @property {FastTurnRecord|null} pending - committed, not yet picked up by handleUserSpeech
 * @property {FastTurnRecord|null} current - the turn handleUserSpeech answered last
 * @property {number} llmErrors - gate H1: fast turns that failed (an apology instead of a reply)
 * @property {number} llmErrorStreak - failed fast turns in a row (two or more page at error level)
 * @property {number} draftsInCall - gate B: drafts started in the call
 * @property {number|null} draftTurnIndex - the turn the last draft was started for
 * @property {number} draftsForTurn - drafts started for that turn
 * @property {boolean} draftCapLogged - the draft cap is logged once per call
 *
 * SCRUM-594: the fast path's turn in flight (server.js beginFastTurn). Its
 * abort() is what a barge-in calls.
 * @typedef {Object} FastTurn
 * @property {AbortController} ctl - aborted by a barge-in or cleanup; the LLM call's signal
 * @property {import("./lib/speculative-reply").SpeculativeReply|null} draft - the adopted draft, if any
 * @property {FastTurnRecord} record
 * @property {string[]} chunks - what the LLM response in flight has sent to TTS (recorded, plus "…", on an abort)
 * @property {boolean} ending - the turn is ending the call: a barge-in leaves its goodbye alone
 * @property {boolean} over - aborted or finished: late fillers and chunks are dropped
 * @property {string|null} abortReason - "barge-in" or "cleanup" once aborted
 * @property {(reason?: string) => void} abort
 */

class CallSession {
  constructor(callSid) {
    this.callSid = callSid;
    this.streamSid = null;
    this.messages = [];
    this.fullTranscriptMessages = []; // Never windowed — used for final transcript
    this.isSpeaking = false;
    this.isProcessing = false;
    this.deepgramWs = null;
    this._sttDropWarned = false;

    // Production fields
    this.startedAt = Date.now();
    this.callerPhone = null;
    this.callRecordId = null;
    this.organizationId = null;
    this.assistantId = null;
    this.phoneNumberId = null;
    this.calendarEnabled = false;
    this.transferRules = [];
    this.deepgramVoice = null;
    this.holdPreset = "neutral";
    this.language = "en";
    this.callFailed = false;
    this.endedReason = null;
    // SCRUM-535: set when the call was served by the fallback realtime
    // provider because Gemini never completed setup. Shape:
    // { from, to, reason, model } — persisted into calls.metadata.
    this.pipelineFailover = null;
    // SCRUM-594: the pipeline this call runs on, set at pipeline selection in
    // server.js ("classic" once a Gemini selection falls back for a missing
    // key). Null on a transfer reconnect, which never selects. Demo-line calls
    // record it in calls.metadata.pipeline.
    /** @type {string|null} */
    this.effectivePipeline = null;
    // SCRUM-594: the demo line's fast classic variant (DEMO_LINE_PIPELINE=classic-fast).
    // "degraded-stt" once its Flux STT has fallen back to Nova (spec §4.8).
    /** @type {boolean|"degraded-stt"} */
    this.fastPath = false;
    // SCRUM-594 PHASE 2 (B1): the model's context window — the system prompt
    // plus the last maxMessages - 1 messages. The fast path keeps the whole call
    // (server.js applyFastConversationSettings): at 20 messages it lost its own
    // booking mid-call and told the caller nothing was booked.
    /** @type {number} */
    this.maxMessages = MAX_MESSAGES;
    // SCRUM-594 PHASE 2 (B2–B4): the fast path's booking guards (lib/booking-guards.js);
    // off on every other call. bookingGuardState counts their holds for this call.
    /** @type {boolean} */
    this.bookingGuards = false;
    /** @type {import("./lib/booking-guards").GuardState} */
    this.bookingGuardState = { spellingHolds: 0, lastSpellingHoldTurn: -1, secondBookingNudged: false, endCallHolds: 0, lastEndCallHoldTurn: -1 };
    // SCRUM-594: the fast path's audio player (lib/fast-player.js); null on every other call.
    /** @type {import("./lib/fast-player").FastPlayer|null} */
    this.fastPlayer = null;
    // SCRUM-594: the fast path's Aura-2 WebSocket TTS (services/aura-stream.js).
    // Null on every other call, and once the stream has failed: sendTTS then
    // speaks over REST for the rest of the call.
    /** @type {import("./services/aura-stream").AuraStream|null} */
    this.fastTts = null;
    // SCRUM-594: the fast path's Flux turn engine (lib/fast-turns.js); null on
    // every other call, and once Flux has fallen back to Nova.
    /** @type {import("./lib/fast-turns").FastTurnEngine|null} */
    this.fastTurns = null;
    // SCRUM-594: the fast path's audio and flush bookkeeping (server.js).
    /** @type {FastPathState|null} */
    this.fastState = null;
    // SCRUM-594: the fast path's turn in flight; a barge-in calls its abort().
    /** @type {FastTurn|null} */
    this.currentTurn = null;
    // SCRUM-594: the speculative draft started on Flux's EagerEndOfTurn
    // (lib/speculative-reply.js), until the turn adopts or discards it.
    /** @type {import("./lib/speculative-reply").SpeculativeReply|null} */
    this.speculation = null;
    // SCRUM-594: the fast path's latency record ([FastTurn], [FastCall]).
    /** @type {FastCallStats|null} */
    this.fastStats = null;
    // SCRUM-594: a reconnected leg (after a failed transfer) writes the first
    // leg's fast-path summary into calls.metadata.fastPath (restoreFrom).
    /** @type {object|null} */
    this.carriedFastPath = null;
    // SCRUM-594 gate C7: the first leg's pipeline (calls.metadata.pipeline), carried the same way.
    /** @type {string|null} */
    this.carriedPipeline = null;
    // SCRUM-594: optional — resolves once the call's queued speech has played.
    // The classic end_call hang-up (server.js hangUpAfterEndCall) awaits it
    // instead of its sendTTS-duration estimate. The fast path sets it: its
    // streaming player has its own flush/mark sequence. Null: the estimate.
    /** @type {(() => Promise<void>)|null} */
    this.awaitPlaybackEnd = null;
    this.recordingDisclosurePlayed = false;
    this.recordingDisclosureFailed = false;
    // SCRUM-424: the disclosure was woven into Gemini's first message but its
    // audio hasn't reached the caller yet. recordingDisclosurePlayed flips
    // true on the first audio chunk actually sent to Twilio — never before.
    this.pendingDisclosureInFirstMessage = false;
    this.pendingTransfer = false;
    this.piiRedactionEnabled = false;
    // SCRUM-587: owner-assistant mode (spec §2). Set on the stream `start`
    // event from the SERVER-SIDE token only (/twiml/owner-pin verified the PIN);
    // false for every customer call. ownerAuth also carries "locked"/"failed"/
    // "error" on a customer call that failed the PIN gate (or whose lockout
    // check failed) → calls.metadata.owner_auth.
    this.ownerMode = false;
    this.ownerAuth = null;         // "verified" | "locked" | "failed" | "error" | null
    this.ownerFirstName = null;    // greeting + caller_name on owner calls
    this.ownerToolCalls = 0;       // per-call cap, lib/owner-tool-runner.js
    // SCRUM-587: the owner confirmation gate's clock (lib/owner-tool-runner.js
    // readBackVerdict), moved ONLY by lib/owner-turn-stamps.js on owner
    // sessions. The turn count only ever goes up — never reset mid-call, or an
    // expired read-back could match again. 0 / null = fail-closed defaults.
    this.assistantTurnSeq = 0;           // assistant turns that produced speech
    this.lastAssistantTurnAt = 0;        // Date.now() when the last one ended
    this.assistantTurnHadSpeech = false; // the current turn has produced audio
    this.lastAssistantSpeechAt = 0;      // Date.now() of the latest assistant audio (heard after the arm?)
    this.lastOwnerSpeechAt = 0;          // first fragment of the owner's latest utterance
    this.ownerPendingConfirmations = null; // Map of armed read-backs (the runner creates it)
    this.ownerConfirmSpentSpeechAt = null; // the utterance that last confirmed a write
    this.ownerConfirmRefusals = null;      // Map key → re-armed since the gate refused it? (the runner creates it)
    this.ownerToolRunsInFlight = null;     // Set of owner tool calls still running (the runner creates it)
    this.ownerToolRunsSettled = false;     // cleanup stopped waiting for them: a write finishing later pages
    this.ownerCancelledToolCallIds = null; // Set of tool call ids Gemini cancelled (the runner creates it)
    // SCRUM-587: an owner who hangs up during setup is not paged as a lost
    // call record (server.js cleanupSession) — these say which case it was.
    this.callRecordRequested = false;      // stream setup reached createCallRecord
    this.streamStoppedByCaller = false;    // Twilio's "stop" arrived (the caller hung up)

    // Call context — populated by loadCallContext()/loadTestCallContext() in
    // server.js once the stream connects (not known at construction). Declared
    // here so the session's full shape is typed (SCRUM-317); all are read via
    // optional chaining and assigned before first use, so null init is inert.
    this.organization = null;       // full organization row
    this.orgPhoneNumber = null;     // business E.164 number (the AI's line)
    this.userPhoneNumber = null;    // owner's number (transfer/forward target)
    this.serviceTypes = null;       // bookable service types for scheduling
    this.behaviors = null;          // assistant behavior flags (transferToHuman, …)
    this.telephonyProvider = null;  // "twilio" | "telnyx"
    this.sourceType = null;         // how the call arrived (e.g. forwarded)
    this.forwardingStatus = null;   // call-forwarding verification status
    this.transferAttempt = null;    // in-progress transfer bookkeeping
    this.scheduleSnapshot = null;   // cached availability snapshot
    this._cacheUnsub = null;        // unsubscribe fn for the schedule-cache listener
    this.callerState = null;        // detected caller US state (recording consent)
    this.consentReason = null;      // recording-consent decision reason
    this.transferToForwardedNumber = false; // SCRUM-327: owner opt-in — transfer to the forwarded number when no rules

    // Utterance buffering — accumulate STT finals before sending to LLM
    this._utteranceBuffer = [];
    this._utteranceTimer = null;
    this._maxWaitTimer = null;
    this._bufferStartedAt = null;
    this._pendingTranscript = null; // queued transcript while LLM is processing

    // Adaptive input detection — controls buffer timing per input type
    this._expectedInputType = "general";

    // Tool call audit — tracks which tools fired successfully during the call.
    // Used by cleanupSession to detect hallucinated bookings (SCRUM-227): if
    // Sophie claims "I've booked you" in the transcript but never got a
    // successful `book_appointment` tool result, flag the call.
    this.toolCallAudit = [];

    // SCRUM-367: count book_appointment rejections in this call. After a few,
    // registerBookOutcome() escalates the tool-result instruction so the model
    // stops re-asking the caller to repeat the same detail (the prose-only
    // "3 strikes" guidance fails under re-STT churn). Reset to 0 on success.
    this.bookRejectionCount = 0;
    // Set true once a booking completes under escalation — its name/phone were
    // AI-supplied, so post-call review may want to verify the spelling.
    this.bookNameEscalated = false;
    // SCRUM-503: reschedule twin of the book-loop cap.
    this.rescheduleRetryCount = 0;

    // SCRUM-372: deterministic cancel-confirmation gate. The FIRST
    // cancel_appointment call in a call is held pending an explicit caller
    // confirmation; only a SECOND call with a matching fingerprint executes.
    // Prevents an irreversible cancel from a single misheard/garbled turn.
    this._pendingCancel = null; // { keys: string[], at: number, callerTurn?: number } | null
    // SCRUM-594 PHASE 2 (B4): the fast path's CancelGate, per booking (keyed by
    // its most specific identifier): held cancels, and confirmed ones kept until
    // the cancel succeeds (clearCancelConfirmation) or five minutes pass.
    /** @type {Map<string, { keys: string[], at: number, callerTurn?: number, transcriptAt?: number }>} */
    this._fastPendingCancels = new Map();
    /** @type {Map<string, { keys: string[], at: number, transcriptAt?: number }>} */
    this._fastConfirmedCancels = new Map();

    // SCRUM-506: per-call carry-forward of the caller's OWN identity/verification
    // details (name/phone/email/date_of_birth), so the AI never re-asks for
    // something the caller already gave earlier in THIS call.
    // PRIVACY CONTRACT: in-memory on this per-call session ONLY; wiped in
    // destroy() at call end; NEVER persisted, NEVER logged as raw values, NEVER
    // shared across calls (each call gets its own CallSession); deliberately NOT
    // restored across a transfer reconnect (see restoreFrom) so it can't enter
    // the module-global pendingTransfers map.
    this.collectedDetails = {};
  }

  /**
   * SCRUM-367: record a book_appointment outcome and return an escalation
   * directive to append to the tool result once the same-detail loop repeats.
   *
   * The model's STT re-hears a hard name differently each turn, so each
   * rejection looks like a NEW value and the prose-only "3 strikes" guard never
   * self-triggers. This counts rejections deterministically and, from the 2nd,
   * tells the model to stop re-asking and proceed (transliterate the name to
   * English itself, use the caller-ID phone).
   *
   * Availability/conflict rejections are legitimate "offer another time" turns,
   * NOT a same-detail loop — they reset the counter so they never escalate.
   *
   * @param {{ successful: boolean, isAvailabilityReject: boolean }} outcome
   * @returns {string} directive to append to the tool-result message ("" = none)
   */
  registerBookOutcome({ successful, isAvailabilityReject }) {
    if (successful || isAvailabilityReject) {
      this.bookRejectionCount = 0;
      return "";
    }
    this.bookRejectionCount += 1;
    if (this.bookRejectionCount < 2) return "";
    // A booking that completes after this point used an AI-supplied name/phone
    // under escalation — flag it so post-call review can surface "name may need
    // verification" (dashboard surfacing tracked as a follow-up).
    this.bookNameEscalated = true;
    return (
      ` (SYSTEM — booking attempt ${this.bookRejectionCount}: you keep re-collecting the same detail. ` +
      `Stop asking the caller to repeat it. If a name is not in English/Latin letters, transliterate it into ` +
      `English letters YOURSELF and use that. Use the caller's phone from caller ID. Then complete the booking. ` +
      `If instead a requested time is unavailable, offer the caller an alternative time.)`
    );
  }

  /**
   * SCRUM-503: the reschedule twin of registerBookOutcome. On the first
   * completed Grok eval call (2026-07-04) the model re-fired
   * reschedule_appointment ~10x in 40s when the tool asked it to confirm the
   * caller's name — every non-success reschedule result is a QUESTION to relay
   * to the caller (name / phone / which-appointment disambiguation), never a
   * retriable error. The blind retries then tripped the per-number attempt cap
   * and blocked the eventually-correct call.
   *
   * Availability/conflict rejections reset the counter — they're legitimate
   * "offer another time" turns, exactly as in the booking cap.
   *
   * @param {{ successful: boolean, isAvailabilityReject: boolean }} outcome
   * @returns {string} directive to append to the tool-result message ("" = none)
   */
  registerRescheduleOutcome({ successful, isAvailabilityReject }) {
    if (successful || isAvailabilityReject) {
      this.rescheduleRetryCount = 0;
      return "";
    }
    this.rescheduleRetryCount += 1;
    if (this.rescheduleRetryCount < 2) return "";
    return (
      ` (SYSTEM — reschedule attempt ${this.rescheduleRetryCount}: STOP calling reschedule_appointment. ` +
      `The tool result above is a QUESTION for the caller, not a retriable error. ASK THE CALLER for exactly ` +
      `what it requests (the name on the booking, or which appointment to move), WAIT for their spoken answer, ` +
      `then call the tool ONCE more with that answer included. If instead the tool says a time or practitioner ` +
      `is unavailable, offer the caller an alternative time.)`
    );
  }

  /**
   * SCRUM-372: two-phase, language-agnostic cancel-confirmation gate.
   *
   * cancel_appointment is destructive and irreversible, and Gemini will call it
   * from a single misheard/garbled turn (a low-volume Arabic call was mis-heard
   * as Spanish and an appointment was wrongly cancelled). This holds the FIRST
   * attempt and only lets a SECOND attempt through when it SHARES a stable
   * identifier with the held one, within a 5-minute window.
   *
   * Stable keys = normalized phone digits and the date (datetime collapsed to
   * YYYY-MM-DD to survive STT churn). Matching on a shared key (not an exact
   * fingerprint) means adding `phone` on the confirm turn — or re-hearing the
   * time within the same day — still confirms. An attempt with NO usable
   * identifier (arg-less / garbled — the noisiest, most dangerous case) is
   * ALWAYS held and can NEVER auto-confirm.
   *
   * SCRUM-594 PHASE 2 (B4): `options.fastPath` runs the fast path's gate
   * instead (confirmFastCancel). Without it the options are ignored: Gemini and
   * classic keep the gate above.
   *
   * @param {{phone?: string, date?: string, datetime?: string}} args
   * @param {number} nowMs - current epoch ms (passed in; Date.now is fine here)
   * @param {{ fastPath?: boolean, callerTurn?: number, transcriptAt?: number, declinedAt?: number }} [options] - the fast path only; ignored otherwise
   * @returns {boolean} true to PROCEED with the cancel, false to hold + confirm first
   */
  confirmCancel(args, nowMs, options = {}) {
    const keys = [];
    const phone = String(args?.phone || "").replace(/\D/g, "");
    if (phone.length >= 6) keys.push("p:" + phone);
    const datePart = String(args?.datetime || args?.date || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) keys.push("d:" + datePart);

    // No usable identifier — always hold, never auto-confirm (clears any pending
    // so two arg-less garbled cancels can't accidentally match each other).
    if (keys.length === 0) {
      this._pendingCancel = null;
      return false;
    }

    if (options.fastPath) return this.confirmFastCancel(args, nowMs, options).proceed;

    const pending = this._pendingCancel;
    if (pending && nowMs - pending.at < 5 * 60 * 1000 && pending.keys.some((k) => keys.includes(k))) {
      this._pendingCancel = null; // shares an identifier with the held attempt — proceed
      return true;
    }
    this._pendingCancel = { keys, at: nowMs };
    return false; // first attempt (or a different/expired one) — hold and confirm
  }

  /**
   * SCRUM-594 PHASE 2 (B4): the CancelGate on the fast path (see confirmCancel,
   * and lib/booking-guards.js fastCancelGate, which passes the model's OWN
   * arguments), with why it proceeded or held. Per BOOKING — the exact time
   * ("t:") when both attempts carry one, else the date, else a shared phone —
   * so two cancels in one reply each keep their own hold. A held cancel is
   * confirmed only by the same booking's attempt after the caller has spoken
   * again (`callerTurn`); a confirmed one stays confirmed for exactly that
   * booking across a handler retry. A caller decline at transcript index
   * `declinedAt` drops every record made before it (`dropped` counts them, for
   * the log), and a cancel right after a decline leaves no hold. A held cancel's
   * retry needs the AI to have spoken after the hold (`assistantAt`: the
   * read-back), not just the caller.
   * @param {{ phone?: string, date?: string, datetime?: string }} args - the model's own arguments
   * @param {number} nowMs
   * @param {{ callerTurn?: number, transcriptAt?: number, declinedAt?: number, assistantAt?: number }} [options]
   * @returns {{ proceed: boolean, via: "confirmed" | "retry" | null, reason: "no-identifier" | "first-attempt" | "awaiting-caller" | "caller-declined" | null, dropped: number }}
   */
  confirmFastCancel(args, nowMs, options = {}) {
    const keys = [];
    const phone = String(args?.phone || "").replace(/\D/g, "");
    if (phone.length >= 6) keys.push("p:" + phone);
    const datePart = String(args?.datetime || args?.date || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) keys.push("d:" + datePart);
    if (keys.length === 0) return { proceed: false, via: null, reason: "no-identifier", dropped: 0 }; // never confirms (SCRUM-372)
    const time = String(args?.datetime || "").slice(0, 16);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time)) keys.push("t:" + time);

    const declinedAt = typeof options.declinedAt === "number" ? options.declinedAt : -1;
    const declinedAfter = (/** @type {{ transcriptAt?: number }} */ rec) => typeof rec.transcriptAt === "number" && declinedAt >= rec.transcriptAt;
    let dropped = 0;
    for (const map of [this._fastPendingCancels, this._fastConfirmedCancels]) {
      for (const [id, rec] of map) {
        if (declinedAfter(rec)) dropped++;
        if (declinedAfter(rec) || nowMs - rec.at >= 5 * 60 * 1000) map.delete(id);
      }
    }
    // Right after the caller's no: hold, and leave nothing their next words could confirm.
    if (typeof options.transcriptAt === "number" && declinedAt === options.transcriptAt - 1) {
      return { proceed: false, via: null, reason: "caller-declined", dropped };
    }
    const key = (/** @type {string[]} */ ks, /** @type {string} */ kind) => ks.find((k) => k.startsWith(kind));
    const sameBooking = (/** @type {string[]} */ held) => {
      if (key(held, "t:") && key(keys, "t:")) return key(held, "t:") === key(keys, "t:");
      if (key(held, "d:") && key(keys, "d:")) return key(held, "d:") === key(keys, "d:");
      return held.some((k) => keys.includes(k));
    };
    const exactlySameBooking = (/** @type {string[]} */ held) => {
      if (key(held, "t:") || key(keys, "t:")) return Boolean(key(held, "t:") && key(held, "t:") === key(keys, "t:"));
      return Boolean(key(held, "d:") && key(held, "d:") === key(keys, "d:"));
    };
    const id = /** @type {string} */ (key(keys, "t:") || key(keys, "d:") || key(keys, "p:"));

    for (const rec of this._fastConfirmedCancels.values()) {
      if (exactlySameBooking(rec.keys)) return { proceed: true, via: "confirmed", reason: null, dropped }; // the handler wanted a detail
    }
    /** @type {[string, { keys: string[], at: number, callerTurn?: number, transcriptAt?: number }] | null} */
    let held = null;
    for (const entry of this._fastPendingCancels) if (sameBooking(entry[1].keys)) { held = entry; break; }
    if (held) {
      const [heldId, rec] = held;
      const callerSpoke = typeof options.callerTurn !== "number" || typeof rec.callerTurn !== "number" || options.callerTurn > rec.callerTurn;
      const aiSpoke = typeof options.assistantAt !== "number" || typeof rec.transcriptAt !== "number" || options.assistantAt >= rec.transcriptAt;
      if (callerSpoke && aiSpoke) {
        this._fastPendingCancels.delete(heldId);
        this._fastConfirmedCancels.set(id, { keys, at: nowMs, transcriptAt: options.transcriptAt });
        return { proceed: true, via: "retry", reason: null, dropped };
      }
      this._fastPendingCancels.set(heldId, { ...rec, keys, at: nowMs });
      return { proceed: false, via: null, reason: "awaiting-caller", dropped };
    }
    this._fastPendingCancels.set(id, { keys, at: nowMs, callerTurn: options.callerTurn, transcriptAt: options.transcriptAt });
    return { proceed: false, via: null, reason: "first-attempt", dropped };
  }

  /**
   * A cancel went through: the next one needs its own confirmation. On the fast
   * path, given the cancel's arguments, only that booking's records go (another
   * booking's held cancel stands); without, everything does.
   * @param {{ phone?: string, date?: string, datetime?: string }} [args]
   */
  clearCancelConfirmation(args) {
    this._pendingCancel = null;
    if (!args) {
      this._fastPendingCancels.clear();
      this._fastConfirmedCancels.clear();
      return;
    }
    const time = String(args.datetime || "").slice(0, 16);
    const date = String(args.datetime || args.date || "").slice(0, 10);
    const phone = String(args.phone || "").replace(/\D/g, "");
    const id = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time) ? "t:" + time : /^\d{4}-\d{2}-\d{2}$/.test(date) ? "d:" + date : phone.length >= 6 ? "p:" + phone : null;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? "d:" + date : null;
    for (const map of [this._fastPendingCancels, this._fastConfirmedCancels]) {
      if (id === null) {
        map.clear();
        continue;
      }
      for (const [key, rec] of map) {
        // That booking's records, and that day's date-only ones (a "which one?" retry's confirmation is spent).
        const dateOnlySameDay = day !== null && rec.keys.includes(day) && !rec.keys.some((k) => k.startsWith("t:"));
        if (key === id || rec.keys.includes(id) || dateOnlySameDay) map.delete(key);
      }
    }
  }

  /**
   * SCRUM-373/377: language-agnostic "did a booking start but never complete?"
   * check, keyed off TOOL STATE (not transcript language).
   *
   * SCRUM-377 fix: it is keyed by TIMESTAMP ORDER, not "any successful cancel
   * clears it." A real reschedule call cancels appointment X (success) and then
   * books appointment Y — the earlier successful cancel must NOT mask the later
   * unfinished booking. So: a booking is unfinished iff there is booking INTENT
   * (a book_appointment attempt — even rejected — or entering the booking funnel
   * via check_availability) that occurred AFTER the most recent SUCCESSFUL
   * book_appointment with no later resolution, OR an end_call whose reason claims
   * a booking/reschedule while NOTHING was booked in the call. A pure
   * cancel/callback call (no booking intent) is still a clean exit.
   *
   * @param {string} [endCallReason] - the reason arg from an end_call tool call
   * @returns {boolean}
   */
  hasUnfinishedBooking(endCallReason = "") {
    const audit = this.toolCallAudit || [];
    const at = (t) => (typeof t.at === "number" ? t.at : 0);
    // The "booking funnel": entering availability or attempting/being-blocked on
    // a booking. A booking/reschedule "resolves" via a SUCCESSFUL book, or via a
    // SUCCESSFUL schedule_callback (the take-a-message fallback).
    // NOTE: book_appointment_blocked is intentionally NOT a funnel step — it is
    // only emitted by the SCRUM-257 duplicate-rebook guard, which fires AFTER a
    // booking already succeeded, so it must not re-flag a completed booking. A
    // genuine failed attempt always logs a `book_appointment` (successful:false).
    // SCRUM-377: reschedule_appointment is BOTH booking intent (a failed move
    // with no resolution is an unfinished booking) AND, when successful, a
    // resolution in its own right (it books the new slot atomically).
    const isFunnel = (t) => this._isFunnelStep(t);
    const isResolve = (t) => this._resolvesFunnel(t, audit);
    const lastFunnelAt = audit.reduce((m, t) => (isFunnel(t) ? Math.max(m, at(t)) : m), 0);
    const lastResolveAt = audit.reduce((m, t) => (isResolve(t) ? Math.max(m, at(t)) : m), 0);
    if (lastFunnelAt > 0) {
      // A booking/reschedule flow was entered. It is unfinished unless a
      // successful booking or a take-a-message callback came AFTER the most
      // recent funnel step — so an earlier cancel (or an earlier completed
      // booking) cannot mask a LATER unfinished reschedule.
      return lastFunnelAt > lastResolveAt;
    }
    // No booking-funnel tool calls at all — only flag if the end_call reason
    // explicitly claims a booking/reschedule while nothing was ever booked.
    // SCRUM-594 (phone test F4): on the fast path, not when the call looked up or
    // cancelled the caller's existing bookings — the model ended a pure cancel
    // call as "booking complete", the nudge said the caller had NO appointment,
    // and a callback the caller didn't want was logged.
    if (this.bookingGuards && audit.some((t) => (t.name === "lookup_appointment" || t.name === "cancel_appointment") && t.successful)) return false;
    const everBooked = audit.some((t) => t.name === "book_appointment" && t.successful);
    // Substring match (not \b-anchored) so snake_case reasons like
    // "booking_complete" / "reschedule_done" match; "cancelled" does not.
    return /(book|reschedul|reserv)/i.test(endCallReason || "") && !everBooked;
  }

  /**
   * SCRUM-593: the booking write an unfinished funnel (see hasUnfinishedBooking)
   * is waiting on: the most recent book_appointment or reschedule_appointment
   * attempt, by `at`, after the last resolution, or null when there is none
   * (only availability checks). The end_call guard words its nudge by it: after
   * a held or failed reschedule the caller's existing appointment still stands.
   * @returns {"book_appointment" | "reschedule_appointment" | null}
   */
  lastFunnelStep() {
    const audit = this.toolCallAudit || [];
    const at = (t) => (typeof t.at === "number" ? t.at : 0);
    // The resolutions hasUnfinishedBooking counts.
    const lastResolveAt = audit.reduce((m, t) => (this._resolvesFunnel(t, audit) ? Math.max(m, at(t)) : m), 0);
    let last = null;
    for (const t of audit) {
      if (t.name !== "book_appointment" && t.name !== "reschedule_appointment" && t.name !== "book_appointment_held") continue;
      if (at(t) <= lastResolveAt) continue;
      if (!last || at(t) >= at(last)) last = t;
    }
    if (!last) return null;
    return last.name === "reschedule_appointment" ? "reschedule_appointment" : "book_appointment"; // a held booking booked nothing
  }

  /**
   * A booking-funnel step (hasUnfinishedBooking): availability, a booking or
   * reschedule attempt, or — the fast path's — a booking its guards held.
   * @param {{ name: string }} t - a toolCallAudit entry
   * @returns {boolean}
   */
  _isFunnelStep(t) {
    return t.name === "book_appointment" || t.name === "check_availability" || t.name === "reschedule_appointment" || t.name === "book_appointment_held";
  }

  /**
   * Does this audit entry resolve the booking funnel: a successful booking,
   * reschedule or take-a-message callback. On the fast path also B3's redirect
   * (this call's booking stands), and (SCRUM-594 phone test F1) a successful
   * cancel of the booking a failed move was for —
   * the caller chose to drop it ("just cancel the one you booked"). Only then:
   * a cancel after a failed BOOKING still leaves the caller with nothing, and
   * Gemini and classic keep the rule they had.
   * @param {{ name: string, successful?: boolean, at?: number, dt?: string, oldDt?: string }} t
   * @param {Array<{ name: string, successful?: boolean, at?: number, dt?: string, oldDt?: string }>} audit
   * @returns {boolean}
   */
  _resolvesFunnel(t, audit) {
    // The fast path's B3 redirect: the caller already has this call's booking, so
    // the new booking flow it interrupted is not left unfinished.
    if (this.bookingGuards && t.name === "book_appointment_redirected") return true;
    if (!t.successful) return false;
    if (t.name === "book_appointment" || t.name === "reschedule_appointment" || t.name === "schedule_callback") return true;
    if (!this.bookingGuards || t.name !== "cancel_appointment") return false;
    const at = (/** @type {{ at?: number }} */ x) => (typeof x.at === "number" ? x.at : 0);
    // The latest booking WRITE before the cancel (an availability check in between changes nothing).
    let latest = null;
    for (const x of audit) {
      if (x !== t && this._isFunnelStep(x) && x.name !== "check_availability" && at(x) <= at(t) && (!latest || at(x) >= at(latest))) latest = x;
    }
    const day = (/** @type {unknown} */ v) => (typeof v === "string" ? v.slice(0, 10) : "");
    return Boolean(latest && latest.name === "reschedule_appointment" && !latest.successful && day(latest.oldDt) && day(latest.oldDt) === day(t.dt));
  }

  /**
   * Restore session state saved by `saveForTransfer` (pending-transfers.js)
   * when a failed/no-answer transfer reconnects the caller to the AI. Mirrors
   * the saveForTransfer payload field-for-field.
   *
   * SCRUM-325: this now also restores userPhoneNumber/forwardingStatus/
   * sourceType — without them a SECOND transfer on the reconnected call
   * couldn't use the forwarded-number fallback (executeToolCall gates the
   * fallback on those three fields, so they were silently `undefined`).
   *
   * @param {Record<string, any>} savedState
   */
  restoreFrom(savedState) {
    this.messages = savedState.messages;
    this.organizationId = savedState.organizationId;
    this.assistantId = savedState.assistantId;
    this.phoneNumberId = savedState.phoneNumberId;
    this.callerPhone = savedState.callerPhone;
    this.callRecordId = savedState.callRecordId;
    this.calendarEnabled = savedState.calendarEnabled;
    this.serviceTypes = savedState.serviceTypes || [];
    this.transferRules = savedState.transferRules;
    this.userPhoneNumber = savedState.userPhoneNumber;
    this.forwardingStatus = savedState.forwardingStatus;
    this.sourceType = savedState.sourceType;
    this.transferToForwardedNumber = savedState.transferToForwardedNumber === true;
    // SCRUM-326: restore the telephony provider so a reconnected Telnyx org's
    // next transfer routes through the Telnyx (not the default Twilio) service.
    // Default "twilio" mirrors how it's read at the executeToolCall context sites.
    this.telephonyProvider = savedState.telephonyProvider || "twilio";
    this.deepgramVoice = savedState.deepgramVoice;
    this.holdPreset = savedState.holdPreset;
    this.organization = savedState.organization;
    this.orgPhoneNumber = savedState.orgPhoneNumber;
    this.transferAttempt = savedState.transferAttempt;
    this.startedAt = savedState.startedAt;
    this.language = savedState.language || "en";
    // SCRUM-587: a customer call that failed the owner PIN gate keeps its
    // stamp across the reconnect (calls.metadata.owner_auth → PR B's lockout
    // email). Owner MODE is never restored: it comes only from a stream token.
    this.ownerAuth = typeof savedState.ownerAuth === "string" ? savedState.ownerAuth : null;
    // SCRUM-594: the first leg's fast-path summary (attached to the entry when
    // that leg's stream closed for the dial), for this leg's call record.
    this.carriedFastPath = savedState.fastPath && typeof savedState.fastPath === "object" ? savedState.fastPath : null;
    this.carriedPipeline = typeof savedState.pipeline === "string" ? savedState.pipeline : null;
  }

  /**
   * Set the system prompt as the first message.
   */
  setSystemPrompt(prompt) {
    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages[0].content = prompt;
    } else {
      this.messages.unshift({ role: "system", content: prompt });
    }
  }

  addMessage(role, content) {
    this.messages.push({ role, content });
    // Keep a complete copy for transcript (never windowed)
    if ((role === "user" || role === "assistant") && typeof content === "string") {
      this.fullTranscriptMessages.push({ role, content, at: Date.now() }); // at: SCRUM-559 temporal claim alignment
    }
    // Sliding window: keep system prompt + last N messages
    if (this.messages.length > this.maxMessages) {
      const keep = this.messages.slice(-this.maxMessages + 1);
      // Don't start with an orphaned tool response — find a safe cut point
      let startIdx = 0;
      while (startIdx < keep.length && keep[startIdx].role === "tool") {
        startIdx++;
      }
      this.messages = [this.messages[0], ...keep.slice(startIdx)];
    }
  }

  /**
   * Build a transcript string from the FULL conversation (not windowed).
   * Excludes tool call internals — only user and assistant content messages.
   */
  getTranscript() {
    return this.fullTranscriptMessages
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
      .join("\n");
  }

  /**
   * Get call duration in seconds from startedAt to now.
   */
  getDurationSeconds() {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  /**
   * Set the expected input type for the next user utterance.
   * Controls buffer timing and validation behavior.
   * @param {"phone"|"email"|"name"|"address"|"date_time"|"general"} type
   */
  setExpectedInputType(type) {
    this._expectedInputType = type || "general";
  }

  /**
   * Buffer a final STT transcript and debounce before dispatching.
   * Uses type-aware timing: structured inputs (phone, email, address)
   * get longer debounce and max-wait to avoid cutting off mid-dictation.
   */
  bufferTranscript(text, callback) {
    const config = getBufferConfig(this._expectedInputType);

    this._utteranceBuffer.push(text);
    if (!this._utteranceCallback) this._utteranceCallback = callback;

    // Start max-wait timer on first buffer entry
    if (!this._bufferStartedAt) {
      this._bufferStartedAt = Date.now();
      this._hasExtendedMaxWait = false;
      this._maxWaitTimer = setTimeout(() => {
        this._handleMaxWait(config);
      }, config.maxWaitMs);
    }

    // Reset debounce timer
    if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
    this._utteranceTimer = setTimeout(() => {
      const combined = this._utteranceBuffer.join(" ").trim();
      if (!combined) return;

      // For structured inputs, check completeness before flushing
      if (this._expectedInputType !== "general") {
        // If the response is clearly natural language (no digits at all),
        // don't wait for structured input — flush immediately.
        // E.g., "it's the same one" when expecting a phone number.
        const hasDigits = /\d/.test(combined) || extractSpokenDigits(combined).length > 0;
        if (!hasDigits && combined.split(/\s+/).length >= 2) {
          console.log(`[Buffer] Natural language response for type="${this._expectedInputType}" — flushing immediately`);
          this._flushAndReset();
        } else {
          const { complete, reason } = validateInput(this._expectedInputType, combined);
          if (complete) {
            console.log(`[Buffer] Input validated (${this._expectedInputType}): ${reason}`);
            this._flushAndReset();
          } else {
            console.log(`[Buffer] Input incomplete (${this._expectedInputType}): ${reason} — waiting...`);
            // Don't flush yet — debounce will restart on next STT final,
            // or maxWait will force flush
          }
        }
      } else {
        this._flushAndReset();
      }
    }, config.debounceMs);
  }

  /**
   * Flush the utterance buffer when triggered by UtteranceEnd.
   * Respects ignoreUtteranceEnd for structured input types.
   */
  flushBuffer() {
    const config = getBufferConfig(this._expectedInputType);
    if (config.ignoreUtteranceEnd && this._utteranceBuffer.length > 0) {
      console.log(`[Buffer] Ignoring UtteranceEnd for type="${this._expectedInputType}"`);
      return;
    }
    this._flushAndReset();
  }

  /**
   * Handle max-wait timer expiry. For phone input, if the digit count is
   * between 4-7 (partial number), extend the timer once by 4s to allow the
   * caller to finish dictating. Prevents 10-digit AU numbers from splitting.
   */
  _handleMaxWait(config) {
    if (this._expectedInputType === "phone" && !this._hasExtendedMaxWait) {
      const combined = this._utteranceBuffer.join(" ").trim();
      if (combined) {
        const digits = extractSpokenDigits(combined);
        if (digits.length >= 4 && digits.length < 8) {
          this._hasExtendedMaxWait = true;
          console.log(`[Buffer] Phone incomplete (${digits.length} digits) at max-wait — extending 4s`);
          this._maxWaitTimer = setTimeout(() => {
            console.log(`[Buffer] Extended max-wait expired — force flushing`);
            this._flushAndReset();
          }, 4000);
          return;
        }
      }
    }
    console.log(`[Buffer] Max wait (${config.maxWaitMs}ms) reached for type="${this._expectedInputType}" — force flushing`);
    this._flushAndReset();
  }

  /**
   * Internal: flush buffer, clear all timers, reset input type.
   */
  _flushAndReset() {
    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
      this._utteranceTimer = null;
    }
    if (this._maxWaitTimer) {
      clearTimeout(this._maxWaitTimer);
      this._maxWaitTimer = null;
    }
    this._bufferStartedAt = null;

    const combined = this._utteranceBuffer.join(" ").trim();
    const fragmentCount = this._utteranceBuffer.length;
    this._utteranceBuffer = [];
    const cb = this._utteranceCallback;
    this._utteranceCallback = null;

    // Log short utterance flushes — signals premature STT splitting
    if (combined) {
      const wordCount = combined.split(/\s+/).length;
      if (wordCount <= 2 && fragmentCount === 1) {
        // SCRUM-339: `combined` is verbatim caller speech — gate behind debug.
        logTranscript(`[Metrics] Short utterance flush (${wordCount} words, type=${this._expectedInputType})`, combined);
      }
      if (fragmentCount > 1) {
        logTranscript(`[Metrics] Multi-fragment utterance: ${fragmentCount} fragments (type=${this._expectedInputType})`, combined);
      }
    }

    // Capture input type before reset — callback may need it for model selection
    const inputTypeAtFlush = this._expectedInputType;

    // Reset to general after flushing
    this._expectedInputType = "general";

    if (combined && cb) cb(combined, inputTypeAtFlush);
  }

  /**
   * Queue transcript if LLM is busy, otherwise process immediately.
   * After LLM finishes, check for a queued transcript and process it.
   */
  queueOrProcess(transcript, processFn) {
    if (this.isProcessing) {
      // Append to pending instead of dropping
      this._pendingTranscript = this._pendingTranscript
        ? this._pendingTranscript + " " + transcript
        : transcript;
      return;
    }
    processFn(transcript);
  }

  /**
   * Call after LLM processing finishes. If there's a queued transcript,
   * dispatch it for processing.
   */
  drainPending(processFn) {
    if (this._pendingTranscript) {
      const pending = this._pendingTranscript;
      this._pendingTranscript = null;
      // Use setImmediate to break the call chain:
      // handleUserSpeech → finally → drainPending → handleUserSpeech
      setImmediate(() => processFn(pending));
    }
  }

  /**
   * SCRUM-506: accumulate the caller's OWN identity/verification details from
   * the structured tool args the model already controls, so a later tool call
   * in THIS call can reuse them instead of re-asking. Last-non-empty wins (a
   * correction updates it; an arg-less later call can't wipe a good value).
   *
   * Scoped to the caller's identity: book_appointment is intentionally excluded
   * (its attendee may be a THIRD PARTY), and a reschedule's first_name/last_name
   * (the NEW attendee name for a rename) are excluded too — only the top-level
   * `name` (the caller confirming who they are) is remembered.
   *
   * @param {string} functionName
   * @param {Record<string, unknown>} args
   */
  rememberDetails(functionName, args) {
    if (!args || typeof args !== "object") return;
    const FIELDS_BY_TOOL = {
      lookup_appointment: ["name", "phone", "email", "date_of_birth"],
      cancel_appointment: ["name", "phone", "email"],
      reschedule_appointment: ["name", "phone", "email"],
    };
    // Array.isArray (not a plain truthy check): functionName is model-controlled,
    // so a name matching an Object.prototype key ("constructor"/"toString"/…)
    // would otherwise return a truthy non-array via the prototype chain and make
    // the for..of below throw. Only the three real tool entries are arrays.
    const fields = FIELDS_BY_TOOL[functionName];
    if (!Array.isArray(fields)) return;
    for (const key of fields) {
      const v = args[key];
      if (typeof v === "string" && v.trim()) {
        this.collectedDetails[key] = v.trim();
      }
    }
  }

  /** SCRUM-506: a shallow copy of the per-call details (never the live ref). */
  getCollectedDetails() {
    return { ...this.collectedDetails };
  }

  destroy() {
    if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
    if (this._maxWaitTimer) clearTimeout(this._maxWaitTimer);
    if (this.deepgramWs && this.deepgramWs.readyState === WebSocket.OPEN) {
      this.deepgramWs.close();
    }
    this.deepgramWs = null;
    // Close Gemini Live session if active
    if (this.geminiSession) {
      this.geminiSession.close();
      this.geminiSession = null;
    }
    this.messages = [];
    this.fullTranscriptMessages = [];
    this.collectedDetails = {}; // SCRUM-506: wipe caller details at call end
  }
}

module.exports = { CallSession };
