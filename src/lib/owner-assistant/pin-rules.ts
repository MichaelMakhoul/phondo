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
