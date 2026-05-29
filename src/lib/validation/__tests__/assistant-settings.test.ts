import { describe, it, expect } from "vitest";
import { assistantSettingsSchema } from "../assistant-settings";

// SCRUM-347 (L4): the settings allow-list must reject unknown keys
// (mass-assignment guard) and accept every key real create/update paths send
// plus every key present in production settings.

describe("assistantSettingsSchema", () => {
  it("rejects an unknown key (mass-assignment guard)", () => {
    const result = assistantSettingsSchema.safeParse({ isAdmin: true });
    expect(result.success).toBe(false);
  });

  it("rejects a known key alongside an unknown key (no partial passthrough)", () => {
    const result = assistantSettingsSchema.safeParse({
      recordingEnabled: true,
      __proto__pollute: "x",
    });
    expect(result.success).toBe(false);
  });

  it("accepts every key present in production settings", () => {
    const result = assistantSettingsSchema.safeParse({
      flexibleBooking: true,
      maxCallDuration: 600,
      piiRedactionEnabled: true,
      recordingDisclosure: "This call may be recorded.",
      recordingEnabled: true,
      spamFilterEnabled: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts the full union of create + update sender keys", () => {
    const result = assistantSettingsSchema.safeParse({
      recordingEnabled: true,
      recordingDisclosure: "x",
      maxCallDuration: 300,
      spamFilterEnabled: true,
      flexibleBooking: false,
      industry: "dental",
      answerMode: "ring_first",
      ringFirstNumber: "+15551234567",
      ringFirstTimeout: 30,
      piiRedactionEnabled: true,
      transferToForwardedNumber: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object and allows nullable ring-first fields", () => {
    expect(assistantSettingsSchema.safeParse({}).success).toBe(true);
    expect(
      assistantSettingsSchema.safeParse({ ringFirstNumber: null, ringFirstTimeout: null }).success
    ).toBe(true);
  });

  it("enforces field-level constraints (E.164 ring-first number, timeout bounds)", () => {
    expect(assistantSettingsSchema.safeParse({ ringFirstNumber: "not-a-number" }).success).toBe(false);
    expect(assistantSettingsSchema.safeParse({ ringFirstTimeout: 1 }).success).toBe(false);
    expect(assistantSettingsSchema.safeParse({ answerMode: "bogus" }).success).toBe(false);
  });
});
