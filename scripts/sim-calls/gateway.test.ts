import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MESSAGES_URL, assertApiModel, envKey, OPENROUTER_MESSAGES_URL, simFetch, simGateway, toOpenRouter } from "./gateway";

// SCRUM-594: the simulator's model gateway. Haiku only; OpenRouter as a stopgap while the Anthropic balance is empty.
const request = (model: string, extra: Record<string, unknown> = {}): RequestInit => ({
  method: "POST",
  headers: { "x-api-key": "the-anthropic-key", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
  body: JSON.stringify({ model, max_tokens: 200, stream: true, thinking: { type: "disabled" }, messages: [{ role: "user", content: "hi" }], ...extra }),
});

const INTERNAL = "http://sim.internal/api/internal/tool-call";

function sandbox(gateway: "anthropic" | "openrouter", openRouterKey?: string) {
  const realFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response("ok"));
  const internal = vi.fn<(req: Request) => Promise<Response>>(async () => new Response("tool"));
  const fetch = simFetch({ realFetch: realFetch as unknown as typeof globalThis.fetch, internalUrl: INTERNAL, internal, gateway, openRouterKey });
  return { fetch, realFetch, internal };
}

function sent(realFetch: ReturnType<typeof sandbox>["realFetch"]): { url: string; headers: Headers; body: Record<string, unknown> } {
  const [url, init] = realFetch.mock.calls[0];
  return { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
}

describe("simGateway", () => {
  it("is Anthropic unless SIM_GATEWAY says openrouter", () => {
    expect(simGateway(undefined)).toBe("anthropic");
    expect(simGateway("")).toBe("anthropic");
    expect(simGateway("anthropic")).toBe("anthropic");
    expect(simGateway("openrouter")).toBe("openrouter");
  });

  it("refuses anything else rather than guess", () => {
    expect(() => simGateway("OpenRouter")).toThrow(/SIM_GATEWAY must be/);
    expect(() => simGateway("bedrock")).toThrow(/SIM_GATEWAY must be/);
  });
});

describe("assertApiModel", () => {
  it("lets Haiku through to Anthropic", () => {
    expect(() => assertApiModel("claude-haiku-5-5", "anthropic")).not.toThrow();
    expect(() => assertApiModel("claude-haiku-4-5-20251001", "anthropic")).not.toThrow();
  });

  it("refuses Sonnet and Opus: their work is done in the Claude Code session", () => {
    for (const gateway of ["anthropic", "openrouter"] as const) {
      expect(() => assertApiModel("claude-sonnet-5-5", gateway)).toThrow(/Claude Code session/);
      expect(() => assertApiModel("claude-opus-5-5", gateway)).toThrow(/Claude Code session/);
      expect(() => assertApiModel("", gateway)).toThrow(/\(no model\)/);
    }
  });

  it("lets only Haiku 5.5 through to OpenRouter (the key is capped)", () => {
    expect(() => assertApiModel("claude-haiku-5-5", "openrouter")).not.toThrow();
    expect(() => assertApiModel("claude-haiku-4-5-20251001", "openrouter")).toThrow(/claude-haiku-5-5 only/);
    expect(() => assertApiModel("anthropic/claude-haiku-5.5", "openrouter")).toThrow(/claude-haiku-5-5 only/);
  });

  it("is not fooled by an object's own property names", () => {
    expect(() => assertApiModel("constructor", "openrouter")).toThrow(/claude-haiku-5-5 only/);
    expect(() => assertApiModel("toString", "openrouter")).toThrow(/claude-haiku-5-5 only/);
  });

  it("anchors the Haiku match at the start", () => {
    expect(() => assertApiModel("not-claude-haiku-5-5", "anthropic")).toThrow(/Haiku only/);
  });
});

describe("toOpenRouter", () => {
  it("swaps the Anthropic key for the OpenRouter one and keeps the other headers", () => {
    const headers = new Headers(toOpenRouter(request("claude-haiku-5-5"), "or-key").headers);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer or-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("drops the Anthropic key whatever its spelling", () => {
    const init = { ...request("claude-haiku-5-5"), headers: { "X-Api-Key": "the-anthropic-key" } };
    expect(new Headers(toOpenRouter(init, "or-key").headers).get("x-api-key")).toBeNull();
  });

  it("asks for OpenRouter's name of the model, on Anthropic's own servers, and keeps the rest of the request", () => {
    const init = toOpenRouter(request("claude-haiku-5-5", { tools: [{ name: "check_availability" }] }), "or-key");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "anthropic/claude-haiku-5.5",
      max_tokens: 200,
      stream: true,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "check_availability" }],
      provider: { only: ["anthropic"], allow_fallbacks: false },
    });
    expect(init.method).toBe("POST");
  });

  it("keeps the caller's abort signal", () => {
    const signal = AbortSignal.timeout(1000);
    expect(toOpenRouter({ ...request("claude-haiku-5-5"), signal }, "or-key").signal).toBe(signal);
  });

  it("refuses any model but Haiku 5.5, and a request without a JSON body", () => {
    expect(() => toOpenRouter(request("claude-sonnet-5-5"), "or-key")).toThrow(/Claude Code session/);
    expect(() => toOpenRouter({ ...request("claude-haiku-5-5"), body: JSON.stringify({ model: 5 }) }, "or-key")).toThrow(/\(no model\)/);
    expect(() => toOpenRouter({ method: "POST" }, "or-key")).toThrow(/without a JSON body/);
    expect(() => toOpenRouter(undefined, "or-key")).toThrow(/without a JSON body/);
  });
});

describe("simFetch", () => {
  it("serves the tool-call route in process", async () => {
    const { fetch, realFetch, internal } = sandbox("anthropic");
    const res = await fetch(INTERNAL, { method: "POST", body: "{}" });
    expect(await res.text()).toBe("tool");
    const [req] = internal.mock.calls[0];
    expect(req.url).toBe(INTERNAL);
    expect(await req.text()).toBe("{}");
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("blocks every other address, Anthropic's other endpoints included", async () => {
    for (const gateway of ["anthropic", "openrouter"] as const) {
      const { fetch, realFetch } = sandbox(gateway, "or-key");
      await expect(fetch("https://example.com/", {})).rejects.toThrow(/blocked network call to https:\/\/example.com/);
      await expect(fetch("https://api.anthropic.com/v1/models", {})).rejects.toThrow(/blocked network call/);
      await expect(fetch(OPENROUTER_MESSAGES_URL, request("claude-haiku-5-5"))).rejects.toThrow(/blocked network call/);
      expect(realFetch).not.toHaveBeenCalled();
    }
  });

  it("sends Haiku to Anthropic unchanged", async () => {
    const { fetch, realFetch } = sandbox("anthropic");
    const init = request("claude-haiku-5-5");
    await fetch(ANTHROPIC_MESSAGES_URL, init);
    expect(realFetch).toHaveBeenCalledWith(ANTHROPIC_MESSAGES_URL, init);
  });

  it("accepts the Messages URL as a URL object", async () => {
    const { fetch, realFetch } = sandbox("anthropic");
    await fetch(new URL(ANTHROPIC_MESSAGES_URL), request("claude-haiku-5-5"));
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it("sends Haiku to OpenRouter under SIM_GATEWAY=openrouter, with the OpenRouter key only", async () => {
    const { fetch, realFetch } = sandbox("openrouter", "or-key");
    await fetch(ANTHROPIC_MESSAGES_URL, request("claude-haiku-5-5"));
    const out = sent(realFetch);
    expect(out.url).toBe(OPENROUTER_MESSAGES_URL);
    expect(out.headers.get("authorization")).toBe("Bearer or-key");
    expect(out.headers.get("x-api-key")).toBeNull();
    expect(out.body.model).toBe("anthropic/claude-haiku-5.5");
  });

  it("refuses Sonnet and Opus on either gateway, before anything is sent", async () => {
    for (const gateway of ["anthropic", "openrouter"] as const) {
      const { fetch, realFetch } = sandbox(gateway, "or-key");
      await expect(fetch(ANTHROPIC_MESSAGES_URL, request("claude-sonnet-5-5"))).rejects.toThrow(/Claude Code session/);
      await expect(fetch(ANTHROPIC_MESSAGES_URL, request("claude-opus-5-5"))).rejects.toThrow(/Claude Code session/);
      expect(realFetch).not.toHaveBeenCalled();
    }
  });

  it("refuses a request without a JSON body, or without a model name, on either gateway", async () => {
    for (const gateway of ["anthropic", "openrouter"] as const) {
      const { fetch, realFetch } = sandbox(gateway, "or-key");
      await expect(fetch(ANTHROPIC_MESSAGES_URL, { method: "POST" })).rejects.toThrow(/without a JSON body/);
      await expect(fetch(ANTHROPIC_MESSAGES_URL, { method: "POST", body: JSON.stringify({ model: 5 }) })).rejects.toThrow(/\(no model\)/);
      expect(realFetch).not.toHaveBeenCalled();
    }
  });

  it("refuses OpenRouter without its key", async () => {
    const { fetch, realFetch } = sandbox("openrouter", undefined);
    await expect(fetch(ANTHROPIC_MESSAGES_URL, request("claude-haiku-5-5"))).rejects.toThrow(/needs OPENROUTER_API_KEY/);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("refuses a Request object, whose body it can't check", async () => {
    const { fetch, realFetch } = sandbox("anthropic");
    const req = new Request(ANTHROPIC_MESSAGES_URL, { method: "POST", body: String(request("claude-sonnet-5-5").body) });
    await expect(fetch(req)).rejects.toThrow(/not a Request/);
    expect(realFetch).not.toHaveBeenCalled();
  });
});

describe("envKey", () => {
  const NAME = "SIM_GATEWAY_TEST_KEY";

  function envFile(contents: string): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-gateway-")), ".env");
    fs.writeFileSync(file, contents);
    return file;
  }

  it("prefers the environment", () => {
    vi.stubEnv(NAME, "from-env");
    try {
      expect(envKey(NAME, envFile(`${NAME}=from-file\n`))).toBe("from-env");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads the file's line for exactly that name, quotes and spaces trimmed", () => {
    expect(envKey(NAME, envFile(`${NAME}_OLD=wrong\n${NAME}= "from-file" \r\nOTHER=x\n`))).toBe("from-file");
    expect(envKey(NAME, envFile(`${NAME}='single'\n`))).toBe("single");
  });

  it("is undefined when the file has no such line, an empty one, or there is no file", () => {
    expect(envKey(NAME, envFile("OTHER=x\n"))).toBeUndefined();
    expect(envKey(NAME, envFile(`${NAME}=\n`))).toBeUndefined();
    expect(envKey(NAME, path.join(os.tmpdir(), "no-such-dir-sim-gateway", ".env"))).toBeUndefined();
  });
});
