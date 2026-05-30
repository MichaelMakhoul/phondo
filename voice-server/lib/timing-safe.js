/**
 * SCRUM-355: constant-time string comparison for internal-secret checks.
 *
 * Plain `a === b` short-circuits on the first differing byte, leaking secret
 * length/prefix via timing. crypto.timingSafeEqual is constant-time but THROWS on
 * differing buffer lengths — which would itself leak length and could crash the
 * handler — so we length-check first and return false instead. (Mirrors the
 * Next.js timingSafeCompare in src/lib/security/validation.ts.)
 */

const crypto = require("crypto");

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean} true iff both are equal non-empty strings (constant-time
 *   for equal-length inputs)
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { timingSafeEqualStr };
