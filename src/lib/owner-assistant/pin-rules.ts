/**
 * Owner-assistant PIN shape (spec §6/§7): digits only, 4–8 long.
 *
 * Deliberately dependency-free so the Settings card (a client component) can
 * import it. The hashing lives in ./pin.ts, which pulls in Node crypto and
 * must stay server-only.
 */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
export const PIN_REGEX = /^\d{4,8}$/;

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_REGEX.test(pin);
}

/**
 * Common 4-digit PINs that the structural rules in isWeakPin do not catch:
 * years, a keypad column (2580) and its reverse (0852), "LOVE" on a phone
 * keypad (5683), and a few perennials. Exact matches only.
 */
const COMMON_PINS: ReadonlySet<string> = new Set([
  "1212",
  "1004",
  "2000",
  "2580",
  "6969",
  "1122",
  "1313",
  "4545",
  "5683",
  "0852",
]);

const ASCENDING_DIGITS = "0123456789";
const DESCENDING_DIGITS = "9876543210";

/**
 * True when a PIN is among the first guesses an attacker would try. A tradie's
 * mobile number is public and caller ID can be spoofed, so the PIN is the real
 * second factor and these must be refused:
 *   - one digit repeated: 0000, 111111
 *   - a straight run in steps of one, up or down: 1234, 0123, 4321, 3210, 12345678
 *   - one 2-digit pair repeated: 4545, 121212 (an odd length such as 12121 is
 *     the same pattern cut short, so it counts too)
 *   - the short list of common PINs above
 *
 * Call it on a PIN that already passed isValidPin; for anything else the
 * answer is not meaningful. Dependency-free, like the rest of this file.
 */
export function isWeakPin(pin: string): boolean {
  return (
    COMMON_PINS.has(pin) ||
    ASCENDING_DIGITS.includes(pin) ||
    DESCENDING_DIGITS.includes(pin) ||
    // Even positions all match the first digit, odd positions the second: one
    // digit repeated (0000) or one pair repeated (4545), odd lengths included.
    [...pin].every((digit, i) => digit === pin[i % 2])
  );
}
