/**
 * Map an internal ended-reason code to customer-facing email copy (SCRUM-496).
 *
 * The voice server labels failures with the pipeline that actually ran
 * ("gemini-error", "grok-error", "openai-error", "…-setup-timeout",
 * "…-session-closed"). Those codes are for the DB (calls.metadata.ended_reason)
 * and support diagnostics — they must NEVER appear verbatim in an email to a
 * business owner, both because they're meaningless to them and because they
 * leak which AI vendor is behind their receptionist.
 */

const PROVIDER_ERROR = /^(gemini|grok|openai)-(error|setup-timeout)$/;
const PROVIDER_CLOSED = /^(gemini|grok|openai)-session-closed$/;

export function humanizeEndedReason(endedReason: string | undefined): string {
  const reason = endedReason || "";
  switch (reason) {
    case "stt-error":
    case "stt-connection-lost":
      return "The speech recognition system failed during the call.";
    case "llm-error":
      return "The AI assistant encountered a technical error and couldn't respond.";
    case "tts-error":
      return "The voice system failed during the call.";
    case "server-error":
      return "The voice server encountered an error processing the call.";
    default:
      // hallucinated_booking / hallucinated_callback / …: the AI claimed an
      // action it never completed. This is the ONE failure class where the
      // owner must act (a caller now believes a false thing) — generic
      // "technical issue" copy would bury that (review P2).
      if (reason.startsWith("hallucinated_")) {
        return "The AI may have told the caller something was completed when it wasn't. Please review the call and contact the caller to confirm.";
      }
      if (PROVIDER_ERROR.test(reason)) {
        return "The AI assistant encountered a technical error and couldn't take the call.";
      }
      if (PROVIDER_CLOSED.test(reason)) {
        return "The AI assistant disconnected unexpectedly during the call.";
      }
      // Unknown code: neutral copy only — the raw code stays in the call's
      // metadata for support; echoing it here exposed internal provider names
      // (the "(gemini-error)" email, SCRUM-496).
      return "The call ended unexpectedly due to a technical issue.";
  }
}
