/**
 * Post-call structured data extraction using OpenAI with JSON mode.
 * Analyzes the conversation transcript after a call ends in TWO parallel calls:
 *  1) Structured fields: caller_name, summary, sentiment, etc.
 *  2) Cleaned transcript: STT-normalised version of the transcript
 *
 * Splitting these calls means a truncation/failure of one (e.g., the longer
 * cleanup hitting max_tokens) does not erase the other from the dashboard.
 */

const { Sentry } = require("../lib/sentry");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANALYSIS_MODEL = "gpt-4.1-nano";

const STRUCTURED_PROMPT = `You are analyzing a phone call transcript between an AI receptionist and a caller.
The transcript may contain speech-to-text errors. Always produce the output in English regardless of the transcript language.

Extract the following information from the transcript. If information is not available, use null.

Return a JSON object with these fields:
- caller_name: The caller's name if mentioned (string or null)
- caller_phone_reason: The primary reason for the call (string or null)
- appointment_requested: Whether the caller wanted to schedule an appointment (boolean)
- summary: A 1-2 sentence summary of the call IN ENGLISH (string)
- success_evaluation: Rate the call outcome as "successful", "partial", or "unsuccessful" (string)
- collected_data: Any structured data collected during the call like phone numbers, emails, dates mentioned (object or null)
- unanswered_questions: Questions the caller asked that the AI could not answer. Translate to English. (array of strings, or null)
- sentiment: "positive" | "neutral" | "negative" (string)

Return ONLY valid JSON, no other text.`;

const CLEANUP_PROMPT = `You are normalising a phone call transcript that may contain speech-to-text errors, especially misdetected languages.

First, infer the language each turn was actually spoken in by looking at context (surrounding turns, common names, business context). Phone STT often mis-routes audio into the wrong language tokenizer, producing random Korean/Chinese/Japanese/Hindi characters inside an otherwise coherent English/Arabic/French/Spanish conversation — treat those as STT errors and recover the likely intended text.

Produce a cleaned version of the conversation.

Return a JSON object with this shape:
{ "turns": [ { "role": "user" | "assistant", "text": string, "original"?: string, "language"?: string } ] }

Rules:
- Keep each turn in the language the caller/AI actually used (do NOT translate).
- If a turn's raw text contains obviously wrong characters (e.g., Korean or Chinese tokens inside an otherwise English utterance), replace them with the most likely intended text and preserve the raw text under "original".
- Set "language" to the ISO 639-1 code of the language each turn was actually spoken in (en, ar, fr, es, zh, etc.) when you can tell.
- Preserve turn order. Infer speaker labels from "User:"/"Assistant:" markers in the input.
- If the transcript is too garbled to confidently recover, return { "turns": [] }.

Return ONLY valid JSON.`;

async function callOpenAI({ system, user, maxTokens }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
      response_format: { type: "json_object" },
      stream: false,
    }),
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const finishReason = choice?.finish_reason;
  const content = choice?.message?.content;

  if (!content) {
    throw new Error("OpenAI returned empty content");
  }

  if (finishReason === "length") {
    throw new Error("OpenAI hit max_tokens (truncated)");
  }

  return JSON.parse(content);
}

async function analyzeStructured(transcript) {
  try {
    const parsed = await callOpenAI({
      system: STRUCTURED_PROMPT,
      user: `Analyze this call transcript:\n\n${transcript.slice(0, 6000)}`,
      maxTokens: 600,
    });
    return {
      callerName: parsed.caller_name || null,
      callerPhoneReason: parsed.caller_phone_reason || null,
      appointmentRequested: !!parsed.appointment_requested,
      summary: parsed.summary || null,
      successEvaluation: parsed.success_evaluation || null,
      collectedData: parsed.collected_data || null,
      unansweredQuestions: Array.isArray(parsed.unanswered_questions) ? parsed.unanswered_questions : null,
      sentiment: ["positive", "neutral", "negative"].includes(parsed.sentiment) ? parsed.sentiment : null,
    };
  } catch (err) {
    console.error("[PostCallAnalysis] Structured analysis failed:", err.message);
    Sentry.withScope((scope) => {
      scope.setTag("service", "post-call-analysis");
      scope.setTag("step", "structured");
      Sentry.captureException(err);
    });
    return null;
  }
}

async function analyzeCleanup(transcript) {
  try {
    const parsed = await callOpenAI({
      system: CLEANUP_PROMPT,
      user: `Clean up this transcript:\n\n${transcript.slice(0, 6000)}`,
      maxTokens: 2500,
    });

    if (!parsed.turns || !Array.isArray(parsed.turns)) return null;
    const turns = parsed.turns.filter(
      (t) => t && typeof t.text === "string" && (t.role === "user" || t.role === "assistant"),
    );
    return turns.length > 0 ? { turns } : null;
  } catch (err) {
    console.error("[PostCallAnalysis] Cleanup analysis failed:", err.message);
    Sentry.withScope((scope) => {
      scope.setTag("service", "post-call-analysis");
      scope.setTag("step", "cleanup");
      Sentry.captureException(err);
    });
    return null;
  }
}

/**
 * Analyze a completed call transcript. Runs structured-data extraction and
 * STT cleanup in parallel so a failure (or truncation) of one does not affect
 * the other.
 *
 * @param {string} transcript - The full call transcript
 * @returns {Promise<object|null>} Extracted data or null if both calls fail
 */
async function analyzeCallTranscript(transcript) {
  if (!transcript || transcript.trim().length < 20) {
    return null; // Too short to analyze meaningfully
  }

  if (!OPENAI_API_KEY) {
    console.error("[PostCallAnalysis] OPENAI_API_KEY not set");
    Sentry.withScope((scope) => {
      scope.setTag("service", "post-call-analysis");
      Sentry.captureException(new Error("PostCallAnalysis: OPENAI_API_KEY not set"));
    });
    return null;
  }

  const [structured, cleanedTranscript] = await Promise.all([
    analyzeStructured(transcript),
    analyzeCleanup(transcript),
  ]);

  if (!structured && !cleanedTranscript) return null;

  return {
    ...(structured ?? {
      callerName: null,
      callerPhoneReason: null,
      appointmentRequested: false,
      summary: null,
      successEvaluation: null,
      collectedData: null,
      unansweredQuestions: null,
      sentiment: null,
    }),
    cleanedTranscript,
  };
}

module.exports = { analyzeCallTranscript };
