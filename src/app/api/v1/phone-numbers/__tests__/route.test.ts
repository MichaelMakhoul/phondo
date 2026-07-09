import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

// ──────────────────────────────────────────────────────────────────────────
// A purchased number with no voice webhook is CALL-DEAD: every inbound call
// drops, while the dashboard shows it as live. The route therefore treats
// webhook configuration as fatal — it releases the number and 502s rather than
// persisting a broken one. These tests pin that contract, including the
// worst case where the compensating release ALSO fails and the number is
// orphaned (billed, owned by nobody) and must page.
//
// Module-level mutable state; vitest serializes tests in a file by default.
// Do NOT enable test.concurrent here.
// ──────────────────────────────────────────────────────────────────────────

const supabaseState: {
  user: { id: string } | null;
  membership: { organization_id: string; role: string } | null;
  org: { country: string } | null;
  insertError: unknown;
  insertCalls: number;
} = {
  user: { id: "user-1" },
  membership: { organization_id: "org-1", role: "owner" },
  org: { country: "AU" },
  insertError: null,
  insertCalls: 0,
};

const twilioState: {
  purchased: { sid: string; number: string };
  configureVoiceWebhook: Mock<AnyFn>;
  releaseNumber: Mock<AnyFn>;
  searchResult: { number: string }[];
} = {
  purchased: { sid: "PN-abc", number: "+61255551234" },
  configureVoiceWebhook: vi.fn<AnyFn>(),
  releaseNumber: vi.fn<AnyFn>(),
  searchResult: [{ number: "+61255551234" }],
};

const pageSentryMock = vi.fn<AnyFn>();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: supabaseState.user }, error: null })) },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.single = async () => {
        if (table === "org_members") return { data: supabaseState.membership, error: null };
        if (table === "organizations") return { data: supabaseState.org, error: null };
        return { data: null, error: null };
      };
      chain.insert = () => {
        supabaseState.insertCalls += 1;
        return {
          select: () => ({
            single: async () => ({
              data: supabaseState.insertError ? null : { id: "row-1", phone_number: twilioState.purchased.number },
              error: supabaseState.insertError,
            }),
          }),
        };
      };
      return chain;
    },
  })),
}));

vi.mock("@/lib/stripe/billing-service", () => ({
  checkResourceLimit: vi.fn(async () => ({ allowed: true, plan: "starter", limit: 1, currentCount: 0 })),
}));
vi.mock("@/lib/stripe/client", () => ({ PLANS: { starter: { name: "Starter" } } }));

vi.mock("@/lib/twilio/client", () => ({
  searchAvailableNumbers: vi.fn(async () => twilioState.searchResult),
  purchaseNumber: vi.fn(async () => twilioState.purchased),
  configureVoiceWebhook: (...args: unknown[]) => twilioState.configureVoiceWebhook(...args),
  configureSmsWebhook: vi.fn(async () => undefined),
  releaseNumber: (...args: unknown[]) => twilioState.releaseNumber(...args),
}));

vi.mock("@/lib/observability/page-sentry", () => ({
  pageSentry: (...args: unknown[]) => pageSentryMock(...args),
}));

import { POST } from "../route";

function makeRequest(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/v1/phone-numbers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceType: "purchased", areaCode: "02", ...body }),
  });
}

beforeEach(() => {
  vi.stubEnv("PROVISIONING_ENABLED", "true");
  vi.stubEnv("VOICE_SERVER_PUBLIC_URL", "https://voice.example.com");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  supabaseState.user = { id: "user-1" };
  supabaseState.membership = { organization_id: "org-1", role: "owner" };
  supabaseState.org = { country: "AU" };
  supabaseState.insertError = null;
  supabaseState.insertCalls = 0;

  twilioState.configureVoiceWebhook = vi.fn<AnyFn>(async () => undefined);
  twilioState.releaseNumber = vi.fn<AnyFn>(async () => undefined);
  pageSentryMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/v1/phone-numbers — voice webhook is fatal", () => {
  it("persists the number on the happy path", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(201);
    expect(twilioState.configureVoiceWebhook).toHaveBeenCalledWith(
      "PN-abc",
      "https://voice.example.com/twiml",
      "https://app.example.com/api/twilio/voice-fallback"
    );
    expect(twilioState.releaseNumber).not.toHaveBeenCalled();
    expect(supabaseState.insertCalls).toBe(1);
  });

  it("releases the number and 502s when VOICE_SERVER_PUBLIC_URL is missing", async () => {
    vi.stubEnv("VOICE_SERVER_PUBLIC_URL", "");

    const res = await POST(makeRequest());

    expect(res.status).toBe(502);
    expect(twilioState.releaseNumber).toHaveBeenCalledWith("PN-abc");
    // Never save a call-dead number.
    expect(supabaseState.insertCalls).toBe(0);
    expect(pageSentryMock).toHaveBeenCalled();
  });

  it("releases the number and 502s when configureVoiceWebhook throws", async () => {
    twilioState.configureVoiceWebhook = vi.fn<AnyFn>(async () => {
      throw new Error("twilio 500");
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(502);
    expect(twilioState.releaseNumber).toHaveBeenCalledWith("PN-abc");
    expect(supabaseState.insertCalls).toBe(0);
  });

  it("still 502s (and pages) when the compensating release ALSO fails", async () => {
    twilioState.configureVoiceWebhook = vi.fn<AnyFn>(async () => {
      throw new Error("twilio 500");
    });
    twilioState.releaseNumber = vi.fn<AnyFn>(async () => {
      throw new Error("release failed");
    });

    // Must not reject with an unhandled error — the orphan is logged + paged.
    const res = await POST(makeRequest());

    expect(res.status).toBe(502);
    expect(supabaseState.insertCalls).toBe(0);
    const reasons = pageSentryMock.mock.calls.map((c) => (c[0] as { reason: string }).reason);
    expect(reasons).toContain("phone-number-orphaned");
  });

  it("releases the number when the DB insert fails", async () => {
    supabaseState.insertError = { message: "boom", code: "23505" };

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(twilioState.releaseNumber).toHaveBeenCalledWith("PN-abc");
  });
});

describe("POST /api/v1/phone-numbers — guards still hold", () => {
  it("503s when provisioning is disabled, before touching the carrier", async () => {
    vi.stubEnv("PROVISIONING_ENABLED", "false");

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.code).toBe("PROVISIONING_DISABLED");
    expect(twilioState.releaseNumber).not.toHaveBeenCalled();
  });

  it("401s for an unauthenticated caller", async () => {
    supabaseState.user = null;
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it("403s for a non-owner/admin member", async () => {
    supabaseState.membership = { organization_id: "org-1", role: "member" };
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
  });
});
