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
const OWNER_CALL = "99999999-8888-4777-8666-555555555555";
const req = (over: Partial<ContactRequest> = {}): ContactRequest => ({
  orgId: ORG, method: "text", kind: "cancelled", appointmentId: APPT, startTime: START,
  phone: "+61414141883", country: "AU", timezone: "Australia/Sydney", requestedByCallId: OWNER_CALL, ...over,
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

  // SCRUM-598: a call is offered only when the voice server says one can be placed now.
  const CALL = { appointmentId: APPT, purpose: "cancelled" as const, requestedByCallId: OWNER_CALL };
  it("asks the voice server about a call for THIS booking, purpose and owner session", async () => {
    const checkCall = vi.fn(async () => ({ canCall: true as const }));
    expect(await getContactOptions(ORG, "+61414141883", "AU", { ...CAN, checkCall }, CALL)).toEqual({ options: ["text", "call", "none"] });
    expect(checkCall).toHaveBeenCalledWith({ organizationId: ORG, appointmentId: APPT, purpose: "cancelled", phone: "+61414141883", requestedByCallId: OWNER_CALL });
  });
  it("a landline can't be texted but can be called", async () => {
    const checkCall = vi.fn(async () => ({ canCall: true as const }));
    expect(await getContactOptions(ORG, "+61295551234", "AU", { ...CAN, checkCall }, CALL)).toEqual({
      options: ["call", "none"], note: "Their number is a landline, so it can't take a text.",
    });
  });
  it("a call that can't be placed says why — unless calls aren't switched on at all", async () => {
    const blocked = (reason: string) => vi.fn(async () => ({ canCall: false as const, reason: reason as any }));
    expect(await getContactOptions(ORG, "+61414141883", "AU", { ...CAN, checkCall: blocked("outside_hours") }, CALL)).toEqual({
      options: ["text", "none"], note: "I can't call them now: it's outside calling hours (8 am to 8 pm), and I can't schedule calls for later yet — ask me again after 8 am.",
    });
    expect(await getContactOptions(ORG, "+61414141883", "AU", { ...CAN, checkCall: blocked("calls_disabled") }, CALL)).toEqual({ options: ["text", "none"] });
    expect(await getContactOptions(ORG, "+61414141883", "AU", { smsEnabled: false, checkCall: blocked("do_not_call") }, CALL)).toEqual({
      options: ["none"], note: "Texting customers isn't available yet. I can't call them: they've asked not to be called.",
    });
  });
  it("without a call context it never asks about a call", async () => {
    const checkCall = vi.fn(async () => ({ canCall: true as const }));
    expect(await getContactOptions(ORG, "+61414141883", "AU", { ...CAN, checkCall })).toEqual({ options: ["text", "none"] });
    expect(checkCall).not.toHaveBeenCalled();
  });
});

describe("contactCustomer", () => {
  it("none: nothing is sent", async () => {
    expect(await contactCustomer(req({ method: "none" }), CAN)).toEqual({ method: "none", status: "not_requested" });
    expect(sendCancellationSMS).not.toHaveBeenCalled();
    expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
  });

  it("call: asks the voice server to place it, about the booking the change left, for the owner session", async () => {
    const placeCall = vi.fn(async () => ({ placed: true as const, callId: "call-9" }));
    expect(await contactCustomer(req({ method: "call" }), { ...CAN, placeCall })).toEqual({ method: "call", status: "calling", callId: "call-9" });
    expect(placeCall).toHaveBeenCalledWith({ organizationId: ORG, appointmentId: APPT, purpose: "cancelled", phone: "+61414141883", requestedByCallId: OWNER_CALL });
    expect(await contactCustomer(req({ method: "call", kind: "moved" }), { ...CAN, placeCall })).toEqual({ method: "call", status: "calling", callId: "call-9" });
    expect(placeCall).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: "moved" }));
    expect(sendCancellationSMS).not.toHaveBeenCalled();
    expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
  });

  it("call: a call that isn't placed is reported with its reason; a throw is 'not sure it went out'", async () => {
    expect(await contactCustomer(req({ method: "call" }), { ...CAN, placeCall: async () => ({ placed: false as const, reason: "number_cap" as const }) })).toEqual({
      method: "call", status: "not_placed", reason: "number_cap",
    });
    expect(await contactCustomer(req({ method: "call" }), { ...CAN, placeCall: async () => { throw new Error("boom"); } })).toEqual({
      method: "call", status: "not_placed", reason: "place_unconfirmed",
    });
    expect(console.error).toHaveBeenCalled();
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
    expect(contactOutcomeSentence({ method: "text", status: "sent" }, "Jane Smith", "cancelled")).toBe(" I've texted Jane Smith to let them know.");
    expect(contactOutcomeSentence({ method: "none", status: "not_requested" }, "Jane Smith", "cancelled")).toBe(" I haven't let Jane Smith know. I can read you their number if you want to tell them yourself.");
    expect(contactOutcomeSentence({ method: "call", status: "not_placed", reason: "calls_disabled" }, "Jane Smith", "cancelled")).toBe(" I can't call customers yet, so I haven't let Jane Smith know. I can read you their number if you want to tell them yourself.");
  });
  it("SCRUM-598: a placed call says the owner gets an email; one not placed says why; an unsure one says so", () => {
    // Clients lens M8: the owner hears what the call will do.
    expect(contactOutcomeSentence({ method: "call", status: "calling", callId: "c" }, "Jane Smith", "cancelled")).toBe(" I'm calling Jane Smith now to let them know, and to offer them another time. You'll get an email when the call's done.");
    expect(contactOutcomeSentence({ method: "call", status: "calling", callId: "c" }, "Jane Smith", "moved")).toBe(" I'm calling Jane Smith now to tell them the new time and check it suits. You'll get an email when the call's done.");
    expect(contactOutcomeSentence({ method: "call", status: "not_placed", reason: "outside_hours" }, "Jane Smith", "cancelled")).toBe(" I couldn't call Jane Smith: it's outside calling hours (8 am to 8 pm), and I can't schedule calls for later yet — ask me again after 8 am. I can read you their number if you want to tell them yourself.");
    const unsure = contactOutcomeSentence({ method: "call", status: "not_placed", reason: "place_unconfirmed" }, "Jane Smith", "cancelled");
    expect(unsure).toBe(" I'm not sure the call to Jane Smith went out — check Calls in the dashboard before you ring them yourself.");
    // A call that may be ringing is never reported as not placed.
    expect(unsure).not.toMatch(/couldn't call|haven't let/);
  });
  it("a text that didn't go out says why, and offers the number", () => {
    const s = contactOutcomeSentence({ method: "text", status: "not_sent", reason: "landline" }, "Jane Smith", "cancelled");
    expect(s).toBe(" I couldn't text Jane Smith: their number is a landline. I can read you their number if you want to tell them yourself.");
    expect(contactOutcomeSentence({ method: "text", status: "not_sent", reason: "texts_paused" }, "J", "cancelled")).toContain("texting customers isn't available yet");
    expect(contactOutcomeSentence({ method: "text", status: "not_sent", reason: "sms_globally_paused" }, "J", "cancelled")).toContain("texting customers isn't available yet");
    expect(contactOutcomeSentence({ method: "text", status: "not_sent", reason: "caller_opted_out" }, "J", "cancelled")).toContain("opted out");
    expect(contactOutcomeSentence({ method: "text", status: "not_sent", reason: "something_new" }, "J", "cancelled")).toContain("the text didn't go through");
  });
  it("a cap that couldn't be checked says so — never that a text went out moments ago", () => {
    const s = contactOutcomeSentence({ method: "text", status: "not_sent", reason: "cap_check_failed" }, "J", "cancelled");
    expect(s).toContain("I couldn't check their recent texts, so I held it back");
    expect(s).not.toMatch(/moments ago/);
  });

  it("a held-back text never reads as if the customer already knows about THIS change", () => {
    const s = contactOutcomeSentence({ method: "text", status: "not_sent", reason: "rate_limited" }, "J", "cancelled");
    expect(s).toContain("they've already had several texts from you this hour, so this one was held back");
    expect(s).not.toMatch(/already texted about this/i);
  });
  it("never claims a text that wasn't sent", () => {
    const notSent = [
      { method: "text", status: "not_sent", reason: "x" },
      { method: "call", status: "not_placed", reason: "calls_disabled" },
      { method: "call", status: "calling", callId: "c" },
      { method: "none", status: "not_requested" },
    ] as const;
    for (const r of notSent) expect(contactOutcomeSentence(r, "Jane", "cancelled")).not.toMatch(/I've texted/);
  });
});

describe("isCustomerNotified", () => {
  it("is true for a text that went out or a call placed (the spec's customer_notified), nothing else", () => {
    expect(isCustomerNotified({ method: "text", status: "sent" })).toBe(true);
    expect(isCustomerNotified({ method: "call", status: "calling", callId: "c" })).toBe(true);
    expect(isCustomerNotified({ method: "text", status: "not_sent", reason: "landline" })).toBe(false);
    expect(isCustomerNotified({ method: "none", status: "not_requested" })).toBe(false);
    expect(isCustomerNotified({ method: "call", status: "not_placed", reason: "outside_hours" })).toBe(false);
    expect(isCustomerNotified(undefined)).toBe(false);
  });
});
