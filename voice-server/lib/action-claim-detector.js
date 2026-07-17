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

// SCRUM-559: UNAMBIGUOUS booking-completion claims. Deliberately EXCLUDES
// "you're all set" — that phrase is also legitimate closure language right
// after a successful cancel ("you're all set, the appointment is cancelled"),
// so it must not participate in the cancel-negation rule below.
const STRONG_BOOKING_CLAIM =
  /\b(i'?ve booked|booked you in|i have you booked|your appointment (?:is|has been) (?:booked|confirmed))\b/i;

/**
 * SCRUM-559: net LIVE booking outcome of a call from its tool audit.
 * A successful book or atomic reschedule leaves a live appointment; a
 * successful cancel removes one. Floored at zero. The real incident: one
 * successful book followed by one successful cancel = 0 live — yet the AI
 * kept claiming a booking existed, and "a successful book anywhere backs the
 * claim" made every monitor blind to the negation.
 * @param {Array<{name?: string, successful?: boolean}>} audit
 * @returns {number}
 */
function netLiveOutcome(audit) {
  let live = 0;
  for (const t of Array.isArray(audit) ? audit : []) {
    if (!t || !t.successful) continue;
    if (t.name === "book_appointment" || t.name === "reschedule_appointment") live++;
    else if (t.name === "cancel_appointment") live = Math.max(0, live - 1);
  }
  return live;
}

/**
 * SCRUM-559: compact ground-truth digest of a call's appointment tool activity
 * for the post-call analysis LLM — the transcript alone reads as success when
 * the AI confidently claims a booking that the tools never (net) delivered.
 * Language-agnostic by construction: it reports what the TOOLS did.
 * @param {Array<{name?: string, successful?: boolean}>} audit
 * @returns {string|null} digest text, or null when there is no tool activity
 */
function buildToolOutcomeDigest(audit) {
  const entries = (Array.isArray(audit) ? audit : []).filter((t) => t && typeof t.name === "string");
  if (entries.length === 0) return null;
  const lines = entries.slice(-20).map((t) => `- ${t.name}: ${t.successful ? "SUCCEEDED" : "did NOT succeed"}`);
  const live = netLiveOutcome(entries);
  lines.push(
    live > 0
      ? `FINAL STATE: ${live} live appointment(s) booked or moved in this call.`
      : "FINAL STATE: NO live appointment resulted from this call (anything booked was cancelled or never completed)."
  );
  return lines.join("\n");
}

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
    // SCRUM-559: a booking success that was NEGATED by a later cancel must not
    // keep backing UNAMBIGUOUS "you're booked" claims (the real incident: book
    // → cancel → "your new appointment is at 9am"). Loose phrases like
    // "you're all set" stay exempt — they're legit closure after a cancel.
    if (action === "booking" && STRONG_BOOKING_CLAIM.test(aiTurnText) && netLiveOutcome(audit) === 0) {
      return { action, primaryTool: PRIMARY_TOOL[action] };
    }
    // Claim is backed — keep scanning for a later, unbacked claim in the same turn.
  }
  return null;
}

// ── Post-call phantom detection (SCRUM-383) ──────────────────────────────────
// The live detector (detectPhantomAction) runs per turn and self-corrects mid-
// call. The post-call check runs ONCE over the whole call and marks it failed for
// human review, so it must be HIGHER precision — a false positive corrupts a good
// call's status. Two deliberate differences from the live patterns:
//   - cancellation drops the loose "cancel.*for you" alternative: an OFFER like
//     "I can cancel that for you" (caller then declines) must NOT fail the call;
//     only past-tense completions count.
//   - the fabricated-confirmation-code tell is handled separately (see below),
//     not folded into the booking phrase pattern, so it can be gated.
// Actions without an override reuse ACTION_CLAIM_PATTERNS.
const POST_CALL_PATTERN_OVERRIDES = {
  booking:
    /\b(i've booked|you'?re all set|your appointment (?:is|has been) (?:booked|confirmed)|booked you in)\b/i,
  // Past-tense ONLY ("cancelled"/"canceled") — base "cancel" is an offer/future
  // ("I can cancel that for you", "I'll cancel that"), which must NOT fail a call.
  cancellation:
    /\b(i'?ve cancell?ed|that'?s cancell?ed|(?:your |the )?appointment (?:is|has been) cancell?ed|cancell?ed (?:your|the|that) appointment)\b/i,
};

// A spoken confirmation code is a fabricated-BOOKING tell ONLY when no appointment
// operation happened at all — codes are also legitimately read back during a
// lookup, cancellation, or reschedule, so those reads must not be mislabelled a
// phantom booking. Gated on APPOINTMENT_TOOLS below.
const CONFIRMATION_CODE_TELL = /\bconfirmation code (?:is )?\d{3,8}\b/i;
const APPOINTMENT_TOOLS = ["book_appointment", "reschedule_appointment", "cancel_appointment", "lookup_appointment"];

// Untimed backing for a post-call claim: any successful tool that could have
// accomplished the action (primary or cross) ANYWHERE in the call. Post-call has
// no per-claim timing, so the question is simply "did this action ever happen?".
function postCallBackingTools(action) {
  return [...new Set([...(PRIMARY_TOOLS[action] || []), ...(CROSS_TOOLS[action] || [])])];
}

/**
 * Detect phantom actions over a whole call: which actions the AI CLAIMED to the
 * caller but no successful tool actually performed. Used by post-call analysis to
 * flag a call (status=failed) when the AI said it did something the tools never
 * did. Claim-based — only fires on an explicit completion claim, so it does not
 * flag legitimate non-completions (slot taken, caller declined), only fabrications.
 *
 * Scans ASSISTANT turns ONLY. A hallucinated claim is by definition something the
 * AI said; scanning caller turns would false-positive on a caller reciting their
 * confirmation code or narrating a past appointment ("I cancelled that last
 * week"). Taking the structured messages (not a pre-joined string) makes that
 * scoping structural — the function cannot be handed caller text by mistake.
 *
 * Callback note: "someone will call you back" is a forward-looking promise, not a
 * past-tense completion like the other patterns — intentionally so. That phrasing
 * IS how a scheduled callback is conveyed, and saying it without a successful
 * schedule_callback means the caller is owed a callback that won't happen, which is
 * exactly the phantom worth flagging.
 *
 * @param {Array<{role?: string, content?: string}>} transcriptMessages - full transcript messages
 * @param {Array<{name?: string, successful?: boolean}>} [toolCallAudit]
 * @returns {string[]} phantom action names (subset of booking/reschedule/cancellation/callback)
 */
function detectPostCallPhantoms(transcriptMessages, toolCallAudit) {
  const aiText = (Array.isArray(transcriptMessages) ? transcriptMessages : [])
    .filter((m) => m && m.role === "assistant" && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n");
  if (!aiText) return [];
  const audit = Array.isArray(toolCallAudit) ? toolCallAudit : [];
  const succeeded = (names) => audit.some((t) => t && t.successful && names.includes(t.name));

  const phantoms = [];
  for (const action of Object.keys(ACTION_CLAIM_PATTERNS)) {
    const pattern = POST_CALL_PATTERN_OVERRIDES[action] || ACTION_CLAIM_PATTERNS[action];
    if (pattern.test(aiText) && !succeeded(postCallBackingTools(action))) {
      phantoms.push(action);
    }
  }
  // A cited confirmation code with NO appointment operation at all = fabricated
  // booking. With any appointment op it's a legit read-back, so don't double-flag.
  if (!phantoms.includes("booking") && CONFIRMATION_CODE_TELL.test(aiText) && !succeeded(APPOINTMENT_TOOLS)) {
    phantoms.push("booking");
  }
  // SCRUM-559: negated booking — a successful book that a later successful
  // cancel removed no longer backs an UNAMBIGUOUS booking claim. (The loose
  // "you're all set" is deliberately excluded: legit closure after a cancel.)
  if (
    !phantoms.includes("booking") &&
    succeeded(["book_appointment"]) &&
    netLiveOutcome(audit) === 0 &&
    STRONG_BOOKING_CLAIM.test(aiText)
  ) {
    phantoms.push("booking");
  }
  return phantoms;
}

/**
 * Collapse a phantom-action list into the values both post-call pipelines need,
 * keeping them in lockstep. Preserves the SCRUM-227 "hallucinated_booking"
 * reason/tag when booking is among the phantoms (dashboards key on it); otherwise
 * names the first action.
 * @param {string[]} phantomActions - non-empty
 * @returns {{ primaryPhantom: string, bugTag: string, reason: string }}
 */
function summarizePhantoms(phantomActions) {
  const primaryPhantom = phantomActions.includes("booking") ? "booking" : phantomActions[0];
  return {
    primaryPhantom,
    bugTag: primaryPhantom === "booking" ? "hallucinated_booking" : "hallucinated_action",
    reason: `hallucinated_${primaryPhantom}`,
  };
}

module.exports = {
  detectPhantomAction,
  detectPostCallPhantoms,
  summarizePhantoms,
  mostRecentWrite,
  netLiveOutcome,
  buildToolOutcomeDigest,
  STRONG_BOOKING_CLAIM,
  ACTION_CLAIM_PATTERNS,
  POST_CALL_PATTERN_OVERRIDES,
  PRIMARY_TOOLS,
  CROSS_TOOLS,
  SCHEDULING_WRITE_TOOLS,
  PRIMARY_TOOL,
};
