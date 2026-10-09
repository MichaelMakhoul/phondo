// src/app/api/internal/tool-call/__tests__/owner-dispatch-pin.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/owner-assistant/tool-handlers", () => ({
  OWNER_TOOL_NAMES: ["owner_list_appointments", "owner_list_messages", "owner_reschedule_appointment", "owner_cancel_appointment"],
  handleOwnerListAppointments: vi.fn(async () => ({ success: true, message: "jobs", data: { count: 1 } })),
  handleOwnerListMessages: vi.fn(async () => ({ success: true, message: "msgs", data: { callbacks: [], calls: [] } })),
  handleOwnerRescheduleAppointment: vi.fn(async () => ({ success: true, message: "moved", data: { outcome: "rescheduled", customer_notified: false } })),
  handleOwnerCancelAppointment: vi.fn(async () => ({ success: false, error: true, message: "trouble" })),
}));
vi.mock("@/lib/callbacks/tool-handler", () => ({ handleScheduleCallback: vi.fn(async () => ({ success: true, message: "cb" })) }));
vi.mock("@/lib/service-types", () => ({ getActiveServiceTypes: vi.fn(async () => []) }));
vi.mock("@/lib/security/rate-limiter", () => ({ withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })) }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import * as Sentry from "@sentry/nextjs";
import { POST } from "../route";
import {
  handleOwnerListAppointments,
  handleOwnerListMessages,
  handleOwnerRescheduleAppointment,
  handleOwnerCancelAppointment,
} from "@/lib/owner-assistant/tool-handlers";
import { handleCancelAppointment } from "@/lib/calendar/tool-handlers";

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL_ID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const APPT = "44444444-5555-4666-8777-888888888888";
const SECRET = "owner-dispatch-pin-secret";

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
    const res = await post({ ...base, functionName: "owner_list_appointments", arguments: { range: "today" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: true, message: "That isn't available on this call." });
    expect(handleOwnerListAppointments).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith("owner tool called without owner authority", expect.objectContaining({ level: "error" }));
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
    expect(handleOwnerListMessages).toHaveBeenCalledWith(ORG);
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
