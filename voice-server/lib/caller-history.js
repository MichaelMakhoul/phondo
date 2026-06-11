"use strict";

// SCRUM-414: returning-caller prompt hint that discloses NO PII.
//
// Caller ID is trivially spoofable on the PSTN, so we must not volunteer a
// caller's name or appointment history just because the inbound number matches
// a record. Previously the system prompt was injected with the name on file,
// the visit/call counts, and the most-recent appointment date — all readable by
// anyone who spoofs a customer's number — and the name was interpolated
// verbatim (a stored-prompt-injection vector if a customer booked under a
// crafted name).
//
// Instead we derive only a BINARY "this number has contacted the business
// before" signal (from an exact phone match made by the caller — see server.js)
// and instruct the AI to greet warmly but verify identity (via the lookup tool)
// before referencing anything on file.

/**
 * @param {{ pastApptCount?: number, totalCalls?: number }} counts
 * @returns {string} the prompt hint, or "" when the caller is not returning.
 */
function buildReturningCallerHint(counts) {
  const pastApptCount = (counts && counts.pastApptCount) || 0;
  const totalCalls = (counts && counts.totalCalls) || 0;
  // totalCalls is PRIOR calls only — at prompt-build time the current call has
  // not been logged yet — so any prior call (>0) OR a past appointment means
  // the caller is returning.
  if (pastApptCount > 0 || totalCalls > 0) {
    return (
      "\nRETURNING CALLER: This phone number has contacted the business before. " +
      'You may greet them warmly (e.g. "Welcome back!"). IMPORTANT: caller ID can ' +
      "be spoofed, so do NOT state any name or past-appointment details unless the " +
      "caller first provides their name/details and they are confirmed — use the " +
      "lookup tool to verify identity before disclosing anything on file."
    );
  }
  return "";
}

module.exports = { buildReturningCallerHint };
