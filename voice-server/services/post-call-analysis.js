/**
 * Post-call structured data extraction using OpenAI with JSON mode.
 * Analyzes the conversation transcript after a call ends to extract:
 * - caller_name, caller_phone_reason, appointment_requested
 * - summary, success_evaluation, collected_data
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANALYSIS_MODEL = "gpt-4.1-nano";

const ANALYSIS_PROMPT = `You are analyzing a phone call transcript between an AI receptionist and a caller.
Extract the following information from the transcript. If information is not available, use null.

Return a JSON object with these fields:
- caller_name: The caller's name if mentioned (string or null)
- caller_phone_reason: The primary reason for the call (string or null)
- appointment_requested: Whether the caller wanted to schedule an appointment (boolean)
- summary: A 1-2 sentence summary of the call (string)
- success_evaluation: Rate the call outcome as "successful", "partial", or "unsuccessful" (string)
- collected_data: Any structured data collected during the call like phone numbers, emails, dates mentioned (object or null)
- unanswered_questions: Questions the caller asked that the AI could not answer, said "I don't have that information", or deflected. Only include genuine knowledge gaps, not rhetorical questions. (array of strings, or null if all questions were answered)

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
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error("[PostCallAnalysis] OpenAI returned empty content");
      return null;
    }

    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (parseErr) {
      console.error("[PostCallAnalysis] Failed to parse OpenAI response as JSON:", content.slice(0, 200));
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
    };
  } catch (err) {
    console.error("[PostCallAnalysis] Failed to analyze transcript:", err.message);
    return null;
  }
}

module.exports = { analyzeCallTranscript };
