// SCRUM-505: STT-tolerant name matching for appointment verification.
//
// Phone STT routinely mangles unusual names — a real call heard "Makhoul" as
// "Macool"/"McCool"/"Machool", so the model passed the wrong spelling and a
// strict `attendee_name ILIKE %provided%` never matched the booking that was
// sitting right there under the caller's verified number. This module confirms
// a spoken name against the stored name TOLERANTLY.
//
// It is only ever used as a SECONDARY factor AFTER phone possession is
// established (the caller is verified to hold the number on the booking), so a
// small amount of phonetic looseness is safe: the phone is the strong factor,
// the name is a "do you know whose booking this is" confirmation. It is
// deliberately NOT loose enough to match unrelated names (see the tests:
// "Makhoul" must not confirm "Michael" or "Johnson").
//
// Approach: normalize both strings into a phonetic skeleton (fold the digraphs
// and soft-c/duplicate-letter variations that dominate STT and spelling drift),
// then accept on exact / substring / bounded edit-distance. Vowels are KEPT so
// the edit-distance bound can still separate similar-consonant-skeleton names
// ("Michael" vs "Makhoul").

/** Multi-letter clusters folded to a single phonetic form (order matters:
 *  longer clusters first so "sch" wins over "ch"). */
const DIGRAPHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sch/g, "sk"],
  [/tch/g, "ch"],
  [/ph/g, "f"],
  [/gh/g, "g"],
  [/kh/g, "k"],
  [/ck/g, "k"],
  [/ch/g, "k"], // hard "ch" (Michael, Christopher) — the common STT case
  [/th/g, "t"],
  [/wh/g, "w"],
  [/qu/g, "kw"],
  [/x/g, "ks"],
];

/**
 * Fold a name into a phonetic skeleton: lowercase, strip accents/punctuation,
 * normalize soft-c and the common digraphs, collapse doubled letters, and
 * squeeze whitespace. Vowels are intentionally preserved.
 */
export function phoneticSkeleton(raw: string): string {
  let s = (raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/['’\-]/g, "") // drop intra-name apostrophes/hyphens (O'Brien → obrien)
    .replace(/[^a-z\s]/g, " ") // any other non-letter → word break
    .replace(/\s+/g, " ")
    .trim();

  // Join spelled-out runs ("m a k h o u l" → "makhoul") — when STT mangles a
  // name the caller often SPELLS it, which otherwise splinters into single
  // letters the matcher discards. Only 3+ consecutive single letters (a real
  // spelling), so ordinary names and middle initials are untouched.
  s = s.replace(/\b[a-z](?: [a-z]){2,}\b/g, (run) => run.replace(/ /g, ""));

  // Soft "c" (before e/i/y) → s. Runs first so it isn't clobbered by the
  // digraph/bare-c passes; "ch" is untouched here (c is before h, not e/i/y).
  s = s.replace(/c(?=[eiy])/g, "s");

  // Digraphs — includes hard "ch" → k (Michael), so the bare-c pass below never
  // sees a "ch".
  for (const [re, rep] of DIGRAPHS) s = s.replace(re, rep);

  // Any remaining hard "c" → k (cool → kool).
  s = s.replace(/c/g, "k");

  s = s.replace(/(.)\1+/g, "$1"); // collapse doubled letters (Aaron → aron)
  return s.replace(/\s+/g, " ").trim();
}

/** Classic Levenshtein edit distance (small strings — names). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Does the caller's spoken name confirm the stored booking name, tolerating
 * STT/spelling drift WITHOUT becoming a rubber stamp?
 *
 * Matching is anchored to WHOLE tokens (≥3 chars) so a bare initial or particle
 * can never confirm — the danger being that this runs behind a spoofable caller
 * ID, so an over-loose match re-opens an enumeration oracle (SCRUM-505 review).
 * A spoken token confirms a stored token when their skeletons are EQUAL, or —
 * only for longer tokens (≥5 chars, same initial letter) — within a tight
 * length-scaled edit distance. That absorbs real STT drift ("makoul" ≈
 * "makhoul") while still rejecting distinct short names ("Ben" ≠ "Ken").
 *
 * Confirmation requires that EVERY token on one side is matched by a token on
 * the other (checked in both directions). One-directional coverage lets the
 * caller give just a surname, just a first name, or extra middle names; the
 * symmetry stops two DISTINCT full names that merely share a common token from
 * confirming ("Jane Smith" ✗ "John Smith", "John Smith" ✗ "John Baker") — which
 * matters on a shared family line, exactly what name+phone is meant to
 * disambiguate.
 */
export function namesMatch(spoken: string | null | undefined, stored: string | null | undefined): boolean {
  const s = phoneticSkeleton(spoken || "");
  const t = phoneticSkeleton(stored || "");
  if (!s || !t) return false;
  if (s === t) return true;

  const sTokens = s.split(" ").filter((w) => w.length >= 3);
  const tTokens = t.split(" ").filter((w) => w.length >= 3);
  if (!sTokens.length || !tTokens.length) return false;

  const tokenConfirms = (a: string, b: string): boolean => {
    if (a === b) return true;
    const minLen = Math.min(a.length, b.length);
    if (minLen < 5 || a[0] !== b[0]) return false; // short/different-initial → must be exact
    return levenshtein(a, b) <= Math.floor(minLen * 0.25);
  };

  const everyTokenCovered = (xs: string[], ys: string[]) =>
    xs.every((a) => ys.some((b) => tokenConfirms(a, b)));

  return everyTokenCovered(sTokens, tTokens) || everyTokenCovered(tTokens, sTokens);
}
