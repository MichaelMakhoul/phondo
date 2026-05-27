import { describe, it, expect } from "vitest";
import { formatCallDuration } from "../notification-service";

// SCRUM-335: the daily-summary email used to render raw seconds ("221s").
// formatCallDuration turns the seconds average into a readable m:ss / h:m string.

describe("formatCallDuration", () => {
  it("renders sub-minute durations as seconds", () => {
    expect(formatCallDuration(0)).toBe("0s");
    expect(formatCallDuration(1)).toBe("1s");
    expect(formatCallDuration(45)).toBe("45s");
    expect(formatCallDuration(59)).toBe("59s");
  });

  it("renders the reported 221s as 3m 41s", () => {
    expect(formatCallDuration(221)).toBe("3m 41s");
  });

  it("renders exact minutes with zero seconds", () => {
    expect(formatCallDuration(60)).toBe("1m 0s");
    expect(formatCallDuration(120)).toBe("2m 0s");
  });

  it("renders hours when over 60 minutes", () => {
    expect(formatCallDuration(3600)).toBe("1h 0m");
    expect(formatCallDuration(3725)).toBe("1h 2m");
  });

  it("rounds fractional seconds", () => {
    expect(formatCallDuration(221.4)).toBe("3m 41s");
    expect(formatCallDuration(221.6)).toBe("3m 42s");
  });

  it("clamps negatives and non-finite input to 0s", () => {
    expect(formatCallDuration(-5)).toBe("0s");
    expect(formatCallDuration(NaN)).toBe("0s");
    // @ts-expect-error — defensive against undefined slipping through
    expect(formatCallDuration(undefined)).toBe("0s");
  });
});
