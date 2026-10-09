import { describe, it, expect } from "vitest";
import { parsePhoneToE164 } from "@/lib/phone/normalize";
import { WEAK_PIN_MESSAGE } from "@/lib/owner-assistant/pin-rules";
import {
  LOAD_FAILED_MESSAGE,
  PIN_CONFIRM_ONLY_MESSAGE,
  PIN_FORMAT_MESSAGE,
  PIN_MISMATCH_MESSAGE,
  PIN_REQUIRED_MESSAGE,
  PIN_RULE_TEXT,
  buildSaveBody,
  phoneExampleFor,
  resolveOwnerLineInitial,
  serverErrorMessage,
  validateOwnerLineForm,
} from "@/lib/owner-assistant/line-form";

// A strong PIN: not a repeat, a run, a repeated pair or on the common list.
const PIN = "9753";
const PHONE = "0412 345 678";

const FIRST_SAVE = { country: "AU", configured: false } as const;
const EXISTING = { country: "AU", configured: true } as const;

describe("PIN copy", () => {
  it('says "4–8 digits (0–9)" — PIN_REGEX is ASCII-only, so the copy names the digits', () => {
    expect(PIN_RULE_TEXT).toBe("4–8 digits (0–9)");
    expect(PIN_REQUIRED_MESSAGE).toContain(PIN_RULE_TEXT);
    expect(PIN_FORMAT_MESSAGE).toContain(PIN_RULE_TEXT);
  });
});

describe("validateOwnerLineForm — first save", () => {
  it("accepts a valid mobile with a matching strong PIN", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: PIN, pinConfirm: PIN }, FIRST_SAVE)).toEqual({});
  });

  it("asks for a PIN when none is entered, and only the phone and PIN fields complain", () => {
    expect(validateOwnerLineForm({ phone: "", pin: "", pinConfirm: "" }, FIRST_SAVE)).toEqual({
      phone: expect.stringContaining("Enter a valid mobile number"),
      pin: PIN_REQUIRED_MESSAGE,
    });
  });

  it("still asks for a PIN when only the confirmation was typed", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: "", pinConfirm: PIN }, FIRST_SAVE)).toEqual({
      pin: PIN_REQUIRED_MESSAGE,
    });
  });

  it.each(["04", "abc", "0412 345 67", "+44 7911 123456", "1234 5678"])(
    "rejects the phone %j and names the AU example",
    (phone) => {
      const errors = validateOwnerLineForm({ phone, pin: PIN, pinConfirm: PIN }, FIRST_SAVE);
      expect(errors.phone).toContain("0412 345 678");
      expect(errors.pin).toBeUndefined();
      expect(errors.pinConfirm).toBeUndefined();
    },
  );

  it("names the US example for a US org, and accepts US formats", () => {
    const us = { country: "US", configured: false } as const;
    expect(validateOwnerLineForm({ phone: "123", pin: PIN, pinConfirm: PIN }, us).phone).toContain("+14155551234");
    expect(validateOwnerLineForm({ phone: "415-555-1234", pin: PIN, pinConfirm: PIN }, us)).toEqual({});
  });

  it("accepts a phone already in E.164, with stray spaces around it", () => {
    expect(validateOwnerLineForm({ phone: " +61412345678 ", pin: PIN, pinConfirm: PIN }, FIRST_SAVE)).toEqual({});
  });

  // The card and the API both validate with parsePhoneToE164, whose documented
  // escape hatch is a compact E.164 number from another country. Pinned so the
  // two can't drift: the card must not refuse what the API would accept.
  it("accepts a compact E.164 number from another country, as the API does", () => {
    expect(validateOwnerLineForm({ phone: "+447911123456", pin: PIN, pinConfirm: PIN }, FIRST_SAVE)).toEqual({});
  });
});

describe("validateOwnerLineForm — PIN shape", () => {
  // isWeakPin returns true for these, so a wrong check order would call a
  // half-typed PIN "weak". They must be reported as too short instead.
  it.each(["1", "12", "123"])("reports the half-typed %j as the wrong length, never as weak", (pin) => {
    const errors = validateOwnerLineForm({ phone: PHONE, pin, pinConfirm: pin }, FIRST_SAVE);
    expect(errors.pin).toBe(PIN_FORMAT_MESSAGE);
    expect(errors.pin).not.toBe(WEAK_PIN_MESSAGE);
  });

  it.each([
    ["too long", "123456789"],
    ["letters", "12a4"],
    ["a leading space", " 9753"],
    ["a trailing newline", "9753\n"],
    ["Arabic-Indic digits", "٩٧٥٣"],
    ["full-width digits", "９７５３"],
    ["a decimal point", "97.53"],
  ])("rejects a PIN with %s", (_label, pin) => {
    expect(validateOwnerLineForm({ phone: PHONE, pin, pinConfirm: pin }, FIRST_SAVE).pin).toBe(PIN_FORMAT_MESSAGE);
  });

  it.each(["1234", "0000", "4321", "121212", "2580", "12345678", "11111111", "5683"])(
    "refuses the guessable PIN %s with the shared weak-PIN message",
    (pin) => {
      expect(validateOwnerLineForm({ phone: PHONE, pin, pinConfirm: pin }, FIRST_SAVE)).toEqual({
        pin: WEAK_PIN_MESSAGE,
      });
    },
  );

  it.each(["9753", "1739", "805214", "40271958"])("accepts the strong PIN %s", (pin) => {
    expect(validateOwnerLineForm({ phone: PHONE, pin, pinConfirm: pin }, FIRST_SAVE)).toEqual({});
  });

  it("flags a mismatched confirmation on the confirm field, not the PIN field", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: PIN, pinConfirm: "9754" }, FIRST_SAVE)).toEqual({
      pinConfirm: PIN_MISMATCH_MESSAGE,
    });
  });

  it("flags an empty confirmation as a mismatch", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: PIN, pinConfirm: "" }, FIRST_SAVE)).toEqual({
      pinConfirm: PIN_MISMATCH_MESSAGE,
    });
  });

  it("reports a weak PIN and a mismatch together so both can be fixed in one pass", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: "1234", pinConfirm: PIN }, FIRST_SAVE)).toEqual({
      pin: WEAK_PIN_MESSAGE,
      pinConfirm: PIN_MISMATCH_MESSAGE,
    });
  });
});

// The card sets no maxLength on the PIN inputs, so a paste reaches the validator
// whole. A browser would otherwise cut "402719583" down to the valid, strong
// "40271958" — a PIN the owner never chose and cannot know. It must be refused.
describe("validateOwnerLineForm — a PIN pasted past the maximum length", () => {
  const PASTES = ["402719583", "4027195830", "40271958305", "40271958305172839405", "7".repeat(64)];

  it.each(PASTES.map((paste) => [paste.length, paste] as const))(
    "rejects a pasted %i-digit PIN with the format error, not a truncated 8-digit one (first save)",
    (_digits, paste) => {
      // Pasted into both fields, so the confirmation matches: only the length is wrong.
      expect(validateOwnerLineForm({ phone: PHONE, pin: paste, pinConfirm: paste }, FIRST_SAVE)).toEqual({
        pin: PIN_FORMAT_MESSAGE,
      });
    },
  );

  it.each(PASTES.map((paste) => [paste.length, paste] as const))(
    "rejects a pasted %i-digit PIN the same way when resetting an existing line",
    (_digits, paste) => {
      expect(validateOwnerLineForm({ phone: PHONE, pin: paste, pinConfirm: paste }, EXISTING)).toEqual({
        pin: PIN_FORMAT_MESSAGE,
      });
    },
  );

  it("accepts 8 digits and refuses the 9th: the first 8 of a paste would have passed, which is why truncating is unsafe", () => {
    const eight = "40271958";
    expect(validateOwnerLineForm({ phone: PHONE, pin: eight, pinConfirm: eight }, FIRST_SAVE)).toEqual({});
    expect(validateOwnerLineForm({ phone: PHONE, pin: `${eight}3`, pinConfirm: `${eight}3` }, FIRST_SAVE)).toEqual({
      pin: PIN_FORMAT_MESSAGE,
    });
  });

  it("does not let a paste hide behind a matching truncation: a long PIN with an 8-digit confirm is a mismatch too", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: "402719583", pinConfirm: "40271958" }, FIRST_SAVE)).toEqual({
      pin: PIN_FORMAT_MESSAGE,
      pinConfirm: PIN_MISMATCH_MESSAGE,
    });
  });
});

describe("validateOwnerLineForm — a line that is already set up", () => {
  it("lets a blank PIN through to keep the current one", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: "", pinConfirm: "" }, EXISTING)).toEqual({});
  });

  it("still validates the phone when the PIN is kept", () => {
    const errors = validateOwnerLineForm({ phone: "04", pin: "", pinConfirm: "" }, EXISTING);
    expect(Object.keys(errors)).toEqual(["phone"]);
  });

  it("refuses a lone confirmation, which would otherwise keep the old PIN while looking like a reset", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: "", pinConfirm: PIN }, EXISTING)).toEqual({
      pin: PIN_CONFIRM_ONLY_MESSAGE,
    });
  });

  it("accepts a new matching strong PIN", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: "40271958", pinConfirm: "40271958" }, EXISTING)).toEqual({});
  });

  it("holds a reset PIN to the same weak-PIN and mismatch rules", () => {
    expect(validateOwnerLineForm({ phone: PHONE, pin: "0000", pinConfirm: "0000" }, EXISTING)).toEqual({
      pin: WEAK_PIN_MESSAGE,
    });
    expect(validateOwnerLineForm({ phone: PHONE, pin: PIN, pinConfirm: "" }, EXISTING)).toEqual({
      pinConfirm: PIN_MISMATCH_MESSAGE,
    });
  });
});

describe("phoneExampleFor", () => {
  it("gives each country an example its own validator accepts", () => {
    expect(phoneExampleFor("AU")).toBe("0412 345 678");
    expect(phoneExampleFor("US")).toBe("+14155551234");
    expect(parsePhoneToE164(phoneExampleFor("AU"), "AU")).toBe("+61412345678");
    expect(parsePhoneToE164(phoneExampleFor("US"), "US")).toBe("+14155551234");
  });
});

describe("buildSaveBody", () => {
  it("omits the PIN when it is blank, so the API keeps the stored one", () => {
    const body = buildSaveBody({ phone: PHONE, pin: "", enabled: true });
    expect(body).toEqual({ phone: PHONE, enabled: true });
    expect("pin" in body).toBe(false);
  });

  it("includes the PIN when one was entered", () => {
    expect(buildSaveBody({ phone: PHONE, pin: PIN, enabled: true })).toEqual({ phone: PHONE, enabled: true, pin: PIN });
  });

  it("trims the phone and carries a paused line through", () => {
    expect(buildSaveBody({ phone: "  +61412345678 ", pin: "", enabled: false })).toEqual({
      phone: "+61412345678",
      enabled: false,
    });
  });
});

describe("serverErrorMessage", () => {
  const FALLBACK = "Failed to save settings. Please try again.";

  it("returns the API's message", () => {
    expect(serverErrorMessage({ error: "Too many changes — try again in a minute." }, FALLBACK)).toBe(
      "Too many changes — try again in a minute.",
    );
  });

  it.each([
    ["null (an unparseable body)", null],
    ["undefined", undefined],
    ["a string", "boom"],
    ["an object without error", { message: "boom" }],
    ["an empty error", { error: "" }],
    ["a blank error", { error: "   " }],
    ["a non-string error", { error: { code: 42 } }],
    ["a numeric error", { error: 500 }],
  ])("falls back for %s", (_label, body) => {
    expect(serverErrorMessage(body, FALLBACK)).toBe(FALLBACK);
  });
});

// A failed owner_access read must never look like "no row yet": the empty form
// says "Not set up yet." and a save from it would overwrite a stored PIN through
// the service-role API with a success toast. Only a clean no-row read may give
// the empty form; everything unreadable fails closed to null (the load error).
describe("resolveOwnerLineInitial — the Settings page's owner_access read", () => {
  const ROW = { phone_e164: "+61412345678", pin_length: 6, enabled: false };
  const PERMISSION_DENIED = { code: "42501", message: "permission denied for table owner_access" };
  const EMPTY = { configured: false, phoneE164: null, pinLength: null, enabled: true };

  it("returns null when the read failed, so a configured line is never shown as not set up", () => {
    expect(resolveOwnerLineInitial({ data: null, error: PERMISSION_DENIED })).toBeNull();
  });

  it.each([
    ["a Postgrest error", PERMISSION_DENIED],
    ["a thrown Error", new Error("fetch failed")],
    ["an error without a code", { message: "JWT expired" }],
    ["a bare string", "boom"],
    ["true", true],
  ])("returns null for %s", (_label, error) => {
    expect(resolveOwnerLineInitial({ data: null, error })).toBeNull();
  });

  it("lets an error win even when a row came back alongside it", () => {
    expect(resolveOwnerLineInitial({ data: ROW, error: PERMISSION_DENIED })).toBeNull();
  });

  it.each([null, undefined])("gives the empty form only for a clean no-row read (data %s)", (data) => {
    expect(resolveOwnerLineInitial({ data, error: null })).toStrictEqual(EMPTY);
  });

  it("returns a fresh empty state each time, never a shared object", () => {
    const first = resolveOwnerLineInitial({ data: null, error: null });
    const second = resolveOwnerLineInitial({ data: null, error: null });
    expect(first).not.toBe(second);
  });

  it("maps a row to the configured state, whatever its pause flag and PIN length", () => {
    expect(resolveOwnerLineInitial({ data: ROW, error: null })).toStrictEqual({
      configured: true,
      phoneE164: "+61412345678",
      pinLength: 6,
      enabled: false,
    });
    expect(resolveOwnerLineInitial({ data: { ...ROW, enabled: true, pin_length: 4 }, error: null })).toStrictEqual({
      configured: true,
      phoneE164: "+61412345678",
      pinLength: 4,
      enabled: true,
    });
  });

  it("copies only the three non-secret columns, even if the row carries more", () => {
    const wide = {
      ...ROW,
      id: "row-id",
      organization_id: "org-1",
      pin_hash: "a".repeat(64),
      pin_salt: "b".repeat(32),
    };
    const result = resolveOwnerLineInitial({ data: wide, error: null });
    expect(Object.keys(result ?? {}).sort()).toEqual(["configured", "enabled", "phoneE164", "pinLength"]);
    expect(JSON.stringify(result)).not.toMatch(/a{64}|b{32}/);
  });

  it.each([
    ["an empty object", {}],
    ["a missing phone", { phone_e164: null, pin_length: 6, enabled: true }],
    ["a missing pause flag", { phone_e164: "+61412345678", pin_length: 6 }],
    ["a string PIN length", { phone_e164: "+61412345678", pin_length: "6", enabled: true }],
    ["a string pause flag", { phone_e164: "+61412345678", pin_length: 6, enabled: "true" }],
    ["a bare string", "a row"],
    ["an array", []],
    ["false", false],
    ["zero", 0],
    ["an empty string", ""],
  ])("fails closed on a row that is not the expected columns (%s)", (_label, data) => {
    expect(resolveOwnerLineInitial({ data, error: null })).toBeNull();
  });
});

describe("LOAD_FAILED_MESSAGE", () => {
  it("is the agreed wording and never claims the line is not set up", () => {
    expect(LOAD_FAILED_MESSAGE).toBe("We couldn't load your assistant line — refresh to try again.");
    expect(LOAD_FAILED_MESSAGE).not.toMatch(/not set up/i);
  });
});
