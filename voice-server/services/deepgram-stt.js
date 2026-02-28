const WebSocket = require("ws");

/**
 * Industry-specific keywords that Deepgram should boost for better
 * transcription accuracy. Each keyword gets an intensity boost (default 1.0,
 * max ~3.0). Higher values = stronger bias toward that word.
 */
const INDUSTRY_KEYWORDS = {
  dental: [
    "appointment:2", "cleaning:1.5", "extraction:2", "crown:1.5", "filling:1.5",
    "denture:1.5", "orthodontist:2", "hygienist:1.5", "checkup:1.5", "x-ray:1.5",
    "toothache:1.5", "cavity:1.5", "root canal:2", "dental:1.5",
  ],
  medical: [
    "appointment:2", "prescription:2", "referral:1.5", "doctor:1.5", "specialist:1.5",
    "symptoms:1.5", "blood test:1.5", "diagnosis:1.5", "Medicare:2", "bulk bill:2",
    "consultation:1.5", "pathology:1.5",
  ],
  legal: [
    "consultation:1.5", "attorney:1.5", "solicitor:2", "barrister:1.5", "litigation:1.5",
    "contract:1.5", "conveyancing:2", "affidavit:2", "subpoena:2", "probate:2",
    "power of attorney:2", "settlement:1.5",
  ],
  home_services: [
    "quote:1.5", "estimate:1.5", "emergency:2", "leak:1.5", "burst:1.5",
    "plumber:1.5", "electrician:1.5", "blocked:1.5", "hot water:1.5", "air conditioning:1.5",
    "switchboard:1.5", "inspection:1.5",
  ],
  real_estate: [
    "inspection:1.5", "listing:1.5", "auction:1.5", "appraisal:1.5", "settlement:1.5",
    "conveyancing:1.5", "strata:1.5", "property:1.5", "tenant:1.5", "lease:1.5",
  ],
  // Common keywords boosted for all industries
  _common: [
    "appointment:1.5", "callback:1.5", "reschedule:1.5", "cancel:1.5",
    "available:1.5", "urgent:1.5", "emergency:1.5", "Monday:1", "Tuesday:1",
    "Wednesday:1", "Thursday:1", "Friday:1", "Saturday:1", "Sunday:1",
  ],
};

/**
 * Build the keywords query parameter for Deepgram.
 * @param {string} [industry] - Industry key from org settings
 * @returns {string} URL-encoded keywords param, or empty string
 */
function buildKeywordsParam(industry) {
  const keywords = [...(INDUSTRY_KEYWORDS._common || [])];
  if (industry && INDUSTRY_KEYWORDS[industry]) {
    keywords.push(...INDUSTRY_KEYWORDS[industry]);
  }
  if (keywords.length === 0) return "";
  // Deepgram format: &keywords=word:boost&keywords=word2:boost2
  return keywords.map((kw) => `&keywords=${encodeURIComponent(kw)}`).join("");
}

/**
 * Opens a real-time Deepgram STT WebSocket.
 * Accepts raw mulaw 8kHz audio — no conversion needed from Twilio.
 *
 * @param {string} apiKey
 * @param {{ onTranscript, onUtteranceEnd, onError, onClose }} callbacks
 * @param {{ industry?: string }} [options] - Optional config for keyword boosting
 * @returns {WebSocket}
 */
function openDeepgramStream(apiKey, { onTranscript, onUtteranceEnd, onError, onClose }, options = {}) {
  const keywordsParam = buildKeywordsParam(options.industry);

  const url =
    "wss://api.deepgram.com/v1/listen?" +
    "encoding=mulaw&sample_rate=8000&channels=1" +
    "&model=nova-2" +
    "&punctuate=true" +
    "&interim_results=true" +
    "&endpointing=300" +
    "&utterance_end_ms=1000" +
    keywordsParam;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  ws.on("open", () => {
    console.log(`[STT] Deepgram WebSocket connected (industry=${options.industry || "general"}, keywords=${keywordsParam ? "yes" : "none"})`);
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

module.exports = { openDeepgramStream, INDUSTRY_KEYWORDS };
