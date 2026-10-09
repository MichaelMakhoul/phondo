"use strict";
/**
 * SCRUM-587 — the clock the owner confirmation gate reads
 * (lib/owner-tool-runner.js readBackAnswered): which assistant turn this is,
 * when the last one ended, and when the owner last started to speak.
 * server.js calls these from both pipelines, for owner sessions only:
 *
 * - noteAssistantSpeech — the current assistant turn produced AUDIO: a
 *   Gemini/realtime output audio chunk (delivered in order with the turn's
 *   end), or a classic reply sentence that reached the caller. It also stamps
 *   lastAssistantSpeechAt — the gate needs the read-back to be heard AFTER the
 *   arm. Output transcription never counts: it can trail its turn, so a late
 *   fragment after `interrupted` would make that turn's `turnComplete` count
 *   again, and one before a tool-call-only turn would make that turn count.
 * - noteAssistantTurnEnd — a turn ended (Gemini turnComplete or interrupted;
 *   classic: once the reply has been spoken). It counts ONCE, and only if the
 *   turn produced speech: a tool-call-only turn (Gemini's non-blocking tool
 *   calls end one) must not count, or every armed read-back would expire; and
 *   Gemini can deliver `interrupted` and `turnComplete` for the same turn —
 *   whichever comes first spends the turn's speech, so the pair counts once.
 * - noteOwnerSpeech — the owner said something (a transcript with at least
 *   one letter or digit once transcription markers such as "<noise>" and
 *   "[inaudible]" are removed). Once per utterance: only the first fragment
 *   after the last assistant turn moves the stamp, so the two fragments of
 *   "ok… thanks" are one utterance and can confirm one write.
 *
 * assistantTurnSeq only ever goes up. Nothing resets it mid-call: a reset
 * would let an expired read-back's `seq + 1` match again. All stamps are
 * Date.now() based, like the runner's arm time.
 */

/** At least one letter or digit, in any script — not silence, noise or punctuation. */
const HAS_WORDS = /[\p{L}\p{N}]/u;
/** Transcription markers for sounds, not words: "<noise>", "[inaudible]". */
const NON_SPEECH_MARKERS = /<[^<>]*>|\[[^[\]]*\]/g;

/**
 * @param {any} session
 * @returns {boolean}
 */
function isOwnerSession(session) {
  return Boolean(session) && session.ownerMode === true;
}

/**
 * The current assistant turn produced audio.
 * @param {any} session
 * @param {number} [now]
 */
function noteAssistantSpeech(session, now = Date.now()) {
  if (!isOwnerSession(session)) return;
  session.assistantTurnHadSpeech = true;
  session.lastAssistantSpeechAt = now;
}

/**
 * An assistant turn ended (completed or interrupted).
 * @param {any} session
 * @param {number} [now]
 * @returns {boolean} whether the turn was counted
 */
function noteAssistantTurnEnd(session, now = Date.now()) {
  if (!isOwnerSession(session) || session.assistantTurnHadSpeech !== true) return false;
  session.assistantTurnHadSpeech = false;
  session.assistantTurnSeq += 1;
  session.lastAssistantTurnAt = now;
  return true;
}

/**
 * The owner spoke (a transcript fragment).
 * @param {any} session
 * @param {unknown} text
 * @param {number} [now]
 * @returns {boolean} whether the stamp moved
 */
function noteOwnerSpeech(session, text, now = Date.now()) {
  if (!isOwnerSession(session) || typeof text !== "string") return false;
  if (!HAS_WORDS.test(text.replace(NON_SPEECH_MARKERS, " "))) return false;
  // Already stamped since the assistant last spoke: the same utterance.
  if (session.lastOwnerSpeechAt > session.lastAssistantTurnAt) return false;
  session.lastOwnerSpeechAt = now;
  return true;
}

module.exports = { noteAssistantSpeech, noteAssistantTurnEnd, noteOwnerSpeech };
