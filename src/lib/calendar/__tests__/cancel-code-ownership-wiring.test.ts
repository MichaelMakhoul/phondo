import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-415 wiring guard: prove handleCancelAppointment actually calls the
// ownership check on the confirmation_code path — i.e. a code match with a
// NON-matching caller phone is blocked and NEVER mutates. (The pure helper is
// unit-tested separately in code-ownership.test.ts; this guards the call site.)

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

describe("handleCancelAppointment confirmation_code ownership wiring (SCRUM-415)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks a valid code from a non-matching phone and does NOT mutate", async () => {
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
    expect(result.message).toMatch(/doesn't match/i);
    expect(calls.mutated).toBeUndefined(); // the appointment was never cancelled
  });
});
