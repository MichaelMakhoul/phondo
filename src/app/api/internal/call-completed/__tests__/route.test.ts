import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-442: notificationStatus must report the sender's REAL outcome.
// Previously the route hardcoded "sent" after a resolved send — even when
// every channel was disabled by preference and nothing went out.
//
// SCRUM-441: also covers the org timezone/country lookup wiring (SCRUM-418)
// — orgRow.timezone/country must flow into CallMetadata, an org-fetch error
// must NOT abort spam analysis, and the AU-org-on-US-timezone drift guard
// must warn.

vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));

// State-driven admin-client mock (precedent: test-fallback route test). The
// route's org timezone/country lookup is the only admin query these tests
// exercise — callId stays null so the calls-metadata merge and billing RPC
// paths never run.
const adminState: {
  orgRow: any;
  orgError: any;
  /** Per-table .eq() log so tests can assert the filter shape. */
  eqs: Record<string, { col: string; val: unknown }[]>;
} = { orgRow: null, orgError: null, eqs: {} };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      if (!adminState.eqs[table]) adminState.eqs[table] = [];
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          adminState.eqs[table].push({ col, val });
          return chain;
        },
        single: async () => {
          if (table === "organizations") {
            return { data: adminState.orgRow, error: adminState.orgError };
          }
          return { data: null, error: { message: `unexpected table ${table}` } };
        },
      };
      return chain;
    },
    rpc: vi.fn(async () => ({ data: true, error: null })),
  })),
}));
vi.mock("@/lib/spam/spam-detector", () => ({ analyzeCall: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({
  sendMissedCallNotification: vi.fn(),
  sendFailedCallNotification: vi.fn(),
  sendUnsuccessfulCallNotification: vi.fn(),
}));
vi.mock("@/lib/sms/caller-sms", () => ({ sendMissedCallTextBack: vi.fn() }));
vi.mock("@/lib/integrations/webhook-delivery", () => ({ deliverWebhooks: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })),
}));

import { sendMissedCallNotification } from "@/lib/notifications/notification-service";
import { analyzeCall, type SpamAnalysisResult } from "@/lib/spam/spam-detector";
import { POST } from "@/app/api/internal/call-completed/route";

const SECRET = "test-internal-secret";

/** A short, transcript-less, non-spam call — classifies as "missed". */
function missedCallRequest(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/internal/call-completed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": SECRET,
    },
    body: JSON.stringify({
      callId: null,
      organizationId: "org-1",
      assistantId: null,
      callerPhone: "", // no spam analysis / text-back path
      status: "missed",
      durationSeconds: 5,
      ...overrides,
    }),
  });
}

const NOT_SPAM: SpamAnalysisResult = {
  isSpam: false,
  spamScore: 0,
  reasons: [],
  confidence: "low",
  recommendation: "allow",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_SECRET = SECRET;
  adminState.orgRow = null;
  adminState.orgError = null;
  adminState.eqs = {};
});

describe("POST /api/internal/call-completed notificationStatus honesty (SCRUM-442)", () => {

  it("reports 'sent' when the sender actually delivered a channel", async () => {
    vi.mocked(sendMissedCallNotification).mockResolvedValue("sent");

    const res = await POST(missedCallRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).notificationStatus).toBe("sent");
    expect(sendMissedCallNotification).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1" }),
    );
  });

  it("reports 'skipped' when every channel was disabled by preference", async () => {
    vi.mocked(sendMissedCallNotification).mockResolvedValue("skipped");

    const res = await POST(missedCallRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).notificationStatus).toBe("skipped");
  });

  it("reports 'failed' when the sender throws (wanted but undeliverable)", async () => {
    vi.mocked(sendMissedCallNotification).mockRejectedValue(
      new Error("missed-call: 0 notification channels delivered — wanted channel(s) unavailable: owner-email"),
    );

    const res = await POST(missedCallRequest());

    expect(res.status).toBe(200); // route still acks; failure is in the field
    expect((await res.json()).notificationStatus).toBe("failed");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Org timezone/country wiring for spam analysis (SCRUM-418, tested under
// SCRUM-441). callerPhone is set so the route runs the org lookup + spam
// analysis; callId stays null so no other admin queries fire.
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/internal/call-completed org timezone/country lookup (SCRUM-418/441)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(analyzeCall).mockResolvedValue(NOT_SPAM);
    vi.mocked(sendMissedCallNotification).mockResolvedValue("skipped");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("flows orgRow.timezone/country into CallMetadata, filtered by the payload's org id", async () => {
    adminState.orgRow = { timezone: "Australia/Sydney", country: "AU" };

    const res = await POST(missedCallRequest({ callerPhone: "+61295550123" }));

    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(true);
    expect(analyzeCall).toHaveBeenCalledTimes(1);
    expect(analyzeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callerPhone: "+61295550123",
        organizationId: "org-1",
        timezone: "Australia/Sydney",
        countryCode: "AU",
      }),
    );
    // The lookup must be scoped to the payload's organization.
    expect(adminState.eqs.organizations).toEqual([{ col: "id", val: "org-1" }]);
  });

  it("still returns 200 and runs spam analysis (minus timing/country signals) when the org fetch errors", async () => {
    adminState.orgError = { message: "connection refused", code: "08006" };

    const res = await POST(missedCallRequest({ callerPhone: "+15125550173" }));

    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(true);
    // Fail-soft contract: analysis still runs, with timezone/country undefined
    // so the timing signal is dropped instead of scored in the wrong zone.
    expect(analyzeCall).toHaveBeenCalledTimes(1);
    expect(analyzeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callerPhone: "+15125550173",
        timezone: undefined,
        countryCode: undefined,
      }),
    );
  });

  it("warns (with orgId) when an AU org has a non-Australian timezone — DB-default drift guard (SCRUM-441)", async () => {
    // organizations.timezone defaults to 'America/New_York'; an AU org stuck
    // on the default would be timing-scored in NY time.
    adminState.orgRow = { timezone: "America/New_York", country: "AU" };

    const res = await POST(missedCallRequest({ callerPhone: "+61295550123" }));

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("AU org has a non-Australian timezone"),
      expect.objectContaining({ organizationId: "org-1", timezone: "America/New_York" }),
    );
    // The drift guard only warns — the (wrong-zone) timezone still flows
    // through so the behavior is observable, not silently altered.
    expect(analyzeCall).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/New_York", countryCode: "AU" }),
    );
  });

  it("does not warn for an AU org with an Australian timezone", async () => {
    adminState.orgRow = { timezone: "Australia/Brisbane", country: "AU" };

    await POST(missedCallRequest({ callerPhone: "+61295550123" }));

    const driftWarns = warnSpy.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("non-Australian timezone"),
    );
    expect(driftWarns).toHaveLength(0);
  });

  it("does not warn for a US org on the DB-default timezone", async () => {
    adminState.orgRow = { timezone: "America/New_York", country: "US" };

    await POST(missedCallRequest({ callerPhone: "+15125550173" }));

    const driftWarns = warnSpy.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("non-Australian timezone"),
    );
    expect(driftWarns).toHaveLength(0);
  });
});
