import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";

// SCRUM-447 suite for the callback-reminders cron: the claim/release
// semantics from SCRUM-429 (previously only enforced by code review), plus
// the new behaviors — typed NotificationDeliveryError branching (replacing
// the "0 notification channels delivered" message regex), the
// reminder_delivered_at claim-vs-confirm write, and the maxDuration export.

type LoggedOp = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: Record<string, unknown>;
  filters: Array<{ name: string; args: unknown[] }>;
};

const db = vi.hoisted(() => ({
  handlers: {} as Record<string, (op: LoggedOp) => { data?: unknown; error?: unknown }>,
  log: [] as LoggedOp[],
  reset() {
    this.handlers = {};
    this.log = [];
  },
  ops(table: string, op: string) {
    return this.log.filter((o: LoggedOp) => o.table === table && o.op === op);
  },
}));

function makeBuilder(table: string) {
  const ctx: LoggedOp & { opSet?: boolean } = { table, op: "select", filters: [] };
  const b: Record<string, unknown> = {
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      db.log.push(ctx);
      const handler = db.handlers[`${ctx.table}.${ctx.op}`];
      const result = handler
        ? handler(ctx)
        : { data: ctx.op === "select" ? [] : null, error: null };
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  for (const name of ["eq", "gte", "lt", "lte", "in", "is", "not", "order", "limit", "match"]) {
    (b as Record<string, unknown>)[name] = (...args: unknown[]) => {
      ctx.filters.push({ name, args });
      return b;
    };
  }
  (b as Record<string, unknown>).select = (...args: unknown[]) => {
    // .select() after .update() is a returning-clause, not a new op
    if (!ctx.opSet) ctx.op = "select";
    ctx.filters.push({ name: "select", args });
    return b;
  };
  for (const op of ["insert", "update", "delete"] as const) {
    (b as Record<string, unknown>)[op] = (payload?: Record<string, unknown>) => {
      ctx.op = op;
      ctx.opSet = true;
      ctx.payload = payload;
      return b;
    };
  }
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((fn: (scope: unknown) => void) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() })
  ),
}));

// Keep NotificationDeliveryError REAL — the route's instanceof/field branch
// is the contract under test. Only the sender is stubbed.
vi.mock("@/lib/notifications/notification-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/notification-service")>();
  return {
    ...actual,
    sendCallbackReminderNotification: vi.fn(async () => "sent" as const),
  };
});

import {
  sendCallbackReminderNotification,
  NotificationDeliveryError,
} from "@/lib/notifications/notification-service";

const DUE_CALLBACK = {
  id: "cb-1",
  organization_id: "org-1",
  caller_name: "Sam",
  caller_phone: "+61400000000",
  reason: "quote follow-up",
  requested_time: "2026-06-10T22:00:00Z",
  urgency: "medium",
};

const state = {
  dueCallbacks: [DUE_CALLBACK] as Array<Record<string, unknown>>,
  claimWon: true,
  releaseError: null as unknown,
  confirmError: null as unknown,
};

/**
 * The route issues three different UPDATEs against callback_requests,
 * distinguishable by payload:
 *   claim   — { reminder_sent_at: <iso> }
 *   release — { reminder_sent_at: null }
 *   confirm — { reminder_delivered_at: <iso> }
 */
function kindOf(op: LoggedOp): "claim" | "release" | "confirm" {
  if (op.payload && "reminder_delivered_at" in op.payload) return "confirm";
  return op.payload?.reminder_sent_at === null ? "release" : "claim";
}

function updatesOfKind(kind: "claim" | "release" | "confirm") {
  return db.ops("callback_requests", "update").filter((o) => kindOf(o) === kind);
}

function installHandlers() {
  db.handlers["callback_requests.select"] = () => ({ data: state.dueCallbacks, error: null });
  db.handlers["callback_requests.update"] = (ctx) => {
    switch (kindOf(ctx)) {
      case "claim":
        return { data: state.claimWon ? [{ id: ctx.filters.find((f) => f.name === "eq")!.args[1] }] : [], error: null };
      case "release":
        return { data: null, error: state.releaseError };
      case "confirm":
        return { data: null, error: state.confirmError };
    }
  };
}

const CRON_SECRET = "test-cron-secret";

async function callRoute(headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  const { GET } = await import("../route");
  return GET(new NextRequest("http://localhost/api/cron/callback-reminders", { method: "GET", headers }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendCallbackReminderNotification).mockResolvedValue("sent");
  process.env.CRON_SECRET = CRON_SECRET;
  db.reset();
  state.dueCallbacks = [DUE_CALLBACK];
  state.claimWon = true;
  state.releaseError = null;
  state.confirmError = null;
  installHandlers();
});

describe("GET /api/cron/callback-reminders — sizing & auth", () => {
  it("exports maxDuration=60 (Hobby plan ceiling — SCRUM-447)", async () => {
    const mod = await import("../route");
    expect(mod.maxDuration).toBe(60);
  });

  it("401 without the cron bearer; no DB work runs", async () => {
    const res = await callRoute({});
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
  });
});

describe("GET /api/cron/callback-reminders — claim/confirm flow", () => {
  it("claims first, sends, then confirms reminder_delivered_at (SCRUM-447)", async () => {
    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 1, reminders_skipped: 0 });

    expect(updatesOfKind("claim")).toHaveLength(1);
    expect(sendCallbackReminderNotification).toHaveBeenCalledTimes(1);
    expect(updatesOfKind("confirm")).toHaveLength(1);
    expect(updatesOfKind("release")).toHaveLength(0);

    // Claim precedes confirm (claim-first ordering).
    const kinds = db.ops("callback_requests", "update").map(kindOf);
    expect(kinds).toEqual(["claim", "confirm"]);
  });

  it("a lost claim (another run owns the reminder) skips the send entirely", async () => {
    state.claimWon = false;
    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 0, reminders_skipped: 0 });
    expect(sendCallbackReminderNotification).not.toHaveBeenCalled();
    expect(updatesOfKind("confirm")).toHaveLength(0);
  });

  it("confirmation failure does not flip the reminder into the release path — Sentry-flagged instead", async () => {
    state.confirmError = { message: "update timeout" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 1, reminders_skipped: 0 });
    expect(updatesOfKind("release")).toHaveLength(0);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/reminder_delivered_at confirmation failed/),
      "warning",
    );
    errSpy.mockRestore();
  });

  it("a 'skipped' send (all channels off by preference) keeps the claim, skips confirmation, counts as skipped", async () => {
    vi.mocked(sendCallbackReminderNotification).mockResolvedValue("skipped");
    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 0, reminders_skipped: 1 });
    expect(updatesOfKind("release")).toHaveLength(0); // claim kept — must leave the queue
    expect(updatesOfKind("confirm")).toHaveLength(0); // nothing reached an inbox
  });
});

describe("GET /api/cron/callback-reminders — typed send-error branching (SCRUM-447)", () => {
  it("PERMANENT org-config failure keeps the claim (abandoned — no retry churn) and never confirms", async () => {
    vi.mocked(sendCallbackReminderNotification).mockRejectedValue(
      new NotificationDeliveryError("callback-reminder: 0 notification channels delivered — wanted channel(s) unavailable: owner-email", {
        deliveredCount: 0,
        wantedCount: 1,
        permanent: true,
        permanentCause: "org-config",
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 0, reminders_skipped: 0 });
    expect(updatesOfKind("release")).toHaveLength(0); // claim kept
    expect(updatesOfKind("confirm")).toHaveLength(0); // nothing was delivered
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("Abandoning reminder")),
    ).toBe(true);
    errSpy.mockRestore();
  });

  it("credential-ABSENCE permanent failure RELEASES the claim (retries once the env is fixed)", async () => {
    // One cron run during a deploy window with EMAIL_API_KEY missing must not
    // permanently abandon up to 50 reminders — the env fix makes a retry
    // succeed, unlike the org-config case above.
    vi.mocked(sendCallbackReminderNotification).mockRejectedValue(
      new NotificationDeliveryError("1/1 notification channels failed: [Email] EMAIL_API_KEY is not configured", {
        deliveredCount: 0,
        wantedCount: 1,
        permanent: true,
        permanentCause: "credential-absence",
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 0, reminders_skipped: 0 });
    expect(updatesOfKind("release")).toHaveLength(1); // claim released for the post-fix retry
    expect(updatesOfKind("confirm")).toHaveLength(0);
    // The notification service already pages Sentry at error level for
    // credential absence — the route adds no per-reminder retry warning.
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
      expect.stringMatching(/claim released for retry/),
      "warning",
    );
    errSpy.mockRestore();
  });

  it("PARTIAL delivery keeps the claim and confirms (a release would double the delivered channel)", async () => {
    vi.mocked(sendCallbackReminderNotification).mockRejectedValue(
      new NotificationDeliveryError("1/2 notification channels failed: Error: Webhook returned 500", {
        deliveredCount: 1,
        wantedCount: 2,
        permanent: false,
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 0, reminders_skipped: 0 });
    expect(updatesOfKind("release")).toHaveLength(0);
    expect(updatesOfKind("confirm")).toHaveLength(1);
    // Not Sentry-paged as a transient outage — nothing here needs a retry.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("PERMANENT failure with partial delivery still confirms (the delivered channel is recorded)", async () => {
    // e.g. webhook delivered but EMAIL_API_KEY is absent: a release would
    // double the webhook AND the email can't go out until env is fixed —
    // keep the claim and record that something reached the owner.
    vi.mocked(sendCallbackReminderNotification).mockRejectedValue(
      new NotificationDeliveryError("1/2 notification channels failed: [Email] EMAIL_API_KEY is not configured", {
        deliveredCount: 1,
        wantedCount: 2,
        permanent: true,
        permanentCause: "credential-absence",
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 0, reminders_skipped: 0 });
    expect(updatesOfKind("release")).toHaveLength(0); // claim kept
    expect(updatesOfKind("confirm")).toHaveLength(1); // partial delivery recorded
    warnSpy.mockRestore();
  });

  it("transient nothing-delivered failure releases the claim for retry + Sentry warning", async () => {
    vi.mocked(sendCallbackReminderNotification).mockRejectedValue(
      new NotificationDeliveryError("1/1 notification channels failed: Error: Resend API error: 500", {
        deliveredCount: 0,
        wantedCount: 1,
        permanent: false,
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 0, reminders_skipped: 0 });
    expect(updatesOfKind("release")).toHaveLength(1);
    expect(updatesOfKind("confirm")).toHaveLength(0);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/claim released for retry/),
      "warning",
    );
    errSpy.mockRestore();
  });

  it("claim-release failure is Sentry-paged at error level (the reminder will not retry)", async () => {
    vi.mocked(sendCallbackReminderNotification).mockRejectedValue(new Error("kaboom"));
    state.releaseError = { message: "update timeout" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 0, reminders_skipped: 0 });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/claim release failed/),
      "error",
    );
    errSpy.mockRestore();
  });

  it("a non-typed (unexpected) error is treated as transient — release + retry", async () => {
    vi.mocked(sendCallbackReminderNotification).mockRejectedValue(new Error("kaboom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callRoute();
    expect(await res.json()).toEqual({ reminders_sent: 0, reminders_skipped: 0 });
    expect(updatesOfKind("release")).toHaveLength(1);
    errSpy.mockRestore();
  });
});
