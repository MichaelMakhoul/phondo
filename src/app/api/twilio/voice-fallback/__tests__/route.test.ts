import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-589: Twilio only reaches this route when the voice server failed or
// timed out on /twiml, so every served fallback is a caller who got voicemail
// instead of the AI. Grafana pages on the line CONTENT ("[ALERT:error]" plus
// "reason=<tag>"), so these tests assert the emitted line itself rather than a
// mocked pageSentry call.

const validateRequest = vi.hoisted(() => vi.fn(() => true));
vi.mock("twilio", () => ({ default: { validateRequest } }));

const db = vi.hoisted(() => ({
  throwOnCreate: false,
  phoneRecord: null as Record<string, string> | null,
  inserts: [] as unknown[],
  signals: [] as unknown[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    if (db.throwOnCreate) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    return {
      from: (table: string) => {
        if (table === "phone_numbers") {
          const chain = {
            select: () => chain,
            eq: () => chain,
            abortSignal: (signal: unknown) => {
              db.signals.push(signal);
              return chain;
            },
            maybeSingle: async () => ({ data: db.phoneRecord, error: null }),
          };
          return chain;
        }
        return {
          insert: (row: unknown) => {
            db.inserts.push(row);
            return {
              abortSignal: async (signal: unknown) => {
                db.signals.push(signal);
                return { error: null };
              },
            };
          },
        };
      },
    };
  }),
}));

// pageSentry's Sentry side channel is a no-op without a DSN; keep it inert.
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const CALLER = "+61400111222";
const FAILED_CALL = {
  From: CALLER,
  Called: "+61238205672",
  CallSid: "CA0123456789abcdef0123456789abcdef",
  ErrorCode: "11200",
};

function post(params: Record<string, string>, query = "") {
  return new Request(`http://localhost/api/twilio/voice-fallback${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": "test-signature",
    },
    body: new URLSearchParams(params).toString(),
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
  validateRequest.mockReturnValue(true);
  db.throwOnCreate = false;
  db.phoneRecord = { id: "pn-1", organization_id: "org-1", assistant_id: "asst-1" };
  db.inserts = [];
  db.signals = [];
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  // pushToLoki stays dormant without its credentials, so nothing leaves the test.
  delete process.env.LOKI_PUSH_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/twilio/voice-fallback — outage paging (SCRUM-589)", () => {
  it("pages reason=voice-fallback-served when a caller is sent to voicemail", async () => {
    const { POST } = await import("../route");
    const res = await POST(post(FAILED_CALL));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("temporarily unavailable");
    const lines = alertLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[ALERT:error\] \[next-api\] /);
    expect(reasonOf(lines[0])).toBe("voice-fallback-served");
    expect(lines[0]).toContain("errorCode=11200");
    expect(lines[0]).toContain(`callSid=${FAILED_CALL.CallSid}`);
    // The business still gets its failed-call row.
    expect(db.inserts).toHaveLength(1);
  });

  it("never puts the caller's number in the alert line", async () => {
    const { POST } = await import("../route");
    await POST(post(FAILED_CALL));

    expect(alertLines().join("\n")).not.toContain(CALLER);
    expect(alertLines().join("\n")).not.toContain(CALLER.slice(1));
  });

  it("names the failed voice-server path, without its host or query", async () => {
    const { POST } = await import("../route");
    await POST(post({ ...FAILED_CALL, ErrorUrl: "https://phondo-voice.fly.dev/twiml/transfer-status?attempt=2" }));

    const [line] = alertLines();
    expect(line).toContain("errorUrl=/twiml/transfer-status");
    expect(line).not.toContain("fly.dev");
    expect(line).not.toContain("attempt=2");
  });

  it("bounds both Supabase queries with a timeout so a hung DB can't eat the page", async () => {
    const { POST } = await import("../route");
    await POST(post(FAILED_CALL));

    expect(db.signals).toHaveLength(2);
    for (const signal of db.signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("still pages when the called number matches no business", async () => {
    db.phoneRecord = null;
    const { POST } = await import("../route");
    await POST(post(FAILED_CALL));

    expect(alertLines().map(reasonOf)).toEqual(["voice-fallback-served"]);
  });

  it("does not page again for the same call's recording-done callback", async () => {
    const { POST } = await import("../route");
    const res = await POST(post(FAILED_CALL, "?recording=done"));

    expect(res.status).toBe(200);
    expect(alertLines()).toEqual([]);
  });

  it("does not page for a request that fails Twilio signature validation", async () => {
    validateRequest.mockReturnValue(false);
    const { POST } = await import("../route");
    const res = await POST(post(FAILED_CALL));

    expect(res.status).toBe(403);
    expect(alertLines()).toEqual([]);
  });

  it.each([
    ["no body at all", undefined, undefined],
    ["a JSON body", "application/json", JSON.stringify({ From: CALLER })],
  ])("rejects %s with 400 before the signature check, without paging", async (_label, contentType, body) => {
    const { POST } = await import("../route");
    const res = await POST(
      new Request("http://localhost/api/twilio/voice-fallback", {
        method: "POST",
        headers: contentType ? { "Content-Type": contentType } : {},
        body,
      })
    );

    expect(res.status).toBe(400);
    expect(validateRequest).not.toHaveBeenCalled();
    expect(alertLines()).toEqual([]);
  });

  it("pages reason=voice-fallback-env-missing when TWILIO_AUTH_TOKEN is unset", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const { POST } = await import("../route");
    const res = await POST(post(FAILED_CALL));

    expect(res.status).toBe(403);
    const lines = alertLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[ALERT:error\] \[next-api\] /);
    expect(reasonOf(lines[0])).toBe("voice-fallback-env-missing");
  });

  it("pages reason=voice-fallback-failed when the fallback itself throws", async () => {
    db.throwOnCreate = true;
    const { POST } = await import("../route");
    const res = await POST(post(FAILED_CALL));

    expect(await res.text()).toContain("technical difficulties");
    const lines = alertLines();
    // The served page goes out before the DB lookup, so it survives the throw.
    expect(lines.map(reasonOf)).toEqual(["voice-fallback-served", "voice-fallback-failed"]);
    for (const line of lines) expect(line).toMatch(/^\[ALERT:error\] \[next-api\] /);
  });
});
