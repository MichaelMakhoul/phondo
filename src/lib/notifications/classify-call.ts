/**
 * Decide which owner notification (if any) a completed call should trigger.
 *
 * Pure function so the SCRUM-281 / SCRUM-299 classification matrix is unit
 * testable without standing up the whole call-completed route.
 *
 * Precedence (most specific signal wins):
 *   1. "failed"        — status === "failed" (technical failure: STT/LLM/TTS/server)
 *   2. "unsuccessful"  — AI engaged (has transcript) AND the post-call analyzer
 *                        rated it "unsuccessful" or "partial". This is the
 *                        SCRUM-299 fix: such calls used to be mislabeled "missed".
 *   3. "missed"        — very short AND no transcript = caller hung up before
 *                        the AI engaged at all.
 *   4. "none"          — successful conversation, or a booking/callback that
 *                        fires its own dedicated notification.
 */
export type CallNotificationKind = "failed" | "unsuccessful" | "missed" | "none";

export interface ClassifyCallInput {
  status: string;
  durationSeconds: number;
  hasTranscript: boolean;
  successEvaluation?: string | null;
}

/** Short-call threshold (seconds) under which a no-transcript call is "missed". */
export const MISSED_CALL_MAX_SECONDS = 10;

export function classifyCallNotification(input: ClassifyCallInput): CallNotificationKind {
  const { status, durationSeconds, hasTranscript } = input;
  const evalLower = (input.successEvaluation || "").toLowerCase();

  if (status === "failed") {
    return "failed";
  }

  if (hasTranscript && (evalLower === "unsuccessful" || evalLower === "partial")) {
    return "unsuccessful";
  }

  if (durationSeconds < MISSED_CALL_MAX_SECONDS && !hasTranscript) {
    return "missed";
  }

  return "none";
}
