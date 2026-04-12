/**
 * Post-call structured data extraction using OpenAI with JSON mode.
 * Analyzes the conversation transcript after a call ends to extract:
 * - caller_name, caller_phone_reason, appointment_requested
 * - summary, success_evaluation, collected_data
 * - cleaned_transcript: STT-normalised version of the transcript
 */

const { Sentry } = require("../lib/sentry");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANALYSIS_MODEL = "gpt-4.1-nano";

function buildAnalysisPrompt({ supportedLanguages }) {
  const languageHint = supportedLanguages && supportedLanguages.length > 0
    ? `\nThe caller is most likely speaking one of: ${supportedLanguages.join(", ")}. If the raw transcript contains tokens that look like a different language (e.g. Korean, Hindi, or Chinese characters when the caller probably spoke Arabic, French, or English), treat them as STT errors and recover the likely intended text.`
    : "";

  return `You are analyzing a phone call transcript between an AI receptionist and a caller.
The transcript may contain speech-to-text errors, especially misdetected languages.${languageHint}

You have TWO responsibilities.

1) Extract structured data:
- caller_name: string or null
- caller_phone_reason: string or null
- appointment_requested: boolean
- summary: 1-2 sentence summary IN ENGLISH
- success_evaluation: "successful" | "partial" | "unsuccessful"
- collected_data: object or null
- unanswered_questions: array of strings in English, or null
- sentiment: "positive" | "neutral" | "negative"

2) Produce a cleaned transcript that normalises STT errors:
- cleaned_transcript: object { turns: [ { role: "user" | "assistant", text: string, original?: string, language?: string } ] }
- For each turn, keep the text in the language the caller/AI actually used (do NOT translate).
- If the raw turn contains obviously wrong characters (e.g., Korean or Chinese tokens inside an otherwise English utterance), replace them with the most likely intended English/Arabic/French text, and include the raw text under "original".
- Preserve turn order. Infer speaker labels from the raw transcript's "User:"/"Assistant:" markers.
- If the transcript is too garbled to confidently recover, return cleaned_transcript: null.

Return ONLY valid JSON with all fields above.`;
}

/**
 * Analyze a completed call transcript and extract structured data.
 *
 * @param {string} transcript - The full call transcript
 * @param {object} [options] - Optional configuration
 * @param {string[]} [options.supportedLanguages] - Languages the assistant supports (for STT hint)
 * @returns {Promise<object|null>} Extracted data or null if analysis fails
 */
async function analyzeCallTranscript(transcript, options = {}) {
  const { supportedLanguages = [] } = options;

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

  try {
    const messages = [
      { role: "system", content: buildAnalysisPrompt({ supportedLanguages }) },
      {
        role: "user",
        content: `Analyze this call transcript:\n\n${transcript.slice(0, 6000)}`,
      },
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        messages,
        max_tokens: 1200,
        temperature: 0.1,
        response_format: { type: "json_object" },
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      console.error(`[PostCallAnalysis] OpenAI API error ${res.status}:`, text);
      Sentry.withScope((scope) => {
        scope.setTag("service", "post-call-analysis");
        scope.setExtra("httpStatus", res.status);
        scope.setExtra("responseBody", text);
        Sentry.captureException(new Error(`PostCallAnalysis: OpenAI API error ${res.status}`));
      });
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error("[PostCallAnalysis] OpenAI returned empty content");
      Sentry.withScope((scope) => {
        scope.setTag("service", "post-call-analysis");
        Sentry.captureException(new Error("PostCallAnalysis: OpenAI returned empty content"));
      });
      return null;
    }

    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (parseErr) {
      console.error("[PostCallAnalysis] Failed to parse OpenAI response as JSON:", content.slice(0, 200));
      Sentry.withScope((scope) => {
        scope.setTag("service", "post-call-analysis");
        scope.setExtra("responseContent", content.slice(0, 200));
        Sentry.captureException(parseErr);
      });
      return null;
    }

    // Validate cleaned_transcript shape; drop if malformed.
    let cleanedTranscript = null;
    if (analysis.cleaned_transcript && Array.isArray(analysis.cleaned_transcript.turns)) {
      const turns = analysis.cleaned_transcript.turns.filter(
        (t) => t && typeof t.text === "string" && (t.role === "user" || t.role === "assistant"),
      );
      if (turns.length > 0) cleanedTranscript = { turns };
    }

    return {
      callerName: analysis.caller_name || null,
      callerPhoneReason: analysis.caller_phone_reason || null,
      appointmentRequested: !!analysis.appointment_requested,
      summary: analysis.summary || null,
      successEvaluation: analysis.success_evaluation || null,
      collectedData: analysis.collected_data || null,
      unansweredQuestions: Array.isArray(analysis.unanswered_questions) ? analysis.unanswered_questions : null,
      sentiment: ["positive", "neutral", "negative"].includes(analysis.sentiment)
        ? analysis.sentiment : null,
      cleanedTranscript,
    };
  } catch (err) {
    console.error("[PostCallAnalysis] Failed to analyze transcript:", err.message);
    Sentry.withScope((scope) => {
      scope.setTag("service", "post-call-analysis");
      Sentry.captureException(err);
    });
    return null;
  }
}

module.exports = { analyzeCallTranscript };
