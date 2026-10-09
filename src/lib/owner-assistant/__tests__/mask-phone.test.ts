import { describe, it, expect } from "vitest";
import { maskPhoneForOwner } from "../mask-phone";

// SCRUM-586: the lockout email names the calling number by its last three
// digits only — enough for the owner to recognise their own mobile, not
// enough to leak a stranger's number into an inbox.
describe("maskPhoneForOwner", () => {
  it("formats an AU mobile nationally with the last three digits visible", () => {
    expect(maskPhoneForOwner("+61412345137")).toBe("04xx xxx 137");
    expect(maskPhoneForOwner("0412345137")).toBe("04xx xxx 137");
    expect(maskPhoneForOwner("+61 412 345 137")).toBe("04xx xxx 137");
  });
  it("masks every other number to its last three digits", () => {
    expect(maskPhoneForOwner("+15125550173")).toBe("+xxxxxxxx173");
    expect(maskPhoneForOwner("+61298765432")).toBe("+xxxxxxxx432");
    expect(maskPhoneForOwner("1234")).toBe("+x234");
  });
  it("never throws on junk", () => {
    expect(maskPhoneForOwner("")).toBe("an unknown number");
    expect(maskPhoneForOwner("Unknown")).toBe("an unknown number");
    expect(maskPhoneForOwner("137")).toBe("an unknown number");
    expect(maskPhoneForOwner(undefined as unknown as string)).toBe("an unknown number");
  });
});
