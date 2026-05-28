/**
 * SCRUM-339: keep caller PII out of stdout.
 *
 * Fly ships the voice server's stdout to Grafana Loki, so anything logged here
 * is readable by anyone with log access — bypassing the per-org PII redaction.
 * Caller speech, AI turns that echo it back ("Thanks, John…"), and tool-call
 * arguments (first_name/last_name/phone/email) are all PII.
 *
 * With DEBUG_TRANSCRIPTS=true (NOT set in production) the full content is
 * logged for local debugging; otherwise only a non-PII breadcrumb is logged so
 * call flow stays traceable.
 */
const DEBUG_TRANSCRIPTS = process.env.DEBUG_TRANSCRIPTS === "true";

/** Log transcript / AI-turn / reply text. Full text under debug, else "[N chars]". */
function logTranscript(label, text) {
  if (DEBUG_TRANSCRIPTS) {
    console.log(`${label}: "${text}"`);
  } else {
    console.log(`${label}: [${(text || "").length} chars]`);
  }
}

/**
 * Log a tool call. The function NAME is safe to log; the ARGUMENTS carry caller
 * PII, so they're only emitted under debug — otherwise just the arg count.
 * `args` may be an object or a raw JSON string.
 */
function logToolCall(label, name, args) {
  if (DEBUG_TRANSCRIPTS) {
    let argStr;
    if (typeof args === "string") {
      argStr = args;
    } else {
      try {
        argStr = JSON.stringify(args ?? {});
      } catch {
        argStr = "[unserializable]";
      }
    }
    console.log(`${label}: ${name}(${argStr.slice(0, 200)})`);
  } else {
    let count = 0;
    if (args && typeof args === "object") {
      count = Object.keys(args).length;
    } else if (typeof args === "string") {
      count = args.length ? 1 : 0;
    }
    console.log(`${label}: ${name} (${count} arg${count === 1 ? "" : "s"})`);
  }
}

module.exports = { DEBUG_TRANSCRIPTS, logTranscript, logToolCall };
