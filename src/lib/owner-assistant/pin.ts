import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * PIN hashing for the owner assistant line (SCRUM-585).
 *
 * scrypt(pin, salt, 32) with Node's default cost (N=16384, r=8, p=1) and a
 * per-row 16-byte salt. The 32-char hex salt STRING is passed as the salt
 * (its UTF-8 bytes) — the voice server's lib/owner-auth.js verifies with the
 * exact same call, so do not "fix" this to Buffer.from(salt, "hex").
 * Known-answer vectors are pinned in __tests__/pin.test.ts.
 *
 * A 4–8 digit PIN is a small space; the real protection is the caller-ID
 * prerequisite plus the persisted lockout (spec §9). Server-only: never
 * import from a client component.
 */

const SALT_BYTES = 16;
const HASH_BYTES = 32;
// A stored hash is HASH_BYTES bytes as hex text. Case-insensitive because hex
// text decodes to the same bytes either way (hashPin only emits lowercase and
// the table CHECK only stores lowercase).
const HASH_HEX_REGEX = /^[0-9a-f]{64}$/i;

export function generatePinSalt(): string {
  return randomBytes(SALT_BYTES).toString("hex");
}

export function hashPin(pin: string, salt: string): string {
  return scryptSync(pin, salt, HASH_BYTES).toString("hex");
}

/**
 * Timing-safe compare. A stored hash that is not exactly 64 hex characters (or
 * not a string at all) is simply "wrong PIN". The shape is checked BEFORE
 * decoding: Buffer.from(hash, "hex") silently stops at the first non-hex
 * character, so the right digest with junk appended would otherwise verify.
 */
export function verifyPin(pin: string, salt: string, hash: string): boolean {
  if (typeof hash !== "string" || !HASH_HEX_REGEX.test(hash)) return false;
  const actual = scryptSync(pin, salt, HASH_BYTES);
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}
