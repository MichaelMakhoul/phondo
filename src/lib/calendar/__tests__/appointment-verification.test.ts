import { describe, it, expect } from "vitest";
import {
  parseVerificationSettings,
  verifyKnowledgeFactors,
  applyCollectedDetails,
} from "@/lib/calendar/appointment-verification";

// SCRUM-438: shared parsing of `appointment_verification_fields` and the
// knowledge factors (name/email) that mutations now enforce on top of the
// phone possession check. phonesMatchForOwnership / verifyPhonePossession are
// covered in code-ownership.test.ts.

describe("parseVerificationSettings", () => {
  it("parses the structured object form and marks it explicit", () => {
    expect(parseVerificationSettings({ method: "details_only", fields: ["phone", "name"] })).toEqual({
      method: "details_only",
      fields: ["phone", "name"],
      explicit: true,
    });
  });

  it("defaults fields to ['name'] when the object has no fields array", () => {
    expect(parseVerificationSettings({ method: "code_only" })).toEqual({
      method: "code_only",
      fields: ["name"],
      explicit: true,
    });
  });

  it("treats a legacy plain array as code_and_verify (explicit)", () => {
    expect(parseVerificationSettings(["name", "phone"])).toEqual({
      method: "code_and_verify",
      fields: ["name", "phone"],
      explicit: true,
    });
  });

  it("falls back to platform defaults (NOT explicit) for null/undefined/garbage", () => {
    for (const raw of [null, undefined, "weird", 42]) {
      expect(parseVerificationSettings(raw)).toEqual({
        method: "code_and_verify",
        fields: ["name"],
        explicit: false,
      });
    }
  });
});

describe("verifyKnowledgeFactors", () => {
  const APPT = {
    attendee_name: "Jane Smith",
    attendee_email: "jane@example.com",
  };
  const NAME_ORG = { method: "details_only" as const, fields: ["name", "phone"], explicit: true };

  it("does nothing for platform-default (non-explicit) settings — no behavior change for unconfigured orgs", () => {
    const defaults = parseVerificationSettings(null);
    expect(verifyKnowledgeFactors(APPT, {}, defaults)).toBeNull();
  });

  it("does nothing for code_only orgs (they opted into the lightest verification)", () => {
    expect(
      verifyKnowledgeFactors(APPT, {}, { method: "code_only", fields: ["name"], explicit: true })
    ).toBeNull();
  });

  it("asks for the name when the org requires it and none was provided", () => {
    const r = verifyKnowledgeFactors(APPT, {}, NAME_ORG);
    expect(r?.success).toBe(false);
    expect(r?.message).toMatch(/confirm the name/i);
  });

  it("passes a case-insensitive partial/whole-token name (tolerant phonetic match, same as lookup)", () => {
    expect(verifyKnowledgeFactors(APPT, { name: "jane" }, NAME_ORG)).toBeNull();
    expect(verifyKnowledgeFactors(APPT, { name: "JANE SMITH" }, NAME_ORG)).toBeNull();
    expect(verifyKnowledgeFactors({ attendee_name: "Jane" }, { name: "Jane Smith" }, NAME_ORG)).toBeNull();
  });

  it("SCRUM-506: accepts an STT-mangled spelling that lookup would accept (Makhoul≈Macool), fixing the lookup/mutation asymmetry", () => {
    // Before: mutation used a strict substring check, so a name good enough to
    // FIND the booking could FAIL to change it. Now both use namesMatch.
    expect(verifyKnowledgeFactors({ attendee_name: "Makhoul" }, { name: "Macool" }, NAME_ORG)).toBeNull();
  });

  it("SCRUM-506: still refuses an unrelated name under the tolerant matcher (not a rubber stamp)", () => {
    expect(
      verifyKnowledgeFactors({ attendee_name: "Makhoul" }, { name: "Michael" }, NAME_ORG)?.success
    ).toBe(false);
  });

  it("refuses a non-matching name with a GENERIC message that names no factor and echoes no identity", () => {
    const r = verifyKnowledgeFactors(APPT, { name: "Robert Brown" }, NAME_ORG);
    expect(r?.success).toBe(false);
    expect(r?.message).toMatch(/don't match/i);
    expect(r?.message).not.toMatch(/name/i); // doesn't reveal WHICH factor failed
    expect(r?.message).not.toContain("Jane"); // never echoes the stored identity
  });

  it("skips the name factor when there is no name on file to verify against", () => {
    expect(
      verifyKnowledgeFactors({ attendee_name: null }, {}, NAME_ORG)
    ).toBeNull();
  });

  it("'phone' and 'date_of_birth' in fields are not knowledge factors (possession / no DB column — PR #346)", () => {
    const settings = { method: "details_only" as const, fields: ["phone", "date_of_birth"], explicit: true };
    expect(verifyKnowledgeFactors(APPT, {}, settings)).toBeNull();
  });

  describe("email factor", () => {
    const EMAIL_ORG = { method: "details_only" as const, fields: ["email"], explicit: true };

    it("asks for the email when required and not provided", () => {
      const r = verifyKnowledgeFactors(APPT, {}, EMAIL_ORG);
      expect(r?.message).toMatch(/confirm the email/i);
    });

    it("passes a case-insensitive matching email", () => {
      expect(verifyKnowledgeFactors(APPT, { email: "Jane@Example.com" }, EMAIL_ORG)).toBeNull();
    });

    it("refuses a non-matching email generically", () => {
      const r = verifyKnowledgeFactors(APPT, { email: "evil@attacker.com" }, EMAIL_ORG);
      expect(r?.success).toBe(false);
      expect(r?.message).not.toContain("jane@example.com");
    });

    it("skips the factor entirely for synthetic booking emails (nothing was ever collected)", () => {
      const appt = { attendee_name: "Jane Smith", attendee_email: "booking-abc123@noreply.phondo.ai" };
      expect(verifyKnowledgeFactors(appt, {}, EMAIL_ORG)).toBeNull();
    });

    it("skips the factor when no email is on file", () => {
      expect(verifyKnowledgeFactors({ attendee_email: null }, {}, EMAIL_ORG)).toBeNull();
    });
  });
});

describe("applyCollectedDetails (SCRUM-506)", () => {
  it("fills a MISSING name/email from the per-call collected details", () => {
    expect(applyCollectedDetails({}, { name: "Jane Smith", email: "j@x.com" })).toEqual({
      name: "Jane Smith",
      email: "j@x.com",
    });
  });

  it("NEVER overrides a value the model actually provided", () => {
    expect(applyCollectedDetails({ name: "Model Name" }, { name: "Collected Name" })).toEqual({
      name: "Model Name",
    });
  });

  it("treats a blank/whitespace provided value as missing (backfills it)", () => {
    expect(applyCollectedDetails({ name: "   " }, { name: "Collected" }).name).toBe("Collected");
  });

  it("is a no-op when there are no collected details", () => {
    expect(applyCollectedDetails({ name: "A" }, undefined)).toEqual({ name: "A" });
  });

  it("only backfills the enforced factors (name/email), ignoring other collected keys", () => {
    const out = applyCollectedDetails(
      {},
      { name: "N", phone: "+61400000000", date_of_birth: "1990-01-01" },
    );
    expect(out).toEqual({ name: "N" });
  });
});
