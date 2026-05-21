/**
 * Forwarded-number transfer fallback eligibility (SCRUM-327).
 *
 * When a business forwards its line to Phondo but configures NO explicit
 * transfer rules, the AI can — IF the owner opts in — transfer a caller who
 * asks for a human to the owner's own forwarded number (their
 * `user_phone_number`) instead of taking a message.
 *
 * This is OFF by default (matches the industry norm: competitors take a
 * message when no transfer destination is configured, and none auto-dial the
 * forwarding source — it risks a loop). It activates only when the owner
 * enables `assistant.settings.transferToForwardedNumber`.
 *
 * This predicate is shared by the two registration gates (`buildLLMOptions` +
 * the Gemini transfer prompt) so the tool is offered to the LLM only when the
 * forwarded fallback can fire. The tool-executor synthesises the fallback rule
 * only when `transferRules` is empty (so it never competes with explicit
 * rules); it does NOT itself re-check the opt-in — it relies on this gate
 * being the only path that offers the tool in the no-rules case (a
 * defense-in-depth check there is tracked separately).
 *
 * @param {Record<string, any>} session
 * @returns {boolean}
 */
function forwardingFallbackEligible(session) {
  // Owner opt-in (default off). This explicit toggle is itself the
  // authorization for the no-rules forwarded transfer — it intentionally does
  // NOT also require the `transferToHuman` behavior, which is an industry
  // DEFAULT (not UI-settable) and is off for dental/home_services. Coupling to
  // it would leave this toggle permanently dead for those core verticals.
  // (Rules-based transfer still respects transferToHuman — see buildLLMOptions.)
  if (session.transferToForwardedNumber !== true) return false;
  // Only for forwarded calls with verified-active forwarding.
  if (session.sourceType !== "forwarded") return false;
  if (session.forwardingStatus !== "active") return false;

  // Loop guard: if the forwarded number equals the Phondo number, dialing it
  // routes back into Phondo and burns both legs. Normalised compare (mirrors
  // the tool-executor guard).
  const user = (session.userPhoneNumber || "").replace(/[^\d+]/g, "");
  const org = (session.orgPhoneNumber || "").replace(/[^\d+]/g, "");
  if (!user) return false;
  if (user === org) return false;

  return true;
}

module.exports = { forwardingFallbackEligible };
