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

/** Admin client whose upsert captures the payload it was given. */
function adminClient(captured: { payload?: Record<string, unknown> }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    upsert: (payload: Record<string, unknown>) => {
      captured.payload = payload;
      return builder;
    },
    select: chain,
    single: async () => ({ data: captured.payload, error: null }),
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
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.smsFieldsDowngraded).toBe(false);
    expect(captured.payload).toMatchObject({
      sms_on_missed_call: true,
      sms_textback_on_missed_call: true,
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
