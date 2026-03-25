// LLM provider configuration — supports OpenAI-compatible APIs (OpenAI, Gemini, etc.)
// Set LLM_PROVIDER env var to switch: "gemini" (default), "openai"
const LLM_PROVIDER = process.env.LLM_PROVIDER || "gemini";

const PROVIDER_CONFIG = {
  openai: {
    baseUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4.1-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    authHeader: (key) => `Bearer ${key}`,
    name: "OpenAI",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-2.5-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    authHeader: (key) => `Bearer ${key}`,
    name: "Gemini",
  },
};

const config = PROVIDER_CONFIG[LLM_PROVIDER] || PROVIDER_CONFIG.gemini;
const DEFAULT_MODEL = process.env.LLM_MODEL || config.defaultModel;
const MAX_RETRIES = 2;

// Resolve API key at startup
function getApiKey(explicitKey) {
  if (explicitKey) return explicitKey;
  return process.env[config.apiKeyEnv];
}

/**
 * Calls chat completion with optional tool/function calling support.
 * Retries on 429 rate-limit errors.
 *
 * @param {string} apiKey
 * @param {Array<{ role: string, content: string } | { role: string, tool_call_id: string, content: string }>} messages
 * @param {{ model?: string, tools?: object[], tool_choice?: string }} [options]
 * @returns {Promise<{ type: "content", content: string } | { type: "tool_calls", toolCalls: object[], message: object }>}
 */
async function getChatResponse(apiKey, messages, options) {
  if (!messages || messages.length === 0) {
    throw new Error("getChatResponse called with empty messages array");
  }

  const resolvedKey = getApiKey(apiKey);
  const model = options?.model || DEFAULT_MODEL;

  const body = {
    model,
    messages,
    max_tokens: 150,
    temperature: 0.7,
    stream: false,
  };

  // Add tools if provided (OpenAI function calling)
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || "auto";
    // Allow more tokens for tool call arguments
    body.max_tokens = 300;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(config.baseUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: config.authHeader(resolvedKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get("retry-after");
      const waitSec = retryAfter ? Math.min(parseFloat(retryAfter), 10) : 3;
      console.warn(`[LLM] Rate limited, retrying in ${waitSec}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }

    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new Error(`${config.name} API error ${res.status}: ${text}`);
    }

    const data = await res.json();

    if (!data.choices || data.choices.length === 0) {
      throw new Error(`${config.name} returned no choices`);
    }

    const message = data.choices[0].message;

    // Check for tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      return { type: "tool_calls", toolCalls: message.tool_calls, message };
    }

    const content = message?.content;
    if (!content) {
      throw new Error(`${config.name} returned empty content (finish_reason: ${data.choices[0].finish_reason ?? "unknown"})`);
    }

    return { type: "content", content };
  }

  throw new Error(`${config.name} API rate limited after all retries`);
}

// Sentence boundary regex — splits on . ! ? followed by whitespace.
// Note: will split on abbreviations like "Dr. Smith" — acceptable for TTS
// chunking since slightly early splits sound natural in speech.
const SENTENCE_BREAK = /(?<=[.!?])\s+/;

/**
 * Streaming chat completion.
 * Calls `onSentence(text)` for each sentence boundary found in the stream,
 * allowing TTS to start before the full response is generated.
 *
 * For tool calls, returns the same shape as getChatResponse.
 *
 * @param {string} apiKey
 * @param {object[]} messages
 * @param {{ model?: string, tools?: object[], tool_choice?: string, onSentence?: (text: string) => void }} [options]
 * @returns {Promise<{ type: "content", content: string } | { type: "tool_calls", toolCalls: object[], message: object }>}
 */
async function streamChatResponse(apiKey, messages, options) {
  if (!messages || messages.length === 0) {
    throw new Error("streamChatResponse called with empty messages array");
  }

  const resolvedKey = getApiKey(apiKey);
  const model = options?.model || DEFAULT_MODEL;
  const onSentence = options?.onSentence;

  const body = {
    model,
    messages,
    max_tokens: 150,
    temperature: 0.7,
    stream: true,
  };

  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || "auto";
    body.max_tokens = 300;
  }

  // Retry loop for rate limits (matching getChatResponse behavior)
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(config.baseUrl, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: config.authHeader(resolvedKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < 2) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : 1000 * (attempt + 1);
      console.warn(`[LLM] Stream rate limited (429), retrying in ${waitMs}ms (attempt ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    break;
  }

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`${config.name} API error ${res.status}: ${text}`);
  }

  // Parse SSE stream
  let fullContent = "";
  let textBuffer = "";
  // Tool call accumulation
  const toolCallMap = {};
  let hasToolCalls = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (parseErr) {
        console.warn(`[LLM] Failed to parse SSE chunk (possible incomplete JSON in stream):`, data.slice(0, 200));
        continue;
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      // Tool call deltas
      if (delta.tool_calls) {
        hasToolCalls = true;
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallMap[idx]) {
            toolCallMap[idx] = {
              id: tc.id || "",
              type: "function",
              function: { name: "", arguments: "" },
            };
          }
          if (tc.id) toolCallMap[idx].id = tc.id;
          if (tc.function?.name) toolCallMap[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCallMap[idx].function.arguments += tc.function.arguments;
        }
        continue;
      }

      // Text content delta
      if (delta.content) {
        fullContent += delta.content;
        textBuffer += delta.content;

        // Check for sentence boundaries and fire callback
        // Only split if the first sentence is long enough to be worth sending as a
        // separate TTS chunk. Very short fragments (e.g., "M-A-K.") create
        // audible gaps when they need their own TTS call. Threshold lowered to
        // 30 chars to get first audio out faster (latency optimization).
        if (onSentence) {
          while (SENTENCE_BREAK.test(textBuffer)) {
            const parts = textBuffer.split(SENTENCE_BREAK);
            const candidate = parts[0];
            // Don't split if the first chunk is very short — accumulate more text
            if (candidate.length < 30 && parts.length > 1 && textBuffer.length < 100) {
              break; // Wait for more text to accumulate
            }
            const sentence = parts.shift();
            textBuffer = parts.join(" ");
            if (sentence.trim()) {
              onSentence(sentence.trim());
            }
          }
        }
      }
    }
  }

  // Tool calls
  if (hasToolCalls) {
    const toolCalls = Object.keys(toolCallMap)
      .sort((a, b) => Number(a) - Number(b))
      .map((idx) => toolCallMap[idx]);
    const message = {
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    };
    return { type: "tool_calls", toolCalls, message };
  }

  // Flush remaining text
  if (onSentence && textBuffer.trim()) {
    onSentence(textBuffer.trim());
  }

  if (!fullContent) {
    throw new Error(`${config.name} stream returned no content`);
  }

  return { type: "content", content: fullContent };
}

module.exports = { getChatResponse, streamChatResponse, LLM_PROVIDER, DEFAULT_MODEL };
