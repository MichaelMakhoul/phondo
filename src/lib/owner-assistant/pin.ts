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

export function generatePinSalt(): string {
  return randomBytes(SALT_BYTES).toString("hex");
}

export function hashPin(pin: string, salt: string): string {
  return scryptSync(pin, salt, HASH_BYTES).toString("hex");
}

/** Timing-safe compare; a malformed stored hash is simply "wrong PIN". */
export function verifyPin(pin: string, salt: string, hash: string): boolean {
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== HASH_BYTES) return false;
  const actual = scryptSync(pin, salt, HASH_BYTES);
  return timingSafeEqual(actual, expected);
}
