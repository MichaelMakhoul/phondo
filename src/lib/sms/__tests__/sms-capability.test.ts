import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-597: who can take a text. The owner's rule: never text a landline, or a
// number that can't receive SMS for any reason. Every step fails closed.

const lookupFetch = vi.fn();
vi.mock("@/lib/twilio/client", () => ({
  getTwilioClient: () => ({ lookups: { v2: { phoneNumbers: () => ({ fetch: lookupFetch }) } } }),
}));
const optOutRead = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: unknown[][] = [];
      const b: any = {
        select: () => b,
        eq: (...args: unknown[]) => { filters.push(args); return b; },
        maybeSingle: async () => optOutRead(table, filters),
      };
      return b;
    },
  }),
}));

import { numberingPlanLineType, toNumberingPlanE164, getTextCapability, lookupLineTypeViaTwilio } from "../sms-capability";

const ORG = "11111111-2222-4333-a444-555555555555";
const ON = { smsEnabled: true, isOptedOut: async () => false };

beforeEach(() => {
  lookupFetch.mockReset();
  optOutRead.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CALLER_SMS_ENABLED;
});

describe("numberingPlanLineType (free, no I/O)", () => {
  it("AU: 4 is a mobile; 2/3/7/8 are landlines; anything else under +61 is other", () => {
    expect(numberingPlanLineType("+61414141883")).toBe("mobile");
    for (const n of ["+61295551234", "+61395551234", "+61755551234", "+61855551234"]) {
      expect(numberingPlanLineType(n)).toBe("landline");
    }
    expect(numberingPlanLineType("+61512345678")).toBe("other"); // 05: not a standard mobile range
    expect(numberingPlanLineType("+61130055")).toBe("other"); // a 13 number
    expect(numberingPlanLineType("+611300123456")).toBe("other"); // 1300
    expect(numberingPlanLineType("+611800123456")).toBe("other"); // 1800
  });

  it("only a real E.164 string is classified: a formatted or empty number is null, never 'other'", () => {
    for (const n of ["+61 412 345 678", "+61412345678 ", "0412 345 678", "", null, undefined]) {
      expect(numberingPlanLineType(n as any), JSON.stringify(n)).toBeNull();
    }
  });

  it("NANP and other countries can't be told from the number: null", () => {
    expect(numberingPlanLineType("+14155551234")).toBeNull();
    expect(numberingPlanLineType("+447700900123")).toBeNull();
  });
});

describe("getTextCapability", () => {
  it("the global SMS pause comes first and needs no number check, lookup or opt-out read", async () => {
    const lookupLineType = vi.fn();
    const isOptedOut = vi.fn();
    expect(await getTextCapability(ORG, "+61414141883", "AU", { smsEnabled: false, lookupLineType, isOptedOut })).toEqual({
      canText: false, reason: "texts_paused", phone: null,
    });
    expect(lookupLineType).not.toHaveBeenCalled();
    expect(isOptedOut).not.toHaveBeenCalled();
  });

  it("reads CALLER_SMS_ENABLED at call time when not told: only the exact string \"true\" turns texts on", async () => {
    for (const v of [undefined, "", "1", "TRUE", "yes"]) {
      if (v === undefined) delete process.env.CALLER_SMS_ENABLED; else process.env.CALLER_SMS_ENABLED = v;
      expect((await getTextCapability(ORG, "+61414141883", "AU", { isOptedOut: async () => false })).canText).toBe(false);
    }
    process.env.CALLER_SMS_ENABLED = "true";
    expect(await getTextCapability(ORG, "+61414141883", "AU", { isOptedOut: async () => false })).toEqual({ canText: true, phone: "+61414141883" });
  });

  it("no number, garbage, a 13/1300 number or an unsupported country: no_number", async () => {
    for (const phone of [null, undefined, "", "call me", "13 13 13", "1300 123 456"]) {
      expect(await getTextCapability(ORG, phone, "AU", ON)).toMatchObject({ canText: false, reason: "no_number" });
    }
    expect(await getTextCapability(ORG, "+61414141883", "NZ", ON)).toMatchObject({ canText: false, reason: "no_number" });
    expect(await getTextCapability(ORG, "+61414141883", null, ON)).toMatchObject({ canText: false, reason: "no_number" });
    // A national-format US number on an AU org doesn't normalise (no cross-country guessing)...
    expect(await getTextCapability(ORG, "415-555-1234", "AU", ON)).toMatchObject({ canText: false, reason: "no_number" });
  });

  it("a number already in E.164 is taken as stored whatever the org's country; NANP goes to the lookup", async () => {
    const lookupLineType = vi.fn(async () => "mobile" as const);
    expect(await getTextCapability(ORG, "+14155551234", "AU", { ...ON, lookupLineType })).toEqual({ canText: true, phone: "+14155551234" });
    expect(lookupLineType).toHaveBeenCalledWith("+14155551234");
    // ...and a non-NANP, non-AU E.164 number is refused without a paid lookup.
    const notCalled = vi.fn();
    expect(await getTextCapability(ORG, "+447700900123", "AU", { ...ON, lookupLineType: notCalled })).toMatchObject({ canText: false, reason: "not_mobile" });
    expect(notCalled).not.toHaveBeenCalled();
  });

  it("normalises the stored number in the org's country before deciding", async () => {
    expect(await getTextCapability(ORG, "0414 141 883", "AU", ON)).toEqual({ canText: true, phone: "+61414141883" });
  });

  it("an AU landline is refused for free, with no lookup and no opt-out read", async () => {
    const lookupLineType = vi.fn();
    const isOptedOut = vi.fn();
    expect(await getTextCapability(ORG, "(02) 9555 1234", "AU", { smsEnabled: true, lookupLineType, isOptedOut })).toEqual({
      canText: false, reason: "landline", phone: "+61295551234",
    });
    expect(lookupLineType).not.toHaveBeenCalled();
    expect(isOptedOut).not.toHaveBeenCalled();
  });

  it("US numbers need a carrier lookup: only mobile qualifies; landline, other and a failed lookup don't", async () => {
    const cases: Array<[string, object]> = [
      ["mobile", { canText: true, phone: "+14155551234" }],
      ["landline", { canText: false, reason: "landline", phone: "+14155551234" }],
      ["other", { canText: false, reason: "not_mobile", phone: "+14155551234" }],
      ["error", { canText: false, reason: "check_failed", phone: "+14155551234" }],
    ];
    for (const [line, expected] of cases) {
      const lookupLineType = vi.fn(async () => line as any);
      expect(await getTextCapability(ORG, "415-555-1234", "US", { ...ON, lookupLineType })).toEqual(expected);
      expect(lookupLineType).toHaveBeenCalledWith("+14155551234");
    }
  });

  it("a customer who replied STOP is refused; a failed opt-out read is refused too (fail closed)", async () => {
    expect(await getTextCapability(ORG, "+61414141883", "AU", { smsEnabled: true, isOptedOut: async () => true })).toEqual({
      canText: false, reason: "opted_out", phone: "+61414141883",
    });
    expect(await getTextCapability(ORG, "+61414141883", "AU", { smsEnabled: true, isOptedOut: async () => { throw new Error("db down"); } })).toEqual({
      canText: false, reason: "check_failed", phone: "+61414141883",
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("the default opt-out read is org-scoped on the normalised number and fails closed on a DB error", async () => {
    optOutRead.mockResolvedValueOnce({ data: { id: "x" }, error: null });
    expect(await getTextCapability(ORG, "0414141883", "AU", { smsEnabled: true })).toMatchObject({ reason: "opted_out" });
    const [table, filters] = optOutRead.mock.calls[0];
    expect(table).toBe("caller_sms_optouts");
    expect(filters).toEqual([["phone_number", "+61414141883"], ["organization_id", ORG]]);

    optOutRead.mockResolvedValueOnce({ data: null, error: { code: "57014" } });
    expect(await getTextCapability(ORG, "0414141883", "AU", { smsEnabled: true })).toMatchObject({ canText: false, reason: "check_failed" });

    optOutRead.mockResolvedValueOnce({ data: null, error: null });
    expect(await getTextCapability(ORG, "0414141883", "AU", { smsEnabled: true })).toEqual({ canText: true, phone: "+61414141883" });
  });
});

describe("lookupLineTypeViaTwilio", () => {
  it("maps Twilio's line type: mobile; landline and fixedVoip are landlines; any other type is other", async () => {
    const cases: Array<[string, string]> = [
      ["mobile", "mobile"], ["landline", "landline"], ["fixedVoip", "landline"],
      ["nonFixedVoip", "other"], ["tollFree", "other"], ["pager", "other"],
    ];
    for (const [type, expected] of cases) {
      lookupFetch.mockResolvedValueOnce({ lineTypeIntelligence: { type } });
      expect(await lookupLineTypeViaTwilio("+14155551234")).toBe(expected);
    }
    expect(lookupFetch).toHaveBeenCalledWith({ fields: "line_type_intelligence" });
  });

  it("no type, an empty result or a thrown request is an error (no text)", async () => {
    lookupFetch.mockResolvedValueOnce({ lineTypeIntelligence: { type: null, error_code: 60600 } });
    expect(await lookupLineTypeViaTwilio("+14155551234")).toBe("error");
    lookupFetch.mockResolvedValueOnce({ lineTypeIntelligence: null });
    expect(await lookupLineTypeViaTwilio("+14155551234")).toBe("error");
    lookupFetch.mockRejectedValueOnce(new Error("20003 auth"));
    expect(await lookupLineTypeViaTwilio("+14155551234")).toBe("error");
  });
});

describe("toNumberingPlanE164 (what sendCallerSMS classifies)", () => {
  it("compacts international form, reads a national number as AU, and leaves NANP national numbers alone", () => {
    expect(toNumberingPlanE164("+61 412 345 678")).toBe("+61412345678");
    expect(toNumberingPlanE164("+61 (2) 9555-1234")).toBe("+61295551234");
    expect(toNumberingPlanE164("+61 13 13 13")).toBe("+61131313");
    expect(toNumberingPlanE164("0412 345 678")).toBe("+61412345678");
    expect(toNumberingPlanE164("(02) 9555 1234")).toBe("+61295551234");
    expect(toNumberingPlanE164("+1 (415) 555-1234")).toBe("+14155551234");
    expect(toNumberingPlanE164("415-555-1234")).toBeNull();
    expect(toNumberingPlanE164("614-555-1234")).toBeNull(); // a Columbus, OH number, not +61
    for (const n of ["", "call me", null, undefined]) expect(toNumberingPlanE164(n as any)).toBeNull();
  });
  it("feeds numberingPlanLineType the right class", () => {
    expect(numberingPlanLineType(toNumberingPlanE164("+61 412 345 678"))).toBe("mobile");
    expect(numberingPlanLineType(toNumberingPlanE164("(02) 9555 1234"))).toBe("landline");
    expect(numberingPlanLineType(toNumberingPlanE164("+61 13 13 13"))).toBe("other");
    expect(numberingPlanLineType(toNumberingPlanE164("415-555-1234"))).toBeNull();
  });
});

describe("the AU trunk zero after +61 (types lens round 2)", () => {
  it("'+61 (0) 412 345 678' and '+610412345678' are the mobile +61412345678; a 1300 number stays non-mobile", () => {
    expect(toNumberingPlanE164("+61 (0) 412 345 678")).toBe("+61412345678");
    expect(toNumberingPlanE164("+610412345678")).toBe("+61412345678");
    expect(toNumberingPlanE164("+61 (0)2 9555 1234")).toBe("+61295551234");
    expect(numberingPlanLineType(toNumberingPlanE164("+61 (0) 412 345 678"))).toBe("mobile");
    expect(numberingPlanLineType(toNumberingPlanE164("+61 1300 123 456"))).toBe("other");
  });
  it("the owner path reads it as a textable mobile too", async () => {
    expect(await getTextCapability(ORG, "+61 (0) 412 345 678", "AU", ON)).toEqual({ canText: true, phone: "+61412345678" });
  });
});
