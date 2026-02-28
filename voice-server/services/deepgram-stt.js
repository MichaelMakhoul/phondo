const WebSocket = require("ws");

/**
 * Opens a real-time Deepgram STT WebSocket.
 * Accepts raw mulaw 8kHz audio — no conversion needed from Twilio.
 *
 * @param {string} apiKey
 * @param {{ onTranscript, onUtteranceEnd, onError, onClose }} callbacks
 * @returns {WebSocket}
 */
function openDeepgramStream(apiKey, { onTranscript, onUtteranceEnd, onError, onClose }) {
  const url =
    "wss://api.deepgram.com/v1/listen?" +
    "encoding=mulaw&sample_rate=8000&channels=1" +
    "&model=nova-3" +
    "&punctuate=true" +
    "&interim_results=true" +
    "&endpointing=300" +
    "&utterance_end_ms=1000";

  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  ws.on("open", () => {
    console.log("[STT] Deepgram WebSocket connected");
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "Error") {
        onError(new Error(`Deepgram error: ${msg.message || JSON.stringify(msg)}`));
        return;
      }
      if (msg.type === "Results" && msg.channel) {
        const alt = msg.channel.alternatives[0];
        if (alt && alt.transcript) {
          onTranscript({
            transcript: alt.transcript,
            isFinal: msg.is_final,
          });
        }
      }
      // UtteranceEnd fires when Deepgram's VAD detects the user has stopped speaking.
      // Use this to immediately flush the utterance buffer instead of waiting for debounce.
      if (msg.type === "UtteranceEnd" && onUtteranceEnd) {
        onUtteranceEnd();
      }
    } catch (err) {
      onError(err);
    }
  });

  ws.on("error", (err) => {
    onError(err);
  });

  ws.on("close", (code, reason) => {
    const reasonStr = reason ? reason.toString() : "";
    if (code !== 1000 && code !== 1005) {
      console.error(`[STT] Deepgram WebSocket closed unexpectedly: ${code} ${reasonStr}`);
    } else {
      console.log(`[STT] Deepgram WebSocket closed: ${code} ${reasonStr}`);
    }
    if (onClose) onClose(code);
  });

  return ws;
}

module.exports = { openDeepgramStream };
