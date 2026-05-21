import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pushToLoki } from "../loki-push";

// Capture the callbacks scheduled via Next's `after()` so tests can run the
// deferred push deterministically (real `after` defers past the response).
const afterState = vi.hoisted(() => ({ tasks: [] as Array<() => unknown>, throwOnUse: false }));
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => {
    if (afterState.throwOnUse) throw new Error("after() called outside a request scope");
    afterState.tasks.push(cb);
  },
}));

async function runDeferred() {
  const tasks = afterState.tasks.splice(0);
  for (const t of tasks) await t();
}

const LABELS = { service_name: "phondo-next", level: "error" } as const;
const LINE = "[ALERT:error] [next-api] boom | reason=voice-preview-failed";

beforeEach(() => {
  afterState.tasks = [];
  afterState.throwOnUse = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function enableLoki() {
  vi.stubEnv("LOKI_PUSH_URL", "https://logs-prod-1.grafana.net/loki/api/v1/push");
  vi.stubEnv("LOKI_USERNAME", "123456");
  vi.stubEnv("LOKI_API_TOKEN", "glc_secret");
}

describe("pushToLoki (SCRUM-323)", () => {
  it("is a no-op when the LOKI_* env vars are unset (no fetch, nothing scheduled)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Only some set → still dormant.
    vi.stubEnv("LOKI_PUSH_URL", "https://logs-prod-1.grafana.net/loki/api/v1/push");

    pushToLoki(LINE, LABELS);
    await runDeferred();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(afterState.tasks).toHaveLength(0);
  });

  it("POSTs a correct single-stream payload with Basic auth to LOKI_PUSH_URL", async () => {
    enableLoki();
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    pushToLoki(LINE, LABELS);
    // Deferred via after() — not sent until the response is flushed.
    expect(fetchMock).not.toHaveBeenCalled();
    await runDeferred();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://logs-prod-1.grafana.net/loki/api/v1/push");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("123456:glc_secret").toString("base64")}`,
    );

    const body = JSON.parse(init.body);
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].stream).toEqual(LABELS);
    const [ts, loggedLine] = body.streams[0].values[0];
    expect(loggedLine).toBe(LINE);
    expect(ts).toMatch(/^\d+$/); // nanosecond timestamp string
  });

  it("does NOT throw or reject when fetch fails (swallows to a breadcrumb)", async () => {
    enableLoki();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => pushToLoki(LINE, LABELS)).not.toThrow();
    await expect(runDeferred()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "[loki-push] push failed (continuing):",
      "network down",
    );
  });

  it("logs a breadcrumb (with the response body) on a non-2xx response, without throwing", async () => {
    enableLoki();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "rate limited" })),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    pushToLoki(LINE, LABELS);
    await runDeferred();

    expect(errorSpy).toHaveBeenCalledWith(
      "[loki-push] non-2xx (429) — alert line not ingested: rate limited",
    );
  });

  it("falls back to a direct send when after() is unavailable (outside a request scope)", async () => {
    enableLoki();
    afterState.throwOnUse = true; // simulate after() throwing
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    // The fallback invokes the task immediately; fetch is called synchronously
    // (before its first await), and pushToLoki must not throw.
    expect(() => pushToLoki(LINE, LABELS)).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
