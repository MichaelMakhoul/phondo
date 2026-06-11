import { describe, it, expect } from "vitest";
import { verifyCodeCallerOwnership } from "@/lib/calendar/tool-handlers";

describe("verifyCodeCallerOwnership (SCRUM-415)", () => {
  it("passes (null) when the caller's phone matches the booking (last-9 digits)", () => {
    expect(verifyCodeCallerOwnership({ attendee_phone: "+61412345678" }, "+61412345678")).toBeNull();
  });

  it("passes across phone formats with the same last-9 digits", () => {
    // E.164 vs national vs spaced — all end in 412345678.
    expect(verifyCodeCallerOwnership({ attendee_phone: "+61412345678" }, "0412345678")).toBeNull();
    expect(verifyCodeCallerOwnership({ attendee_phone: "0412 345 678" }, "+61 412 345 678")).toBeNull();
  });

  it("blocks when the caller's phone does NOT match the booking", () => {
    const r = verifyCodeCallerOwnership({ attendee_phone: "+61412345678" }, "+61499999999");
    expect(r).not.toBeNull();
    expect(r!.success).toBe(false);
    expect(r!.message).toMatch(/doesn't match/i);
  });

  it("blocks when there is no phone on file to verify against", () => {
    expect(verifyCodeCallerOwnership({ attendee_phone: null }, "+61412345678")!.success).toBe(false);
    expect(verifyCodeCallerOwnership({}, "+61412345678")!.success).toBe(false);
  });

  it("blocks when the caller provided no phone", () => {
    expect(verifyCodeCallerOwnership({ attendee_phone: "+61412345678" }, undefined)!.success).toBe(false);
    expect(verifyCodeCallerOwnership({ attendee_phone: "+61412345678" }, "")!.success).toBe(false);
  });
});
