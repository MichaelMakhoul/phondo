import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

/**
 * SCRUM-596: the owner assistant in the browser. This route signs the token the
 * voice server's /ws/test turns into the phone line's owner assistant, so it is
 * the whole of the web's access control:
 *   - dark behind OWNER_ASSISTANT_UI_ENABLED (404), owner role only (401/404/403)
 *   - rate-limited per user, the assistant scoped to the caller's org
 *   - the token: signed with TEST_CALL_SECRET, mode "owner", 2-minute expiry,
 *     a fresh jti, exactly the agreed claims, never logged
 * Module-level mutable state; vitest runs a file's tests serially.
 */

const state = vi.hoisted(() => ({
  flagOn: true,
  user: { id: "user-1" } as { id: string } | null,
  membership: { organization_id: "org-1", role: "owner" } as { organization_id: string; role: string } | null,
  assistant: { id: "asst-1" } as { id: string } | null,
  assistantError: null as { code: string; message: string } | null,
  allowed: true,
  throwOnUser: null as unknown,
}));

const calls = vi.hoisted(() => ({
  getUser: 0,
  eqs: [] as [string, string][],
  rateLimit: [] as unknown[][],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => {
        calls.getUser++;
        if (state.throwOnUser) throw state.throwOnUser;
        return { data: { user: state.user } };
      },
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (col: string, val: string) => {
          calls.eqs.push([`${table}.${col}`, val]);
          return chain;
        },
        single: async () => ({
          data: state.assistant,
          error: state.assistantError ?? (state.assistant ? null : { code: "PGRST116", message: "no rows" }),
        }),
      };
      return chain;
    },
  })),
}));

vi.mock("@/lib/auth/membership", () => ({
  getPrimaryMembership: vi.fn(async () => state.membership),
}));

vi.mock("@/lib/feature-flags", () => ({
  isOwnerAssistantUiEnabled: () => state.flagOn,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ admin: true }),
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async (...args: unknown[]) => {
    calls.rateLimit.push(args);
    return { allowed: state.allowed, headers: { "Retry-After": "60" } };
  }),
}));

import { POST } from "../route";

const SECRET = "test-call-secret";

function post(body: unknown = { assistantId: "asst-1" }) {
  return POST(
    new Request("http://localhost/api/v1/owner-assistant/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

function decode(token: string) {
  const [payloadB64, sig] = token.split(".");
  return { payload: JSON.parse(Buffer.from(payloadB64, "base64url").toString()), payloadB64, sig };
}

let logs: string[];

beforeEach(() => {
  state.flagOn = true;
  state.user = { id: "user-1" };
  state.membership = { organization_id: "org-1", role: "owner" };
  state.assistant = { id: "asst-1" };
  state.assistantError = null;
  state.allowed = true;
  state.throwOnUser = null;
  calls.getUser = 0;
  calls.eqs = [];
  calls.rateLimit = [];
  process.env.TEST_CALL_SECRET = SECRET;
  process.env.VOICE_SERVER_PUBLIC_URL = "https://voice.example.com";
  logs = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TEST_CALL_SECRET;
  delete process.env.VOICE_SERVER_PUBLIC_URL;
});

describe("POST /api/v1/owner-assistant/token — who gets one", () => {
  it("404 while the owner assistant's UI is switched off, before anything else is asked", async () => {
    state.flagOn = false;
    const res = await post();
    expect(res.status).toBe(404);
    expect(calls.getUser).toBe(0);
  });

  it("401 when not logged in", async () => {
    state.user = null;
    expect((await post()).status).toBe(401);
  });

  it("404 with no organization", async () => {
    state.membership = null;
    expect((await post()).status).toBe(404);
  });

  it.each(["admin", "member"])("403 for an %s: only the business owner", async (role) => {
    state.membership = { organization_id: "org-1", role };
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only the business owner can talk to the assistant here.");
    expect(calls.rateLimit).toHaveLength(0);
  });

  it("429 past the per-user limit, with the limiter's headers", async () => {
    state.allowed = false;
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(calls.rateLimit).toEqual([[{ admin: true }, "user-1", "owner-assistant-token", "auth"]]);
  });
});

describe("POST /api/v1/owner-assistant/token — the request", () => {
  it.each([
    ["no body", "not json"],
    ["no assistantId", {}],
    ["a non-string assistantId", { assistantId: 42 }],
  ])("400 for %s", async (_label, body) => {
    expect((await post(body)).status).toBe(400);
  });

  it("404 for an assistant outside the owner's org; the lookup is scoped to the org", async () => {
    state.assistant = null;
    const res = await post({ assistantId: "asst-other" });
    expect(res.status).toBe(404);
    expect(calls.eqs).toEqual([
      ["assistants.id", "asst-other"],
      ["assistants.organization_id", "org-1"],
    ]);
  });

  it("a failed assistants read is a logged 500, never a 404 that hides it", async () => {
    state.assistant = null;
    state.assistantError = { code: "08006", message: "connection failure" };
    const res = await post();
    expect(res.status).toBe(500);
    expect(logs.some((l) => l.includes("[OwnerAssistantToken] assistants read failed") && l.includes("08006"))).toBe(true);
  });

  it.each(["TEST_CALL_SECRET", "VOICE_SERVER_PUBLIC_URL"])("503 without %s", async (name) => {
    delete process.env[name];
    expect((await post()).status).toBe(503);
  });
});

describe("POST /api/v1/owner-assistant/token — the token", () => {
  it("is signed with TEST_CALL_SECRET and carries exactly mode, assistant, org, user, a 2-minute expiry and a fresh jti", async () => {
    const before = Date.now();
    const res = await post();
    expect(res.status).toBe(200);
    const { token, wsUrl } = await res.json();
    expect(wsUrl).toBe("wss://voice.example.com/ws/test");
    const { payload, payloadB64, sig } = decode(token);
    expect(sig).toBe(crypto.createHmac("sha256", SECRET).update(payloadB64).digest("hex"));
    expect(Object.keys(payload).sort()).toEqual(["assistantId", "exp", "jti", "mode", "organizationId", "userId"]);
    expect(payload).toMatchObject({ mode: "owner", assistantId: "asst-1", organizationId: "org-1", userId: "user-1" });
    expect(payload.exp).toBeGreaterThanOrEqual(before + 120_000);
    expect(payload.exp).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(payload.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("the organization comes from the membership, never from the request", async () => {
    const res = await post({ assistantId: "asst-1", organizationId: "org-evil", mode: "owner", userId: "u-evil" });
    const { payload } = decode((await res.json()).token);
    expect(payload.organizationId).toBe("org-1");
    expect(payload.userId).toBe("user-1");
  });

  it("each token has its own jti (the voice server uses each one once)", async () => {
    const a = decode((await (await post()).json()).token).payload.jti;
    const b = decode((await (await post()).json()).token).payload.jti;
    expect(a).not.toBe(b);
  });

  it("an http voice server URL gives a ws:// socket URL", async () => {
    process.env.VOICE_SERVER_PUBLIC_URL = "http://localhost:3001";
    expect((await (await post()).json()).wsUrl).toBe("ws://localhost:3001/ws/test");
  });

  it("nothing is logged on success, and the token never appears in a log", async () => {
    const { token } = await (await post()).json();
    expect(logs).toEqual([]);
    expect(logs.join("\n")).not.toContain(token);
  });

  it("an unexpected failure is a 500 that logs only the error's message", async () => {
    state.throwOnUser = new Error("supabase down");
    const res = await post();
    expect(res.status).toBe(500);
    expect(logs.some((l) => l.includes("[OwnerAssistantToken]") && l.includes("supabase down"))).toBe(true);
  });
});
