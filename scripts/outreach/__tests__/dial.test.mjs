import { describe, it, expect } from "vitest";
import { normalizeAuNumber, callingWindow, buildBridgeTwiml, isOnDoNotCallList } from "../dial.mjs";

// The dialer places real phone calls, so its guards matter more than its happy
// path. The Telemarketing Industry Standard 2017 covers business numbers too:
// weekdays 9am-8pm, Saturday 9am-5pm, never Sundays or national public holidays
// (recipient's local time), unless the person gave express consent in advance.

describe("normalizeAuNumber", () => {
  it.each([
    ["0469 926 137", "+61469926137"],
    ["0469926137", "+61469926137"],
    ["+61 469 926 137", "+61469926137"],
    ["61469926137", "+61469926137"],
    ["(02) 9876 5432", "+61298765432"],
    ["02-9876-5432", "+61298765432"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeAuNumber(input)).toBe(expected);
  });

  it.each([
    "", "12345", "0469 926 13", "0469 926 1377", "+1 415 555 0100", "1300 123 456", "13 12 34", "000", "0569 926 137", "abc",
    // international-format inputs reach the final check directly, so pin it too
    "+61 13 12 34", "+61 1300 123 456", "+61 469 926 13", "+61 569 926 137",
  ])(
    "rejects %s (not an Australian mobile or landline)",
    (bad) => {
      expect(normalizeAuNumber(bad)).toBeNull();
    }
  );
});

describe("callingWindow (Sydney time)", () => {
  const at = (iso) => callingWindow(new Date(iso));

  it("allows weekdays from 9am to just before 8pm", () => {
    expect(at("2026-10-07T08:59:00+11:00").allowed).toBe(false);
    expect(at("2026-10-07T09:00:00+11:00").allowed).toBe(true);
    expect(at("2026-10-07T19:59:00+11:00").allowed).toBe(true);
    expect(at("2026-10-07T20:00:00+11:00").allowed).toBe(false);
  });

  it("allows Saturdays from 9am to just before 5pm", () => {
    expect(at("2026-10-10T16:59:00+11:00").allowed).toBe(true);
    expect(at("2026-10-10T17:00:00+11:00").allowed).toBe(false);
  });

  it("never allows Sundays or national public holidays", () => {
    expect(at("2026-10-11T12:00:00+11:00").allowed).toBe(false); // Sunday
    expect(at("2026-12-25T12:00:00+11:00").allowed).toBe(false); // Christmas
    expect(at("2027-03-26T12:00:00+11:00").allowed).toBe(false); // Good Friday 2027
  });

  it("judges the time in Sydney, whatever the machine's timezone (DST included)", () => {
    expect(at("2026-10-06T22:30:00Z").allowed).toBe(true); // 9:30am AEDT Wed
    expect(at("2026-07-15T08:30:00+10:00").allowed).toBe(false); // 8:30am AEST
    expect(at("2026-07-15T09:30:00+10:00").allowed).toBe(true);
  });

  it("fails closed for a year the holiday table doesn't cover", () => {
    const result = at("2028-03-01T12:00:00+11:00");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/holiday/i);
  });

  it("express consent overrides the hours (they asked to be called then)", () => {
    expect(callingWindow(new Date("2026-10-11T07:30:00+11:00"), { consented: true }).allowed).toBe(true);
  });
});

describe("buildBridgeTwiml", () => {
  it("dials the prospect showing the business caller ID", () => {
    const twiml = buildBridgeTwiml("+61469926137", "+61257015064");
    expect(twiml).toContain('<Dial callerId="+61257015064"');
    expect(twiml).toContain("<Number>+61469926137</Number>");
  });

  it("refuses anything that isn't plain E.164 (no markup can reach the TwiML)", () => {
    expect(() => buildBridgeTwiml('+614"/><Hangup/>', "+61257015064")).toThrow();
    expect(() => buildBridgeTwiml("+61469926137", "0257015064")).toThrow();
  });
});

describe("isOnDoNotCallList", () => {
  const list = "# people who asked not to be called\n0469 926 137\n\n+61 2 9876 5432 # landline\n";

  it("matches a listed number whatever format either side uses", () => {
    expect(isOnDoNotCallList("+61469926137", list)).toBe(true);
    expect(isOnDoNotCallList("+61298765432", list)).toBe(true);
  });

  it("does not match numbers that aren't listed", () => {
    expect(isOnDoNotCallList("+61413336662", list)).toBe(false);
    expect(isOnDoNotCallList("+61469926137", "")).toBe(false);
  });
});
