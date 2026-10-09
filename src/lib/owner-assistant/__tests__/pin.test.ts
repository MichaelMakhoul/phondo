import { describe, it, expect } from "vitest";
import { PIN_REGEX, isValidPin } from "@/lib/owner-assistant/pin-rules";
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
});
