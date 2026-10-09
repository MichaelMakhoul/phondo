import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// SCRUM-586 characterization: the CUSTOMER pipeline for calls that carry a
// callId, which is every production call. route.test.ts keeps callId null, so
// the calls-metadata merge, the usage claim and the webhook payload were never
// pinned. These tests were written against the route BEFORE the owner-call
// carve-out and must stay green after it. A customer call has to behave
// exactly as before: the same calls update, alerts, text-back, webhook,
// billing and response.

vi.mock("@/lib/utils/after-response", () => ({
  runAfterResponse: vi.fn((work: () => Promise<unknown>) => { void work(); }),
}));

type Query = { table: string; op: "select" | "update"; arg: unknown; filters: Array<[string, unknown]> };

const db: {
  callMetadata: Record<string, unknown> | null;
  callError: unknown;
  assistantError: unknown;
  /** Every from(table) chain, in order, with its select/update argument and .eq() filters. */
  queries: Query[];
  rpc: Mock;
} = {
  callMetadata: null,
  callError: null,
  assistantError: null,
  queries: [],
  rpc: vi.fn(async () => ({ data: true, error: null })),
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      const query: Query = { table, op: "select", arg: undefined, filters: [] };
      db.queries.push(query);
      const chain: any = {
        select: (cols: string) => { query.op = "select"; query.arg = cols; return chain; },
        update: (payload: unknown) => { query.op = "update"; query.arg = payload; return chain; },
        eq: (col: string, val: unknown) => { query.filters.push([col, val]); return chain; },
        single: async () => {
          if (table === "calls") {
            return db.callError ? { data: null, error: db.callError } : { data: { metadata: db.callMetadata }, error: null };
          }
          if (table === "organizations") return { data: { timezone: "Australia/Sydney", country: "AU" }, error: null };
          if (table === "assistants") {
            return db.assistantError ? { data: null, error: db.assistantError } : { data: { name: "Copperline" }, error: null };
          }
          return { data: null, error: { message: `unexpected table ${table}` } };
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return chain;
    },
    rpc: (...args: unknown[]) => db.rpc(...args),
  })),
}));
vi.mock("@/lib/spam/spam-detector", () => ({ analyzeCall: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({
  sendMissedCallNotification: vi.fn(async () => "sent"),
  sendFailedCallNotification: vi.fn(async () => "sent"),
  sendUnsuccessfulCallNotification: vi.fn(async () => "sent"),
}));
vi.mock("@/lib/sms/caller-sms", () => ({ sendMissedCallTextBack: vi.fn() }));
vi.mock("@/lib/integrations/webhook-delivery", () => ({ deliverWebhooks: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({ withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })) }));

import { analyzeCall, type SpamAnalysisResult } from "@/lib/spam/spam-detector";
import {
  sendMissedCallNotification,
  sendFailedCallNotification,
  sendUnsuccessfulCallNotification,
} from "@/lib/notifications/notification-service";
import { sendMissedCallTextBack } from "@/lib/sms/caller-sms";
import { deliverWebhooks } from "@/lib/integrations/webhook-delivery";
import { POST } from "@/app/api/internal/call-completed/route";

const SECRET = "customer-pipeline-test-secret";
const CALL_ID = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const CALLER = "+61412345678";
const TRANSCRIPT = "Do you do hot water systems?";
const SUMMARY = "Asked about hot water systems";

const NOT_SPAM: SpamAnalysisResult = {
  isSpam: false, spamScore: 12, reasons: ["Unusual number format"], confidence: "low", recommendation: "allow",
};

// An AI-engaged call rated unsuccessful, shaped like the voice server's
// notifyCallCompleted payload (server.js cleanupSession).
function callCompleted(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/internal/call-completed", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET },
    body: JSON.stringify({
      callId: CALL_ID, organizationId: "org-1", assistantId: "asst-1", callerPhone: CALLER,
      status: "completed", durationSeconds: 90, transcript: TRANSCRIPT, endedReason: "customer-ended-call",
      summary: SUMMARY, callerName: "Jane", collectedData: { service: "hot water" },
      successEvaluation: "unsuccessful", unansweredQuestions: ["Do you work Sundays?"],
      ...overrides,
    }),
  });
}

const callReads = () => db.queries.filter((q) => q.table === "calls" && q.op === "select");
const callUpdates = () => db.queries.filter((q) => q.table === "calls" && q.op === "update");

const CLAIM_USAGE = ["claim_and_increment_call_usage", { p_call_id: CALL_ID, p_org_id: "org-1" }] as const;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_SECRET = SECRET;
  db.callMetadata = {};
  db.callError = null;
  db.assistantError = null;
  db.queries = [];
  vi.mocked(analyzeCall).mockResolvedValue(NOT_SPAM);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/internal/call-completed — customer pipeline with a callId (SCRUM-586 characterization)", () => {
  it("merges the spam result onto the stored metadata and writes the analysis columns (exact calls update)", async () => {
    db.callMetadata = { voice_provider: "self_hosted", successEvaluation: "unsuccessful", consentReason: "one_party", callerState: null };

    const res = await POST(callCompleted());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, notificationStatus: "sent" });
    expect(callReads()).toEqual([{ table: "calls", op: "select", arg: "metadata", filters: [["id", CALL_ID]] }]);
    expect(callUpdates()).toEqual([{
      table: "calls",
      op: "update",
      filters: [["id", CALL_ID]],
      arg: {
        is_spam: false,
        spam_score: 12,
        summary: SUMMARY,
        caller_name: "Jane",
        collected_data: { service: "hot water" },
        metadata: {
          voice_provider: "self_hosted",
          successEvaluation: "unsuccessful",
          consentReason: "one_party",
          callerState: null,
          ended_reason: "customer-ended-call",
          unansweredQuestions: ["Do you work Sundays?"],
          spam_analysis: { reasons: ["Unusual number format"], confidence: "low", recommendation: "allow" },
        },
      },
    }]);
  });

  it("runs every customer side effect: unsuccessful-call alert, text-back, call.completed webhook, usage claim", async () => {
    await POST(callCompleted());

    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(1);
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledWith({
      organizationId: "org-1", callId: CALL_ID, callerPhone: CALLER, timestamp: expect.any(Date),
      duration: 90, transcript: TRANSCRIPT, summary: SUMMARY, successEvaluation: "unsuccessful",
    });
    expect(sendMissedCallNotification).not.toHaveBeenCalled();
    expect(sendFailedCallNotification).not.toHaveBeenCalled();
    expect(sendMissedCallTextBack).toHaveBeenCalledTimes(1);
    expect(sendMissedCallTextBack).toHaveBeenCalledWith("org-1", CALLER, false);
    expect(deliverWebhooks).toHaveBeenCalledTimes(1);
    expect(deliverWebhooks).toHaveBeenCalledWith("org-1", "call.completed", {
      callId: CALL_ID, caller: CALLER, transcript: TRANSCRIPT, duration: 90, assistantName: "Copperline", outcome: "completed",
    });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith(...CLAIM_USAGE);
  });

  it("a failed metadata read still writes the spam columns, skips the metadata merge, logs it, and runs every side effect", async () => {
    db.callError = { message: "connection refused", code: "08006" };

    const res = await POST(callCompleted());

    expect(await res.json()).toEqual({ received: true, notificationStatus: "sent" });
    expect(callUpdates()).toHaveLength(1);
    const update = callUpdates()[0];
    expect(update.filters).toEqual([["id", CALL_ID]]);
    expect(update.arg).toEqual({
      is_spam: false, spam_score: 12, summary: SUMMARY, caller_name: "Jane", collected_data: { service: "hot water" },
    });
    expect(update.arg).not.toHaveProperty("metadata");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch existing call metadata"),
      expect.objectContaining({ callId: CALL_ID }),
    );
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(1);
    expect(sendMissedCallTextBack).toHaveBeenCalledTimes(1);
    expect(deliverWebhooks).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith(...CLAIM_USAGE);
  });

  it("a spam-flagged call gets no alert and no text-back, but still gets its webhook and is billed", async () => {
    vi.mocked(analyzeCall).mockResolvedValue({
      isSpam: true, spamScore: 75, reasons: ["Robocall phrases"], confidence: "medium", recommendation: "flag",
    });

    const res = await POST(callCompleted());

    expect(await res.json()).toEqual({ received: true, notificationStatus: "skipped" });
    expect(callUpdates()[0].arg).toMatchObject({ is_spam: true, spam_score: 75 });
    expect(sendUnsuccessfulCallNotification).not.toHaveBeenCalled();
    expect(sendMissedCallNotification).not.toHaveBeenCalled();
    expect(sendFailedCallNotification).not.toHaveBeenCalled();
    expect(sendMissedCallTextBack).not.toHaveBeenCalled();
    expect(deliverWebhooks).toHaveBeenCalledWith("org-1", "call.completed", expect.objectContaining({ callId: CALL_ID }));
    expect(db.rpc).toHaveBeenCalledWith(...CLAIM_USAGE);
  });

  it("a blocked spam call is not billed", async () => {
    vi.mocked(analyzeCall).mockResolvedValue({
      isSpam: true, spamScore: 100, reasons: ["Previously marked as spam"], confidence: "high", recommendation: "block",
    });

    await POST(callCompleted());

    expect(db.rpc).not.toHaveBeenCalled();
    expect(deliverWebhooks).toHaveBeenCalledTimes(1);
  });

  it("a failed spam analysis writes nothing to the call row, still alerts the owner, and suppresses the text-back", async () => {
    vi.mocked(analyzeCall).mockRejectedValue(new Error("blocklist lookup failed"));

    const res = await POST(callCompleted());

    expect(await res.json()).toEqual({ received: true, notificationStatus: "sent" });
    expect(callUpdates()).toHaveLength(0);
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(1);
    expect(sendMissedCallTextBack).not.toHaveBeenCalled();
    expect(deliverWebhooks).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith(...CLAIM_USAGE);
  });

  it("a withheld number gets no spam analysis and no call-row write; the alert and webhook say Unknown; no text-back", async () => {
    const res = await POST(callCompleted({ callerPhone: "" }));

    expect(await res.json()).toEqual({ received: true, notificationStatus: "sent" });
    expect(analyzeCall).not.toHaveBeenCalled();
    expect(callUpdates()).toHaveLength(0);
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledWith(expect.objectContaining({ callerPhone: "Unknown" }));
    expect(sendMissedCallTextBack).not.toHaveBeenCalled();
    expect(deliverWebhooks).toHaveBeenCalledWith("org-1", "call.completed", expect.objectContaining({ caller: "Unknown" }));
    expect(db.rpc).toHaveBeenCalledWith(...CLAIM_USAGE);
  });

  it.each([
    ["missed", sendMissedCallNotification],
    ["failed", sendFailedCallNotification],
  ] as const)("a %s call fires its alert, the text-back and a call.missed webhook, and is not billed", async (status, sender) => {
    const res = await POST(callCompleted({
      status, durationSeconds: 5, transcript: undefined, summary: undefined, successEvaluation: undefined,
    }));

    expect(await res.json()).toEqual({ received: true, notificationStatus: "sent" });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1", callId: CALL_ID, callerPhone: CALLER }));
    expect(sendUnsuccessfulCallNotification).not.toHaveBeenCalled();
    expect(sendMissedCallTextBack).toHaveBeenCalledWith("org-1", CALLER, false);
    expect(deliverWebhooks).toHaveBeenCalledWith("org-1", "call.missed", expect.objectContaining({ callId: CALL_ID, outcome: status }));
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("the webhook names no assistant when the call has none (no lookup) or the lookup fails", async () => {
    await POST(callCompleted({ assistantId: null }));

    expect(db.queries.some((q) => q.table === "assistants")).toBe(false);
    expect(deliverWebhooks).toHaveBeenLastCalledWith("org-1", "call.completed", expect.objectContaining({ assistantName: null }));

    db.assistantError = { message: "connection refused", code: "08006" };
    await POST(callCompleted());

    expect(deliverWebhooks).toHaveBeenCalledTimes(2);
    expect(deliverWebhooks).toHaveBeenLastCalledWith("org-1", "call.completed", expect.objectContaining({ assistantName: null }));
  });

  it("without a callId there is no call row: no calls read or write, and usage falls back to the plain increment", async () => {
    const res = await POST(callCompleted({ callId: null }));

    expect(await res.json()).toEqual({ received: true, notificationStatus: "sent" });
    expect(callReads()).toHaveLength(0);
    expect(callUpdates()).toHaveLength(0);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("increment_call_usage", { org_id: "org-1" });
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledWith(expect.objectContaining({ callId: "unknown" }));
    expect(deliverWebhooks).toHaveBeenCalledWith("org-1", "call.completed", expect.objectContaining({ callId: "unknown" }));
  });
});
