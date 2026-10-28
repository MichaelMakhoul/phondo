// src/app/api/internal/tool-call/__tests__/owner-dispatch-pin.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SCRUM-586: the owner tools' authority is the request ENVELOPE's
// `ownerVerified: true` (set by the voice server only after the PIN gate) AND a
// production call (envelope callId). Model `arguments` can never grant it. These
// pins are the acceptance bar: see the mutation check in the plan (Task 5 Step 6).

vi.mock("@/lib/calendar/tool-handlers", () => ({
  handleGetCurrentDatetime: vi.fn(async () => ({ success: true, message: "dt" })),
  handleCheckAvailability: vi.fn(async () => ({ success: true, message: "avail" })),
  handleBookAppointment: vi.fn(async () => ({ success: true, message: "booked" })),
  handleCancelAppointment: vi.fn(async () => ({ success: true, message: "cancelled" })),
  handleUpdateAppointmentAttendee: vi.fn(async () => ({ success: true, message: "attendee" })),
  handleUpdateAppointmentDetails: vi.fn(async () => ({ success: true, message: "updated" })),
  handleRescheduleAppointment: vi.fn(async () => ({ success: true, message: "moved" })),
  handleLookupAppointment: vi.fn(async () => ({ success: true, message: "found" })),
  // The SCRUM-509 helper, same shape as the real one: the owner dispatch builds its fault reply with it.
  errorResult: (message: string) => ({ success: false, error: true, message }),
}));
vi.mock("@/lib/owner-assistant/tool-handlers", async () => ({
  // The REAL list (test lens): a hard-coded copy hid owner_call_customer from these tests.
  OWNER_TOOL_NAMES: (await import("@/lib/owner-assistant/tool-names")).OWNER_TOOL_NAMES,
  handleOwnerListAppointments: vi.fn(async () => ({ success: true, message: "jobs", data: { count: 1 } })),
  handleOwnerListMessages: vi.fn(async () => ({ success: true, message: "msgs", data: { callbacks: [], calls: [] } })),
  handleOwnerRescheduleAppointment: vi.fn(async () => ({ success: true, message: "moved", data: { outcome: "rescheduled", customer_notified: false } })),
  handleOwnerCancelAppointment: vi.fn(async () => ({ success: false, error: true, message: "trouble" })),
  handleOwnerCallCustomer: vi.fn(async () => ({ success: true, message: "calling", data: { outcome: "calling" } })),
  handleOwnerBookAppointment: vi.fn(async () => ({ success: true, message: "booked", data: { outcome: "booked" } })),
  handleOwnerBlockTime: vi.fn(async () => ({ success: true, message: "blocked", data: { outcome: "blocked" } })),
  handleOwnerMarkCallbackDone: vi.fn(async () => ({ success: true, message: "done", data: { outcome: "callback_done" } })),
}));
vi.mock("@/lib/callbacks/tool-handler", () => ({ handleScheduleCallback: vi.fn(async () => ({ success: true, message: "cb" })) }));
vi.mock("@/lib/service-types", () => ({ getActiveServiceTypes: vi.fn(async () => []) }));
vi.mock("@/lib/security/rate-limiter", () => ({ withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })) }));
// withScope is a no-op: pageSentry's Sentry leg stays silent, its [ALERT:*] console line is what the pins read.
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn(), withScope: vi.fn() }));

import * as Sentry from "@sentry/nextjs";
import { POST } from "../route";
import {
  handleOwnerListAppointments,
  handleOwnerListMessages,
  handleOwnerRescheduleAppointment,
  handleOwnerCancelAppointment,
  handleOwnerCallCustomer,
  handleOwnerBookAppointment,
  handleOwnerBlockTime,
  handleOwnerMarkCallbackDone,
} from "@/lib/owner-assistant/tool-handlers";
import { handleCancelAppointment } from "@/lib/calendar/tool-handlers";

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL_ID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const APPT = "44444444-5555-4666-8777-888888888888";
const SECRET = "owner-dispatch-pin-secret";
/** A model-argument value that must never reach a log line. */
const ARG_CANARY = "arg-canary-5b1e";

function post(payload: Record<string, unknown>) {
  return POST(new Request("http://voice.internal/api/internal/tool-call", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Internal-Secret": SECRET },
    body: JSON.stringify(payload),
  }));
}
const base = { organizationId: ORG, assistantId: "asst-1", callId: CALL_ID, callerIdState: "verified", callerPhone: "+61412345678" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_SECRET = SECRET;
});

describe("owner_* authority (SCRUM-586)", () => {
  it("dispatches with envelope ownerVerified:true on a production call, threading {callId}", async () => {
    const res = await post({ ...base, ownerVerified: true, functionName: "owner_reschedule_appointment", arguments: { appointment_id: APPT, new_datetime: "2026-10-20T09:00", confirmed: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: "moved", data: { outcome: "rescheduled", customer_notified: false } });
    expect(handleOwnerRescheduleAppointment).toHaveBeenCalledWith(ORG, { appointment_id: APPT, new_datetime: "2026-10-20T09:00", confirmed: true }, { callId: CALL_ID });
  });

  it("refuses with 403 + error:true when ownerVerified is absent", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post({ ...base, functionName: "owner_list_appointments", arguments: { range: "today", date: ARG_CANARY } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ success: false, error: true, message: "That isn't available on this call." });
      expect(handleOwnerListAppointments).not.toHaveBeenCalled();
      // A refusal is a security signal, so the route pages it itself: one [ALERT:error]
      // line (Sentry is off in production, SCRUM-320) naming the reason and the tool,
      // never the model's arguments.
      const alerts = errors.mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith("[ALERT:error]"));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain("reason=owner-tool-refused");
      expect(alerts[0]).toContain("functionName=owner_list_appointments");
      expect(alerts[0]).toContain("isProductionCall=true");
      expect(alerts[0]).toContain("ownerVerified=false");
      expect(alerts[0]).not.toContain(ARG_CANARY);
      expect(alerts[0]).not.toContain("arguments");
      // Nothing else logged on the refusal carries the arguments either.
      const logged = errors.mock.calls.map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      expect(logged.filter((line) => line.includes(ARG_CANARY))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("refuses when ownerVerified is anything but the boolean true", async () => {
    for (const v of ["true", 1, "yes", {}]) {
      const res = await post({ ...base, ownerVerified: v, functionName: "owner_list_messages", arguments: {} });
      expect(res.status).toBe(403);
    }
    expect(handleOwnerListMessages).not.toHaveBeenCalled();
  });

  it("refuses a browser/test session (no envelope callId) even with ownerVerified:true", async () => {
    const res = await post({ organizationId: ORG, assistantId: "asst-1", ownerVerified: true, functionName: "owner_list_messages", arguments: {} });
    expect(res.status).toBe(403);
    expect(handleOwnerListMessages).not.toHaveBeenCalled();
  });

  it("an ownerVerified smuggled through model `arguments` grants nothing", async () => {
    const res = await post({ ...base, functionName: "owner_cancel_appointment", arguments: { appointment_id: APPT, confirmed: true, ownerVerified: true } });
    expect(res.status).toBe(403);
    expect(handleOwnerCancelAppointment).not.toHaveBeenCalled();
  });

  it("plucks `confirmed` as a strict boolean (the string \"true\" arrives as false) and `reason` as a string", async () => {
    await post({ ...base, ownerVerified: true, functionName: "owner_cancel_appointment", arguments: { appointment_id: APPT, confirmed: "true", reason: "no longer needed" } });
    expect(handleOwnerCancelAppointment).toHaveBeenCalledWith(ORG, { appointment_id: APPT, confirmed: false, reason: "no longer needed" }, { callId: CALL_ID });
  });

  it("both write tools take only the boolean true as `confirmed` (\"true\" and 1 arrive as false)", async () => {
    // Step 6 found Boolean(raw.confirmed) on the reschedule branch alone survived the
    // cancel-only pin above; 1 also covers a loose `== true`.
    for (const confirmed of ["true", 1]) {
      await post({ ...base, ownerVerified: true, functionName: "owner_reschedule_appointment", arguments: { appointment_id: APPT, new_datetime: "2026-10-20T09:00", confirmed } });
      await post({ ...base, ownerVerified: true, functionName: "owner_cancel_appointment", arguments: { appointment_id: APPT, confirmed } });
    }
    expect(vi.mocked(handleOwnerRescheduleAppointment).mock.calls.map((c) => c[1].confirmed)).toEqual([false, false]);
    expect(vi.mocked(handleOwnerCancelAppointment).mock.calls.map((c) => c[1].confirmed)).toEqual([false, false]);
  });

  it("forwards a handler's error:true flag (SCRUM-509) and 200", async () => {
    const res = await post({ ...base, ownerVerified: true, functionName: "owner_cancel_appointment", arguments: { appointment_id: APPT, confirmed: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: false, error: true, message: "trouble" });
  });

  it("plucks list arguments exactly", async () => {
    await post({ ...base, ownerVerified: true, functionName: "owner_list_appointments", arguments: { range: "date", date: "2026-10-20", extra: "ignored" } });
    expect(handleOwnerListAppointments).toHaveBeenCalledWith(ORG, { range: "date", date: "2026-10-20" });
    await post({ ...base, ownerVerified: true, functionName: "owner_list_messages", arguments: {} });
    // The envelope callId, so the handler can leave the owner's own live call out of "today's calls".
    expect(handleOwnerListMessages).toHaveBeenCalledWith(ORG, { callId: CALL_ID });
  });

  it("ownerVerified changes nothing for customer tools", async () => {
    const res = await post({ ...base, ownerVerified: true, functionName: "cancel_appointment", arguments: { phone: "+61412345678" } });
    expect(res.status).toBe(200);
    expect(handleCancelAppointment).toHaveBeenCalledTimes(1);
  });

  it("a customer tool never sees ownerVerified: its handler gets the same arguments with or without it", async () => {
    const args = { phone: "+61412345678", confirmation_code: "111111" };
    const without = await post({ ...base, functionName: "cancel_appointment", arguments: args });
    const withFlag = await post({ ...base, ownerVerified: true, functionName: "cancel_appointment", arguments: args });
    expect(withFlag.status).toBe(without.status);
    expect(await withFlag.json()).toEqual(await without.json());
    const calls = vi.mocked(handleCancelAppointment).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toStrictEqual(calls[0]);
  });
});

describe("owner handler faults (SCRUM-586 controller override)", () => {
  const OWNER_FAULT = "Something went wrong on our side — please try again or check the dashboard.";
  const cases = [
    { name: "owner_list_appointments", handler: handleOwnerListAppointments, args: { range: "today" } },
    { name: "owner_list_messages", handler: handleOwnerListMessages, args: {} },
    { name: "owner_reschedule_appointment", handler: handleOwnerRescheduleAppointment, args: { appointment_id: APPT, new_datetime: "2026-10-20T09:00", confirmed: true } },
    { name: "owner_cancel_appointment", handler: handleOwnerCancelAppointment, args: { appointment_id: APPT, confirmed: true } },
  ] as const;

  it.each(cases)("$name: a throw becomes the owner-worded errorResult (200 + error:true), never the customer catch-all", async ({ name, handler, args }) => {
    // e.g. an invalid IANA zone stored on the org makes Intl throw inside the handler.
    const boom = new RangeError("Invalid time zone specified: Mars/Olympus_Mons");
    vi.mocked(handler).mockRejectedValueOnce(boom);
    const res = await post({ ...base, ownerVerified: true, functionName: name, arguments: args });
    // 200, not 5xx: the voice server swaps ANY non-2xx body for its customer-worded
    // fallback; error:true still raises its [ALERT:error] (SCRUM-509).
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: false, error: true, message: OWNER_FAULT });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, expect.anything());
  });
});

// SCRUM-597 (test lens G1): a dropped notify_customer at dispatch would leave every
// owner change asking "let them know?" forever — toHaveBeenCalledWith treats a
// missing key as undefined, so the plucking is pinned on the exact value.
describe("SCRUM-597: notify_customer reaches both owner write handlers", () => {
  it("is plucked as a string on reschedule and cancel; a non-string arrives as undefined", async () => {
    await post({ ...base, ownerVerified: true, functionName: "owner_reschedule_appointment", arguments: { appointment_id: APPT, new_datetime: "2026-10-20T09:00", confirmed: true, notify_customer: "text" } });
    await post({ ...base, ownerVerified: true, functionName: "owner_cancel_appointment", arguments: { appointment_id: APPT, confirmed: true, notify_customer: "none" } });
    await post({ ...base, ownerVerified: true, functionName: "owner_cancel_appointment", arguments: { appointment_id: APPT, confirmed: true, notify_customer: ["text"] } });
    expect(vi.mocked(handleOwnerRescheduleAppointment).mock.calls[0][1].notify_customer).toBe("text");
    expect(vi.mocked(handleOwnerCancelAppointment).mock.calls.map((c) => c[1].notify_customer)).toEqual(["none", undefined]);
  });
});

describe("SCRUM-598 (test lens): owner_call_customer reaches its handler with what the route plucks", () => {
  it("appointment_id, purpose and the window as strings, and a strict boolean confirmed", async () => {
    await post({ ...base, ownerVerified: true, functionName: "owner_call_customer", arguments: { appointment_id: APPT, purpose: "find_new_time", earliest_date: "2026-11-02", latest_date: "2026-11-06", time_of_day: "morning", confirmed: true } });
    await post({ ...base, ownerVerified: true, functionName: "owner_call_customer", arguments: { appointment_id: APPT, purpose: "confirm", confirmed: "true" } });
    const calls = vi.mocked(handleOwnerCallCustomer).mock.calls;
    expect(calls[0][1]).toEqual({ appointment_id: APPT, purpose: "find_new_time", earliest_date: "2026-11-02", latest_date: "2026-11-06", time_of_day: "morning", confirmed: true });
    expect(calls[0][2]).toEqual({ callId: CALL_ID });
    expect(calls[1][1].confirmed).toBe(false);
  });
});

describe("SCRUM-599: the book, block and mark-done tools reach their handlers with what the route plucks", () => {
  it("every argument the voice server declares, as given, with the envelope's callId — and the result passed back as is", async () => {
    const book = await post({
      ...base, ownerVerified: true, functionName: "owner_book_appointment",
      // SCRUM-602: the email and the business's other details ride along too (security lens: the route dropped them).
      arguments: { customer_name: "Jane Smith", customer_phone: "0412 345 678", start: "2026-10-29T14:00", service_type_id: APPT, notes: "Leaking tap", customer_email: "jane@example.com", details: "service address=12 Smith St; urgency level=today", confirmed: true, notify_customer: "text" },
    });
    expect(await book.json()).toEqual({ success: true, message: "booked", data: { outcome: "booked" } });
    expect(handleOwnerBookAppointment).toHaveBeenCalledWith(
      ORG,
      { customer_name: "Jane Smith", customer_phone: "0412 345 678", start: "2026-10-29T14:00", service_type_id: APPT, notes: "Leaking tap", customer_email: "jane@example.com", details: "service address=12 Smith St; urgency level=today", confirmed: true, notify_customer: "text" },
      { callId: CALL_ID }
    );
    // A non-string optional field reaches the handler as undefined — absent — which is exactly how the
    // voice gate keys it (SCRUM-602); the two must not drift.
    vi.mocked(handleOwnerBookAppointment).mockClear();
    await post({ ...base, ownerVerified: true, functionName: "owner_book_appointment", arguments: { customer_name: "Jane", customer_phone: "0412 345 678", start: "2026-10-29T14:00", details: ["service address=99 Other Rd"], customer_email: 5, notes: { text: "x" }, service_type_id: 7 } });
    const got = vi.mocked(handleOwnerBookAppointment).mock.calls[0][1];
    expect([got.details, got.customer_email, got.notes, got.service_type_id]).toEqual([undefined, undefined, undefined, undefined]);
    vi.mocked(handleOwnerBookAppointment).mockClear();
    await post({
      ...base, ownerVerified: true, functionName: "owner_book_appointment",
      arguments: { customer_name: "Jane Smith", customer_phone: "0412 345 678", start: "2026-10-29T14:00", service_type_id: APPT, notes: "Leaking tap", customer_email: "jane@example.com", details: "service address=12 Smith St; urgency level=today", confirmed: true, notify_customer: "text" },
    });
    // Every key the voice server declares for the booking reaches the handler — a new parameter
    // added to the tool without a line here would be dropped on the way, silently.
    const voiceTools = createRequire(import.meta.url)(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../../voice-server/lib/owner-tools.js"));
    const declared = Object.keys(voiceTools.ownerToolDefinitions.find((t: { function: { name: string } }) => t.function.name === "owner_book_appointment").function.parameters.properties).sort();
    expect(Object.keys(vi.mocked(handleOwnerBookAppointment).mock.calls[0][1]).sort()).toEqual(declared);
    await post({ ...base, ownerVerified: true, functionName: "owner_block_time", arguments: { start: "2026-10-30T13:00", end: "2026-10-30T17:00", reason: "Quote visit", confirmed: true } });
    expect(handleOwnerBlockTime).toHaveBeenCalledWith(ORG, { start: "2026-10-30T13:00", end: "2026-10-30T17:00", reason: "Quote visit", confirmed: true }, { callId: CALL_ID });
    await post({ ...base, ownerVerified: true, functionName: "owner_mark_callback_done", arguments: { callback_id: APPT, note: "Rang back", confirmed: true } });
    expect(handleOwnerMarkCallbackDone).toHaveBeenCalledWith(ORG, { callback_id: APPT, note: "Rang back", confirmed: true }, { callId: CALL_ID });
  });

  it("a handler that throws is the owner's fault line at 200 + error:true (never the customer fallback)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(handleOwnerBlockTime).mockRejectedValueOnce(new Error("boom"));
      const res = await post({ ...base, ownerVerified: true, functionName: "owner_block_time", arguments: { start: "2026-10-30T13:00", end: "2026-10-30T17:00", confirmed: true } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBe(true);
      expect(body.success).toBe(false);
      expect(body.message).not.toMatch(/take your information/i);
    } finally {
      errors.mockRestore();
    }
  });
});
