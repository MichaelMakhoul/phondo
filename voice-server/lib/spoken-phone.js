// How a phone number is said. SCRUM-619: the receptionist read a caller's own number back
// as "+61 414 141 883" (28 Oct demo-line call) — the prompt gave it only in E.164.

/**
 * "02 5701 5064" / "0412 345 678": an AU number the way people say it, or null.
 * (From lib/notify-call-prompt.js, which still uses it.)
 * @param {unknown} e164
 * @returns {string|null}
 */
function spokenAuNumber(e164) {
  const m = typeof e164 === "string" ? /^\+61([23478])(\d{8})$/.exec(e164) : null;
  if (!m) return null;
  const [, lead, rest] = m;
  return lead === "4" ? `04${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}` : `0${lead} ${rest.slice(0, 4)} ${rest.slice(4)}`;
}

/**
 * The national form of an Australian or US number, as it's said — or null.
 * @param {unknown} e164
 * @returns {string | null}
 */
function spokenPhoneNumber(e164) {
  const s = typeof e164 === "string" ? e164.trim() : e164;
  const au = spokenAuNumber(s);
  if (au) return au;
  const us = typeof s === "string" ? /^\+1(\d{3})(\d{3})(\d{4})$/.exec(s) : null;
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : null; // US: (415) 555-1234
}

module.exports = { spokenAuNumber, spokenPhoneNumber };
