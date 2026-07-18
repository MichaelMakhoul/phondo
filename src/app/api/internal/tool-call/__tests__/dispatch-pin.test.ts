import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-560 (part 2): dispatch pins for the internal tool-call route.
//
// The route plucks fields out of `arguments` case-by-case and threads the
// TRUSTED envelope (callId / caller-ID fields) as separate handler params.
// No route case had a dispatch test, so a dropped field was silent — for
// update_appointment a lost `email`/`notes` simply never reaches the handler
// and a combined correction quietly half-applies. These tests mock the
// handlers and pin the exact pluck + anchor shape for update_appointment,
// plus the SCRUM-560 call-authority threading into cancel/reschedule.

vi.mock("@/lib/calendar/tool-handlers", () => ({
  handleGetCurrentDatetime: vi.fn(async () => ({ success: true, message: "dt" })),
  handleCheckAvailability: vi.fn(async () => ({ success: true, message: "avail" })),
  handleBookAppointment: vi.fn(async () => ({ success: true, message: "booked" })),
  handleCancelAppointment: vi.fn(async () => ({ success: true, message: "cancelled" })),
  handleUpdateAppointmentAttendee: vi.fn(async () => ({ success: true, message: "attendee" })),
  handleUpdateAppointmentDetails: vi.fn(async () => ({ success: true, message: "updated" })),
  handleRescheduleAppointment: vi.fn(async () => ({ success: true, message: "moved" })),
  handleLookupAppointment: vi.fn(async () => ({ success: true, message: "found" })),
}));
vi.mock("@/lib/callbacks/tool-handler", () => ({
  handleScheduleCallback: vi.fn(async () => ({ success: true, message: "callback" })),
}));
vi.mock("@/lib/service-types", () => ({
  getActiveServiceTypes: vi.fn(async () => []),
}));
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })),
}));

import { POST } from "../route";
import {
  handleCancelAppointment,
  handleRescheduleAppointment,
  handleUpdateAppointmentDetails,
} from "@/lib/calendar/tool-handlers";

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL_ID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const CALLER = "+61412345678";
const SECRET = "dispatch-pin-test-secret";

function post(payload: Record<string, unknown>) {
  return POST(
    new Request("http://voice.internal/api/internal/tool-call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Internal-Secret": SECRET,
      },
      body: JSON.stringify(payload),
    }),
  );
}

const UPDATE_ARGS = {
  datetime: "2027-07-01T10:00:00",
  first_name: "Jane",
  last_name: "Smith",
  phone: "+61477000111",
  email: "jane@example.com",
  notes: "prefers mornings",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_SECRET = SECRET;
});

describe("update_appointment dispatch (SCRUM-558/560 pin)", () => {
  it("plucks ALL six fields and threads the production anchor {callId, verifiedCallerPhone}", async () => {
    const res = await post({
      organizationId: ORG,
      assistantId: "asst-1",
      functionName: "update_appointment",
      arguments: UPDATE_ARGS,
      callId: CALL_ID,
      callerIdState: "verified",
      callerPhone: CALLER,
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(handleUpdateAppointmentDetails)).toHaveBeenCalledTimes(1);
    const [orgArg, fields, anchor] = vi.mocked(handleUpdateAppointmentDetails).mock.calls[0];
    expect(orgArg).toBe(ORG);
    // Exact pluck — a dropped field here means a combined correction silently
    // half-applies in production.
    expect(fields).toEqual(UPDATE_ARGS);
    expect(anchor).toEqual({ callId: CALL_ID, verifiedCallerPhone: CALLER });
  });

  it("test sessions (no envelope callId) get NO anchor", async () => {
    await post({
      organizationId: ORG,
      assistantId: "asst-1",
      functionName: "update_appointment",
      arguments: UPDATE_ARGS,
    });

    const [, , anchor] = vi.mocked(handleUpdateAppointmentDetails).mock.calls[0];
    expect(anchor).toBeUndefined();
  });

  it("a withheld caller ID keeps the callId anchor but no verifiedCallerPhone", async () => {
    await post({
      organizationId: ORG,
      assistantId: "asst-1",
      functionName: "update_appointment",
      arguments: UPDATE_ARGS,
      callId: CALL_ID,
      callerIdState: "withheld",
    });

    const [, , anchor] = vi.mocked(handleUpdateAppointmentDetails).mock.calls[0];
    expect(anchor).toEqual({ callId: CALL_ID, verifiedCallerPhone: undefined });
  });

  it("a callId smuggled through model `arguments` is NEVER an anchor (envelope discipline)", async () => {
    await post({
      organizationId: ORG,
      assistantId: "asst-1",
      functionName: "update_appointment",
      arguments: { ...UPDATE_ARGS, callId: CALL_ID },
    });

    const [, , anchor] = vi.mocked(handleUpdateAppointmentDetails).mock.calls[0];
    expect(anchor).toBeUndefined();
  });
});

describe("cancel/reschedule call-authority threading (SCRUM-560)", () => {
  it("cancel_appointment receives the envelope callId on production calls", async () => {
    await post({
      organizationId: ORG,
      assistantId: "asst-1",
      functionName: "cancel_appointment",
      arguments: { phone: CALLER, confirmation_code: "111111" },
      callId: CALL_ID,
      callerIdState: "verified",
      callerPhone: CALLER,
    });

    expect(vi.mocked(handleCancelAppointment)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(handleCancelAppointment).mock.calls[0];
    expect(call[3]).toEqual({ callId: CALL_ID });
  });

  it("cancel_appointment gets NO callId for test sessions", async () => {
    await post({
      organizationId: ORG,
      assistantId: "asst-1",
      functionName: "cancel_appointment",
      arguments: { phone: CALLER },
    });

    const call = vi.mocked(handleCancelAppointment).mock.calls[0];
    expect(call[3]).toBeUndefined();
  });

  it("reschedule_appointment keeps its envelope callId threading (existing linkage pin)", async () => {
    await post({
      organizationId: ORG,
      assistantId: "asst-1",
      functionName: "reschedule_appointment",
      arguments: { phone: CALLER, new_datetime: "2027-07-15T10:00:00" },
      callId: CALL_ID,
      callerIdState: "verified",
      callerPhone: CALLER,
    });

    const call = vi.mocked(handleRescheduleAppointment).mock.calls[0];
    expect(call[3]).toEqual({ callId: CALL_ID });
  });
});
