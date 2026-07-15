// SCRUM-550: rebuild a two-sided call transcript from Deepgram's multichannel
// pre-recorded utterances. Output matches call-session.getTranscript()'s shape
// ("User: …\nAI: …") so it feeds analyzeCallTranscript + the dashboard raw view
// unchanged.

// Which Deepgram channel index is the caller (the other is the AI). Twilio
// dual-channel recordings put the two legs on separate channels; verify on the
// first real call — flipping this constant is the only change if reversed.
const CALLER_RECORDING_CHANNEL = 0;

/**
 * @param {Array<{start:number,channel:number,transcript:string}>} utterances
 * @param {{ callerChannel?: number }} [options]
 * @returns {string}
 */
function buildTwoSidedTranscript(utterances, { callerChannel = CALLER_RECORDING_CHANNEL } = {}) {
  const sorted = [...(utterances || [])]
    .filter((u) => u && typeof u.transcript === "string" && u.transcript.trim())
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

  const lines = [];
  let curRole = null;
  let curText = [];
  const flush = () => {
    if (curText.length) lines.push(`${curRole}: ${curText.join(" ")}`);
    curText = [];
  };

  for (const u of sorted) {
    const role = u.channel === callerChannel ? "User" : "AI";
    if (role !== curRole) {
      flush();
      curRole = role;
    }
    curText.push(u.transcript.trim());
  }
  flush();

  return lines.join("\n");
}

module.exports = { buildTwoSidedTranscript, CALLER_RECORDING_CHANNEL };
