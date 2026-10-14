import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-586: the owner_* authority gate, pinned at the edges owner-dispatch-pin.test.ts
// leaves open — the "is this a production call" test (an empty or non-string envelope
// callId), where the owner's callId comes from, what str() lets through from the model's
// untyped arguments, and tool-name variants.

vi.mock("@/lib/calendar/tool-handlers", () => ({
  handleGetCurrentDatetime: vi.fn(async () => ({ success: true, message: "dt" })),
  handleCheckAvailability: vi.fn(async () => ({ success: true, message: "avail" })),
  handleBookAppointment: vi.fn(async () => ({ success: true, message: "booked" })),
  handleCancelAppointment: vi.fn(async () => ({ success: true, message: "cancelled" })),
  handleUpdateAppointmentAttendee: vi.fn(async () => ({ success: true, message: "attendee" })),
  handleUpdateAppointmentDetails: vi.fn(async () => ({ success: true, message: "updated" })),
  handleRescheduleAppointment: vi.fn(async () => ({ success: true, message: "moved" })),
  handleLookupAppointment: vi.fn(async () => ({ success: true, message: "found" })),
  errorResult: (message: string) => ({ success: false, error: true, message }),
}));
vi.mock("@/lib/owner-assistant/tool-handlers", () => ({
  OWNER_TOOL_NAMES: ["owner_list_appointments", "owner_list_messages", "owner_reschedule_appointment", "owner_cancel_appointment"],
  handleOwnerListAppointments: vi.fn(async () => ({ success: true, message: "jobs" })),
  handleOwnerListMessages: vi.fn(async () => ({ success: true, message: "msgs" })),
  handleOwnerRescheduleAppointment: vi.fn(async () => ({ success: true, message: "moved" })),
  handleOwnerCancelAppointment: vi.fn(async () => ({ success: true, message: "cancelled" })),
}));
vi.mock("@/lib/callbacks/tool-handler", () => ({ handleScheduleCallback: vi.fn(async () => ({ success: true, message: "cb" })) }));
vi.mock("@/lib/service-types", () => ({ getActiveServiceTypes: vi.fn(async () => []) }));
vi.mock("@/lib/security/rate-limiter", () => ({ withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })) }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn(), withScope: vi.fn() }));

import { POST } from "../route";
import {
  handleOwnerListAppointments,
  handleOwnerListMessages,
  handleOwnerRescheduleAppointment,
  handleOwnerCancelAppointment,
} from "@/lib/owner-assistant/tool-handlers";

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL_ID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const SMUGGLED = "99999999-0000-4000-8000-000000000000";
const APPT = "44444444-5555-4666-8777-888888888888";
const SECRET = "owner-dispatch-envelope-secret";
const ownerHandlers = () => [handleOwnerListAppointments, handleOwnerListMessages, handleOwnerRescheduleAppointment, handleOwnerCancelAppointment];

function post(payload: Record<string, unknown>) {
  return POST(new Request("http://voice.internal/api/internal/tool-call", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Internal-Secret": SECRET },
    body: JSON.stringify(payload),
  }));
}
const base = { organizationId: ORG, assistantId: "asst-1", callerIdState: "verified", callerPhone: "+61412345678" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_SECRET = SECRET;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("owner_* needs a PRODUCTION call: a non-empty string envelope callId", () => {
  it.each([
    ["an empty string", ""],
    ["null", null],
    ["a number", 123],
    ["true", true],
    ["an object", { id: CALL_ID }],
    ["an array", [CALL_ID]],
  ])("refuses ownerVerified:true when callId is %s", async (_label, callId) => {
    const res = await post({ ...base, callId, ownerVerified: true, functionName: "owner_cancel_appointment", arguments: { appointment_id: APPT, confirmed: true } });
    expect(res.status).toBe(403);
    for (const handler of ownerHandlers()) expect(handler).not.toHaveBeenCalled();
  });

  it("refuses every one of the four tools without owner authority (not just the ones the other pins happen to name)", async () => {
    for (const functionName of ["owner_list_appointments", "owner_list_messages", "owner_reschedule_appointment", "owner_cancel_appointment"]) {
      const res = await post({ ...base, callId: CALL_ID, functionName, arguments: {} });
      expect(res.status, functionName).toBe(403);
    }
    for (const handler of ownerHandlers()) expect(handler).not.toHaveBeenCalled();
  });
});

describe("the owner's callId is the envelope's, never the model's", () => {
  it("a callId smuggled through `arguments` does not replace the envelope callId", async () => {
    await post({ ...base, callId: CALL_ID, ownerVerified: true, functionName: "owner_cancel_appointment", arguments: { appointment_id: APPT, confirmed: true, callId: SMUGGLED, call_id: SMUGGLED } });
    await post({ ...base, callId: CALL_ID, ownerVerified: true, functionName: "owner_reschedule_appointment", arguments: { appointment_id: APPT, new_datetime: "2026-10-20T09:00", confirmed: true, callId: SMUGGLED, call_id: SMUGGLED } });
    expect(vi.mocked(handleOwnerCancelAppointment).mock.calls[0][2]).toEqual({ callId: CALL_ID });
    expect(vi.mocked(handleOwnerRescheduleAppointment).mock.calls[0][2]).toEqual({ callId: CALL_ID });
  });

  it("owner_list_messages gets the envelope callId too (to leave the owner's own call out), never a smuggled one", async () => {
    await post({ ...base, callId: CALL_ID, ownerVerified: true, functionName: "owner_list_messages", arguments: { callId: SMUGGLED, call_id: SMUGGLED } });
    expect(handleOwnerListMessages).toHaveBeenCalledWith(ORG, { callId: CALL_ID });
  });

  it("a callId in `arguments` is not a production call by itself", async () => {
    const res = await post({ ...base, ownerVerified: true, functionName: "owner_cancel_appointment", arguments: { appointment_id: APPT, confirmed: true, callId: SMUGGLED } });
    expect(res.status).toBe(403);
    expect(handleOwnerCancelAppointment).not.toHaveBeenCalled();
  });
});

describe("the model's untyped arguments are plucked as strings only", () => {
  const auth = { ...base, callId: CALL_ID, ownerVerified: true };

  it("owner_cancel_appointment: a non-string appointment_id or reason arrives as undefined", async () => {
    await post({ ...auth, functionName: "owner_cancel_appointment", arguments: { appointment_id: [APPT], confirmed: true, reason: { text: "x" } } });
    await post({ ...auth, functionName: "owner_cancel_appointment", arguments: { appointment_id: 42, confirmed: true, reason: 123 } });
    expect(vi.mocked(handleOwnerCancelAppointment).mock.calls.map((c) => c[1])).toEqual([
      { appointment_id: undefined, confirmed: true, reason: undefined },
      { appointment_id: undefined, confirmed: true, reason: undefined },
    ]);
  });

  it("owner_reschedule_appointment: a non-string appointment_id or new_datetime arrives as undefined", async () => {
    await post({ ...auth, functionName: "owner_reschedule_appointment", arguments: { appointment_id: { id: APPT }, new_datetime: ["2026-10-20T09:00"], confirmed: true } });
    await post({ ...auth, functionName: "owner_reschedule_appointment", arguments: { appointment_id: APPT, new_datetime: 20261020, confirmed: true } });
    expect(vi.mocked(handleOwnerRescheduleAppointment).mock.calls.map((c) => c[1])).toEqual([
      { appointment_id: undefined, new_datetime: undefined, confirmed: true },
      { appointment_id: APPT, new_datetime: undefined, confirmed: true },
    ]);
  });

  it("owner_list_appointments: a non-string range or date arrives as undefined", async () => {
    await post({ ...auth, functionName: "owner_list_appointments", arguments: { range: ["today"], date: 20261102 } });
    expect(handleOwnerListAppointments).toHaveBeenCalledWith(ORG, { range: undefined, date: undefined });
  });

  it.each([["null", null], ["a string", "owner_cancel_appointment"], ["an array", ["x"]], ["a number", 7]])("`arguments` being %s is read as no arguments (confirmed:false), not a crash", async (_label, args) => {
    const res = await post({ ...auth, functionName: "owner_cancel_appointment", arguments: args });
    expect(res.status).toBe(200);
    expect(handleOwnerCancelAppointment).toHaveBeenCalledWith(ORG, { appointment_id: undefined, confirmed: false, reason: undefined }, { callId: CALL_ID });
  });
});

describe("tool-name variants are not owner tools", () => {
  it.each([
    ["different case", "Owner_Cancel_Appointment"],
    ["upper case", "OWNER_LIST_MESSAGES"],
    ["leading space", " owner_list_appointments"],
    ["trailing space", "owner_list_appointments "],
    ["trailing newline", "owner_cancel_appointment\n"],
    ["hyphens", "owner-cancel-appointment"],
    ["an unlisted owner_ name", "owner_delete_everything"],
  ])("%s: an unknown function, no owner handler runs — even with full owner authority", async (_label, functionName) => {
    const res = await post({ ...base, callId: CALL_ID, ownerVerified: true, functionName, arguments: { appointment_id: APPT, confirmed: true } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown function/);
    for (const handler of ownerHandlers()) expect(handler).not.toHaveBeenCalled();
  });
});
