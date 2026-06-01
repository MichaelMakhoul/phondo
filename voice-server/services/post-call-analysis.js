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
// SCRUM-370: when the raw transcript carries the STT mis-detection signature
// (non-Latin scripts where the caller most likely spoke a Latin-script or
// Arabic language), recover with a stronger model. Post-call batch step, so the
// marginal cost is negligible.
const CLEANUP_MODEL_GARBLED = "gpt-4.1-mini";

// Non-Latin script ranges that signal STT language mis-routing (or a genuinely
// non-English call that nano recovers poorly). Covers the scripts plausible for
// AU/US callers: Greek, Cyrillic, Hebrew, Arabic, Devanagari, Bengali, Tamil,
// Thai, Hiragana/Katakana, CJK, Hangul, and half-width Katakana. Latin
// (incl. accents/diacritics) and emoji are intentionally excluded so they don't
// force the pricier model.
const GARBLE_SIGNATURE = new RegExp(
  "[" +
    "\\u0370-\\u03FF" + // Greek
    "\\u0400-\\u04FF" + // Cyrillic
    "\\u0590-\\u05FF" + // Hebrew
    "\\u0600-\\u06FF" + // Arabic
    "\\u0900-\\u097F" + // Devanagari
    "\\u0980-\\u09FF" + // Bengali
    "\\u0B80-\\u0BFF" + // Tamil
    "\\u0E00-\\u0E7F" + // Thai
    "\\u3040-\\u30FF" + // Hiragana + Katakana
    "\\u3400-\\u9FFF" + // CJK (Ext-A + Unified)
    "\\uAC00-\\uD7AF" + // Hangul syllables
    "\\uFF61-\\uFF9F" + // Half-width Katakana
    "]"
);

/** @returns {boolean} true if the transcript contains non-Latin-script characters. */
function containsNonLatinScript(text) {
  return GARBLE_SIGNATURE.test(text || "");
}

const STRUCTURED_PROMPT = `You are analyzing a phone call transcript between an AI receptionist and a caller.
The transcript may contain speech-to-text errors. Always produce the output in English regardless of the transcript language.

Extract the following information from the transcript. If information is not available, use null.

Return a JSON object with these fields:
- caller_name: The caller's name if mentioned (string or null)
- caller_phone_reason: The primary reason for the call (string or null)
- appointment_requested: Whether the caller wanted to schedule an appointment (boolean)
- summary: A 1-2 sentence summary of the call IN ENGLISH (string)
- success_evaluation: Rate the call outcome (string): "successful" = the caller's primary goal was completed via a tool (e.g. an appointment was booked, a callback was captured, or the caller was transferred); "partial" = the goal was attempted but not completed (e.g. a booking was started but never confirmed); "unsuccessful" = the AI could not help, or the caller was frustrated / hung up
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

/**
 * @param {{ system: string, user: string, maxTokens: number, model?: string, timeoutMs?: number }} opts
 */
async function callOpenAI({ system, user, maxTokens, model, timeoutMs }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs || 20_000),
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || ANALYSIS_MODEL,
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

  const data = /** @type {{ choices?: Array<{ finish_reason?: string; message?: { content?: string } }> }} */ (
    await res.json()
  );
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

async function analyzeCleanup(transcript, language) {
  try {
    // SCRUM-370: the business's configured language is a DISAMBIGUATION hint
    // only — never a target to translate INTO (the prompt forbids translation).
    // Framed as "most likely" so a caller speaking another language isn't forced
    // wrong, and explicitly reiterates "do not translate" so an English-config
    // assistant taking an Arabic call doesn't get nudged to anglicise it.
    const langHint = language
      ? `\n\nCONTEXT: The business's configured language is "${language}", so "${language}" is the most likely language for callers — use it to disambiguate mis-detected (random CJK/Hindi/Cyrillic/Arabic) characters when the intended text is unclear. This is a recovery hint only: NEVER translate a turn out of the language it was actually spoken in.`
      : "";
    // Garbled / non-Latin transcripts route to the stronger model AND get a
    // longer timeout — they emit more output (recovered text + "original") and
    // the slower model would otherwise risk silently timing out on exactly the
    // calls this is meant to help.
    const garbled = containsNonLatinScript(transcript);
    const parsed = await callOpenAI({
      system: CLEANUP_PROMPT + langHint,
      user: `Clean up this transcript:\n\n${transcript.slice(0, 6000)}`,
      maxTokens: 2500,
      model: garbled ? CLEANUP_MODEL_GARBLED : undefined,
      timeoutMs: garbled ? 35_000 : undefined,
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
 * @param {{ language?: string }} [options] - language: the call's configured
 *   language (BCP-47/ISO 639-1), used as a recovery hint for the cleanup pass.
 * @returns {Promise<object|null>} Extracted data or null if both calls fail
 */
async function analyzeCallTranscript(transcript, options = {}) {
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
    analyzeCleanup(transcript, options.language),
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

module.exports = { analyzeCallTranscript, _test: { containsNonLatinScript } };
