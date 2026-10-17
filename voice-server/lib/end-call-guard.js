"use strict";

/**
 * SCRUM-594: the SCRUM-373 end_call booking guard, in shared form, for the
 * classic pipeline's end_call hang-up (server.js handleUserSpeech).
 *
 * A port of the Gemini onToolCall guard in server.js: the same audit entry, log
 * lines, and Sentry service tag and levels, and the same nudge text after an
 * unfinished booking. That inline guard stays where it is for now (PR #442 edits
 * that code); moving it onto this helper is a follow-up.
 * tests/end-call-guard.test.js pins that the two agree.
 *
 * One deliberate difference from the Gemini guard on develop (phone test F1):
 * after a failed reschedule the nudge says the caller's existing appointment is
 * unchanged, not that they have NO appointment. The owner's first fast-path call
 * had the AI tell a booked caller there was no appointment on the system. PR #442
 * makes the same change in the Gemini guard (CallSession.lastFunnelStep).
 *
 * Language-agnostic: it reads tool state and the end_call reason
 * (CallSession.hasUnfinishedBooking), never the transcript. It nudges ONCE per
 * call, so a caller who really wants to leave is never trapped; the end_call
 * after that nudge is allowed, and pages at error level, because the caller
 * may be leaving misinformed.
 */

const { Sentry } = require("./sentry");

/** The tool result a blocked end_call gets after an unfinished booking: what the model must do instead of hanging up. */
const END_CALL_BLOCKED_MESSAGE =
  "CANNOT END CALL YET: a booking was started but book_appointment never returned success, so the caller has NO appointment. Do NOT say it is booked or 'all set'. Either (1) call book_appointment now with the collected details, OR (2) if you cannot complete it, tell the caller — in their language — that you could not finish the booking and call schedule_callback to take a message. Only call end_call AFTER one of those succeeds.";

/**
 * SCRUM-594 PHASE 2: ... on the fast path when this call already holds a booking
 * and a NEW one was held or failed: the earlier booking stands, so "NO
 * appointment" would be false and invite a booking the caller just declined.
 */
const END_CALL_BLOCKED_KEPT_MESSAGE =
  "CANNOT END CALL YET: the NEW booking was NOT made — but the caller's earlier booking from this call still stands. If the caller still wants the new appointment, finish booking it; if they don't, just say goodbye — do not book anything they didn't ask for. Do NOT say the new one is booked.";

/**
 * SCRUM-594 PHASE 2 (gate review): ... on the fast path when the call was about a
 * booking the caller already has (CallSession.aboutTheirBooking) and nothing new
 * was booked: only the NEW one is missing — "NO appointment" would be false.
 */
const END_CALL_BLOCKED_NOTHING_NEW_MESSAGE =
  "CANNOT END CALL YET: nothing new was booked on this call — book_appointment never succeeded. If the caller wants a new appointment, book it now; if they don't, just say goodbye. Do NOT say a new one is booked, and don't tell them they have nothing booked — the booking you found or changed for them stays as it is.";

/** ... and after a failed reschedule: the caller's existing appointment still stands (PR #442's text). */
const END_CALL_BLOCKED_RESCHEDULE_MESSAGE =
  "CANNOT END CALL YET: the appointment change was NOT completed — the caller's existing appointment is unchanged. Either call reschedule_appointment again with the confirmed details, or tell the caller — in their language — that you couldn't change it and call schedule_callback to take a message. Only call end_call AFTER one of those succeeds.";

/**
 * Decide whether an end_call may go ahead.
 * @param {{ callSid?: string|null, toolCallAudit: Array<{ name: string, successful?: boolean, at?: number }>, hasUnfinishedBooking: (endCallReason?: string) => boolean, lastFunnelStep: () => string|null, bookingGuards?: boolean, confirmedBookings?: Map<string, unknown>, aboutTheirBooking?: () => boolean }} session - the call's CallSession
 * @param {string} [reason] - the end_call tool call's `reason` argument
 * @returns {{ allow: boolean, message?: string }} `message` is set exactly when allow is false: the tool result to send back instead
 */
function checkEndCallGuard(session, reason) {
  if (!session.hasUnfinishedBooking(reason)) return { allow: true };
  const alreadyNudged = (session.toolCallAudit || []).some((t) => t.name === "end_call_blocked");
  if (!alreadyNudged) {
    console.error(`[HallucinationGuard] Blocking end_call — booking started but no successful book_appointment. callSid=${session.callSid} reason="${reason || ""}"`);
    session.toolCallAudit.push({ name: "end_call_blocked", successful: false, at: Date.now() });
    Sentry.withScope((scope) => {
      scope.setTag("service", "hallucination_guard");
      scope.setExtras({ callSid: session.callSid, endCallReason: reason || "" });
      Sentry.captureMessage("end_call blocked — unfinished booking (language-agnostic)", "warning");
    });
    // The most recent unresolved write decides the wording: after a failed reschedule the
    // caller still has their appointment ("NO appointment" would be false).
    const step = session.lastFunnelStep();
    const message = step === "reschedule_appointment"
      ? END_CALL_BLOCKED_RESCHEDULE_MESSAGE
      : session.bookingGuards === true && session.confirmedBookings instanceof Map && session.confirmedBookings.size > 0
        ? END_CALL_BLOCKED_KEPT_MESSAGE
        : session.bookingGuards === true && typeof session.aboutTheirBooking === "function" && session.aboutTheirBooking()
          ? END_CALL_BLOCKED_NOTHING_NEW_MESSAGE
          : END_CALL_BLOCKED_MESSAGE;
    return { allow: false, message };
  }
  // Already nudged once: let the caller go, but alert at error level — the
  // call is ending on an unfinished booking.
  console.error(`[HallucinationGuard] Allowing end_call on unfinished booking AFTER a prior nudge. callSid=${session.callSid}`);
  Sentry.withScope((scope) => {
    scope.setTag("service", "hallucination_guard");
    scope.setExtras({ callSid: session.callSid, endCallReason: reason || "" });
    Sentry.captureMessage("end_call allowed on unfinished booking after nudge", "error");
  });
  return { allow: true };
}

module.exports = { checkEndCallGuard, END_CALL_BLOCKED_MESSAGE, END_CALL_BLOCKED_RESCHEDULE_MESSAGE, END_CALL_BLOCKED_KEPT_MESSAGE, END_CALL_BLOCKED_NOTHING_NEW_MESSAGE };
