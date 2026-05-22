/**
 * Decide which owner notification (if any) a completed call should trigger.
 *
 * Pure function so the SCRUM-281 / SCRUM-299 classification matrix is unit
 * testable without standing up the whole call-completed route.
 *
 * Precedence (most specific signal wins):
 *   1. "failed"        — status === "failed" (technical failure: STT/LLM/TTS/server)
 *   2. "unsuccessful"  — AI engaged (has transcript) AND the analyzer rated it
 *                        "unsuccessful"/"partial" (any duration). SCRUM-299 fix:
 *                        these used to be mislabeled "missed".
 *   3. short calls (< threshold) ALWAYS notify, matching the pre-PR guarantee
 *      that no short call goes silent:
 *        a. no transcript            -> "missed" (caller hung up before AI engaged)
 *        b. transcript, not rated successful -> "unsuccessful" (engaged but
 *           abandoned quickly; covers null successEvaluation, which is exactly
 *           what post-call analysis emits when it fails on a messy short call)
 *        c. transcript, rated successful     -> "none" (respect the rating)
 *   4. "none"          — longer calls with no negative rating, successful
 *      conversations, or bookings/callbacks that fire their own notification.
 */
export type CallNotificationKind = "failed" | "unsuccessful" | "missed" | "none";

export interface ClassifyCallInput {
  status: string;
  durationSeconds: number;
  hasTranscript: boolean;
  successEvaluation?: string | null;
}

/** Short-call threshold (seconds): under this, a call always notifies. */
export const MISSED_CALL_MAX_SECONDS = 10;

export function classifyCallNotification(input: ClassifyCallInput): CallNotificationKind {
  const { status, durationSeconds, hasTranscript } = input;
  const evalLower = (input.successEvaluation || "").toLowerCase();
  const isSuccessful = evalLower === "successful";
  const isExplicitlyUnsuccessful = evalLower === "unsuccessful" || evalLower === "partial";

  if (status === "failed") {
    return "failed";
  }

  // Explicit negative rating wins regardless of duration.
  if (hasTranscript && isExplicitlyUnsuccessful) {
    return "unsuccessful";
  }

  // Short calls always produce a signal — never go silent (pre-PR guarantee).
  if (durationSeconds < MISSED_CALL_MAX_SECONDS) {
    if (!hasTranscript) return "missed"; // caller never engaged
    if (!isSuccessful) return "unsuccessful"; // engaged but abandoned (incl. null eval)
    // else: short but explicitly rated successful — fall through to "none".
  }

  return "none";
}
