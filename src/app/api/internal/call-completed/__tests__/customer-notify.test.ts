// src/app/api/internal/call-completed/__tests__/customer-notify.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-598: a call the assistant placed to a customer for the owner
// (calls.metadata.call_type "customer_notify"). Not a customer calling in: no spam
// scoring, no missed/failed/unsuccessful alert, no text-back (we called THEM), no
// integrations webhook, not a plan call. The owner gets the call's outcome email
// (step 4e): after the response, once per call (a conditional claim on
// metadata.notify_outcome_emailed_at), and a failure pages without failing the route.

const after: Array<() => Promise<unknown>> = [];
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn((work: () => Promise<unknown>) => { after.push(work); }) }));

type Res = { data: unknown; error: unknown };
const db = {
  stored: null as Record<string, unknown> | null,
  fresh: null as Record<string, unknown> | null,
  claim: { data: [{ id: "c" }], error: null } as Res,
  updates: [] as Array<{ payload: any; filters: Array<[string, unknown[]]> }>,
  callsReads: 0,
  storedError: null as unknown,
  rpc: vi.fn(async () => ({ data: true, error: null })),
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
            return { data: { metadata: db.fresh }, error: null };
          }
          if (table === "organizations") return { data: { timezone: "Australia/Perth", country: "AU" }, error: null };
          if (table === "assistants") return { data: { name: "Receptionist" }, error: null };
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
    rpc: db.rpc,
  })),
}));
vi.mock("@/lib/spam/spam-detector", () => ({ analyzeCall: vi.fn(async () => ({ isSpam: false, spamScore: 0, reasons: [], confidence: "low", recommendation: "allow" })) }));
vi.mock("@/lib/notifications/notification-service", () => ({
  sendMissedCallNotification: vi.fn(async () => "sent"),
  sendFailedCallNotification: vi.fn(async () => "sent"),
  sendUnsuccessfulCallNotification: vi.fn(async () => "sent"),
  sendOwnerPinLockedNotification: vi.fn(async () => "sent"),
  sendOwnerAssistantRecapNotification: vi.fn(async () => "sent"),
  sendCustomerCallOutcomeNotification: vi.fn(async () => "sent"),
}));
vi.mock("@/lib/owner-assistant/recap", () => ({ buildOwnerRecap: vi.fn() }));
vi.mock("@/lib/owner-assistant/call-outcome", () => ({ buildCallOutcome: vi.fn() }));
vi.mock("@/lib/sms/caller-sms", () => ({ sendMissedCallTextBack: vi.fn() }));
vi.mock("@/lib/integrations/webhook-delivery", () => ({ deliverWebhooks: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({ withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })), rateLimitDistributed: vi.fn() }));
vi.mock("@/lib/observability/page-sentry", () => ({ pageSentry: vi.fn() }));

import { analyzeCall } from "@/lib/spam/spam-detector";
import {
  sendMissedCallNotification,
  sendFailedCallNotification,
  sendUnsuccessfulCallNotification,
  sendCustomerCallOutcomeNotification,
  sendOwnerAssistantRecapNotification,
} from "@/lib/notifications/notification-service";
import { buildCallOutcome } from "@/lib/owner-assistant/call-outcome";
import { buildOwnerRecap } from "@/lib/owner-assistant/recap";
import { sendMissedCallTextBack } from "@/lib/sms/caller-sms";
import { deliverWebhooks } from "@/lib/integrations/webhook-delivery";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { POST } from "@/app/api/internal/call-completed/route";

const SECRET = "customer-notify-test-secret";
const CALL_ID = "55555555-5555-4555-8555-555555555555";
const REPORT = { callId: CALL_ID, purpose: "confirm", customer: "Jane Smith", phone: "+61412345678", bookingWhen: "x", result: { kind: "no_answer" }, diary: [], assistantOutcome: null, assistantNote: null, summary: null, voicemailText: null };
const NOTIFY_META = { voice_provider: "self_hosted", call_type: "customer_notify", notify: { purpose: "confirm", appointment_id: "a1", requested_by_call_id: "o1" } };

function ended(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/internal/call-completed", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET },
    body: JSON.stringify({ callId: CALL_ID, organizationId: "org-1", assistantId: "asst-1", callerPhone: "+61412345678", status: "missed", durationSeconds: 0, transcript: "", endedReason: "customer-call-no-answer", callType: "customer_notify", ...overrides }),
  });
}
async function runAfter() {
  while (after.length) await after.shift()!();
}

beforeEach(() => {
  vi.clearAllMocks();
  after.length = 0;
  process.env.INTERNAL_API_SECRET = SECRET;
  db.stored = { ...NOTIFY_META };
  db.fresh = { ...NOTIFY_META };
  db.claim = { data: [{ id: CALL_ID }], error: null };
  db.updates = [];
  db.callsReads = 0;
  db.storedError = null;
  vi.mocked(buildCallOutcome).mockResolvedValue(REPORT as any);
  vi.mocked(sendCustomerCallOutcomeNotification).mockResolvedValue("sent");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function noCustomerPipeline() {
  expect(analyzeCall).not.toHaveBeenCalled();
  expect(sendMissedCallNotification).not.toHaveBeenCalled();
  expect(sendFailedCallNotification).not.toHaveBeenCalled();
  expect(sendUnsuccessfulCallNotification).not.toHaveBeenCalled();
  expect(sendMissedCallTextBack).not.toHaveBeenCalled();
  expect(deliverWebhooks).not.toHaveBeenCalled();
}

describe("call-completed for a call the assistant placed to a customer", () => {
  it("a no-answer: none of the customer pipeline (no 'sorry we missed you' text to the customer we rang), then the outcome email", async () => {
    const res = await POST(ended());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, customerNotifyCall: true });
    expect(sendCustomerCallOutcomeNotification).not.toHaveBeenCalled(); // not before the response
    await runAfter();
    noCustomerPipeline();
    expect(buildCallOutcome).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", callId: CALL_ID, timezone: "Australia/Perth" });
    const claim = db.updates.find((u) => u.filters.some(([m]) => m === "is"));
    expect(claim?.filters).toEqual(expect.arrayContaining([["eq", ["id", CALL_ID]], ["is", ["metadata->>notify_outcome_emailed_at", null]], ["select", ["id"]]]));
    expect(claim?.payload.metadata).toMatchObject({ call_type: "customer_notify", notify: NOTIFY_META.notify, notify_outcome_emailed_at: expect.any(String) });
    expect(sendCustomerCallOutcomeNotification).toHaveBeenCalledWith({ organizationId: "org-1", report: REPORT, timesInDefaultZone: false });
    expect(buildOwnerRecap).not.toHaveBeenCalled();
    expect(sendOwnerAssistantRecapNotification).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("[Internal] Customer-call outcome email:", { callId: CALL_ID, organizationId: "org-1", outcome: "sent" });
  });

  it("an answered call is not a plan call (no usage RPC), and still none of the customer pipeline", async () => {
    await POST(ended({ status: "completed", durationSeconds: 130, transcript: "AI: Hi... User: Thursday please" }));
    await runAfter();
    expect(db.rpc).not.toHaveBeenCalled();
    noCustomerPipeline();
    expect(sendCustomerCallOutcomeNotification).toHaveBeenCalledTimes(1);
  });

  it("an unreadable row: the voice server's own word keeps the customer we rang from getting a text-back", async () => {
    db.storedError = { code: "57014" };
    await POST(ended());
    await runAfter();
    noCustomerPipeline();
    expect(pageSentry).toHaveBeenCalledWith(expect.objectContaining({ reason: SENTRY_REASONS.CALL_METADATA_READ_FAILED }));
  });

  it("the row decides: a payload claiming 'customer_notify' on a customer's call changes nothing", async () => {
    db.stored = { voice_provider: "self_hosted" };
    await POST(ended({ status: "completed", durationSeconds: 60, transcript: "hello" }));
    await runAfter();
    expect(analyzeCall).toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalled();
    expect(buildCallOutcome).not.toHaveBeenCalled();
  });

  it("once per call: a retried delivery (stamp already there, or the conditional claim lost) sends nothing", async () => {
    db.fresh = { ...NOTIFY_META, notify_outcome_emailed_at: "2026-10-27T03:05:00Z" };
    await POST(ended());
    await runAfter();
    expect(sendCustomerCallOutcomeNotification).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("[Internal] Customer-call outcome email:", expect.objectContaining({ outcome: "claimed_elsewhere" }));
    db.fresh = { ...NOTIFY_META };
    db.callsReads = 0;
    db.claim = { data: [], error: null };
    await POST(ended());
    await runAfter();
    expect(sendCustomerCallOutcomeNotification).not.toHaveBeenCalled();
  });

  it("records that can't be read, or a send that throws, page CUSTOMER_CALL_OUTCOME_EMAIL_FAILED and never fail the route", async () => {
    vi.mocked(buildCallOutcome).mockResolvedValueOnce(null);
    expect((await POST(ended())).status).toBe(200);
    await runAfter();
    expect(sendCustomerCallOutcomeNotification).not.toHaveBeenCalled();
    expect(pageSentry).toHaveBeenCalledWith(expect.objectContaining({ reason: SENTRY_REASONS.CUSTOMER_CALL_OUTCOME_EMAIL_FAILED, level: "error", extras: { organizationId: "org-1", callId: CALL_ID } }));
    vi.mocked(pageSentry).mockClear();
    db.callsReads = 0;
    vi.mocked(sendCustomerCallOutcomeNotification).mockRejectedValueOnce(new Error("no owner email"));
    expect((await POST(ended())).status).toBe(200);
    await runAfter();
    expect(pageSentry).toHaveBeenCalledWith(expect.objectContaining({ reason: SENTRY_REASONS.CUSTOMER_CALL_OUTCOME_EMAIL_FAILED }));
  });
});
