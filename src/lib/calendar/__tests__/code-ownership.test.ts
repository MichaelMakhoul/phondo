import { describe, it, expect } from "vitest";
import {
  phonesMatchForOwnership,
  resolveCallerId,
  verifyPhonePossession,
} from "@/lib/calendar/appointment-verification";

// SCRUM-415 established that a confirmation code alone must never authorize a
// mutation — the caller has to hold the booking's phone. SCRUM-438 replaced
// the old verifyCodeCallerOwnership helper with verifyPhonePossession (same
// invariants, plus the verified-caller-ID possession factor and a full
// national-number compare for NANP numbers). These tests carry over every
// SCRUM-415 case and add the new ones, including the tri-state caller ID
// (verified / withheld / test) from the review fixes.

const TEST_SESSION = { state: "test" } as const;
const WITHHELD = { state: "withheld" } as const;
const verified = (phone: string) => ({ state: "verified", phone }) as const;

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

  it("passes when the model-supplied phone matches on a TEST session (no caller ID)", () => {
    expect(verifyPhonePossession(BOOKING, "+61412345678", TEST_SESSION)).toBe("match");
    expect(verifyPhonePossession(BOOKING, "0412345678", TEST_SESSION)).toBe("match");
  });

  it("blocks when the phone does NOT match the booking (SCRUM-415 invariant)", () => {
    expect(verifyPhonePossession(BOOKING, "+61499999999", TEST_SESSION)).toBe("mismatch");
  });

  it("is unverifiable when there is no phone on file (SCRUM-415 invariant)", () => {
    expect(verifyPhonePossession({ attendee_phone: null }, "+61412345678", TEST_SESSION)).toBe("unverifiable");
    expect(verifyPhonePossession({}, "+61412345678", TEST_SESSION)).toBe("unverifiable");
  });

  it("is unverifiable when the caller provided no phone at all (SCRUM-415 invariant)", () => {
    expect(verifyPhonePossession(BOOKING, undefined, TEST_SESSION)).toBe("unverifiable");
    expect(verifyPhonePossession(BOOKING, "", TEST_SESSION)).toBe("unverifiable");
    expect(verifyPhonePossession(BOOKING, "   ", TEST_SESSION)).toBe("unverifiable");
  });

  it("the verified caller ID OVERRIDES a model-supplied phone — echoing the victim's number cannot pass", () => {
    // Model passes the booking's own number (the victim's), but the call is
    // actually FROM a different number — possession fails.
    expect(verifyPhonePossession(BOOKING, "+61412345678", verified("+61499999999"))).toBe("mismatch");
  });

  it("the verified caller ID grants possession even when the model phone is wrong/absent", () => {
    expect(verifyPhonePossession(BOOKING, "+61400000000", verified("+61412345678"))).toBe("match");
    expect(verifyPhonePossession(BOOKING, undefined, verified("0412345678"))).toBe("match");
  });

  it("a WITHHELD caller ID is ALWAYS unverifiable — the model phone is never a fallback (the #31# spoof stays closed)", () => {
    // The attacker dials with caller ID suppressed and the model echoes the
    // victim's own number — possession must still fail.
    expect(verifyPhonePossession(BOOKING, "+61412345678", WITHHELD)).toBe("unverifiable");
    expect(verifyPhonePossession(BOOKING, "0412345678", WITHHELD)).toBe("unverifiable");
    expect(verifyPhonePossession(BOOKING, undefined, WITHHELD)).toBe("unverifiable");
  });
});

describe("resolveCallerId (SCRUM-438 review fix — tri-state validation)", () => {
  it("the COMPLETE absence of both fields is a test/browser session", () => {
    expect(resolveCallerId(undefined)).toEqual({ state: "test" });
    expect(resolveCallerId({})).toEqual({ state: "test" });
  });

  it("an explicit 'verified' state + dialable phone resolves verified with that phone", () => {
    expect(resolveCallerId({ callerIdState: "verified", verifiedCallerPhone: "+61412345678" })).toEqual({
      state: "verified",
      phone: "+61412345678",
    });
  });

  it("an explicit 'withheld' state resolves withheld — no phone is ever trusted, even if one is sent", () => {
    expect(resolveCallerId({ callerIdState: "withheld" })).toEqual({ state: "withheld" });
    expect(resolveCallerId({ callerIdState: "withheld", verifiedCallerPhone: "+61412345678" })).toEqual({
      state: "withheld",
    });
  });

  it("an UNRECOGNIZED state string fails secure to withheld (never trusts the phone)", () => {
    expect(resolveCallerId({ callerIdState: "spoofed", verifiedCallerPhone: "+61412345678" })).toEqual({
      state: "withheld",
    });
  });

  it("the +266696687 anonymous sentinel resolves withheld — even labelled 'verified', and unlabelled", () => {
    expect(resolveCallerId({ callerIdState: "verified", verifiedCallerPhone: "+266696687" })).toEqual({
      state: "withheld",
    });
    expect(resolveCallerId({ verifiedCallerPhone: "+266696687" })).toEqual({ state: "withheld" });
  });

  it("a dialable phone WITHOUT a state resolves verified (rolling-deploy compatibility)", () => {
    expect(resolveCallerId({ verifiedCallerPhone: "+61412345678" })).toEqual({
      state: "verified",
      phone: "+61412345678",
    });
  });

  it("a 'verified' claim with a junk/non-dialable phone fails secure to withheld", () => {
    expect(resolveCallerId({ callerIdState: "verified", verifiedCallerPhone: "anonymous" })).toEqual({
      state: "withheld",
    });
  });
});
