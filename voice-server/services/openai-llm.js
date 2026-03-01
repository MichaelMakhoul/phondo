const DEFAULT_MODEL = "gpt-4.1-nano";
const MAX_RETRIES = 2;

/**
 * Calls OpenAI chat completion with optional tool/function calling support.
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
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const data = await res.json();

    if (!data.choices || data.choices.length === 0) {
      throw new Error("OpenAI returned no choices");
    }

    const message = data.choices[0].message;

    // Check for tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      return { type: "tool_calls", toolCalls: message.tool_calls, message };
    }

    const content = message?.content;
    if (!content) {
      throw new Error(`OpenAI returned empty content (finish_reason: ${data.choices[0].finish_reason ?? "unknown"})`);
    }

    return { type: "content", content };
  }

  throw new Error("OpenAI API rate limited after all retries");
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
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < 2) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : 1000 * (attempt + 1);
      console.warn(`[OpenAI] Stream rate limited (429), retrying in ${waitMs}ms (attempt ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    break;
  }

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
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
        console.warn("[OpenAI] Failed to parse SSE chunk:", data.slice(0, 100));
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
        if (onSentence) {
          while (SENTENCE_BREAK.test(textBuffer)) {
            const parts = textBuffer.split(SENTENCE_BREAK);
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
    throw new Error("OpenAI stream returned no content");
  }

  return { type: "content", content: fullContent };
}

module.exports = { getChatResponse, streamChatResponse };
