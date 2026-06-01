/**
 * SCRUM-367: enforce Latin-letter names at the booking boundary.
 *
 * On the Gemini Live audio-to-audio path, an assistant in a non-English
 * conversation will happily pass the caller's name in their own script (e.g.
 * Arabic) to `book_appointment`. The only "English letters" hint lived in the
 * tool *parameter description* — a soft signal the model ignored mid-Arabic —
 * and the booking handler only trimmed + checked non-empty, so the non-Latin
 * name landed straight in the DB.
 *
 * This is the server-side gate: a name containing a letter outside the Latin
 * script is rejected, prompting the model to transliterate it (which it does
 * well) before the value is stored.
 *
 * Accented Latin (José, Müller, Renée, Łukasz) is FINE — it is still Latin
 * script. The requirement is "no non-Latin scripts", not "ASCII only".
 *
 * Known intentional edge: a few non-Latin *modifier letters* (e.g. the
 * Hawaiian ʻokina U+02BB) are letters of a non-Latin script and are rejected.
 * This is vanishingly rare for the AU/US dental/legal/trades verticals and is
 * accepted rather than widening the allow-list to all `\p{Script=Common}`.
 */

/**
 * Matches a single Unicode LETTER that is NOT in the Latin script.
 *
 * The negated class `[^\p{Script=Latin}\P{L}]` reads as: a character that is
 * neither (a) a Latin-script character nor (b) a non-letter. What's left is
 * exactly "a letter that is not Latin" — Arabic, Han, Cyrillic, Greek, etc.
 * Spaces, digits, hyphens, apostrophes and combining marks are all `\P{L}`
 * (non-letters), so "Jean-Pierre O'Brien" and "José" pass cleanly. Requires
 * the `u` flag.
 */
const NON_LATIN_LETTER = /[^\p{Script=Latin}\P{L}]/u;

/**
 * @returns true if `s` contains any letter outside the Latin script.
 */
export function hasNonLatinLetters(s: string | null | undefined): boolean {
  if (!s) return false;
  return NON_LATIN_LETTER.test(s);
}
