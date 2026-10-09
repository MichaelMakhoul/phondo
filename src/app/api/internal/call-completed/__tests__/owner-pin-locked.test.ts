import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// SCRUM-586: a caller from the registered owner mobile who tripped the PIN
// lockout CONTINUED AS A CUSTOMER CALL (calls.metadata.owner_auth === "locked",
// call_type NOT "owner"). The normal customer pipeline runs unchanged, PLUS one
// lockout email to the owner, deduped per call by the owner_lock_emailed_at
// stamp. "failed"/"verified" send nothing. A send failure is paged
// ([ALERT:error]) and never fails the route. Flags come from the DB row, never
// the payload.
//
// ORDER (ruled after the owner-call review): the email goes out AFTER the
// spam-merge write (step 2), never between the hoisted metadata read and that
// write — a Resend round trip there would stretch the read-modify-write window
// to ~1 s. The stamp is then written from a FRESH re-read that merges only its
// own key, so a stale copy is never written back over a concurrent writer.

vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn((work: () => Promise<unknown>) => { void work(); }) }));

type Update = { table: string; payload: any };

const db: {
  /** The calls row's metadata. A write lands in it when the update is awaited. */
  metadata: Record<string, unknown> | null;
  /** What each calls read returned, in order. */
  reads: Array<Record<string, unknown> | null>;
  /** 1-based number of the calls read that returns an error / throws (null = none). */
  failCallRead: number | null;
  throwCallRead: number | null;
  failStampWrite: boolean;
  updates: Update[];
  /** calls reads, calls writes and the lockout send, in the order they happened. */
  events: string[];
  rpc: Mock;
} = {
  metadata: null, reads: [], failCallRead: null, throwCallRead: null, failStampWrite: false,
  updates: [], events: [], rpc: vi.fn(async () => ({ data: true, error: null })),
};

// The stamp is the only calls write that touches nothing but the metadata column
// (the spam merge also writes is_spam / spam_score).
const isStamp = (u: Update) => u.table === "calls" && Object.keys(u.payload).length === 1 && "metadata" in u.payload;
const stamps = () => db.updates.filter(isStamp);
const callUpdates = () => db.updates.filter((u) => u.table === "calls");

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      let pending: Update | null = null;
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        update: (payload: unknown) => { pending = { table, payload }; return chain; },
        single: async () => {
          if (table === "calls") {
            db.events.push("read:calls");
            const n = db.events.filter((e) => e === "read:calls").length;
            if (db.throwCallRead === n) throw new Error("socket hang up");
            if (db.failCallRead === n) return { data: null, error: { message: "connection refused", code: "08006" } };
            const snapshot = structuredClone(db.metadata);
            db.reads.push(snapshot);
            return { data: { metadata: snapshot }, error: null };
          }
          if (table === "organizations") return { data: { timezone: "Australia/Sydney", country: "AU" }, error: null };
          if (table === "assistants") return { data: { name: "Copperline" }, error: null };
          return { data: null, error: { message: `unexpected table ${table}` } };
        },
        // An awaited .update(...).eq(...) lands here: the write happens now.
        then: (resolve: (v: unknown) => unknown) => {
          let error: unknown = null;
          if (pending) {
            db.updates.push(pending);
            db.events.push(isStamp(pending) ? "update:stamp" : `update:${pending.table}`);
            if (isStamp(pending) && db.failStampWrite) error = { message: "write refused", code: "42501" };
            else if (pending.table === "calls" && pending.payload.metadata !== undefined) db.metadata = structuredClone(pending.payload.metadata);
          }
          return Promise.resolve({ data: null, error }).then(resolve);
        },
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
  sendOwnerPinLockedNotification: vi.fn(),
}));
vi.mock("@/lib/sms/caller-sms", () => ({ sendMissedCallTextBack: vi.fn() }));
vi.mock("@/lib/integrations/webhook-delivery", () => ({ deliverWebhooks: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({ withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })) }));
// pageSentry stays REAL (wrapped in a spy) so the failure test can read the [ALERT:error]
// line it emits — @sentry/nextjs is off in production (SCRUM-320), that line is the page.
// withScope is a no-op so its Sentry leg stays silent.
vi.mock("@/lib/observability/page-sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/observability/page-sentry")>();
  return { pageSentry: vi.fn(actual.pageSentry) };
});
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn(), withScope: vi.fn() }));

import { analyzeCall, type SpamAnalysisResult } from "@/lib/spam/spam-detector";
import { sendUnsuccessfulCallNotification, sendOwnerPinLockedNotification } from "@/lib/notifications/notification-service";
import { deliverWebhooks } from "@/lib/integrations/webhook-delivery";
import { pageSentry } from "@/lib/observability/page-sentry";
import { POST } from "@/app/api/internal/call-completed/route";

const SECRET = "owner-pin-locked-test-secret";
const CALL_ID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const NOT_SPAM: SpamAnalysisResult = { isSpam: false, spamScore: 0, reasons: [], confidence: "low", recommendation: "allow" };

function completedCall(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/internal/call-completed", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET },
    body: JSON.stringify({
      callId: CALL_ID, organizationId: "org-1", assistantId: "asst-1", callerPhone: "+61412345137",
      status: "completed", durationSeconds: 90, transcript: "hi", successEvaluation: "unsuccessful",
      ...overrides,
    }),
  });
}

/** The voice server's other post-call writer landing while the email is in flight. */
function sendThatRacesAWriter() {
  vi.mocked(sendOwnerPinLockedNotification).mockImplementation(async () => {
    db.events.push("send:lock-email");
    db.metadata = { ...db.metadata, transcript_source: "deepgram" };
    return "sent";
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_SECRET = SECRET;
  db.metadata = null;
  db.reads = [];
  db.failCallRead = null;
  db.throwCallRead = null;
  db.failStampWrite = false;
  db.updates = [];
  db.events = [];
  db.rpc.mockClear();
  vi.mocked(analyzeCall).mockReset();
  vi.mocked(analyzeCall).mockResolvedValue(NOT_SPAM);
  vi.mocked(sendOwnerPinLockedNotification).mockReset();
  vi.mocked(sendOwnerPinLockedNotification).mockImplementation(async () => {
    db.events.push("send:lock-email");
    return "sent";
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/internal/call-completed — PIN lockout email (SCRUM-586)", () => {
  it("a locked call is still a customer call (full pipeline) PLUS one owner email with the masked number, then stamps the call", async () => {
    db.metadata = { owner_auth: "locked", ended_reason: "hangup" };
    const res = await POST(completedCall());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ownerLockEmail).toBe("sent");
    expect(body.ownerCall).toBeUndefined(); // not the owner bypass
    // Customer pipeline untouched.
    expect(analyzeCall).toHaveBeenCalledTimes(1);
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(1);
    expect(deliverWebhooks).toHaveBeenCalledTimes(1);
    // Exactly one lockout email, masked, keyed to this call.
    expect(sendOwnerPinLockedNotification).toHaveBeenCalledTimes(1);
    expect(sendOwnerPinLockedNotification).toHaveBeenCalledWith({
      organizationId: "org-1", callId: CALL_ID, callerPhoneMasked: "04xx xxx 137", timestamp: expect.any(Date),
    });
    // The full number never reaches the sender.
    expect(JSON.stringify(vi.mocked(sendOwnerPinLockedNotification).mock.calls)).not.toMatch(/412345137/);
    // One stamp, and the row ends up with the stamp AND the spam merge.
    expect(stamps()).toHaveLength(1);
    expect(db.metadata).toMatchObject({
      owner_auth: "locked",
      owner_lock_emailed_at: expect.stringMatching(ISO),
      spam_analysis: { recommendation: "allow" },
    });
  });

  it("sends AFTER the spam-merge write — never between the hoisted read and that write — then re-reads before stamping", async () => {
    db.metadata = { owner_auth: "locked" };
    await POST(completedCall());
    expect(db.events).toEqual(["read:calls", "update:calls", "send:lock-email", "read:calls", "update:stamp"]);
    // The step-2 write is the unchanged customer merge: it carries no stamp.
    const merge = callUpdates().find((u) => !isStamp(u))!;
    expect(merge.payload).toMatchObject({ is_spam: false, spam_score: 0 });
    expect(merge.payload.metadata.owner_auth).toBe("locked");
    expect(merge.payload.metadata).not.toHaveProperty("owner_lock_emailed_at");
  });

  it("stamps from a FRESH read and merges only its own key — a writer that landed during the send survives", async () => {
    db.metadata = { owner_auth: "locked", ended_reason: "hangup" };
    sendThatRacesAWriter();
    await POST(completedCall());
    expect(db.reads).toHaveLength(2);
    expect(db.reads[1]).toMatchObject({ transcript_source: "deepgram" }); // the re-read saw the racing write
    const stamp = stamps()[0];
    expect(Object.keys(stamp.payload)).toEqual(["metadata"]); // no other column rewritten
    const { owner_lock_emailed_at, ...rest } = stamp.payload.metadata;
    expect(owner_lock_emailed_at).toMatch(ISO);
    expect(rest).toEqual(db.reads[1]); // exactly the fresh copy + the one key
    // Net: nothing the other writer added, nor the spam merge, was lost.
    expect(db.metadata).toMatchObject({
      owner_auth: "locked", transcript_source: "deepgram", spam_analysis: { recommendation: "allow" },
      owner_lock_emailed_at: expect.stringMatching(ISO),
    });
  });

  it("emails and stamps a locked call that gets no spam analysis (withheld number): no step-2 write, masked as unknown", async () => {
    db.metadata = { owner_auth: "locked" };
    const res = await POST(completedCall({ callerPhone: "" }));
    expect((await res.json()).ownerLockEmail).toBe("sent");
    expect(analyzeCall).not.toHaveBeenCalled();
    expect(sendOwnerPinLockedNotification).toHaveBeenCalledWith(expect.objectContaining({ callerPhoneMasked: "an unknown number" }));
    expect(db.events).toEqual(["read:calls", "send:lock-email", "read:calls", "update:stamp"]);
    expect(db.metadata).toMatchObject({ owner_auth: "locked", owner_lock_emailed_at: expect.stringMatching(ISO) });
  });

  it("the security alert is not spam-gated: a spam-flagged locked call still emails the owner (the customer alert stays suppressed)", async () => {
    db.metadata = { owner_auth: "locked" };
    vi.mocked(analyzeCall).mockResolvedValue({ isSpam: true, spamScore: 80, reasons: ["Robocall phrases"], confidence: "high", recommendation: "flag" });
    const res = await POST(completedCall());
    expect((await res.json()).ownerLockEmail).toBe("sent");
    expect(sendUnsuccessfulCallNotification).not.toHaveBeenCalled();
    expect(sendOwnerPinLockedNotification).toHaveBeenCalledTimes(1);
    expect(stamps()).toHaveLength(1);
  });

  it("does not email again when the call is already stamped (webhook retry) and leaves the stamp as it was", async () => {
    db.metadata = { owner_auth: "locked", owner_lock_emailed_at: "2026-10-15T03:01:00.000Z" };
    const res = await POST(completedCall());
    expect((await res.json()).ownerLockEmail).toBeUndefined();
    expect(sendOwnerPinLockedNotification).not.toHaveBeenCalled();
    expect(stamps()).toHaveLength(0);
    expect(db.metadata).toMatchObject({ owner_lock_emailed_at: "2026-10-15T03:01:00.000Z" });
  });

  it("owner_auth 'failed' or 'verified' (or none) sends nothing and writes no stamp", async () => {
    for (const metadata of [{ owner_auth: "failed" }, { owner_auth: "verified" }, { ended_reason: "hangup" }]) {
      db.metadata = metadata;
      const res = await POST(completedCall());
      expect((await res.json()).ownerLockEmail).toBeUndefined();
    }
    expect(sendOwnerPinLockedNotification).not.toHaveBeenCalled();
    expect(stamps()).toHaveLength(0);
  });

  it("a verified owner call takes the owner bypass and never the lockout email (no interference)", async () => {
    db.metadata = { call_type: "owner", owner_auth: "verified" };
    const body = await (await POST(completedCall())).json();
    expect(body.ownerCall).toBe(true);
    expect(body.ownerLockEmail).toBeUndefined();
    expect(sendOwnerPinLockedNotification).not.toHaveBeenCalled();
    expect(sendUnsuccessfulCallNotification).not.toHaveBeenCalled();
  });

  it("ignores a payload claiming ownerAuth:'locked' — only the DB row counts", async () => {
    db.metadata = {};
    await POST(completedCall({ ownerAuth: "locked", metadata: { owner_auth: "locked" } }));
    expect(sendOwnerPinLockedNotification).not.toHaveBeenCalled();
  });

  it("a send failure is paged with [ALERT:error], leaves no stamp, and the route still returns 200", async () => {
    db.metadata = { owner_auth: "locked" };
    const failure = new Error("owner-pin-locked: 0 notification channels delivered");
    vi.mocked(sendOwnerPinLockedNotification).mockRejectedValueOnce(failure);
    const res = await POST(completedCall());
    expect(res.status).toBe(200);
    expect((await res.json()).ownerLockEmail).toBe("failed");
    expect(pageSentry).toHaveBeenCalledTimes(1);
    expect(pageSentry).toHaveBeenCalledWith(expect.objectContaining({
      service: "next-api", reason: "owner-pin-lock-email-failed", level: "error", err: failure,
      extras: { organizationId: "org-1", callId: CALL_ID }, // ids only — no phone number
    }));
    expect(stamps()).toHaveLength(0);
    expect(db.metadata).not.toHaveProperty("owner_lock_emailed_at");
    // Customer pipeline still ran.
    expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(1);
    expect(deliverWebhooks).toHaveBeenCalledTimes(1);
  });

  it("the page is the real [ALERT:error] line: tagged with the reason and the ids, never the caller's number", async () => {
    db.metadata = { owner_auth: "locked" };
    vi.mocked(sendOwnerPinLockedNotification).mockRejectedValueOnce(new Error("owner-pin-locked: 0 notification channels delivered"));
    await POST(completedCall());
    const alerts = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith("[ALERT:error]"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("[next-api]");
    expect(alerts[0]).toContain("reason=owner-pin-lock-email-failed");
    expect(alerts[0]).toContain("organizationId=org-1");
    expect(alerts[0]).toContain(`callId=${CALL_ID}`);
    expect(alerts[0]).not.toMatch(/412345137/);
  });

  it("'skipped' (demo org) is reported and not stamped, so a later real owner would still be told", async () => {
    db.metadata = { owner_auth: "locked" };
    vi.mocked(sendOwnerPinLockedNotification).mockResolvedValueOnce("skipped");
    expect((await (await POST(completedCall())).json()).ownerLockEmail).toBe("skipped");
    expect(stamps()).toHaveLength(0);
    expect(pageSentry).not.toHaveBeenCalled();
  });

  describe("the stamp is best-effort: the email already went out, so nothing here may turn 'sent' into a failure", () => {
    it("a failed fresh re-read writes NO stamp (never a stale write-back), logs it, and still reports 'sent'", async () => {
      db.metadata = { owner_auth: "locked" };
      db.failCallRead = 2;
      const res = await POST(completedCall());
      expect(res.status).toBe(200);
      expect((await res.json()).ownerLockEmail).toBe("sent");
      expect(stamps()).toHaveLength(0);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("owner_lock_emailed_at"), expect.objectContaining({ callId: CALL_ID }),
      );
      expect(pageSentry).not.toHaveBeenCalled(); // the owner WAS told
    });

    it("a thrown re-read is contained: 200, 'sent', no stamp, and no false 'email failed' page", async () => {
      db.metadata = { owner_auth: "locked" };
      db.throwCallRead = 2;
      const res = await POST(completedCall());
      expect(res.status).toBe(200);
      expect((await res.json()).ownerLockEmail).toBe("sent");
      expect(stamps()).toHaveLength(0);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("owner_lock_emailed_at"), expect.objectContaining({ callId: CALL_ID }),
      );
      expect(pageSentry).not.toHaveBeenCalled();
      expect(deliverWebhooks).toHaveBeenCalledTimes(1);
    });

    it("a refused stamp write is logged and the route still reports 'sent' with the customer pipeline intact", async () => {
      db.metadata = { owner_auth: "locked" };
      db.failStampWrite = true;
      const res = await POST(completedCall());
      expect(res.status).toBe(200);
      expect((await res.json()).ownerLockEmail).toBe("sent");
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("owner_lock_emailed_at"), expect.objectContaining({ callId: CALL_ID }),
      );
      expect(pageSentry).not.toHaveBeenCalled();
      expect(sendUnsuccessfulCallNotification).toHaveBeenCalledTimes(1);
    });
  });
});
