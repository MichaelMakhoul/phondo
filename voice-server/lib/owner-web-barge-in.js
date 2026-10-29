// SCRUM-618: the owner talking over the assistant in the browser bubble stops it,
// as Gemini's barge-in did. On the classic pipeline the voice server decides: the
// reply's audio is sent ahead of playback, so it is still playing until
// `webAudioUntil`; owner speech before then tells the browser to drop it ("clear",
// which the bubble already handles for Gemini) and marks the turn barged in, so
// handleTestUserSpeech sends no more of it. More than two words, or a stop word,
// so the speaker's own echo (the browser cancels most of it) can't barge in.

const { browserAudioMs } = require("./browser-audio");

const STOP_WORDS_RE = /^(stop|wait|hold on|no|cancel|nevermind|never mind|excuse me|hello|hey)\b/i;

/**
 * Notes audio sent to the owner's browser: it plays in real time (the phone's 8 kHz
 * μ-law, 8 bytes a millisecond, or wideband PCM, 48 — SCRUM-619) after whatever was
 * already queued — and whose turn it is.
 * @param {{ webAudioUntil?: number, webAudioTurn?: number, browserAudio?: { bytesPerMs: number } | null }} session
 * @param {number} bytes
 * @param {number} turn - the turn the audio belongs to
 * @param {number} [now]
 */
function noteOwnerWebAudio(session, bytes, turn, now = Date.now()) {
  session.webAudioUntil = Math.max(now, session.webAudioUntil || 0) + browserAudioMs(session, bytes);
  session.webAudioTurn = turn;
}

/**
 * The owner spoke while the reply was still playing: the browser drops it, and the turn
 * the playing audio belongs to is marked barged in (session.webBargeInSeq) — never a newer
 * turn that is still thinking, whose reply the owner hasn't heard a word of.
 * @param {{ webAudioUntil?: number, webAudioTurn?: number, webTurnSeq?: number, webBargeInSeq?: number }} session
 * @param {{ readyState: number, send: (data: string) => void }} ws
 * @param {string} transcript - what the owner has said so far (a partial counts)
 * @param {number} [now]
 * @returns {boolean} whether it barged in
 */
function ownerWebBargeIn(session, ws, transcript, now = Date.now()) {
  if (!(now < (session.webAudioUntil || 0))) return false; // nothing is playing
  const said = String(transcript || "").trim();
  if (!said || (said.split(/\s+/).length <= 2 && !STOP_WORDS_RE.test(said))) return false;
  session.webBargeInSeq = session.webAudioTurn ?? session.webTurnSeq ?? 0;
  session.webAudioUntil = 0;
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "clear" })); // 1 = WebSocket.OPEN
  return true;
}

module.exports = { noteOwnerWebAudio, ownerWebBargeIn };
