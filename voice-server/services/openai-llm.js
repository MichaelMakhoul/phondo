// LLM provider configuration — supports OpenAI, Anthropic, and Gemini
// Set LLM_PROVIDER env var to switch: "anthropic" (default), "openai", "gemini"
const LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";

const PROVIDER_CONFIG = {
  openai: {
    defaultModel: "gpt-4.1-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    name: "OpenAI",
    type: "openai-compat",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  gemini: {
    defaultModel: "gemini-2.5-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    name: "Gemini",
    type: "openai-compat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    defaultModel: "claude-haiku-4-5-20251001",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    name: "Anthropic",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com/v1/messages",
    authHeader: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
  },
};

const config = PROVIDER_CONFIG[LLM_PROVIDER];
if (!config) {
  console.error(`[LLM] Invalid LLM_PROVIDER="${LLM_PROVIDER}". Must be one of: ${Object.keys(PROVIDER_CONFIG).join(", ")}`);
  process.exit(1);
}
const DEFAULT_MODEL = process.env.LLM_MODEL || config.defaultModel;
const MAX_RETRIES = 2;

function getApiKey(explicitKey) {
  const key = explicitKey || process.env[config.apiKeyEnv];
  if (!key) throw new Error(`LLM API key not configured — set ${config.apiKeyEnv} env var or pass key explicitly`);
  return key;
}

// ─── Anthropic message format conversion ────────────────────────────────────

/**
 * Convert OpenAI-style messages to Anthropic format.
 * - Extracts system messages into a separate `system` param
 * - Converts tool_calls/tool results to Anthropic content blocks
 */
function toAnthropicMessages(messages) {
  let system = "";
  const converted = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system += (system ? "\n\n" : "") + msg.content;
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      // Convert OpenAI tool_calls to Anthropic tool_use blocks
      const content = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls) {
        let args;
        try {
          args = typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch (parseErr) {
          console.error(`[LLM] Failed to parse tool arguments for ${tc.function?.name}:`, tc.function?.arguments?.slice?.(0, 200), parseErr.message);
          args = {};
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: args,
        });
      }
      converted.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "tool") {
      // Convert OpenAI tool result to Anthropic tool_result block
      // Merge consecutive tool results into one user message (Anthropic requires alternating roles)
      const last = converted[converted.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push({ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content });
      } else {
        converted.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content }],
        });
      }
      continue;
    }

    // Regular user/assistant messages
    converted.push({ role: msg.role, content: msg.content });
  }

  return { system, messages: converted };
}

/**
 * Convert OpenAI-style tools to Anthropic format.
 */
function toAnthropicTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * Parse Anthropic response into our common format.
 */
function parseAnthropicResponse(data) {
  const content = data.content || [];
  const textParts = content.filter((b) => b.type === "text").map((b) => b.text);
  const toolUses = content.filter((b) => b.type === "tool_use");

  if (toolUses.length > 0) {
    const toolCalls = toolUses.map((tu) => ({
      id: tu.id,
      type: "function",
      function: {
        name: tu.name,
        arguments: JSON.stringify(tu.input),
      },
    }));
    // Build OpenAI-compatible assistant message for conversation history
    const message = {
      role: "assistant",
      content: textParts.join("") || null,
      tool_calls: toolCalls,
    };
    return { type: "tool_calls", toolCalls, message };
  }

  const text = textParts.join("");
  if (!text) {
    throw new Error(`Anthropic returned empty content (stop_reason: ${data.stop_reason ?? "unknown"})`);
  }
  return { type: "content", content: text };
}

// ─── Sentence splitting ─────────────────────────────────────────────────────

const SENTENCE_BREAK = /(?<=[.!?])\s+/;

// ─── Non-streaming ──────────────────────────────────────────────────────────

async function getChatResponse(apiKey, messages, options) {
  if (!messages || messages.length === 0) {
    throw new Error("getChatResponse called with empty messages array");
  }

  const resolvedKey = getApiKey(apiKey);
  const model = options?.model || DEFAULT_MODEL;

  let fetchUrl, headers, body;

  if (config.type === "anthropic") {
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);
    fetchUrl = config.baseUrl;
    headers = { ...config.authHeader(resolvedKey), "Content-Type": "application/json" };
    body = {
      model,
      system: system || undefined,
      messages: anthropicMsgs,
      max_tokens: options?.tools?.length > 0 ? 300 : 150,
      temperature: 0.7,
    };
    const tools = toAnthropicTools(options?.tools);
    if (tools) body.tools = tools;
  } else {
    fetchUrl = config.baseUrl;
    headers = { ...config.authHeader(resolvedKey), "Content-Type": "application/json" };
    body = {
      model,
      messages,
      max_tokens: 150,
      temperature: 0.7,
      stream: false,
    };
    if (options?.tools?.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.tool_choice || "auto";
      body.max_tokens = 300;
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(fetchUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers,
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

    if (config.type === "anthropic") {
      return parseAnthropicResponse(data);
    }

    // OpenAI-compatible response
    if (!data.choices || data.choices.length === 0) {
      throw new Error(`${config.name} returned no choices`);
    }
    const message = data.choices[0].message;
    if (message.tool_calls?.length > 0) {
      return { type: "tool_calls", toolCalls: message.tool_calls, message };
    }
    if (!message?.content) {
      throw new Error(`${config.name} returned empty content (finish_reason: ${data.choices[0].finish_reason ?? "unknown"})`);
    }
    return { type: "content", content: message.content };
  }

  throw new Error(`${config.name} API rate limited after all retries`);
}

// ─── Streaming ──────────────────────────────────────────────────────────────

async function streamChatResponse(apiKey, messages, options) {
  if (!messages || messages.length === 0) {
    throw new Error("streamChatResponse called with empty messages array");
  }

  const resolvedKey = getApiKey(apiKey);
  const model = options?.model || DEFAULT_MODEL;
  const onSentence = options?.onSentence;

  let fetchUrl, headers, body;

  if (config.type === "anthropic") {
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);
    fetchUrl = config.baseUrl;
    headers = { ...config.authHeader(resolvedKey), "Content-Type": "application/json" };
    body = {
      model,
      system: system || undefined,
      messages: anthropicMsgs,
      max_tokens: options?.tools?.length > 0 ? 300 : 150,
      temperature: 0.7,
      stream: true,
    };
    const tools = toAnthropicTools(options?.tools);
    if (tools) body.tools = tools;
  } else {
    fetchUrl = config.baseUrl;
    headers = { ...config.authHeader(resolvedKey), "Content-Type": "application/json" };
    body = {
      model,
      messages,
      max_tokens: 150,
      temperature: 0.7,
      stream: true,
    };
    if (options?.tools?.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.tool_choice || "auto";
      body.max_tokens = 300;
    }
  }

  // Retry loop for rate limits
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(fetchUrl, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers,
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < 2) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = Math.min(retryAfter ? Number(retryAfter) * 1000 : 1000 * (attempt + 1), 5000);
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

  if (config.type === "anthropic") {
    return parseAnthropicStream(res, onSentence);
  }
  return parseOpenAIStream(res, onSentence);
}

// ─── OpenAI-compatible stream parser ────────────────────────────────────────

async function parseOpenAIStream(res, onSentence) {
  let fullContent = "";
  let textBuffer = "";
  const toolCallMap = {};
  let hasToolCalls = false;
  let parseFailures = 0;
  let sentenceCount = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        parseFailures++;
        if (parseFailures <= 3) {
          console.warn(`[LLM] SSE parse failure #${parseFailures}:`, data.slice(0, 200));
        } else if (parseFailures === 4) {
          console.error(`[LLM] Multiple SSE parse failures (${parseFailures}+) — possible stream corruption`);
        }
        continue;
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.tool_calls) {
        hasToolCalls = true;
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallMap[idx]) {
            toolCallMap[idx] = { id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
          }
          if (tc.id) toolCallMap[idx].id = tc.id;
          if (tc.function?.name) toolCallMap[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCallMap[idx].function.arguments += tc.function.arguments;
        }
        continue;
      }

      if (delta.content) {
        fullContent += delta.content;
        textBuffer = processSentenceBuffer(textBuffer + delta.content, (sentence) => {
          sentenceCount++;
          if (onSentence) onSentence(sentence);
        });
      }
    }
  }

  if (parseFailures > 0) {
    console.warn(`[LLM] Stream completed with ${parseFailures} parse failure(s)`);
  }

  if (hasToolCalls) {
    const toolCalls = Object.keys(toolCallMap).sort((a, b) => Number(a) - Number(b)).map((idx) => toolCallMap[idx]);
    return { type: "tool_calls", toolCalls, message: { role: "assistant", content: null, tool_calls: toolCalls } };
  }

  if (onSentence && textBuffer.trim()) {
    sentenceCount++;
    onSentence(textBuffer.trim());
  }
  if (!fullContent) {
    throw new Error(`${config.name} stream returned no content${parseFailures > 0 ? ` (${parseFailures} SSE parse failures during stream)` : ""}`);
  }
  return { type: "content", content: fullContent, _meta: { sentenceCount, parseFailures } };
}

// ─── Anthropic stream parser ────────────────────────────────────────────────

async function parseAnthropicStream(res, onSentence) {
  let fullContent = "";
  let textBuffer = "";
  const toolUses = {}; // indexed by block index
  let hasToolCalls = false;
  let parseFailures = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        parseFailures++;
        if (parseFailures <= 3) {
          console.warn(`[LLM] Anthropic SSE parse failure #${parseFailures}:`, data.slice(0, 200));
        } else if (parseFailures === 4) {
          console.error(`[LLM] Multiple Anthropic SSE parse failures (${parseFailures}+) — possible stream corruption`);
        }
        continue;
      }

      // Anthropic SSE event types
      if (parsed.type === "content_block_start") {
        const block = parsed.content_block;
        if (block.type === "tool_use") {
          hasToolCalls = true;
          toolUses[parsed.index] = {
            id: block.id,
            name: block.name,
            arguments: "",
          };
        }
      } else if (parsed.type === "content_block_delta") {
        const delta = parsed.delta;
        if (delta.type === "text_delta") {
          fullContent += delta.text;
          textBuffer = processSentenceBuffer(textBuffer + delta.text, onSentence);
        } else if (delta.type === "input_json_delta") {
          const idx = parsed.index;
          if (toolUses[idx]) {
            toolUses[idx].arguments += delta.partial_json;
          }
        }
      }
      // Handle Anthropic error events (overloaded, content filtering, etc.)
      if (parsed.type === "error") {
        const errMsg = parsed.error?.message || JSON.stringify(parsed);
        throw new Error(`Anthropic stream error: ${errMsg}`);
      }
      // message_stop, content_block_stop, message_delta handled implicitly
    }
  }

  if (hasToolCalls) {
    const toolCalls = Object.keys(toolUses).sort((a, b) => Number(a) - Number(b)).map((idx) => {
      const tu = toolUses[idx];
      return {
        id: tu.id,
        type: "function",
        function: { name: tu.name, arguments: tu.arguments },
      };
    });
    const message = { role: "assistant", content: fullContent || null, tool_calls: toolCalls };
    return { type: "tool_calls", toolCalls, message };
  }

  if (parseFailures > 0) {
    console.warn(`[LLM] Anthropic stream completed with ${parseFailures} parse failure(s)`);
  }

  if (onSentence && textBuffer.trim()) onSentence(textBuffer.trim());
  if (!fullContent) {
    throw new Error(`Anthropic stream returned no content${parseFailures > 0 ? ` (${parseFailures} SSE parse failures during stream)` : ""}`);
  }
  return { type: "content", content: fullContent };
}

// ─── Shared sentence buffer processing ──────────────────────────────────────

function processSentenceBuffer(textBuffer, onSentence) {
  if (!onSentence) return textBuffer;

  while (SENTENCE_BREAK.test(textBuffer)) {
    const parts = textBuffer.split(SENTENCE_BREAK);
    const candidate = parts[0];
    if (candidate.length < 30 && parts.length > 1 && textBuffer.length < 100) {
      break;
    }
    const sentence = parts.shift();
    textBuffer = parts.join(" ");
    if (sentence.trim()) {
      onSentence(sentence.trim());
    }
  }
  return textBuffer;
}

module.exports = {
  getChatResponse, streamChatResponse, LLM_PROVIDER, DEFAULT_MODEL,
  // Exported for testing only
  _test: { toAnthropicMessages, toAnthropicTools, parseAnthropicResponse, processSentenceBuffer },
};
