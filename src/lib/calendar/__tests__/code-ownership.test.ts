import { describe, it, expect } from "vitest";
import {
  phonesMatchForOwnership,
  verifyPhonePossession,
} from "@/lib/calendar/appointment-verification";

// SCRUM-415 established that a confirmation code alone must never authorize a
// mutation — the caller has to hold the booking's phone. SCRUM-438 replaced
// the old verifyCodeCallerOwnership helper with verifyPhonePossession (same
// invariants, plus the verified-caller-ID possession factor and a full
// national-number compare for NANP numbers). These tests carry over every
// SCRUM-415 case and add the new ones.

describe("phonesMatchForOwnership (SCRUM-438)", () => {
  it("matches identical numbers", () => {
    expect(phonesMatchForOwnership("+61412345678", "+61412345678")).toBe(true);
  });

  it("matches across phone formats with the same last-9 digits (AU E.164 vs national vs spaced)", () => {
    expect(phonesMatchForOwnership("+61412345678", "0412345678")).toBe(true);
    expect(phonesMatchForOwnership("0412 345 678", "+61 412 345 678")).toBe(true);
  });

  it("rejects different numbers", () => {
    expect(phonesMatchForOwnership("+61412345678", "+61499999999")).toBe(false);
  });

  it("rejects empty/missing values on either side", () => {
    expect(phonesMatchForOwnership(null, "+61412345678")).toBe(false);
    expect(phonesMatchForOwnership("+61412345678", undefined)).toBe(false);
    expect(phonesMatchForOwnership("", "")).toBe(false);
  });

  it("NANP: compares the FULL 10-digit national number — a leading-area-code-digit difference no longer false-passes", () => {
    // 4155551234 and 2155551234 share the last 9 digits ("155551234") — the
    // old last-9 compare treated these DIFFERENT numbers as the same.
    expect(phonesMatchForOwnership("+14155551234", "+12155551234")).toBe(false);
    expect(phonesMatchForOwnership("4155551234", "2155551234")).toBe(false);
  });

  it("NANP: still matches across +1 / bare-national formats", () => {
    expect(phonesMatchForOwnership("+14155551234", "4155551234")).toBe(true);
    expect(phonesMatchForOwnership("14155551234", "(415) 555-1234")).toBe(true);
  });
});

describe("verifyPhonePossession (SCRUM-438)", () => {
  const BOOKING = { attendee_phone: "+61412345678" };

  it("passes when the model-supplied phone matches and there is no caller ID (browser test calls)", () => {
    expect(verifyPhonePossession(BOOKING, "+61412345678", undefined)).toBe("match");
    expect(verifyPhonePossession(BOOKING, "0412345678", undefined)).toBe("match");
  });

  it("blocks when the phone does NOT match the booking (SCRUM-415 invariant)", () => {
    expect(verifyPhonePossession(BOOKING, "+61499999999", undefined)).toBe("mismatch");
  });

  it("is unverifiable when there is no phone on file (SCRUM-415 invariant)", () => {
    expect(verifyPhonePossession({ attendee_phone: null }, "+61412345678", undefined)).toBe("unverifiable");
    expect(verifyPhonePossession({}, "+61412345678", undefined)).toBe("unverifiable");
  });

  it("is unverifiable when the caller provided no phone at all (SCRUM-415 invariant)", () => {
    expect(verifyPhonePossession(BOOKING, undefined, undefined)).toBe("unverifiable");
    expect(verifyPhonePossession(BOOKING, "", undefined)).toBe("unverifiable");
    expect(verifyPhonePossession(BOOKING, "   ", undefined)).toBe("unverifiable");
  });

  it("the verified caller ID OVERRIDES a model-supplied phone — echoing the victim's number cannot pass", () => {
    // Model passes the booking's own number (the victim's), but the call is
    // actually FROM a different number — possession fails.
    expect(verifyPhonePossession(BOOKING, "+61412345678", "+61499999999")).toBe("mismatch");
  });

  it("the verified caller ID grants possession even when the model phone is wrong/absent", () => {
    expect(verifyPhonePossession(BOOKING, "+61400000000", "+61412345678")).toBe("match");
    expect(verifyPhonePossession(BOOKING, undefined, "0412345678")).toBe("match");
  });
});
