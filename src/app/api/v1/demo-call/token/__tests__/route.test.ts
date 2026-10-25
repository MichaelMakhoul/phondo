import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * SCRUM-596: the voice server's /ws/test turns a token with mode "owner" into the
 * owner assistant. This public route signs with the same secret (TEST_CALL_SECRET),
 * so its payload must stay fixed: the demo org, the industry's demo assistant, an
 * expiry and a jti. Nothing in the request — "mode" least of all — reaches it.
 */

vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    static slidingWindow() {
      return {};
    }
    async limit() {
      return { success: true };
    }
  },
}));
vi.mock("@upstash/redis", () => ({ Redis: { fromEnv: () => ({}) } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/security/rate-limiter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/rate-limiter")>()),
  rateLimitDistributed: vi.fn(async () => ({ allowed: true, headers: {} })),
}));

import { POST } from "../route";
import { DEMO_INDUSTRIES, DEMO_ORG_ID } from "@/lib/demo/config";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/v1/demo-call/token", {
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
  process.env.TEST_CALL_SECRET = "test-call-secret";
  process.env.VOICE_SERVER_PUBLIC_URL = "https://voice.example.com";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TEST_CALL_SECRET;
  delete process.env.VOICE_SERVER_PUBLIC_URL;
});

describe("POST /api/v1/demo-call/token — the signed payload", () => {
  it("is exactly the demo org, the industry's demo assistant, an expiry and a jti: never a mode, whatever the request says", async () => {
    const res = await post({ industry: "dental", mode: "owner", organizationId: "org-evil", assistantId: "asst-evil", userId: "user-evil" });
    expect(res.status).toBe(200);
    const payload = payloadOf((await res.json()).token);
    expect(Object.keys(payload).sort()).toEqual(["assistantId", "exp", "jti", "organizationId"]);
    expect(payload).toMatchObject({ assistantId: DEMO_INDUSTRIES.dental.assistantId, organizationId: DEMO_ORG_ID });
  });
});
