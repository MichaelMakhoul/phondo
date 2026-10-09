// src/app/api/internal/call-completed/__tests__/owner-call.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// SCRUM-586: an OWNER call (the business owner ringing their own assistant,
// calls.metadata.call_type === "owner") is not a customer interaction: no spam
// scoring, no missed/failed/unsuccessful alert (it would email the owner about
// their own call), no caller text-back, no call.completed webhook. Billing still
// counts it (spec decision). The flag is read from the DB, never the payload.

vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn((work: () => Promise<unknown>) => { void work(); }) }));

const adminState: { metadata: Record<string, unknown> | null; metadataError: unknown; rpc: Mock; updates: Array<{ table: string; payload: unknown }> } = {
  metadata: null, metadataError: null, rpc: vi.fn(async () => ({ data: true, error: null })), updates: [],
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        update: (payload: unknown) => { adminState.updates.push({ table, payload }); return chain; },
        single: async () => {
          if (table === "calls") return { data: adminState.metadataError ? null : { metadata: adminState.metadata }, error: adminState.metadataError };
          if (table === "organizations") return { data: { timezone: "Australia/Sydney", country: "AU" }, error: null };
          if (table === "assistants") return { data: { name: "Copperline" }, error: null };
          return { data: null, error: { message: `unexpected table ${table}` } };
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return chain;
    },
    rpc: (...args: unknown[]) => adminState.rpc(...args),
  })),
}));
vi.mock("@/lib/spam/spam-detector", () => ({ analyzeCall: vi.fn(async () => ({ isSpam: false, spamScore: 0, reasons: [], confidence: "low", recommendation: "allow" })) }));
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
import {
  sendMissedCallNotification,
  sendFailedCallNotification,
  sendUnsuccessfulCallNotification,
} from "@/lib/notifications/notification-service";
import { sendMissedCallTextBack } from "@/lib/sms/caller-sms";
import { deliverWebhooks } from "@/lib/integrations/webhook-delivery";
import { POST } from "@/app/api/internal/call-completed/route";

const SECRET = "owner-call-test-secret";
const CALL_ID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";

// An AI-engaged call rated unsuccessful: for a CUSTOMER this fires the
// unsuccessful-call alert, the text-back and the call.completed webhook.
function completedCall(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/internal/call-completed", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET },
    body: JSON.stringify({
      callId: CALL_ID, organizationId: "org-1", assistantId: "asst-1", callerPhone: "+61412345678",
      status: "completed", durationSeconds: 90, transcript: "what's on tomorrow", successEvaluation: "unsuccessful",
      ...overrides,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_SECRET = SECRET;
  adminState.metadata = null;
  adminState.metadataError = null;
  adminState.updates = [];
  adminState.rpc.mockClear();
});

describe("POST /api/internal/call-completed — owner calls (SCRUM-586)", () => {
  it("skips spam scoring, alerts, text-back and webhooks for an owner call, but still bills it", async () => {
    adminState.metadata = { call_type: "owner", ended_reason: "hangup" };
    const res = await POST(completedCall());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, notificationStatus: "skipped", ownerCall: true });
    expect(analyzeCall).not.toHaveBeenCalled();
    expect(sendUnsuccessfulCallNotification).not.toHaveBeenCalled();
    expect(sendMissedCallTextBack).not.toHaveBeenCalled();
    expect(deliverWebhooks).not.toHaveBeenCalled();
    expect(adminState.rpc).toHaveBeenCalledWith("claim_and_increment_call_usage", { p_call_id: CALL_ID, p_org_id: "org-1" });
  });

  it("a customer call on the same payload still gets the full pipeline (control)", async () => {
    adminState.metadata = { ended_reason: "hangup" };
    const res = await POST(completedCall());
    expect(res.status).toBe(200);
    expect((await res.json()).ownerCall).toBeUndefined();
    expect(analyzeCall).toHaveBeenCalledTimes(1);
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(1);
    expect(sendMissedCallTextBack).toHaveBeenCalledTimes(1);
    expect(deliverWebhooks).toHaveBeenCalledWith("org-1", "call.completed", expect.objectContaining({ callId: CALL_ID, assistantName: "Copperline" }));
    // The spam-result merge still preserves existing metadata (re-read right before the write).
    const callUpdate = adminState.updates.find((u) => u.table === "calls")!;
    expect(callUpdate.payload).toMatchObject({ is_spam: false });
    expect((callUpdate.payload as any).metadata.spam_analysis).toBeDefined();
  });

  it("a payload claiming callType:'owner' is ignored — only the DB flag counts", async () => {
    adminState.metadata = {};
    await POST(completedCall({ callType: "owner" }));
    expect(analyzeCall).toHaveBeenCalledTimes(1);
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(1);
  });

  it("only the exact value 'owner' marks an owner call — any other call_type runs the customer pipeline", async () => {
    for (const call_type of ["Owner", "outbound", true]) {
      adminState.metadata = { call_type };
      const res = await POST(completedCall());
      expect((await res.json()).ownerCall).toBeUndefined();
    }
    expect(analyzeCall).toHaveBeenCalledTimes(3);
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(3);
    expect(deliverWebhooks).toHaveBeenCalledTimes(3);
  });

  it("a failed metadata read is treated as a customer call (never silently drops a customer alert)", async () => {
    adminState.metadataError = { message: "connection refused", code: "08006" };
    const res = await POST(completedCall());
    expect(res.status).toBe(200);
    expect(analyzeCall).toHaveBeenCalledTimes(1);
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(1);
  });

  // The failed-call and missed-call alerts are the other two kinds the owner
  // would otherwise get about their own call; the webhook a failed/missed call
  // fires is call.missed.
  it.each([
    ["failed", sendFailedCallNotification],
    ["missed", sendMissedCallNotification],
  ] as const)("a %s owner call gets no alert, no text-back and no call.missed webhook", async (status, sender) => {
    adminState.metadata = { call_type: "owner" };
    const res = await POST(completedCall({ status, durationSeconds: 5, transcript: undefined, successEvaluation: undefined }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, notificationStatus: "skipped", ownerCall: true });
    expect(sender).not.toHaveBeenCalled();
    expect(sendMissedCallTextBack).not.toHaveBeenCalled();
    expect(deliverWebhooks).not.toHaveBeenCalled();
  });

  it("writes nothing to an owner call's row, so the summary and caller name the voice server wrote are never overwritten", async () => {
    adminState.metadata = { call_type: "owner" };
    await POST(completedCall({ summary: "post-call analysis summary", callerName: "Someone else" }));
    expect(adminState.updates.filter((u) => u.table === "calls")).toEqual([]);
  });
});
