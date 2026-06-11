import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-423 (audit finding #13): write-time plan gate must cover ALL SMS
// toggles — owner-alert ones included — not just the caller-facing fields.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn() }));
vi.mock("@/lib/phone/validate-for-org", () => ({
  getOrgCountry: vi.fn(async () => "AU"),
  validatePhone: vi.fn((v: string) => ({ ok: true, value: v })),
}));
vi.mock("@/lib/security/validation", () => ({
  isUrlAllowedAsync: vi.fn(async () => true),
}));

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { PUT } from "@/app/api/v1/notification-preferences/route";

function userClient() {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    select: chain,
    eq: chain,
    single: async () => ({ data: { organization_id: "org-1" }, error: null }),
  });
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => builder,
  };
}

/**
 * Admin client whose upsert captures the payload it was given.
 *
 * `existing` is the pre-existing prefs row served to the SCRUM-442
 * merged-state validation read (single() BEFORE upsert ran); null mimics a
 * missing row (PGRST116). After upsert, single() returns the upserted payload.
 */
function adminClient(
  captured: { payload?: Record<string, unknown> },
  existing: Record<string, unknown> | null = null,
) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  let upserted = false;
  Object.assign(builder, {
    upsert: (payload: Record<string, unknown>) => {
      captured.payload = payload;
      upserted = true;
      return builder;
    },
    select: chain,
    eq: chain,
    single: async () =>
      upserted
        ? { data: captured.payload, error: null }
        : existing
          ? { data: existing, error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows" } },
  });
  return { from: () => builder };
}

function putRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/v1/notification-preferences", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("PUT /api/v1/notification-preferences plan gating (SCRUM-423)", () => {
  const captured: { payload?: Record<string, unknown> } = {};

  beforeEach(() => {
    vi.clearAllMocks();
    captured.payload = undefined;
    vi.mocked(createClient).mockResolvedValue(userClient() as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient(captured) as never);
  });

  it("zeroes owner-alert SMS toggles for a non-entitled org and flags the downgrade", async () => {
    vi.mocked(hasFeatureAccess).mockResolvedValue(false);

    const res = await PUT(
      putRequest({
        sms_on_missed_call: true,
        sms_on_voicemail: true,
        sms_on_callback_scheduled: true,
        sms_textback_on_missed_call: true,
        email_on_missed_call: true,
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.smsFieldsDowngraded).toBe(true);
    expect(captured.payload).toMatchObject({
      sms_on_missed_call: false,
      sms_on_voicemail: false,
      sms_on_callback_scheduled: false,
      sms_textback_on_missed_call: false,
      email_on_missed_call: true, // email is never plan-gated
    });
  });

  it("keeps all SMS toggles for an entitled org", async () => {
    vi.mocked(hasFeatureAccess).mockResolvedValue(true);

    const res = await PUT(
      putRequest({
        sms_on_missed_call: true,
        sms_textback_on_missed_call: true,
        // SCRUM-442: owner-alert SMS now requires a number in the merged state
        sms_phone_number: "+61400111222",
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.smsFieldsDowngraded).toBe(false);
    expect(captured.payload).toMatchObject({
      sms_on_missed_call: true,
      sms_textback_on_missed_call: true,
      sms_phone_number: "+61400111222",
    });
  });

  it("nulls webhook_url for an org without webhookIntegrations", async () => {
    vi.mocked(hasFeatureAccess).mockImplementation(
      async (_org: string, feature: string) => feature !== "webhookIntegrations",
    );

    const res = await PUT(putRequest({ webhook_url: "https://hooks.example.com/x" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.webhookDowngraded).toBe(true);
    expect(captured.payload).toMatchObject({ webhook_url: null });
  });
});

// SCRUM-442: owner-alert SMS toggles and sms_phone_number must be consistent
// in the MERGED state (existing row + patch) — not just the patch alone.
describe("PUT /api/v1/notification-preferences SMS cross-field validation (SCRUM-442)", () => {
  const captured: { payload?: Record<string, unknown> } = {};

  beforeEach(() => {
    vi.clearAllMocks();
    captured.payload = undefined;
    vi.mocked(createClient).mockResolvedValue(userClient() as never);
    // Entitled org — plan gating must not mask the validation under test.
    vi.mocked(hasFeatureAccess).mockResolvedValue(true);
  });

  it("rejects enabling an owner-alert toggle when no number exists anywhere", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminClient(captured, null) as never);

    const res = await PUT(putRequest({ sms_on_missed_call: true }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/SMS phone number/i);
    expect(captured.payload).toBeUndefined(); // nothing stored
  });

  it("rejects clearing sms_phone_number while a stored toggle remains on", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(captured, {
        sms_on_voicemail: true,
        sms_phone_number: "+61400111222",
      }) as never,
    );

    const res = await PUT(putRequest({ sms_phone_number: null }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/turn off SMS alerts/i);
    expect(captured.payload).toBeUndefined();
  });

  it("names the stored toggle(s) when an inherited inconsistent state blocks the patch", async () => {
    // Nothing in THIS patch enables a toggle or clears the number — the
    // stored row is what is inconsistent, so the message must say which
    // stored alerts are still on rather than "add a number to enable".
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(captured, {
        sms_on_missed_call: true,
        sms_on_voicemail: true,
        sms_phone_number: null,
      }) as never,
    );

    const res = await PUT(putRequest({ sms_on_callback_scheduled: false }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/missed calls, voicemails.*still enabled/i);
    expect(captured.payload).toBeUndefined();
  });

  it("ignores legacy stored toggles for a downgraded org (no false 400)", async () => {
    // Starter org with an owner-SMS toggle left over from a higher plan:
    // the stored toggle can never deliver, so it must not block unrelated
    // patches like clearing the number.
    vi.mocked(hasFeatureAccess).mockResolvedValue(false);
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(captured, {
        sms_on_voicemail: true,
        sms_phone_number: "+61400111222",
      }) as never,
    );

    const res = await PUT(putRequest({ sms_phone_number: null }));

    expect(res.status).toBe(200);
    expect(captured.payload).toMatchObject({ sms_phone_number: null });
  });

  it("accepts enabling a toggle when the same patch supplies the number", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminClient(captured, null) as never);

    const res = await PUT(
      putRequest({ sms_on_missed_call: true, sms_phone_number: "+61400111222" }),
    );

    expect(res.status).toBe(200);
    expect(captured.payload).toMatchObject({
      sms_on_missed_call: true,
      sms_phone_number: "+61400111222",
    });
  });

  it("accepts enabling a toggle when the existing row already has a number (merged state)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(captured, { sms_phone_number: "+61400111222" }) as never,
    );

    const res = await PUT(putRequest({ sms_on_callback_scheduled: true }));

    expect(res.status).toBe(200);
    expect(captured.payload).toMatchObject({ sms_on_callback_scheduled: true });
  });

  it("accepts clearing the number when the same patch turns every stored toggle off", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(captured, {
        sms_on_missed_call: true,
        sms_phone_number: "+61400111222",
      }) as never,
    );

    // "" in the request body must be stored as null — migration 00137's
    // CHECK constraint (NULL or E.164) rejects the empty string.
    const res = await PUT(
      putRequest({ sms_phone_number: "", sms_on_missed_call: false }),
    );

    expect(res.status).toBe(200);
    expect(captured.payload).toMatchObject({
      sms_phone_number: null,
      sms_on_missed_call: false,
    });
  });

  it("does not run the validation read when the patch touches no SMS state", async () => {
    // Existing row would FAIL the read if consulted — proves it is skipped.
    const failingAdmin = () => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      let upserted = false;
      Object.assign(builder, {
        upsert: (payload: Record<string, unknown>) => {
          captured.payload = payload;
          upserted = true;
          return builder;
        },
        select: chain,
        eq: chain,
        single: async () =>
          upserted
            ? { data: captured.payload, error: null }
            : { data: null, error: { code: "57014", message: "timeout" } },
      });
      return { from: () => builder };
    };
    vi.mocked(createAdminClient).mockReturnValue(failingAdmin() as never);

    const res = await PUT(putRequest({ email_on_missed_call: false }));

    expect(res.status).toBe(200);
    expect(captured.payload).toMatchObject({ email_on_missed_call: false });
  });

  it("returns 500 when the validation read fails with a real DB error", async () => {
    const failingAdmin = {
      from: () => {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        Object.assign(builder, {
          select: chain,
          eq: chain,
          single: async () => ({ data: null, error: { code: "57014", message: "timeout" } }),
        });
        return builder;
      },
    };
    vi.mocked(createAdminClient).mockReturnValue(failingAdmin as never);

    const res = await PUT(putRequest({ sms_on_missed_call: true }));

    expect(res.status).toBe(500);
  });
});
