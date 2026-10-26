// src/app/api/internal/call-completed/__tests__/owner-recap.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-597 step 4d: after an OWNER call that changed bookings, the owner is emailed
// what actually changed (buildOwnerRecap — the audit trail and the text log, never
// the AI's words). After the response, whatever the call's status, once per call
// (a conditional claim on calls.metadata.owner_recap_emailed_at), and a failure pages
// without failing the route. Reads the DB row's metadata, never the payload.

const after: Array<() => Promise<unknown>> = [];
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn((work: () => Promise<unknown>) => { after.push(work); }) }));

type Res = { data: unknown; error: unknown };
const db = {
  stored: null as Record<string, unknown> | null, // the metadata the route reads up front
  fresh: null as Record<string, unknown> | null, // the claim's re-read
  freshError: null as unknown,
  claim: { data: [{ id: "c" }], error: null } as Res,
  updates: [] as Array<{ payload: any; filters: Array<[string, unknown[]]> }>,
  callsReads: 0,
  storedError: null as unknown, // the route's first metadata read
  tzError: null as unknown,
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      const filters: Array<[string, unknown[]]> = [];
      let update: any = null;
      const chain: any = {
        select: (...a: unknown[]) => { filters.push(["select", a]); return chain; },
        eq: (...a: unknown[]) => { filters.push(["eq", a]); return chain; },
        is: (...a: unknown[]) => { filters.push(["is", a]); return chain; },
        update: (payload: unknown) => { update = payload; return chain; },
        single: async () => {
          if (table === "calls") {
            db.callsReads += 1;
            if (db.callsReads === 1) return db.storedError ? { data: null, error: db.storedError } : { data: { metadata: db.stored }, error: null };
            return db.freshError ? { data: null, error: db.freshError } : { data: { metadata: db.fresh }, error: null };
          }
          if (table === "organizations") return db.tzError ? { data: null, error: db.tzError } : { data: { timezone: "Australia/Perth", country: "AU" }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: Res) => unknown) => {
          if (update) {
            db.updates.push({ payload: update, filters });
            return Promise.resolve(table === "calls" && filters.some(([m]) => m === "is") ? db.claim : { data: null, error: null }).then(resolve);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return chain;
    },
    rpc: vi.fn(async () => ({ data: true, error: null })),
  })),
}));
vi.mock("@/lib/spam/spam-detector", () => ({ analyzeCall: vi.fn(async () => ({ isSpam: false, spamScore: 0, reasons: [], confidence: "low", recommendation: "allow" })) }));
vi.mock("@/lib/notifications/notification-service", () => ({
  sendMissedCallNotification: vi.fn(async () => "sent"),
  sendFailedCallNotification: vi.fn(async () => "sent"),
  sendUnsuccessfulCallNotification: vi.fn(async () => "sent"),
  sendOwnerPinLockedNotification: vi.fn(async () => "sent"),
  sendOwnerAssistantRecapNotification: vi.fn(async () => "sent"),
}));
vi.mock("@/lib/owner-assistant/recap", () => ({ buildOwnerRecap: vi.fn() }));
vi.mock("@/lib/sms/caller-sms", () => ({ sendMissedCallTextBack: vi.fn() }));
vi.mock("@/lib/integrations/webhook-delivery", () => ({ deliverWebhooks: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({ withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })), rateLimitDistributed: vi.fn() }));
vi.mock("@/lib/observability/page-sentry", () => ({ pageSentry: vi.fn() }));

import { sendOwnerAssistantRecapNotification } from "@/lib/notifications/notification-service";
import { buildOwnerRecap } from "@/lib/owner-assistant/recap";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { POST } from "@/app/api/internal/call-completed/route";

const SECRET = "owner-recap-test-secret";
const CALL_ID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const ITEMS = [{ change: "cancelled", customer: "Michael Dunn", when: "Monday, October 26 at 12:30 PM", told: "not_told" }];

function ended(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/internal/call-completed", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET },
    body: JSON.stringify({ callId: CALL_ID, organizationId: "org-1", assistantId: "asst-1", status: "completed", durationSeconds: 105, transcript: "", ...overrides }),
  });
}
async function runAfter() {
  while (after.length) await after.shift()!();
}

beforeEach(() => {
  vi.clearAllMocks();
  after.length = 0;
  process.env.INTERNAL_API_SECRET = SECRET;
  db.stored = { call_type: "owner", owner_auth: "verified", channel: "web" };
  db.fresh = { call_type: "owner", owner_auth: "verified", channel: "web" };
  db.freshError = null;
  db.claim = { data: [{ id: CALL_ID }], error: null };
  db.updates = [];
  db.callsReads = 0;
  db.storedError = null;
  db.tzError = null;
  vi.mocked(buildOwnerRecap).mockResolvedValue(ITEMS as any);
  vi.mocked(sendOwnerAssistantRecapNotification).mockResolvedValue("sent");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("call-completed step 4d: the owner-assistant recap", () => {
  it("an owner web session with changes: claims the call, then emails the recap built from the records (after the response)", async () => {
    const res = await POST(ended());
    expect(res.status).toBe(200);
    expect(sendOwnerAssistantRecapNotification).not.toHaveBeenCalled(); // not before the response
    await runAfter();
    expect(buildOwnerRecap).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", callId: CALL_ID, timezone: "Australia/Perth", since: expect.any(Date) });
    // Text attempts from before the session never count: since = the call's start (105 s ago) less a 10-minute margin.
    const since = vi.mocked(buildOwnerRecap).mock.calls[0][1].since.getTime();
    const expected = Date.now() - 105_000 - 10 * 60_000;
    expect(Math.abs(since - expected)).toBeLessThan(5_000);
    const claim = db.updates.find((u) => u.filters.some(([m]) => m === "is"));
    expect(claim?.filters).toEqual(expect.arrayContaining([["eq", ["id", CALL_ID]], ["is", ["metadata->>owner_recap_emailed_at", null]], ["select", ["id"]]]));
    expect(claim?.payload.metadata).toMatchObject({ call_type: "owner", channel: "web", owner_recap_emailed_at: expect.any(String) });
    expect(sendOwnerAssistantRecapNotification).toHaveBeenCalledTimes(1);
    expect(sendOwnerAssistantRecapNotification).toHaveBeenCalledWith({ organizationId: "org-1", callId: CALL_ID, channel: "web", items: ITEMS, timesInDefaultZone: false });
    expect(console.log).toHaveBeenCalledWith("[Internal] Owner recap email:", { callId: CALL_ID, organizationId: "org-1", outcome: "sent" });
  });

  it("a phone owner call (no channel on the row) is 'phone'; a FAILED session that made a change still gets its recap", async () => {
    db.stored = { call_type: "owner", owner_auth: "verified" };
    db.fresh = { call_type: "owner", owner_auth: "verified" };
    await POST(ended({ status: "failed" }));
    await runAfter();
    expect(sendOwnerAssistantRecapNotification).toHaveBeenCalledWith(expect.objectContaining({ channel: "phone" }));
  });

  it("nothing changed on the call: no claim, no email", async () => {
    vi.mocked(buildOwnerRecap).mockResolvedValue([]);
    await POST(ended());
    await runAfter();
    expect(db.updates.some((u) => u.filters.some(([m]) => m === "is"))).toBe(false);
    expect(sendOwnerAssistantRecapNotification).not.toHaveBeenCalled();
    expect(pageSentry).not.toHaveBeenCalled();
  });

  it("a customer call never builds a recap (the flag comes from the DB row, not the payload)", async () => {
    db.stored = { voice_provider: "self_hosted" };
    await POST(ended({ metadata: { call_type: "owner" } }));
    await runAfter();
    expect(buildOwnerRecap).not.toHaveBeenCalled();
    expect(sendOwnerAssistantRecapNotification).not.toHaveBeenCalled();
  });

  it("already emailed (a retried call-completed): the claim re-read sees the stamp and nothing is sent", async () => {
    db.fresh = { call_type: "owner", owner_recap_emailed_at: "2026-10-26T04:35:00Z" };
    await POST(ended());
    await runAfter();
    expect(sendOwnerAssistantRecapNotification).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("[Internal] Owner recap email:", expect.objectContaining({ outcome: "claimed_elsewhere" }));
  });

  it("a concurrent delivery won the conditional claim (0 rows updated): nothing is sent", async () => {
    db.claim = { data: [], error: null };
    await POST(ended());
    await runAfter();
    expect(sendOwnerAssistantRecapNotification).not.toHaveBeenCalled();
  });

  it("a claim that can't read or write still sends — the safety net beats a rare duplicate", async () => {
    db.freshError = { code: "57014" };
    await POST(ended());
    await runAfter();
    expect(sendOwnerAssistantRecapNotification).toHaveBeenCalledTimes(1);
    vi.mocked(sendOwnerAssistantRecapNotification).mockClear();
    db.freshError = null;
    db.callsReads = 0;
    db.claim = { data: null, error: { code: "57014" } };
    await POST(ended());
    await runAfter();
    expect(sendOwnerAssistantRecapNotification).toHaveBeenCalledTimes(1);
  });

  it("records that can't be read page OWNER_RECAP_EMAIL_FAILED — never treated as 'no changes'", async () => {
    vi.mocked(buildOwnerRecap).mockResolvedValue(null);
    const res = await POST(ended());
    expect(res.status).toBe(200);
    await runAfter();
    expect(sendOwnerAssistantRecapNotification).not.toHaveBeenCalled();
    expect(pageSentry).toHaveBeenCalledWith(expect.objectContaining({ reason: SENTRY_REASONS.OWNER_RECAP_EMAIL_FAILED, level: "error", extras: { organizationId: "org-1", callId: CALL_ID } }));
  });

  it("a send that throws pages and never fails the route", async () => {
    vi.mocked(sendOwnerAssistantRecapNotification).mockRejectedValue(new Error("no owner email"));
    const res = await POST(ended());
    expect(res.status).toBe(200);
    await runAfter();
    expect(pageSentry).toHaveBeenCalledWith(expect.objectContaining({ reason: SENTRY_REASONS.OWNER_RECAP_EMAIL_FAILED }));
    expect(console.log).toHaveBeenCalledWith("[Internal] Owner recap email:", expect.objectContaining({ outcome: "failed" }));
  });

  it("no callId: no recap (there is no call to scope the records to)", async () => {
    await POST(ended({ callId: undefined }));
    await runAfter();
    expect(buildOwnerRecap).not.toHaveBeenCalled();
  });
});

describe("call-completed: SCRUM-597 review fixes", () => {
  it("an unreadable org timezone still sends the recap — in Sydney time, and says so", async () => {
    db.tzError = { code: "57014" };
    await POST(ended());
    await runAfter();
    expect(buildOwnerRecap).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timezone: "Australia/Sydney" }));
    expect(sendOwnerAssistantRecapNotification).toHaveBeenCalledWith(expect.objectContaining({ timesInDefaultZone: true }));
  });

  it("an unreadable call row pages CALL_METADATA_READ_FAILED (an owner call would lose its recap) and the route still answers", async () => {
    db.storedError = { code: "57014", message: "timeout" };
    const res = await POST(ended());
    expect(res.status).toBe(200);
    await runAfter();
    expect(pageSentry).toHaveBeenCalledWith(expect.objectContaining({ reason: SENTRY_REASONS.CALL_METADATA_READ_FAILED, level: "error", extras: { callId: CALL_ID, organizationId: "org-1" } }));
    expect(buildOwnerRecap).not.toHaveBeenCalled(); // it can't tell this was an owner call
  });
});
