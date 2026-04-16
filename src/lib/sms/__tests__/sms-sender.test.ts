import { describe, it, expect } from "vitest";
import {
  computeDefaultSmsSender,
  validateSmsSender,
  isPhoneNumberSender,
  OPT_OUT_MARKER_TEXT,
  OPT_OUT_MARKER_RE,
} from "../sms-sender";

describe("computeDefaultSmsSender", () => {
  it("returns the name trimmed + truncated to 11 chars", () => {
    expect(computeDefaultSmsSender("SmileHub")).toBe("SmileHub");
    expect(computeDefaultSmsSender("SmileHub Dental")).toBe("SmileHub De"); // 11-char cap
  });

  it("strips non-alphanumeric characters (emoji, punctuation) and collapses spaces", () => {
    expect(computeDefaultSmsSender("Mac & Co 😀")).toBe("Mac Co");
    expect(computeDefaultSmsSender("Dr. Chen's Clinic!")).toBe("Dr Chens Cl");
  });

  it("collapses multiple spaces into one", () => {
    expect(computeDefaultSmsSender("A   B   C")).toBe("A B C");
  });

  it("returns null when name has no letters after stripping", () => {
    expect(computeDefaultSmsSender("1234")).toBeNull();
    expect(computeDefaultSmsSender("!!!")).toBeNull();
    expect(computeDefaultSmsSender("")).toBeNull();
    expect(computeDefaultSmsSender(null)).toBeNull();
    expect(computeDefaultSmsSender(undefined)).toBeNull();
  });

  it("returns null when name has only whitespace", () => {
    expect(computeDefaultSmsSender("   ")).toBeNull();
  });

  it("produces output that passes validateSmsSender", () => {
    const inputs = [
      "SmileHub Dental",
      "Harbour Realty Group Pty Ltd",
      "Dr. Chen's Clinic",
      "Café & Co",
    ];
    for (const input of inputs) {
      const result = computeDefaultSmsSender(input);
      if (result) {
        expect(validateSmsSender(result)).toBeNull();
      }
    }
  });
});

describe("validateSmsSender", () => {
  it("accepts valid senders (1-11 alphanumeric + space, contains letter)", () => {
    expect(validateSmsSender("A")).toBeNull();
    expect(validateSmsSender("SmileHub")).toBeNull();
    expect(validateSmsSender("Brand 2024")).toBeNull();
    expect(validateSmsSender("12345678Abc")).toBeNull(); // exactly 11
  });

  it("rejects empty strings", () => {
    expect(validateSmsSender("")).toBe("Sender cannot be empty");
  });

  it("rejects senders longer than 11 chars", () => {
    expect(validateSmsSender("TwelveChars!")).toContain("at most 11");
  });

  it("rejects senders with punctuation or symbols", () => {
    expect(validateSmsSender("Mac&Co")).toContain("letters, numbers, and spaces");
    expect(validateSmsSender("Hi!")).toContain("letters, numbers, and spaces");
  });

  it("rejects digit-only senders (must contain a letter)", () => {
    expect(validateSmsSender("123")).toContain("at least one letter");
    expect(validateSmsSender("2024 2025")).toContain("at least one letter");
  });
});

describe("isPhoneNumberSender", () => {
  it("identifies E.164 phone numbers", () => {
    expect(isPhoneNumberSender("+61412345678")).toBe(true);
    expect(isPhoneNumberSender("+16203029077")).toBe(true);
  });

  it("rejects alphanumeric senders", () => {
    expect(isPhoneNumberSender("SmileHub")).toBe(false);
    expect(isPhoneNumberSender("Brand 2024")).toBe(false);
    expect(isPhoneNumberSender("61412345678")).toBe(false); // no +
    expect(isPhoneNumberSender("+61 412 345 678")).toBe(false); // has spaces
  });
});

describe("OPT_OUT_MARKER_RE (compliance-critical)", () => {
  it("matches the canonical opt-out line at end of body", () => {
    const body = `Your appointment at SmileHub is confirmed for Tuesday at 8 AM.\n\n${OPT_OUT_MARKER_TEXT}`;
    expect(OPT_OUT_MARKER_RE.test(body)).toBe(true);
  });

  it("matches with multiple leading newlines", () => {
    const body = `Message body\n\n\nReply STOP to opt-out.`;
    expect(OPT_OUT_MARKER_RE.test(body)).toBe(true);
  });

  it("matches without the trailing period", () => {
    const body = `Message\n\nReply STOP to opt-out`;
    expect(OPT_OUT_MARKER_RE.test(body)).toBe(true);
  });

  it("matches with 'opt out' (no hyphen)", () => {
    const body = `Message\n\nReply STOP to opt out.`;
    expect(OPT_OUT_MARKER_RE.test(body)).toBe(true);
  });

  it("matches with trailing whitespace", () => {
    const body = `Message\n\nReply STOP to opt-out.   `;
    expect(OPT_OUT_MARKER_RE.test(body)).toBe(true);
  });

  it("is case-insensitive", () => {
    const body = `Message\n\nREPLY STOP TO OPT-OUT.`;
    expect(OPT_OUT_MARKER_RE.test(body)).toBe(true);
  });

  it("does NOT match when the marker is mid-message (must be at the end)", () => {
    const body = `Reply STOP to opt-out.\n\nActually here's more text.`;
    expect(OPT_OUT_MARKER_RE.test(body)).toBe(false);
  });

  it("rewrites correctly — opt-out line replaced with custom text", () => {
    const body = `Your appointment is confirmed.\n\nReply STOP to opt-out.`;
    const rewritten = body.replace(OPT_OUT_MARKER_RE, "\n\nTo opt out, call 555-0100.");
    expect(rewritten).toContain("To opt out, call 555-0100.");
    expect(rewritten).not.toContain("Reply STOP");
  });
});
