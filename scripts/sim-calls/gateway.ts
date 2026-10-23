/**
 * SCRUM-594 simulated calls: what may reach a model API, and where it goes.
 *
 * Haiku only. Sonnet and Opus work (the judge) is done in the Claude Code
 * session, never through the API: the owner's rule, 23 Oct 2026
 * (SIM_JUDGE_MODEL=session). SIM_GATEWAY=openrouter sends the same Messages
 * requests to OpenRouter's Anthropic-compatible endpoint, on the owner's
 * capped OpenRouter key: a stopgap while the Anthropic balance is empty. They
 * are pinned to Anthropic's own servers there, at the same price.
 */
import fs from "fs";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const OPENROUTER_MESSAGES_URL = "https://openrouter.ai/api/v1/messages";

/**
 * ANTHROPIC_API_KEY under SIM_GATEWAY=openrouter. The voice server's client
 * and anthropic.ts insist on a key, and simFetch drops it from every request,
 * so the real Anthropic key is never loaded.
 */
export const OPENROUTER_PLACEHOLDER_KEY = "sim-gateway-openrouter";

/** OpenRouter's names for the models it may be asked for: Haiku 5.5 only (the key is capped at $5). */
const OPENROUTER_MODELS = new Map([["claude-haiku-5-5", "anthropic/claude-haiku-5.5"]]);

/** OpenRouter's own routing fields: any of them could send a request to another model or provider. */
const OPENROUTER_ROUTING = ["models", "route", "preset", "plugins", "provider"];

export type Gateway = "anthropic" | "openrouter";

/** SIM_GATEWAY: unset or `anthropic` (the default), or `openrouter`. */
export function simGateway(value = process.env.SIM_GATEWAY): Gateway {
  if (!value || value === "anthropic") return "anthropic";
  if (value === "openrouter") return "openrouter";
  throw new Error(`sim: SIM_GATEWAY must be "anthropic" or "openrouter" (got "${value}")`);
}

function notAllowed(model: string, gateway: Gateway): Error {
  return new Error(
    `sim: ${model || "(no model)"} may not be called through ${gateway === "openrouter" ? "OpenRouter (claude-haiku-5-5 only)" : "the API (Haiku only)"}. ` +
      "Sonnet and Opus work is done in the Claude Code session: SIM_CALLER_MODEL=claude-haiku-5-5, SIM_JUDGE_MODEL=session.",
  );
}

/** OpenRouter's name for `model`; throws unless it may be sent there. */
function openRouterName(model: string): string {
  const name = OPENROUTER_MODELS.get(model);
  if (!name) throw notAllowed(model, "openrouter");
  return name;
}

/** Throws unless the simulator may send `model` through `gateway`. */
export function assertApiModel(model: string, gateway: Gateway): void {
  if (gateway === "openrouter") openRouterName(model);
  else if (!/^claude-haiku-/.test(model)) throw notAllowed(model, gateway);
}

function messagesBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("sim: a Messages request without a JSON body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function modelOf(body: Record<string, unknown>): string {
  return typeof body.model === "string" ? body.model : "";
}

/**
 * Throws unless the request can reach its own model only. A server tool (the
 * advisor tool consults another model, Opus among them) or a beta header could
 * bring in another model on the provider's side, so only custom tools pass.
 */
function assertNoOtherModel(init: RequestInit | undefined, body: Record<string, unknown>): void {
  if (new Headers(init?.headers).has("anthropic-beta")) throw new Error("sim: a Messages request may not carry an anthropic-beta header");
  const tools = body.tools ?? [];
  if (!Array.isArray(tools)) throw new Error("sim: a Messages request's tools must be a list");
  for (const tool of tools) {
    const t = tool as Record<string, unknown> | null;
    if (!t || typeof t !== "object" || Array.isArray(t) || "model" in t || (t.type !== undefined && t.type !== "custom")) {
      throw new Error(`sim: a Messages request may carry custom tools only (got ${String(JSON.stringify(tool)).slice(0, 80)})`);
    }
  }
}

/**
 * A Messages request for OpenRouter: the OpenRouter key in place of the
 * Anthropic one, OpenRouter's model name, and Anthropic's own servers only.
 */
export function toOpenRouter(init: RequestInit | undefined, key: string): RequestInit {
  const body = messagesBody(init);
  const model = openRouterName(modelOf(body));
  const routing = OPENROUTER_ROUTING.filter((field) => field in body);
  if (routing.length > 0) throw new Error(`sim: a Messages request may not carry OpenRouter's routing fields (${routing.join(", ")})`);
  assertNoOtherModel(init, body);
  const headers = new Headers(init?.headers);
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${key}`);
  return { ...init, headers, body: JSON.stringify({ ...body, model, provider: { only: ["anthropic"], allow_fallbacks: false } }) };
}

/**
 * The simulator's fetch. It reaches the in-process tool-call route, and the
 * Messages API for a model assertApiModel allows: Anthropic's, or
 * OpenRouter's under SIM_GATEWAY=openrouter. Anything else throws, so a
 * simulated call can never reach production.
 */
export function simFetch(o: {
  realFetch: typeof fetch;
  internalUrl: string;
  internal: (req: Request) => Promise<Response>;
  gateway: Gateway;
  openRouterKey?: string;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === o.internalUrl) return o.internal(new Request(url, init));
    if (url !== ANTHROPIC_MESSAGES_URL) throw new Error(`sim: blocked network call to ${url}`);
    if (input instanceof Request) throw new Error("sim: a Messages request must pass its URL and init, not a Request");
    // No redirects: a cross-origin one would carry the x-api-key header along.
    if (o.gateway === "anthropic") {
      const body = messagesBody(init);
      assertApiModel(modelOf(body), "anthropic");
      assertNoOtherModel(init, body);
      // The body that was checked, re-serialised: a repeated "model" key can't slip past.
      return o.realFetch(input, { ...init, body: JSON.stringify(body), redirect: "error" });
    }
    if (!o.openRouterKey) throw new Error("sim: SIM_GATEWAY=openrouter needs OPENROUTER_API_KEY");
    return o.realFetch(OPENROUTER_MESSAGES_URL, { ...toOpenRouter(init, o.openRouterKey), redirect: "error" });
  }) as typeof fetch;
}

/** `name` from the environment, else from the dotenv file `envFile` (never printed). */
export function envKey(name: string, envFile: string): string | undefined {
  if (process.env[name]) return process.env[name];
  if (!fs.existsSync(envFile)) return undefined;
  const line = fs.readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
}
