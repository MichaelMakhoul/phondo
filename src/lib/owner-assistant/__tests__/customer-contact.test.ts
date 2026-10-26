import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-597: "let them know?" — the choices offered, carrying out the owner's
// choice after the change, and the sentence the model repeats. Never claims a
// contact the result doesn't confirm.

vi.mock("@/lib/sms/caller-sms", () => ({ sendCancellationSMS: vi.fn(), sendAppointmentConfirmationSMS: vi.fn() }));

import { sendCancellationSMS, sendAppointmentConfirmationSMS } from "@/lib/sms/caller-sms";
import {
  CONTACT_METHODS,
  parseContactMethod,
  getContactOptions,
  contactCustomer,
  contactOutcomeSentence,
  isCustomerNotified,
  type ContactRequest,
} from "../customer-contact";

const ORG = "11111111-2222-4333-a444-555555555555";
const APPT = "44444444-5555-4666-8777-888888888888";
const START = new Date("2026-10-16T23:00:00Z");
const CAN = { smsEnabled: true, isOptedOut: async () => false };
const req = (over: Partial<ContactRequest> = {}): ContactRequest => ({
  orgId: ORG, method: "text", kind: "cancelled", appointmentId: APPT, startTime: START,
  phone: "+61414141883", country: "AU", timezone: "Australia/Sydney", ...over,
});

beforeEach(() => {
  vi.mocked(sendCancellationSMS).mockReset();
  vi.mocked(sendAppointmentConfirmationSMS).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("parseContactMethod", () => {
  it("accepts exactly text, call and none", () => {
    expect(CONTACT_METHODS).toEqual(["text", "call", "none"]);
    for (const m of CONTACT_METHODS) expect(parseContactMethod(m)).toBe(m);
  });
  it("anything else is null (the confirm is asked again, nothing changes)", () => {
    for (const v of [undefined, null, "", "sms", "Text", "yes", "no", true, 1, {}, ["text"]]) expect(parseContactMethod(v)).toBeNull();
  });
});

describe("getContactOptions", () => {
  it("texts off: only 'none', with the reason to say (not 'switched off' — the owner's own Settings toggle may show on)", async () => {
    expect(await getContactOptions(ORG, "+61414141883", "AU", { smsEnabled: false })).toEqual({
      options: ["none"], note: "Texting customers isn't available yet.",
    });
  });
  it("a landline / no number / an opted-out customer: only 'none', each with its own reason", async () => {
    expect(await getContactOptions(ORG, "+61295551234", "AU", CAN)).toEqual({ options: ["none"], note: "Their number is a landline, so it can't take a text." });
    expect(await getContactOptions(ORG, null, "AU", CAN)).toEqual({ options: ["none"], note: "There's no mobile number on this booking." });
    expect(await getContactOptions(ORG, "+61414141883", "AU", { smsEnabled: true, isOptedOut: async () => true })).toEqual({
      options: ["none"], note: "They've opted out of texts from you.",
    });
  });
  it("a textable mobile: text or leave it, no note", async () => {
    expect(await getContactOptions(ORG, "+61414141883", "AU", CAN)).toEqual({ options: ["text", "none"] });
  });
});

describe("contactCustomer", () => {
  it("none: nothing is sent", async () => {
    expect(await contactCustomer(req({ method: "none" }), CAN)).toEqual({ method: "none", status: "not_requested" });
    expect(sendCancellationSMS).not.toHaveBeenCalled();
    expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
  });

  it("call: not available in this version, nothing is sent", async () => {
    expect(await contactCustomer(req({ method: "call" }), CAN)).toEqual({ method: "call", status: "not_available", reason: "calls_unavailable" });
    expect(sendCancellationSMS).not.toHaveBeenCalled();
  });

  it("text to someone who can't take one: not sent with the reason, and no send attempted", async () => {
    expect(await contactCustomer(req(), { smsEnabled: false })).toEqual({ method: "text", status: "not_sent", reason: "texts_paused" });
    expect(await contactCustomer(req({ phone: "+61295551234" }), CAN)).toEqual({ method: "text", status: "not_sent", reason: "landline" });
    expect(sendCancellationSMS).not.toHaveBeenCalled();
  });

  it("a cancel texts the cancellation message for that booking, to the normalised number, in the org's zone, as owner-requested", async () => {
    vi.mocked(sendCancellationSMS).mockResolvedValue({ sent: true, status: "sent" } as any);
    expect(await contactCustomer(req({ phone: "0414 141 883" }), CAN)).toEqual({ method: "text", status: "sent" });
    // The owner asked for it: the cap for automated texts doesn't hold it back (the
    // booking's confirmation may have gone out minutes ago, about the old time).
    expect(sendCancellationSMS).toHaveBeenCalledWith(ORG, "+61414141883", START, "Australia/Sydney", APPT, { ownerRequested: true });
    expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
  });

  it("a move texts the new time for the NEW leg as a MOVE (never 'confirmed for', which reads as the old booking), owner-requested", async () => {
    vi.mocked(sendAppointmentConfirmationSMS).mockResolvedValue({ sent: true, status: "sent" } as any);
    expect(await contactCustomer(req({ kind: "moved" }), CAN)).toEqual({ method: "text", status: "sent" });
    expect(sendAppointmentConfirmationSMS).toHaveBeenCalledWith(ORG, "+61414141883", START, "Australia/Sydney", undefined, APPT, { ownerRequested: true, moved: true });
    expect(sendCancellationSMS).not.toHaveBeenCalled();
  });

  it("a refused send is not_sent with sendCallerSMS's own reason (or its status)", async () => {
    vi.mocked(sendCancellationSMS).mockResolvedValueOnce({ sent: false, status: "skipped", reason: "org_disabled" } as any);
    expect(await contactCustomer(req(), CAN)).toEqual({ method: "text", status: "not_sent", reason: "org_disabled" });
    vi.mocked(sendCancellationSMS).mockResolvedValueOnce({ sent: false, status: "failed" } as any);
    expect(await contactCustomer(req(), CAN)).toEqual({ method: "text", status: "not_sent", reason: "failed" });
  });

  it("a send that throws is reported, never thrown (the change already happened)", async () => {
    vi.mocked(sendCancellationSMS).mockRejectedValueOnce(new Error("twilio 500"));
    expect(await contactCustomer(req(), CAN)).toEqual({ method: "text", status: "not_sent", reason: "send_failed" });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("contactOutcomeSentence", () => {
  it("says exactly what happened — and never 'as you asked' (with nothing to choose, the owner wasn't asked)", () => {
    expect(contactOutcomeSentence({ method: "text", status: "sent" }, "Jane Smith")).toBe(" I've texted Jane Smith to let them know.");
    expect(contactOutcomeSentence({ method: "none", status: "not_requested" }, "Jane Smith")).toBe(" I haven't let Jane Smith know. I can read you their number if you want to tell them yourself.");
    expect(contactOutcomeSentence({ method: "call", status: "not_available", reason: "calls_unavailable" }, "Jane Smith")).toBe(" I can't call customers yet, so I haven't let Jane Smith know. I can read you their number if you want to tell them yourself.");
  });
  it("a text that didn't go out says why, and offers the number", () => {
    const s = contactOutcomeSentence({ method: "text", status: "not_sent", reason: "landline" }, "Jane Smith");
    expect(s).toBe(" I couldn't text Jane Smith: their number is a landline. I can read you their number if you want to tell them yourself.");
    expect(contactOutcomeSentence({ method: "text", status: "not_sent", reason: "texts_paused" }, "J")).toContain("texting customers isn't available yet");
    expect(contactOutcomeSentence({ method: "text", status: "not_sent", reason: "sms_globally_paused" }, "J")).toContain("texting customers isn't available yet");
    expect(contactOutcomeSentence({ method: "text", status: "not_sent", reason: "caller_opted_out" }, "J")).toContain("opted out");
    expect(contactOutcomeSentence({ method: "text", status: "not_sent", reason: "something_new" }, "J")).toContain("the text didn't go through");
  });
  it("a held-back text never reads as if the customer already knows about THIS change", () => {
    const s = contactOutcomeSentence({ method: "text", status: "not_sent", reason: "rate_limited" }, "J");
    expect(s).toContain("another text went to them moments ago, so this one was held back");
    expect(s).not.toMatch(/already texted about this/i);
  });
  it("never claims a text that wasn't sent", () => {
    const notSent = [
      { method: "text", status: "not_sent", reason: "x" },
      { method: "call", status: "not_available", reason: "calls_unavailable" },
      { method: "none", status: "not_requested" },
    ] as const;
    for (const r of notSent) expect(contactOutcomeSentence(r, "Jane")).not.toMatch(/I've texted/);
  });
});

describe("isCustomerNotified", () => {
  it("is true only for a text that went out", () => {
    expect(isCustomerNotified({ method: "text", status: "sent" })).toBe(true);
    expect(isCustomerNotified({ method: "text", status: "not_sent", reason: "landline" })).toBe(false);
    expect(isCustomerNotified({ method: "none", status: "not_requested" })).toBe(false);
    expect(isCustomerNotified({ method: "call", status: "not_available", reason: "calls_unavailable" })).toBe(false);
    expect(isCustomerNotified(undefined)).toBe(false);
  });
});
