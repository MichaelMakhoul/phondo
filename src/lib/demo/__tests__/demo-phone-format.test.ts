import { describe, it, expect } from "vitest";
import { formatDemoPhoneDisplay } from "../config";

// SCRUM-571: the tap-to-call demo line is stored as E.164 in
// NEXT_PUBLIC_DEMO_PHONE_NUMBER; the page shows it in familiar AU notation.
describe("SCRUM-571: formatDemoPhoneDisplay", () => {
  it("formats AU landlines as (0X) XXXX XXXX", () => {
    expect(formatDemoPhoneDisplay("+61291234567")).toBe("(02) 9123 4567");
    expect(formatDemoPhoneDisplay("+61731234567")).toBe("(07) 3123 4567");
  });

  it("formats AU mobiles as 04XX XXX XXX", () => {
    expect(formatDemoPhoneDisplay("+61412345678")).toBe("0412 345 678");
  });

  it("passes through anything it does not recognize (fail-safe display)", () => {
    expect(formatDemoPhoneDisplay("+12025550123")).toBe("+12025550123");
    expect(formatDemoPhoneDisplay("")).toBe("");
  });

  it("near-miss AU numbers pass through untouched (never display a truncated number)", () => {
    // Anchors matter: without them a wrong-length env value would DISPLAY a
    // plausible truncated number while tel: dials the raw (wrong) value.
    expect(formatDemoPhoneDisplay("+612912345678")).toBe("+612912345678"); // one digit too many
    expect(formatDemoPhoneDisplay("+6129123456")).toBe("+6129123456"); // one digit short
  });
});
