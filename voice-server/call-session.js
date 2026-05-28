const { WebSocket } = require("ws");
const { validateInput, getBufferConfig, extractSpokenDigits } = require("./lib/input-validators");
const { logTranscript } = require("./lib/log-transcript");

const MAX_MESSAGES = 21; // system prompt + up to 20 messages (user/assistant turns + tool call/result messages)

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
    this.recordingDisclosurePlayed = false;
    this.recordingDisclosureFailed = false;
    this.pendingTransfer = false;
    this.piiRedactionEnabled = false;

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
      this.fullTranscriptMessages.push({ role, content });
    }
    // Sliding window: keep system prompt + last N messages
    if (this.messages.length > MAX_MESSAGES) {
      const keep = this.messages.slice(-MAX_MESSAGES + 1);
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
  }
}

module.exports = { CallSession };
