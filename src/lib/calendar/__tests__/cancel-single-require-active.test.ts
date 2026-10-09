import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-586 (final review S3): cancelSingleAppointment's `requireActive` opt-in — used
// only by the owner assistant — writes org-scoped and only while the row is still
// confirmed/pending, and reports a 0-row write as "no longer active" without
// refreshing the cache or texting anyone. Every other caller's write is unchanged
// (by id), which this file pins too.

vi.mock("@/lib/supabase/admin", () => ({
  // getOrgSchedule's org read (timezone for the reply).
  createAdminClient: vi.fn(() => ({
    from: () => {
      const b: any = {};
      for (const name of ["select", "eq"]) b[name] = () => b;
      b.single = async () => ({ data: { timezone: "Australia/Sydney", business_hours: {}, default_appointment_duration: 30 }, error: null });
      return b;
    },
  })),
}));
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn() }));
vi.mock("@/lib/sms/caller-sms", () => ({ sendCancellationSMS: vi.fn(), sendAppointmentConfirmationSMS: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), withScope: vi.fn() }));

import { runAfterResponse } from "@/lib/utils/after-response";
import { cancelSingleAppointment } from "@/lib/calendar/tool-handlers";

type Call = { name: string; args: unknown[] };
/** Records the write chain; resolves with `result` when awaited. */
function writer(result: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const b: any = {};
  for (const name of ["update", "eq", "in", "select"]) {
    b[name] = (...args: unknown[]) => { calls.push({ name, args }); return b; };
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return { supabase: { from: (table: string) => { calls.push({ name: "from", args: [table] }); return b; } }, calls };
}

const ORG = "11111111-2222-4333-a444-555555555555";
const APPT = { id: "44444444-5555-4666-8777-888888888888", provider: "internal", attendee_phone: "+61412345678", start_time: "2026-10-15T23:00:00+00:00" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("cancelSingleAppointment requireActive (SCRUM-586)", () => {
  it("without it (every customer path) the write is exactly update-by-id, as before", async () => {
    const { supabase, calls } = writer({ data: null, error: null });
    const r = await cancelSingleAppointment(supabase, ORG, APPT, "caller asked");
    expect(r.success).toBe(true);
    expect(calls).toEqual([
      { name: "from", args: ["appointments"] },
      { name: "update", args: [{ status: "cancelled" }] },
      { name: "eq", args: ["id", APPT.id] },
    ]);
  });

  it("with it the write is org-scoped, active-only and returns the rows it changed", async () => {
    const { supabase, calls } = writer({ data: [{ id: APPT.id }], error: null });
    const r = await cancelSingleAppointment(supabase, ORG, APPT, "owner", { suppressSms: true, requireActive: true });
    expect(r.success).toBe(true);
    expect(calls).toEqual([
      { name: "from", args: ["appointments"] },
      { name: "update", args: [{ status: "cancelled" }] },
      { name: "eq", args: ["id", APPT.id] },
      { name: "eq", args: ["organization_id", ORG] },
      { name: "in", args: ["status", ["confirmed", "pending"]] },
      { name: "select", args: ["id"] },
    ]);
    expect(runAfterResponse).toHaveBeenCalledTimes(1); // the voice cache refresh (no SMS: suppressed)
  });

  it.each([
    ["no rows", []],
    ["a null representation", null],
  ])("0 rows changed (%s) is 'no longer active': a business non-success, nothing refreshed or texted", async (_label, data) => {
    const { supabase } = writer({ data, error: null });
    const r = await cancelSingleAppointment(supabase, ORG, APPT, "owner", { requireActive: true });
    expect(r).toEqual({ success: false, message: "That appointment is no longer active, so nothing was cancelled.", data: { notActive: true } });
    expect(r.error).toBeUndefined();
    expect(runAfterResponse).not.toHaveBeenCalled();
  });

  it("a DB error is still the genuine-error reply (error:true), never 'no longer active'", async () => {
    const { supabase } = writer({ data: null, error: { message: "boom", code: "08006" } });
    const r = await cancelSingleAppointment(supabase, ORG, APPT, "owner", { requireActive: true });
    expect(r).toMatchObject({ success: false, error: true });
    expect(r.data).toBeUndefined();
  });
});
