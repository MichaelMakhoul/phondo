/**
 * Recording Consent Module
 *
 * Determines whether a call recording disclosure must be played based on
 * the business's country, state, and consent mode setting.
 *
 * Two-party consent US states require all parties to consent to recording.
 * Australia requires disclosure under the Telecommunications (Interception
 * and Access) Act 1979.
 */

const { getStateFromPhone } = require("./area-code-to-state");

// Canonical list of US two-party consent states.
// Keep in sync with TWO_PARTY_CONSENT_STATES in business-settings-form.tsx (UI warning).
const TWO_PARTY_CONSENT_STATES = new Set([
  "CA", "CT", "FL", "IL", "MD", "MA", "MT", "NV", "NH", "PA", "WA",
]);

/**
 * Determine if a recording disclosure is required for this call.
 * (Original function — org-side only, no caller state detection)
 *
 * @param {string} country - Organization's country code (e.g. "US", "AU")
 * @param {string|null} state - Organization's state code (e.g. "CA", "NSW")
 * @param {string} consentMode - "auto" | "always" | "never"
 * @returns {boolean}
 */
function requiresRecordingDisclosure(country, state, consentMode) {
  if (consentMode === "always") return true;
  if (consentMode === "never") return false;

  // Auto mode: determine based on jurisdiction
  if (country === "AU") return true;
  if (country === "US" && state && TWO_PARTY_CONSENT_STATES.has(state.toUpperCase())) {
    return true;
  }

  return false;
}

/**
 * Hybrid recording disclosure check — considers both org state AND caller state.
 * Legally safest: disclose if EITHER party is in a two-party consent jurisdiction.
 *
 * @param {string} country - Organization's country code
 * @param {string|null} orgState - Organization's state code
 * @param {string} consentMode - "auto" | "always" | "never"
 * @param {string|null} callerPhone - Caller's phone number (E.164 or 10-digit)
 * @returns {{ required: boolean, callerState: string|null, reason: string }}
 */
function requiresRecordingDisclosureHybrid(country, orgState, consentMode, callerPhone) {
  const callerState = getStateFromPhone(callerPhone);

  // Explicit overrides take precedence
  if (consentMode === "always") {
    return { required: true, callerState, reason: "consent_mode_always" };
  }
  if (consentMode === "never") {
    return { required: false, callerState, reason: "consent_mode_never" };
  }

  if (consentMode !== "auto") {
    console.warn(`[RecordingConsent] Unknown consentMode "${consentMode}" — treating as "auto"`);
  }

  // Auto mode: determine based on jurisdiction
  if (country === "AU") {
    return { required: true, callerState, reason: "au_required" };
  }

  if (country === "US") {
    const orgIsTwoParty = orgState && TWO_PARTY_CONSENT_STATES.has(orgState.toUpperCase());
    const callerIsTwoParty = callerState && TWO_PARTY_CONSENT_STATES.has(callerState);

    if (orgIsTwoParty && callerIsTwoParty) {
      return { required: true, callerState, reason: "both_two_party" };
    }
    if (orgIsTwoParty) {
      return { required: true, callerState, reason: "org_two_party" };
    }
    if (callerIsTwoParty) {
      return { required: true, callerState, reason: "caller_two_party" };
    }

    return { required: false, callerState, reason: "both_one_party" };
  }

  return { required: false, callerState, reason: "country_not_required" };
}

/**
 * Get the recording disclosure text appropriate for the jurisdiction.
 * Uses the custom disclosure from assistant settings if provided, otherwise
 * falls back to a jurisdiction-appropriate default.
 *
 * @param {string} country - Organization's country code
 * @param {string|null|undefined} customDisclosure - Custom disclosure text from assistant settings
 * @returns {string}
 */
function getRecordingDisclosureText(country, customDisclosure) {
  // Validate custom disclosure: max 500 chars, must be a string
  if (customDisclosure && typeof customDisclosure === "string" && customDisclosure.trim()) {
    const trimmed = customDisclosure.trim().slice(0, 500);
    return trimmed;
  }
  if (country === "AU") {
    return "Please note, this call may be recorded for quality and training purposes.";
  }
  return "This call may be recorded for quality assurance.";
}

module.exports = {
  requiresRecordingDisclosure,
  requiresRecordingDisclosureHybrid,
  getRecordingDisclosureText,
  TWO_PARTY_CONSENT_STATES,
};
