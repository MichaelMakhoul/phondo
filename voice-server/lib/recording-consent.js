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

// Canonical list of US two-party consent states.
// Keep in sync with TWO_PARTY_CONSENT_STATES in business-settings-form.tsx (UI warning).
const TWO_PARTY_CONSENT_STATES = new Set([
  "CA", "CT", "FL", "IL", "MD", "MA", "MT", "NV", "NH", "PA", "WA",
]);

/**
 * Determine if a recording disclosure is required for this call.
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
 * Get the recording disclosure text appropriate for the jurisdiction.
 * @param {string} country - Organization's country code
 * @returns {string}
 */
function getRecordingDisclosureText(country) {
  if (country === "AU") {
    return "Please note, this call may be recorded for quality and training purposes.";
  }
  return "This call may be recorded for quality assurance.";
}

module.exports = {
  requiresRecordingDisclosure,
  getRecordingDisclosureText,
  TWO_PARTY_CONSENT_STATES,
};
