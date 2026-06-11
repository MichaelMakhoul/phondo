import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-415 wiring guard (updated for SCRUM-438): prove handleCancelAppointment
// actually enforces phone possession on the confirmation_code path — i.e. a
// code match with a NON-matching caller phone is blocked and NEVER mutates.
// SCRUM-438 also requires the reply to be indistinguishable from "code not
// found" (no code-enumeration oracle), so the old "doesn't match" message is
// gone: the handler falls through to the phone lookup and reports not-found.

vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { handleCancelAppointment } from "@/lib/calendar/tool-handlers";

function fakeAdmin(codeMatch: Record<string, unknown> | null, calls: { mutated?: boolean }) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    ilike: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    single: async () => ({ data: codeMatch, error: null }),
    // If the handler ever reached the mutation, these would fire — they must not.
    update: () => {
      calls.mutated = true;
      return builder;
    },
    delete: () => {
      calls.mutated = true;
      return builder;
    },
  });
  return { from: () => builder };
}

describe("handleCancelAppointment confirmation_code ownership wiring (SCRUM-415/438)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks a valid code from a non-matching phone, does NOT mutate, and does NOT reveal that the code matched", async () => {
    const calls: { mutated?: boolean } = {};
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        { id: "appt-1", attendee_phone: "+61412345678", start_time: "2026-07-01T10:00:00Z", status: "confirmed", confirmation_code: "123456" },
        calls,
      ) as never,
    );

    const result = await handleCancelAppointment("org-1", {
      confirmation_code: "123456",
      phone: "+61499999999", // valid code, wrong phone
    });

    expect(result.success).toBe(false);
    expect(calls.mutated).toBeUndefined(); // the appointment was never cancelled
    // SCRUM-438: the reply must not distinguish "code exists but wrong phone"
    // from "code doesn't exist" — falls through to the phone path's not-found.
    expect(result.message).toMatch(/wasn't able to find/i);
    expect(result.message).not.toMatch(/doesn't match/i);
  });

  it("blocks a valid code from a SPOOFED model phone when the verified caller ID differs (SCRUM-438 possession factor)", async () => {
    const calls: { mutated?: boolean } = {};
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        { id: "appt-1", attendee_phone: "+61412345678", start_time: "2026-07-01T10:00:00Z", status: "confirmed", confirmation_code: "123456" },
        calls,
      ) as never,
    );

    // The model echoes the victim's number, but the call's REAL From differs.
    const result = await handleCancelAppointment(
      "org-1",
      { confirmation_code: "123456", phone: "+61412345678" },
      { verifiedCallerPhone: "+61499999999" },
    );

    expect(result.success).toBe(false);
    expect(calls.mutated).toBeUndefined();
  });
});
