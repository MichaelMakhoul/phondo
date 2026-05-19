/**
 * Pick a Twilio Polly TTS voice based on the org's country.
 *
 * Twilio + Telnyx TeXML both accept these AWS Polly voice names. Other
 * voices exist per region (e.g., en-IN Aditi, en-IE Niamh) — only the
 * countries Phondo currently sells in are mapped. Adding a country
 * requires picking a Polly voice from the same English locale; see
 * https://docs.aws.amazon.com/polly/latest/dg/available-voices.html
 *
 * Default is Polly.Joanna (en-US, female, neutral). Used when country is
 * null/unknown — better than picking a country-specific accent at random.
 *
 * @param {string|null|undefined} country - ISO-3166-1 alpha-2 (e.g., "AU", "US"),
 *   case-insensitive. Null/undefined/empty falls back to the default.
 * @returns {string} The Polly voice name (e.g., "Polly.Nicole").
 */
function getPollyVoice(country) {
  switch ((country || "").toUpperCase()) {
    case "AU":
      return "Polly.Nicole"; // Australian English, female
    case "GB":
      return "Polly.Amy"; // British English, female — reserved for future GB expansion
    case "US":
    case "CA":
    default:
      return "Polly.Joanna"; // US English, female (also the default)
  }
}

module.exports = { getPollyVoice };
