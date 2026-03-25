const { WebSocket } = require("ws");
const { validateInput, getBufferConfig, extractSpokenDigits } = require("./lib/input-validators");

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

    // Utterance buffering — accumulate STT finals before sending to LLM
    this._utteranceBuffer = [];
    this._utteranceTimer = null;
    this._maxWaitTimer = null;
    this._bufferStartedAt = null;
    this._pendingTranscript = null; // queued transcript while LLM is processing

    // Adaptive input detection — controls buffer timing per input type
    this._expectedInputType = "general";
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
    this._utteranceBuffer = [];
    const cb = this._utteranceCallback;
    this._utteranceCallback = null;

    // Reset to general after flushing
    this._expectedInputType = "general";

    if (combined && cb) cb(combined);
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
    this.messages = [];
    this.fullTranscriptMessages = [];
  }
}

module.exports = { CallSession };
