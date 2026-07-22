import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract coverage for the public early-access route. Two non-obvious
 * contracts live only here and are easy to regress:
 *   1. Honeypot -> 200 with NO DB write and NO signal to the bot.
 *   2. Persist-first: an insert failure surfaces as 500 (lead NOT lost silently),
 *      while a notification-email failure must NOT fail the request (lead saved).
 */

const state = vi.hoisted(() => ({
  perIpAllowed: true,
  globalAllowed: true,
  insertResult: { error: null as unknown },
  notifyShouldThrow: null as Error | null,
}));

const insertSpy = vi.hoisted(() => vi.fn());
const notifySpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (_t: string) => ({
      insert: (v: unknown) => {
        insertSpy(v);
        return Promise.resolve(state.insertResult);
      },
    }),
  })),
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  getClientIp: vi.fn(() => "1.2.3.4"),
  // Two layers: the "earlyAccessGlobal" profile is the global cap, everything
  // else ("auth") is per-IP. Key off the profile so each can be tripped alone.
  rateLimitDistributed: vi.fn(async (_admin: unknown, _id: string, _endpoint: string, type: string) => ({
    allowed: type === "earlyAccessGlobal" ? state.globalAllowed : state.perIpAllowed,
    headers: {},
  })),
}));

vi.mock("@/lib/early-access/notify", () => ({
  sendEarlyAccessNotification: (d: unknown) => {
    notifySpy(d);
    return state.notifyShouldThrow ? Promise.reject(state.notifyShouldThrow) : Promise.resolve();
  },
  EarlyAccessNotifyError: class extends Error {},
}));

import { POST } from "../route";

const VALID = { fullName: "Jane", businessName: "Acme", email: "jane@x.io", phone: "0400 000 000" };

function req(body: unknown): Request {
  return { json: async () => body, headers: new Headers() } as unknown as Request;
}

beforeEach(() => {
  state.perIpAllowed = true;
  state.globalAllowed = true;
  state.insertResult = { error: null };
  state.notifyShouldThrow = null;
  insertSpy.mockClear();
  notifySpy.mockClear();
});

describe("POST /api/v1/early-access", () => {
  it("silently drops a tripped honeypot: 200, no insert, no email, but logs the trip", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await POST(req({ ...VALID, website: "http://spam.example" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
    // Telemetry so a false-positive (autofill eating a real lead) is detectable.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("honeypot"),
      expect.objectContaining({ ip: expect.any(String) }),
    );
    infoSpy.mockRestore();
  });

  it("rejects invalid input with 400 and never touches the DB", async () => {
    const res = await POST(req({ fullName: "Jane" })); // no email
    expect(res.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("returns 500 and does NOT email when the insert fails (lead not silently lost)", async () => {
    state.insertResult = { error: { message: "db down" } };
    const res = await POST(req(VALID));
    expect(res.status).toBe(500);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).not.toHaveBeenCalled(); // route returns before notifying
  });

  it("still returns 200 when the notification email throws (lead already saved)", async () => {
    state.notifyShouldThrow = new Error("mail provider down");
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("happy path: inserts snake_case data with source and returns 200 with tracked:true", async () => {
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    // `tracked: true` distinguishes a GENUINE persisted lead from the honeypot's
    // bare { ok: true } (asserted exactly above) — the client fires the Google
    // Ads conversion only on `tracked`, so a trap trip records no phantom lead.
    expect(await res.json()).toEqual({ ok: true, tracked: true });
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        full_name: "Jane",
        business_name: "Acme",
        email: "jane@x.io",
        source: "signup_page",
      }),
    );
  });

  it("caller cannot override protected columns (status/source) via extra body keys", async () => {
    await POST(req({ ...VALID, status: "converted", source: "attacker", id: "x" }));
    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.source).toBe("signup_page"); // route-set, not caller-set
    expect(inserted).not.toHaveProperty("status");
    expect(inserted).not.toHaveProperty("id");
  });

  it("returns 429 when the per-IP limit trips, without inserting", async () => {
    state.perIpAllowed = false;
    const res = await POST(req(VALID));
    expect(res.status).toBe(429);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("returns 429 when the GLOBAL cap trips even though the per-IP limit passed", async () => {
    state.perIpAllowed = true;
    state.globalAllowed = false;
    const res = await POST(req(VALID));
    expect(res.status).toBe(429);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
