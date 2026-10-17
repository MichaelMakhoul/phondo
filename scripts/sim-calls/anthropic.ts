/**
 * SCRUM-594 simulated calls: the Messages API for the simulated CALLER and the
 * JUDGE (the receptionist itself goes through the voice server's own client).
 * Retries 429/5xx like services/claude-chat.js, reads the text block by type
 * (a thinking block may come first), and keeps a token tally for the report.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export const usage: Record<string, { calls: number; inputTokens: number; outputTokens: number }> = {};

export async function claudeText(o: {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs?: number;
}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("sim: ANTHROPIC_API_KEY is not set");
  const body = JSON.stringify({
    model: o.model,
    system: o.system,
    messages: o.messages,
    max_tokens: o.maxTokens,
    // Haiku 5.5 thinks by default; Sonnet/Opus 5.5 reject `disabled` (lib/model-params.js).
    ...(/^claude-haiku-/.test(o.model) ? { thinking: { type: "disabled" } } : {}),
  });
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: AbortSignal.timeout(o.timeoutMs ?? 180_000),
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body,
    });
    if (res.ok) {
      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };
      const tally = (usage[o.model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      tally.calls++;
      tally.inputTokens += data.usage?.input_tokens ?? 0;
      tally.outputTokens += data.usage?.output_tokens ?? 0;
      const text = data.content?.find((b) => b.type === "text" && typeof b.text === "string")?.text ?? "";
      if (!text) throw new Error(`sim: ${o.model} returned no text (stop_reason=${data.stop_reason ?? "?"})`);
      return text;
    }
    lastError = `${res.status} ${(await res.text()).slice(0, 300)}`;
    if (res.status !== 429 && res.status < 500) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1)));
  }
  throw new Error(`sim: ${o.model} request failed: ${lastError}`);
}
