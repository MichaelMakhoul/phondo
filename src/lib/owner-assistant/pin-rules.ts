/**
 * Owner-assistant PIN shape (spec §6/§7): digits only, 4–8 long.
 *
 * Deliberately dependency-free so the Settings card (a client component) can
 * import it. The hashing lives in ./pin.ts, which pulls in Node crypto and
 * must stay server-only.
 */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
export const PIN_REGEX = new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`);

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

/**
 * The one user-facing refusal for a guessable PIN. The API returns it as the
 * 400 body and the Settings card shows it inline before submitting, so the two
 * can never word it differently.
 */
export const WEAK_PIN_MESSAGE =
  "Choose a PIN that's harder to guess — avoid repeats, runs like 1234, and common PINs.";

/**
 * How the PIN rule is worded to a person. ASCII digits only: PIN_REGEX has no
 * Unicode digits, so the copy names 0–9 rather than just "digits".
 */
export const PIN_RULE_TEXT = `${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits (0–9)`;

/**
 * The one user-facing refusal for a PIN of the wrong shape. Shared like
 * WEAK_PIN_MESSAGE: the API's 400 body and the Settings card's inline error.
 */
export const PIN_FORMAT_MESSAGE = `PIN must be ${PIN_RULE_TEXT}`;
