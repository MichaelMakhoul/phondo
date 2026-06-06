/**
 * Phantom-action detection (SCRUM-227 / SCRUM-381).
 *
 * The voice AI ("Sophie") must never tell a caller an action is done unless the
 * corresponding tool actually ran successfully. This module maps a spoken AI
 * turn to the action it CLAIMS ("I've booked you in", "your appointment has been
 * moved") and the set of tools whose SUCCESSFUL execution would make that claim
 * truthful. The live handler uses it to inject a correction when the AI gets
 * ahead of itself, and the post-call analysis uses the same vocabulary.
 *
 * SCRUM-381: the atomic `reschedule_appointment` tool (one call that books the
 * new slot AND cancels the old one) created two blind spots in the original
 * detector, both of which produced the exact failure a caller reported —
 * "the system said it rebooked my appointment but it didn't":
 *   1. A "reschedule" claim was not detected at all (no pattern), so a phantom
 *      reschedule slipped through silently.
 *   2. After a *successful* atomic reschedule, the AI naturally says "you're all
 *      set" — which matched the "booking" pattern. Because the audit recorded
 *      `reschedule_appointment` (not `book_appointment`), the old detector saw no
 *      backing tool, declared a phantom booking, and told the AI to re-book →
 *      duplicate appointment / rebook-cancel thrash. Letting an atomic reschedule
 *      satisfy booking/cancellation claims closes that false positive.
 */

// Patterns for what the AI just told the caller. Checked in declaration order;
// `reschedule` is first because "I've rebooked you, you're all set" matches both
// reschedule and booking, and reschedule is the more specific intent.
const ACTION_CLAIM_PATTERNS = {
  reschedule:
    /\b(i'?ve\s+(?:rescheduled|rebooked)|(?:rescheduled|rebooked|moved|changed)\s+(?:your|the|that)\s+appointment|appointment\s+(?:is|has been)\s+(?:rescheduled|rebooked|moved|changed))\b/i,
  booking:
    /\b(i've booked|you'?re all set|your appointment (?:is|has been) (?:booked|confirmed)|booked you in)\b/i,
  cancellation:
    /\b(i've cancel|that'?s cancel|appointment (?:is|has been) cancel|cancel.*for you)\b/i,
  callback:
    /\b(i've scheduled.*callback|callback (?:is|has been) scheduled|someone will call you back)\b/i,
};

// The tool that DIRECTLY performs each action. A successful call ANYWHERE in the
// call backs the claim — a booking made early is still a real booking if the AI
// re-confirms "you're all set" later.
const PRIMARY_TOOLS = {
  reschedule: ["reschedule_appointment"],
  booking: ["book_appointment"],
  cancellation: ["cancel_appointment"],
  callback: ["schedule_callback"],
};

// Tools that back a claim only while they are the MOST RECENT successful
// appointment write in the call. An atomic reschedule books the new slot AND
// cancels the old one, so right after it the AI legitimately says "you're all
// set" / "I've cancelled the old one" — and at end-of-call it may RECAP the same
// ("so you're all set for Friday at 11"). Both must be treated as backed, or the
// correction tells the model to re-book and we reopen the duplicate/thrash bug.
//
// But a reschedule must NOT permanently excuse a LATER, INDEPENDENT phantom: once
// any other appointment write happens after it, it is no longer the latest write,
// so a subsequent unbacked "I've booked you" / "that's cancelled" is flagged.
// Keying on "is it the latest write?" (rather than a fixed time window) makes the
// recap safe for calls of ANY length while still catching the superseded case.
// `toolCallAudit` is call-scoped and append-only, so recency = latest write.
const CROSS_TOOLS = {
  reschedule: ["book_appointment"], // legacy reschedule = book new + cancel old
  booking: ["reschedule_appointment"],
  cancellation: ["reschedule_appointment"],
  callback: [],
};

// Appointment-mutating tools, used to find the most-recent successful write.
const SCHEDULING_WRITE_TOOLS = ["book_appointment", "reschedule_appointment", "cancel_appointment"];

// The tool to name in the corrective nudge when a claim has no backing tool.
const PRIMARY_TOOL = {
  reschedule: "reschedule_appointment",
  booking: "book_appointment",
  cancellation: "cancel_appointment",
  callback: "schedule_callback",
};

/**
 * Name of the most-recent SUCCESSFUL appointment-write tool in the audit, or null
 * if there is none. Prefers the `at` timestamp; falls back to audit array order
 * (append-only) when timestamps are absent.
 *
 * @param {Array<{name?: string, successful?: boolean, at?: number}>} audit
 * @returns {string | null}
 */
function mostRecentWrite(audit) {
  let best = null;
  for (const t of audit) {
    if (!t || !t.successful || !SCHEDULING_WRITE_TOOLS.includes(t.name)) continue;
    if (!best) {
      best = t;
      continue;
    }
    const ta = typeof t.at === "number" ? t.at : Number.NEGATIVE_INFINITY;
    const ba = typeof best.at === "number" ? best.at : Number.NEGATIVE_INFINITY;
    if (ta >= ba) best = t; // later timestamp, or later array position when untimed
  }
  return best ? best.name : null;
}

/**
 * Detect a phantom action: an AI turn that claims an action is done while no
 * tool that would accomplish it ran successfully in this call.
 *
 * Returns the FIRST unbacked claim (claims that ARE backed are skipped, so a turn
 * that says "I've rescheduled you and you're all set" after a successful
 * reschedule is clean). Returns null when there is no phantom.
 *
 * Backing rule per matched claim:
 *   - a successful PRIMARY tool anywhere in the call backs it; OR
 *   - a CROSS tool backs it only while it is the most-recent successful
 *     appointment write (so an atomic reschedule excuses a "you're all set"
 *     recap, but stops excusing claims once another write supersedes it).
 *
 * @param {string} aiTurnText - what the AI just said to the caller
 * @param {Array<{name?: string, successful?: boolean, at?: number}>} [toolCallAudit]
 * @returns {null | {action: string, primaryTool: string}}
 */
function detectPhantomAction(aiTurnText, toolCallAudit) {
  if (!aiTurnText || typeof aiTurnText !== "string") return null;
  const audit = Array.isArray(toolCallAudit) ? toolCallAudit : [];
  const latestWrite = mostRecentWrite(audit);
  for (const [action, regex] of Object.entries(ACTION_CLAIM_PATTERNS)) {
    if (!regex.test(aiTurnText)) continue;
    const primary = PRIMARY_TOOLS[action];
    const cross = CROSS_TOOLS[action];
    const backedByPrimary = audit.some((t) => t && t.successful && primary.includes(t.name));
    const backedByCross = cross.length > 0 && cross.includes(latestWrite);
    if (!backedByPrimary && !backedByCross) {
      return { action, primaryTool: PRIMARY_TOOL[action] };
    }
    // Claim is backed — keep scanning for a later, unbacked claim in the same turn.
  }
  return null;
}

/**
 * Tools whose successful execution backs a booking-completion claim in the
 * post-call hallucinated-booking check. Includes the atomic reschedule so a
 * legitimate reschedule that ends with "you're all set" is not mislabelled a
 * hallucinated booking and the call wrongly marked failed.
 */
const BOOKING_BACKING_TOOLS = ["book_appointment", "reschedule_appointment"];

module.exports = {
  detectPhantomAction,
  mostRecentWrite,
  ACTION_CLAIM_PATTERNS,
  PRIMARY_TOOLS,
  CROSS_TOOLS,
  SCHEDULING_WRITE_TOOLS,
  PRIMARY_TOOL,
  BOOKING_BACKING_TOOLS,
};
