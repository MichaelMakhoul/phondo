import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// SCRUM-589: the daily health-check's "down" email needs ADMIN_ALERT_EMAIL or
// ADMIN_ALERT_PHONE on Vercel. A healthy→down change must also page through
// the [ALERT:error] line Grafana emails on, so the alert never depends on them.

const db = vi.hoisted(() => ({
  current: null as { is_healthy: boolean; consecutive_failures: number } | null,
  readError: null as unknown,
  upsertError: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: db.current, error: db.readError }),
        upsert: async () => ({ error: db.upsertError }),
      };
      return chain;
    },
  })),
}));

const sendAdminAlert = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/notifications/admin-alerts", () => ({ sendAdminAlert }));

vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const CRON_SECRET = "test-cron-secret";

function cronRequest() {
  return new NextRequest("http://localhost/api/cron/health-check", {
    method: "GET",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

const logged: string[] = [];
const alertLines = () => logged.filter((line) => line.startsWith("[ALERT:"));
const reasonOf = (line: string) => line.match(/reason=(\S+)/)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  logged.length = 0;
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.VOICE_SERVER_PUBLIC_URL = "https://voice.example.test";
  delete process.env.LOKI_PUSH_URL;
  db.current = { is_healthy: true, consecutive_failures: 0 };
  db.readError = null;
  db.upsertError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /api/cron/health-check — voice-server down paging (SCRUM-589)", () => {
  it("pages reason=voice-server-down when the server goes from healthy to unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));
    const { GET } = await import("../route");
    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    const lines = alertLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[ALERT:error\] \[next-cron\] /);
    expect(reasonOf(lines[0])).toBe("voice-server-down");
    expect(lines[0]).toContain("connect ECONNREFUSED");
    // The email/SMS path still runs for whoever has it configured.
    expect(sendAdminAlert).toHaveBeenCalledWith("down", "voice-server", expect.any(String));
  });

  it("pages with the HTTP status when /health answers non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    const { GET } = await import("../route");
    await GET(cronRequest());

    const lines = alertLines();
    expect(lines.map(reasonOf)).toEqual(["voice-server-down"]);
    expect(lines[0]).toContain("HTTP 502");
  });

  it("does not page again while the server stays down", async () => {
    db.current = { is_healthy: false, consecutive_failures: 3 };
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));
    const { GET } = await import("../route");
    await GET(cronRequest());

    expect(alertLines()).toEqual([]);
    expect(sendAdminAlert).not.toHaveBeenCalled();
  });

  it("does not page when the server is healthy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"status\":\"ok\"}", { status: 200 })));
    const { GET } = await import("../route");
    await GET(cronRequest());

    expect(alertLines()).toEqual([]);
    expect(sendAdminAlert).not.toHaveBeenCalled();
  });
});
