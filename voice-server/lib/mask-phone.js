/**
 * Mask a phone number for safe logging — keeps first 3 and last 3 chars.
 * e.g. "+61412345678" → "+61***678"
 */
function maskPhone(phone) {
  if (!phone) return "unknown";
  // Sub-6-char inputs (short codes, malformed numbers, internal extensions)
  // would leak in clear if we returned them verbatim. PII safety > legibility.
  if (phone.length < 6) return "***";
  return phone.slice(0, 3) + "***" + phone.slice(-3);
}

module.exports = { maskPhone };
