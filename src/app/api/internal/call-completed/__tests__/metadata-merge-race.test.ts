import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-586 (final review, coverage lens): the CUSTOMER spam-merge write must be built from a
// calls.metadata read taken after the spam analysis, not before it. Before SCRUM-586 the read
// sat directly in front of the write; the owner-call check hoisted it ahead of analyzeCall, so
// any writer that landed during the analysis (the voice server's post-call re-transcription
// stamps transcript_source into the same JSON) was silently overwritten by the stale copy.
// The route now re-reads right before the write (the hoisted read still decides owner/locked).

vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn((work: () => Promise<unknown>) => { void work(); }) }));

const db = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  /** calls reads so far, and the 1-based read that returns an error instead (null = none). */
  reads: 0,
  failRead: null as number | null,
  /** Every calls write payload, in order. */
  writes: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      let pending: any = null;
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        update: (payload: unknown) => { pending = payload; return chain; },
        single: async () => {
          if (table === "calls") {
            db.reads++;
            if (db.failRead === db.reads) return { data: null, error: { message: "connection refused", code: "08006" } };
            return { data: { metadata: structuredClone(db.metadata) }, error: null };
          }
          if (table === "organizations") return { data: { timezone: "Australia/Sydney", country: "AU" }, error: null };
          return { data: { name: "Copperline" }, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (pending && table === "calls") db.writes.push(structuredClone(pending));
          if (pending && table === "calls" && pending.metadata !== undefined) db.metadata = structuredClone(pending.metadata);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return chain;
    },
    rpc: async () => ({ data: true, error: null }),
  })),
}));
vi.mock("@/lib/spam/spam-detector", () => ({ analyzeCall: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({
  sendMissedCallNotification: vi.fn(async () => "sent"),
  sendFailedCallNotification: vi.fn(async () => "sent"),
  sendUnsuccessfulCallNotification: vi.fn(async () => "sent"),
  sendOwnerPinLockedNotification: vi.fn(async () => "sent"),
}));
vi.mock("@/lib/sms/caller-sms", () => ({ sendMissedCallTextBack: vi.fn() }));
vi.mock("@/lib/integrations/webhook-delivery", () => ({ deliverWebhooks: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({ withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })), rateLimitDistributed: vi.fn() }));

import { analyzeCall } from "@/lib/spam/spam-detector";
import { POST } from "@/app/api/internal/call-completed/route";

const SECRET = "merge-race-secret";

function completeCall() {
  return POST(new Request("http://localhost/api/internal/call-completed", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET },
    body: JSON.stringify({
      callId: "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f", organizationId: "org-1", assistantId: "asst-1",
      callerPhone: "+61412345678", status: "completed", durationSeconds: 90, transcript: "hi",
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_SECRET = SECRET;
  db.metadata = { voice_provider: "self_hosted" };
  db.reads = 0;
  db.failRead = null;
  db.writes = [];
  vi.mocked(analyzeCall).mockResolvedValue({ isSpam: false, spamScore: 5, reasons: [], confidence: "low", recommendation: "allow" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("call-completed customer spam merge", () => {
  it("keeps what another writer added to calls.metadata while the spam analysis was running", async () => {
    vi.mocked(analyzeCall).mockImplementation(async () => {
      db.metadata = { ...db.metadata, transcript_source: "deepgram" }; // the racing writer lands mid-analysis
      return { isSpam: false, spamScore: 5, reasons: [], confidence: "low", recommendation: "allow" };
    });

    await completeCall();

    expect(db.metadata).toMatchObject({
      voice_provider: "self_hosted",
      transcript_source: "deepgram", // lost if the merge is built from the pre-analysis read
      spam_analysis: { recommendation: "allow" },
    });
  });

  it("a failed re-read writes the spam columns but no metadata at all — never a stale copy", async () => {
    db.failRead = 2; // 1 = the hoisted owner/locked read, 2 = the merge's own read
    vi.mocked(analyzeCall).mockImplementation(async () => {
      db.metadata = { ...db.metadata, transcript_source: "deepgram" };
      return { isSpam: false, spamScore: 5, reasons: [], confidence: "low", recommendation: "allow" };
    });

    const res = await completeCall();

    expect(res.status).toBe(200);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({ is_spam: false, spam_score: 5 });
    expect(db.writes[0]).not.toHaveProperty("metadata");
    expect(db.metadata).toEqual({ voice_provider: "self_hosted", transcript_source: "deepgram" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("skipping metadata merge"), expect.objectContaining({ callId: "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f" }),
    );
  });

  it("the merge depends only on its own read: a failed hoisted read no longer blocks it", async () => {
    db.failRead = 1;

    await completeCall();

    expect(db.writes).toHaveLength(1);
    expect(db.metadata).toMatchObject({ voice_provider: "self_hosted", spam_analysis: { recommendation: "allow" } });
  });
});
