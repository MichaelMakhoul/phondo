// SCRUM-619: a number read back to a caller is said the way people say it. The
// receptionist read the caller's own number back as "+61 414 141 883" (28 Oct demo-line
// call) — the prompt gave it only in E.164.

/**
 * The national form of an Australian or US number, as it's said — or null.
 * @param {unknown} e164
 * @returns {string | null}
 */
function spokenPhoneNumber(e164) {
  const s = typeof e164 === "string" ? e164.trim() : "";
  let m = /^\+61(4\d{2})(\d{3})(\d{3})$/.exec(s);
  if (m) return `0${m[1]} ${m[2]} ${m[3]}`; // a mobile: 0414 141 883
  m = /^\+61([2378])(\d{4})(\d{4})$/.exec(s);
  if (m) return `0${m[1]} ${m[2]} ${m[3]}`; // a landline: 02 9555 1234
  m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(s);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`; // US: (415) 555-1234
  return null;
}

module.exports = { spokenPhoneNumber };
