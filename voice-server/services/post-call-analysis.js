/**
 * Post-call structured data extraction using OpenAI with JSON mode.
 * Analyzes the conversation transcript after a call ends to extract:
 * - caller_name, caller_phone_reason, appointment_requested
 * - summary, success_evaluation, collected_data
 */

const { Sentry } = require("../lib/sentry");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANALYSIS_MODEL = "gpt-4.1-nano";

const ANALYSIS_PROMPT = `You are analyzing a phone call transcript between an AI receptionist and a caller.
The transcript may be in English, Spanish, or a mix of both. Always produce the output in English regardless of the transcript language.

Extract the following information from the transcript. If information is not available, use null.

Return a JSON object with these fields:
- caller_name: The caller's name if mentioned (string or null)
- caller_phone_reason: The primary reason for the call (string or null)
- appointment_requested: Whether the caller wanted to schedule an appointment (boolean)
- summary: A 1-2 sentence summary of the call IN ENGLISH (string)
- success_evaluation: Rate the call outcome as "successful", "partial", or "unsuccessful" (string)
- collected_data: Any structured data collected during the call like phone numbers, emails, dates mentioned (object or null)
- unanswered_questions: Questions the caller asked that the AI could not answer, said "I don't have that information", or deflected. Only include genuine knowledge gaps, not rhetorical questions. Translate to English if originally in another language. (array of strings, or null if all questions were answered)
- sentiment: The overall sentiment of the caller during the call. Use "positive" if the caller was satisfied, friendly, or got what they needed. Use "negative" if the caller was frustrated, angry, or had a bad experience. Use "neutral" for everything else. (string: "positive" | "neutral" | "negative")

Return ONLY valid JSON, no other text.`;

/**
 * Analyze a completed call transcript and extract structured data.
 *
 * @param {string} transcript - The full call transcript
 * @returns {Promise<object|null>} Extracted data or null if analysis fails
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

  try {
    const messages = [
      { role: "system", content: ANALYSIS_PROMPT },
      {
        role: "user",
        content: `Analyze this call transcript:\n\n${transcript.slice(0, 4000)}`,
      },
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        messages,
        max_tokens: 500,
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
