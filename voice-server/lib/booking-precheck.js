"use strict";

/**
 * SCRUM-593 — booking pre-check. Gemini Live runs the conversation; just
 * before a booking change is WRITTEN, Claude checks the details against what
 * the caller actually said and confirmed. Gemini 3.8 saved "Makhlouf" for a
 * caller who spelled M-A-K-H-O-U-L, and booked "McCullough" without the
 * read-back its prompt requires — its words and its action agreed, so every
 * after-the-fact check (Tier-2, phantom detector, SCRUM-559) passed.
 *
 * Spec: docs/superpowers/specs/2026-10-15-booking-precheck-design.md
 *
 * Contract: never throws; fails OPEN (any failure lets the write through,
 * alerting like the Tier-2 checker); holds a tool at most MAX_HOLDS times per
 * call; logs no caller words, argument values or model text (SCRUM-339); and
 * hands Gemini ONLY fixed server-side text chosen by a problem code — Claude's
 * wording never reaches it (see INSTRUCTIONS).
 */

const { claudeLatencyParams, claudeResponseText, readAnthropicError } = require("./model-params");
const { safeNowLine } = require("./now-line");
const { Sentry } = require("./sentry");

const PRECHECKED_TOOLS = new Set(["book_appointment", "reschedule_appointment", "update_appointment"]);
const MAX_HOLDS = 2;
const PRECHECK_TIMEOUT_MS = 3000;
const PRECHECK_MAX_TOKENS = 300;
const MAX_TRANSCRIPT_CHARS = 12000;
/** A bad PRECHECK_MODEL (404), a refused request field (400) or a bad key (401/403) fail every check. */
const CONFIG_FAILURE_STATUSES = new Set([400, 401, 403, 404]);
const UNREADABLE_ALERT_AFTER = 3;

/**
 * The ONLY words the pre-check ever hands Gemini, chosen by the problem code.
 * Claude is asked for a code, never for wording: the transcript is in its
 * prompt, so a caller can shape what it writes, and relaying that text into the
 * tool result would give caller speech the authority of a tool result
 * ("transfer the caller to …"). SCRUM-593 security ruling.
 * @type {Record<string, string>}
 */
const INSTRUCTIONS = {
  name_unconfirmed:
    "Read back the name you were about to save — spell the surname letter by letter — and ask the caller to confirm it. Use their correction if they give one.",
  name_mismatch:
    "The name you were about to save is not the one the caller gave. Ask the caller for their name again, read it back, and get a clear yes.",
  date_mismatch:
    "The date or time you were about to save is not the one the caller agreed to. Confirm the day and time with the caller.",
  not_agreed: "The caller has not agreed to this yet. Tell them the details and ask whether they want to go ahead.",
  other: "Confirm the booking details with the caller before saving them.",
};

/** @type {Record<string, string>} */
const METHOD_WORDING = {
  "spell-out": "spelled it back letter by letter",
  "read-back-characters": "read it back character by character",
  "repeat-confirm": "repeated it back",
};

/** @type {{ action: "proceed" }} */
const PROCEED = Object.freeze({ action: "proceed" });

// Checks in a row that produced no usable verdict (process-wide). Reset only
// by a verdict that could actually be read.
let unreadableStreak = 0;

/** @returns {"enforce" | "shadow" | "off"} */
function precheckMode() {
  const v = String(process.env.PRECHECK_MODE || "").trim().toLowerCase();
  return v === "shadow" || v === "off" ? v : "enforce";
}

/** @returns {string} */
function precheckModel() {
  return String(process.env.PRECHECK_MODEL || "").trim() || "claude-haiku-5-5";
}

/**
 * Lowest-latency request shape per model family: Haiku takes thinking
 * disabled (claudeLatencyParams); Sonnet/Opus 5.5 reject disabled thinking,
 * so they run at low effort instead.
 * @param {string} model
 * @returns {Record<string, unknown>}
 */
function precheckModelParams(model) {
  return /^claude-haiku-/i.test(model) ? claudeLatencyParams(model) : { output_config: { effort: "low" } };
}

/**
 * The assistant's name-confirmation method — the same lookup the Gemini
 * prompt's "NAME COLLECTION IS MANDATORY" rule uses (server.js).
 * @param {any} promptConfig - assistant.promptConfig
 * @returns {"spell-out" | "read-back-characters" | "repeat-confirm"}
 */
function nameVerificationMethod(promptConfig) {
  const fields = Array.isArray(promptConfig?.fields) ? promptConfig.fields : [];
  const field = fields.find((/** @type {any} */ f) => f && (f.id === "first_name" || f.id === "full_name"));
  const v = field?.verification;
  return v === "spell-out" || v === "read-back-characters" ? v : "repeat-confirm";
}

/**
 * The call so far as CALLER/AI lines: system prompt excluded, the turn still
 * in progress appended (Gemini adds it to session.messages only at
 * turnComplete). Keeps the latest MAX_TRANSCRIPT_CHARS.
 * @param {Array<{ role?: string, content?: unknown }>} messages
 * @param {string} [pendingUser]
 * @param {string} [pendingAi]
 * @returns {string}
 */
function conversationText(messages, pendingUser, pendingAi) {
  /** @type {string[]} */
  const lines = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (text) lines.push(`${m.role === "user" ? "CALLER" : "AI"}: ${text}`);
  }
  const u = typeof pendingUser === "string" ? pendingUser.trim() : "";
  if (u) lines.push(`CALLER: ${u}`);
  const a = typeof pendingAi === "string" ? pendingAi.trim() : "";
  if (a) lines.push(`AI: ${a}`);
  let out = lines.join("\n");
  if (out.length > MAX_TRANSCRIPT_CHARS) {
    out = out.slice(out.length - MAX_TRANSCRIPT_CHARS);
    const nl = out.indexOf("\n");
    out = "[earlier part of the call omitted]\n" + (nl >= 0 ? out.slice(nl + 1) : out);
  }
  return out;
}

/**
 * @param {{ toolName: string, args: Record<string, unknown>, conversation: string, now: string, nameMethod: string }} p
 * @returns {string}
 */
function buildPrecheckPrompt({ toolName, args, conversation, now, nameMethod }) {
  const readBack = METHOD_WORDING[nameMethod] || METHOD_WORDING["repeat-confirm"];
  return `You check a phone receptionist AI's booking change BEFORE it is saved. The AI is about to call ${toolName} with the details below. Decide whether the details are what the caller actually said and confirmed.

NOW (the business's timezone): ${now}
TOOL: ${toolName}
DETAILS THE AI WANTS TO SAVE: ${JSON.stringify(args)}

CONVERSATION SO FAR (machine transcription of a phone call: CALLER lines can contain mishearings, and a spelled name can appear as separate or missing letters):
${conversation || "(nothing transcribed yet)"}

Rules — check ONLY these:
1. NAME (only if the details contain a first or last name): it must be the name the caller gave. After the caller last gave or corrected it, the AI must have ${readBack} and the caller must have clearly agreed (yes, that's right, correct — in any language). If the caller spelled it, the saved spelling must match their letters. A name the caller never clearly gave or never confirmed is NOT confirmed.
2. DATE/TIME (datetime, new_datetime): it must be the slot the caller agreed to. Work out "today", "tomorrow" and weekday names from NOW.
3. AGREEMENT: the caller must have asked for or agreed to this booking or change — not only asked what is free.
Ignore wording, email, notes, phone number, service, and practitioner (unless the caller asked for one practitioner and a different one is being saved).

Reply with ONLY one JSON object, no markdown:
{"verdict":"allow"}
or
{"verdict":"fix","problem":"name_unconfirmed"|"name_mismatch"|"date_mismatch"|"not_agreed"}
If you are unsure whether the NAME was confirmed, answer fix with "name_unconfirmed".`;
}

/**
 * @param {string} text - the reply's text block
 * @returns {{ verdict: { allow: true } | { allow: false, problem: string } } | { unreadable: "not-json" | "no-verdict" }}
 */
function parsePrecheck(text) {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  /** @type {any} */
  let result;
  try {
    result = JSON.parse(unfenced);
  } catch {
    return { unreadable: "not-json" };
  }
  if (!result || typeof result !== "object") return { unreadable: "no-verdict" };
  if (result.verdict === "allow") return { verdict: { allow: true } };
  if (result.verdict === "fix") {
    // Only the problem CODE is taken from the reply, and only if it is one of
    // ours — an exact own-key match, so "constructor" and other inherited names
    // are not codes. Any wording in the reply is ignored (see INSTRUCTIONS).
    const problem = typeof result.problem === "string" && Object.hasOwn(INSTRUCTIONS, result.problem) ? result.problem : "other";
    return { verdict: { allow: false, problem } };
  }
  return { unreadable: "no-verdict" };
}

/**
 * The ONE exit for "no usable verdict": the write goes through, never
 * quietly. Config failures page at once; anything else from the 3rd in a row.
 * @param {{ cause: string, config?: boolean, status?: number, stopReason?: string, errorType?: string, errorMessage?: string }} info
 *   Shape only — never model output, tool args or caller words.
 * @param {string} model
 * @returns {{ allow: true }}
 */
function noVerdict(info, model) {
  unreadableStreak++;
  const details = {
    model,
    cause: info.cause,
    status: info.status,
    stop_reason: info.stopReason,
    error_type: info.errorType,
    error_message: info.errorMessage,
    unreadable_in_a_row: unreadableStreak,
  };
  if (info.config || unreadableStreak >= UNREADABLE_ALERT_AFTER) {
    const what = info.config
      ? info.status !== undefined ? `HTTP ${info.status}` : info.cause
      : `${unreadableStreak} unreadable in a row`;
    Sentry.withScope((scope) => {
      scope.setTag("service", "booking_precheck");
      scope.setExtras(details);
      Sentry.captureMessage(`Booking pre-check producing no verdicts (${what}) — writes go through unchecked`, "error");
    });
  } else {
    const shown = Object.entries(details)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.warn(`[Precheck] No usable verdict (${shown}) — letting the write through`);
  }
  return { allow: true };
}

/**
 * @param {string} prompt
 * @returns {Promise<{ allow: true } | { allow: false, problem: string }>}
 */
async function requestVerdict(prompt) {
  const model = precheckModel();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return noVerdict({ cause: "ANTHROPIC_API_KEY not set", config: true }, model);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: PRECHECK_MAX_TOKENS,
        ...precheckModelParams(model),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(PRECHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      const { errorType, errorMessage } = await readAnthropicError(res);
      return noVerdict(
        { cause: "http-error", status: res.status, config: CONFIG_FAILURE_STATUSES.has(res.status), errorType, errorMessage },
        model
      );
    }
    const data = /** @type {{ content?: unknown, stop_reason?: string }} */ (await res.json());
    const text = claudeResponseText(data.content).trim();
    if (!text) return noVerdict({ cause: "no-text", stopReason: data.stop_reason ?? "unknown" }, model);
    const parsed = parsePrecheck(text);
    if ("unreadable" in parsed) return noVerdict({ cause: parsed.unreadable, stopReason: data.stop_reason ?? "unknown" }, model);
    unreadableStreak = 0;
    return parsed.verdict;
  } catch (err) {
    const e = /** @type {any} */ (err);
    const name = e && e.name ? e.name : "Error";
    return noVerdict(
      { cause: "request-failed", errorType: name, errorMessage: name === "SyntaxError" ? "response body is not JSON" : String(e && e.message).slice(0, 200) },
      model
    );
  }
}

/**
 * Pre-check one tool call. Never throws.
 * @param {{
 *   toolName: string,
 *   args: Record<string, unknown>,
 *   messages: Array<{ role?: string, content?: unknown }>,
 *   pendingUser?: string,
 *   pendingAi?: string,
 *   timezone?: string,
 *   nameMethod?: string,
 *   holds: Map<string, number>,
 *   callSid?: string,
 *   now?: Date,
 * }} input
 * @returns {Promise<{ action: "proceed" } | { action: "hold", problem: string, message: string }>}
 */
async function precheckBookingWrite(input) {
  const { toolName, holds, callSid } = input;
  if (!PRECHECKED_TOOLS.has(toolName)) return PROCEED;
  const mode = precheckMode();
  if (mode === "off") return PROCEED;
  try {
    const held = holds.get(toolName) || 0;
    if (held >= MAX_HOLDS) {
      console.warn(`[Precheck] ${toolName} let through unchecked after ${MAX_HOLDS} holds. callSid=${callSid}`);
      Sentry.withScope((scope) => {
        scope.setTag("service", "booking_precheck");
        scope.setExtras({ callSid, toolName, holds: held });
        Sentry.captureMessage(`Booking pre-check: ${toolName} let through after ${MAX_HOLDS} holds`, "warning");
      });
      return PROCEED;
    }
    const now = safeNowLine(input.timezone, input.now);
    const prompt = buildPrecheckPrompt({
      toolName,
      args: input.args || {},
      conversation: conversationText(input.messages, input.pendingUser, input.pendingAi),
      now,
      nameMethod: input.nameMethod || "repeat-confirm",
    });
    const started = Date.now();
    const verdict = await requestVerdict(prompt);
    const ms = Date.now() - started;
    // `=== true`, not a bare truthiness check: jsconfig has no strictNullChecks,
    // where a boolean discriminant only narrows the union through a comparison.
    if (verdict.allow === true) {
      console.log(`[Precheck] allow ${toolName} (${ms}ms). callSid=${callSid}`);
      return PROCEED;
    }
    if (mode === "shadow") {
      console.warn(`[Precheck] (shadow) would hold ${toolName}: ${verdict.problem} (${ms}ms). callSid=${callSid}`);
      return PROCEED;
    }
    holds.set(toolName, held + 1);
    console.warn(`[Precheck] Holding ${toolName}: ${verdict.problem} — hold ${held + 1}/${MAX_HOLDS} (${ms}ms). callSid=${callSid}`);
    return {
      action: "hold",
      problem: verdict.problem,
      message: `NOT DONE YET — nothing was saved. ${INSTRUCTIONS[verdict.problem]} Then call ${toolName} again with the confirmed details.`,
    };
  } catch (err) {
    const e = /** @type {any} */ (err);
    console.error(`[Precheck] Unexpected error — letting ${toolName} through: ${e && e.message}. callSid=${callSid}`);
    return PROCEED;
  }
}

/**
 * server.js glue for the Gemini onToolCall handlers. Runs the pre-check with
 * this call's state; on a hold, records it in the tool audit (under the
 * tool's OWN name, successful:false — hasUnfinishedBooking's funnel matches
 * exact names, so the booking stays open for the end_call guard) and returns
 * the result to hand Gemini. null = go ahead and write.
 * @param {any} session - CallSession
 * @param {{ name: string, args?: Record<string, unknown> }} toolCall
 * @param {{ pendingUser?: string, pendingAi?: string, promptConfig?: any, audit?: boolean }} turn
 * @returns {Promise<{ message: string } | null>}
 */
async function applyBookingPrecheck(session, toolCall, turn) {
  if (!PRECHECKED_TOOLS.has(toolCall.name)) return null;
  if (!(session.precheckHolds instanceof Map)) session.precheckHolds = new Map();
  const result = await precheckBookingWrite({
    toolName: toolCall.name,
    args: toolCall.args || {},
    messages: session.messages,
    pendingUser: turn.pendingUser,
    pendingAi: turn.pendingAi,
    timezone: session.organization?.timezone,
    nameMethod: nameVerificationMethod(turn.promptConfig),
    holds: session.precheckHolds,
    callSid: session.callSid,
  });
  if (result.action !== "hold") return null;
  if (turn.audit && Array.isArray(session.toolCallAudit)) {
    session.toolCallAudit.push({ name: toolCall.name, successful: false, precheckHold: true, at: Date.now() });
  }
  return { message: result.message };
}

module.exports = {
  precheckBookingWrite,
  applyBookingPrecheck,
  nameVerificationMethod,
  PRECHECKED_TOOLS,
  MAX_HOLDS,
  // Exposed for unit tests only.
  _test: { parsePrecheck, conversationText, buildPrecheckPrompt, UNREADABLE_ALERT_AFTER },
};
