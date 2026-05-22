import { describe, it, expect } from "vitest";
import { validateForwarding } from "../forwarding-save";

describe("validateForwarding", () => {
  it("both blank → ok, both null (skip is allowed)", () => {
    expect(validateForwarding("", "", "AU")).toEqual({ ok: true, transfer: null, fallback: null });
    expect(validateForwarding("   ", "  ", "AU")).toEqual({ ok: true, transfer: null, fallback: null });
  });

  it("normalises AU local numbers to E.164", () => {
    const r = validateForwarding("0414 141 883", "02 8123 0183", "AU");
    expect(r.ok).toBe(true);
    expect(r.transfer).toBe("+61414141883");
    expect(r.fallback).toBe("+61281230183");
  });

  it("keeps already-E.164 numbers", () => {
    const r = validateForwarding("+61414141883", "+61281230183", "AU");
    expect(r).toEqual({ ok: true, transfer: "+61414141883", fallback: "+61281230183" });
  });

  it("rejects an invalid transfer number and reports the field", () => {
    const r = validateForwarding("041414141883", "", "AU"); // 12 digits — ambiguous
    expect(r.ok).toBe(false);
    expect(r.errorField).toBe("transfer");
  });

  it("rejects an invalid fallback while preserving the valid transfer", () => {
    const r = validateForwarding("0414141883", "12345", "AU");
    expect(r.ok).toBe(false);
    expect(r.errorField).toBe("fallback");
    // transfer was valid and is carried through so the caller can see what parsed
    expect(r.transfer).toBe("+61414141883");
  });

  it("transfer only (fallback blank) → ok with null fallback", () => {
    const r = validateForwarding("0414141883", "", "AU");
    expect(r).toEqual({ ok: true, transfer: "+61414141883", fallback: null });
  });

  it("handles US numbers", () => {
    const r = validateForwarding("415-555-1234", "", "US");
    expect(r.ok).toBe(true);
    expect(r.transfer).toBe("+14155551234");
  });
});
