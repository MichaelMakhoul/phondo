import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * SCRUM-596: the voice server's /ws/test turns a token with mode "owner" into the
 * owner assistant, which reads and changes the org's real bookings. This route
 * signs with the same secret (TEST_CALL_SECRET), so its payload must stay built
 * field by field: nothing in the request — "mode" least of all — reaches a signed
 * token. Only /api/v1/owner-assistant/token signs mode "owner".
 */

const state = vi.hoisted(() => ({ user: { id: "user-1" } as { id: string } | null }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: table === "org_members" ? { organization_id: "org-1" } : { id: "asst-1" } }),
      };
      return chain;
    },
  })),
}));

import { POST } from "../route";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/v1/test-call/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function payloadOf(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
}

beforeEach(() => {
  state.user = { id: "user-1" };
  process.env.TEST_CALL_SECRET = "test-call-secret";
  process.env.VOICE_SERVER_PUBLIC_URL = "https://voice.example.com";
});

afterEach(() => {
  delete process.env.TEST_CALL_SECRET;
  delete process.env.VOICE_SERVER_PUBLIC_URL;
});

describe("POST /api/v1/test-call/token — the signed payload", () => {
  it("is exactly the assistant, the caller's org, an expiry and a jti: never a mode, whatever the request says", async () => {
    const res = await post({ assistantId: "asst-1", mode: "owner", organizationId: "org-evil", userId: "user-evil", ownerMode: true });
    expect(res.status).toBe(200);
    const payload = payloadOf((await res.json()).token);
    expect(Object.keys(payload).sort()).toEqual(["assistantId", "exp", "jti", "organizationId"]);
    expect(payload).toMatchObject({ assistantId: "asst-1", organizationId: "org-1" });
  });

  it("adds simulateAfterHours only as true, and nothing else", async () => {
    const payload = payloadOf((await (await post({ assistantId: "asst-1", simulateAfterHours: true, mode: "owner" })).json()).token);
    expect(Object.keys(payload).sort()).toEqual(["assistantId", "exp", "jti", "organizationId", "simulateAfterHours"]);
    expect(payload.simulateAfterHours).toBe(true);
    const ignored = payloadOf((await (await post({ assistantId: "asst-1", simulateAfterHours: "yes" })).json()).token);
    expect(Object.keys(ignored).sort()).toEqual(["assistantId", "exp", "jti", "organizationId"]);
  });
});
