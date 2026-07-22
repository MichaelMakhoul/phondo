import { describe, it, expect } from "vitest";
import { validateEarlyAccessInput, EARLY_ACCESS_LIMITS } from "../validate";

describe("validateEarlyAccessInput", () => {
  const valid = {
    fullName: "Jane Smith",
    businessName: "Smith Dental",
    email: "jane@smithdental.com.au",
    phone: "02 9555 1234",
    message: "Keen to try it for our front desk.",
  };

  it("accepts a complete valid submission and returns snake_case data", () => {
    const result = validateEarlyAccessInput(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual({
      full_name: "Jane Smith",
      business_name: "Smith Dental",
      email: "jane@smithdental.com.au",
      phone: "02 9555 1234",
      message: "Keen to try it for our front desk.",
    });
  });

  it("accepts name + email only, nulling absent optionals", () => {
    const result = validateEarlyAccessInput({ fullName: "Jo", email: "jo@x.io" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.business_name).toBeNull();
    expect(result.data.phone).toBeNull();
    expect(result.data.message).toBeNull();
  });

  it("trims surrounding whitespace on every field", () => {
    const result = validateEarlyAccessInput({
      fullName: "  Jane  ",
      email: "  jane@x.io  ",
      businessName: "  Acme  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.full_name).toBe("Jane");
    expect(result.data.email).toBe("jane@x.io");
    expect(result.data.business_name).toBe("Acme");
  });

  it("treats a whitespace-only optional as null, not a value", () => {
    const result = validateEarlyAccessInput({ fullName: "Jane", email: "jane@x.io", phone: "   " });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.phone).toBeNull();
  });

  it("rejects a missing name", () => {
    const result = validateEarlyAccessInput({ email: "jane@x.io" });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a missing email", () => {
    const result = validateEarlyAccessInput({ fullName: "Jane" });
    expect(result).toMatchObject({ ok: false });
  });

  it.each(["not-an-email", "jane@", "@x.io", "jane x@x.io", "jane@nodot"])(
    "rejects malformed email %s",
    (email) => {
      const result = validateEarlyAccessInput({ fullName: "Jane", email });
      expect(result.ok).toBe(false);
    },
  );

  it("flags a tripped honeypot as botDetected (not a normal error)", () => {
    const result = validateEarlyAccessInput({
      fullName: "Jane",
      email: "jane@x.io",
      website: "http://spam.example",
    });
    expect(result).toMatchObject({ ok: false, botDetected: true });
  });

  it("does NOT flag botDetected when the honeypot is empty", () => {
    const result = validateEarlyAccessInput({ fullName: "Jane", email: "jane@x.io", website: "  " });
    expect(result.ok).toBe(true);
  });

  it("honeypot takes precedence over missing required fields (bot with empty name is still a bot)", () => {
    // If the honeypot were checked AFTER field validation, a bot that trips it
    // but leaves name/email blank would get a 400 (leaking that the form
    // validates) and never be classed as a bot. Precedence must hold.
    const result = validateEarlyAccessInput({ website: "spam" });
    expect(result).toMatchObject({ ok: false, botDetected: true });
  });

  it("strips control characters (CR/LF) from single-line fields", () => {
    const lf = String.fromCharCode(10);
    const cr = String.fromCharCode(13);
    const result = validateEarlyAccessInput({
      fullName: `Jane${lf}Bcc: evil@x.io`,
      businessName: `Acme${cr}Co`,
      phone: `0400${lf}000`,
      email: "jane@x.io",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.full_name).toBe("JaneBcc: evil@x.io");
    expect(result.data.business_name).toBe("AcmeCo");
    expect(result.data.phone).toBe("0400000");
  });

  it("preserves newlines in the free-text message (multi-line is legitimate there)", () => {
    const msg = `line one${String.fromCharCode(10)}line two`;
    const result = validateEarlyAccessInput({ fullName: "Jane", email: "jane@x.io", message: msg });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.message).toBe(msg);
  });

  it("rejects an over-long name", () => {
    const result = validateEarlyAccessInput({
      fullName: "a".repeat(EARLY_ACCESS_LIMITS.fullName + 1),
      email: "jane@x.io",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an over-long message", () => {
    const result = validateEarlyAccessInput({
      fullName: "Jane",
      email: "jane@x.io",
      message: "a".repeat(EARLY_ACCESS_LIMITS.message + 1),
    });
    expect(result.ok).toBe(false);
  });

  it("ignores non-string field types instead of throwing", () => {
    const result = validateEarlyAccessInput({
      fullName: 123 as unknown as string,
      email: { x: 1 } as unknown as string,
    });
    expect(result.ok).toBe(false); // both coerce to "" -> missing name
  });
});
