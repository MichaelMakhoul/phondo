import { describe, it, expect } from "vitest";
import {
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  PIN_REGEX,
  isValidPin,
  isWeakPin,
} from "@/lib/owner-assistant/pin-rules";
import { generatePinSalt, hashPin, verifyPin } from "@/lib/owner-assistant/pin";

// Cross-PR contract (spec §1, §9): the voice server's lib/owner-auth.js (PR C)
// must reproduce these digests — Node scryptSync defaults (N=16384, r=8, p=1),
// keylen 32, the hex salt STRING used as the salt bytes. Change these vectors
// and you break every stored PIN.
const SALT = "00112233445566778899aabbccddeeff";
const KAT_1234 = "bd32905894891fff625cb7f496cbf8b7f9ef0cee823bd0aceda87857c65a77d9";
const KAT_90210777 = "32b3fbbd29d2f8c167eead354235f05ccd3e7c61f9f17d47931d459758741595";

describe("PIN rules", () => {
  it("accepts 4 to 8 digits only", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("12345678")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("123456789")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
    expect(isValidPin(" 1234")).toBe(false);
    expect(isValidPin("")).toBe(false);
    expect(isValidPin(1234)).toBe(false);
    expect(isValidPin(null)).toBe(false);
  });

  it("exposes the same regex the route and the card use", () => {
    expect(PIN_REGEX.source).toBe("^\\d{4,8}$");
  });

  it("follows the exported length bounds, so the regex and the constants cannot drift apart", () => {
    expect(isValidPin("0".repeat(PIN_MIN_LENGTH))).toBe(true);
    expect(isValidPin("0".repeat(PIN_MIN_LENGTH - 1))).toBe(false);
    expect(isValidPin("0".repeat(PIN_MAX_LENGTH))).toBe(true);
    expect(isValidPin("0".repeat(PIN_MAX_LENGTH + 1))).toBe(false);
  });
});

// Tradie mobiles are public and caller ID can be spoofed, so the PIN is the
// real second factor: the guesses an attacker tries first must be refused.
describe("weak PIN rule", () => {
  it.each(["0000", "1111", "7777", "000000", "999999", "88888888"])(
    "rejects %s — one digit repeated",
    (pin) => {
      expect(isWeakPin(pin)).toBe(true);
    },
  );

  it.each(["1234", "0123", "2345", "6789", "12345", "123456", "012345", "1234567", "12345678", "23456789"])(
    "rejects %s — a straight ascending run",
    (pin) => {
      expect(isWeakPin(pin)).toBe(true);
    },
  );

  it.each(["4321", "3210", "9876", "98765", "654321", "7654321", "87654321", "98765432"])(
    "rejects %s — a straight descending run",
    (pin) => {
      expect(isWeakPin(pin)).toBe(true);
    },
  );

  it.each(["121212", "7878", "909090", "12121212", "393939", "12121", "1212121"])(
    "rejects %s — a repeated 2-digit pair",
    (pin) => {
      expect(isWeakPin(pin)).toBe(true);
    },
  );

  it.each(["1212", "1004", "2000", "2580", "6969", "1122", "1313", "4545", "5683", "0852"])(
    "rejects %s — on the common-PIN list",
    (pin) => {
      expect(isWeakPin(pin)).toBe(true);
    },
  );

  it.each([
    "1739",
    "805214",
    "40271958",
    "9753", // steps of two, not one
    "1235", // a run broken at the end
    "2346",
    "4320",
    "1243",
    "1213", // a pair repeated, then broken
    "121213",
    "12124",
    "112233", // pairs of digits, but not one pair repeated
  ])("accepts %s", (pin) => {
    expect(isWeakPin(pin)).toBe(false);
  });

  it("treats the common list as exact matches, not substrings", () => {
    expect(isWeakPin("2580")).toBe(true);
    expect(isWeakPin("25801")).toBe(false);
    expect(isWeakPin("92580")).toBe(false);
  });
});

describe("PIN hashing", () => {
  it("generates a 16-byte hex salt that differs per call", () => {
    const a = generatePinSalt();
    const b = generatePinSalt();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("produces the pinned known-answer digests", () => {
    expect(hashPin("1234", SALT)).toBe(KAT_1234);
    expect(hashPin("90210777", SALT)).toBe(KAT_90210777);
  });

  it("is deterministic for one salt and different across salts", () => {
    const salt = generatePinSalt();
    expect(hashPin("4321", salt)).toBe(hashPin("4321", salt));
    expect(hashPin("4321", salt)).not.toBe(hashPin("4321", generatePinSalt()));
    expect(hashPin("4321", salt)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies the right PIN and rejects the wrong one", () => {
    expect(verifyPin("1234", SALT, KAT_1234)).toBe(true);
    expect(verifyPin("1235", SALT, KAT_1234)).toBe(false);
    expect(verifyPin("1234", "ffeeddccbbaa99887766554433221100", KAT_1234)).toBe(false);
  });

  it("returns false (never throws) on a malformed stored hash", () => {
    expect(verifyPin("1234", SALT, "")).toBe(false);
    expect(verifyPin("1234", SALT, "zz")).toBe(false);
    expect(verifyPin("1234", SALT, KAT_1234.slice(0, 60))).toBe(false);
  });

  // Buffer.from(hash, "hex") silently stops at the first non-hex character, so
  // a length check on the DECODED bytes accepts the right digest with junk
  // attached. The stored string's shape is checked BEFORE decoding. Every case
  // below uses the correct PIN and salt, so only the hash text can make it fail.
  it.each([
    { label: "one stray hex char appended (65 chars)", hash: KAT_1234 + "f" },
    { label: "non-hex junk appended", hash: KAT_1234 + "zz" },
    { label: "a trailing newline", hash: KAT_1234 + "\n" },
    { label: "a trailing space", hash: KAT_1234 + " " },
    { label: "a leading space", hash: " " + KAT_1234 },
    { label: "64 non-hex characters", hash: "z".repeat(64) },
  ])("rejects the right PIN against a stored hash with $label", ({ hash }) => {
    expect(verifyPin("1234", SALT, hash)).toBe(false);
  });

  it.each([
    { label: "undefined", hash: undefined },
    { label: "null", hash: null },
    { label: "a number", hash: 1234 },
    { label: "an object", hash: {} },
    { label: "an array holding the digest", hash: [KAT_1234] },
    { label: "an object stringifying to the digest", hash: { toString: () => KAT_1234 } },
    { label: "the raw digest Buffer", hash: Buffer.from(KAT_1234, "hex") },
  ])("returns false instead of throwing when the stored hash is $label", ({ hash }) => {
    expect(verifyPin("1234", SALT, hash as any)).toBe(false);
  });

  it("still verifies the right digest when its hex text is uppercase (same bytes)", () => {
    expect(verifyPin("1234", SALT, KAT_1234.toUpperCase())).toBe(true);
    expect(verifyPin("1235", SALT, KAT_1234.toUpperCase())).toBe(false);
  });
});
