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
 * hands Gemini ONLY fixed server-side text chosen by the write and a problem
 * code — Claude's wording never reaches it (see HOLD_OPENING, INSTRUCTIONS).
 * Shadow mode never delays a write.
 */

const { claudeLatencyParams, claudeResponseText, readAnthropicError } = require("./model-params");
const { safeNowLine } = require("./now-line");
const { Sentry } = require("./sentry");
const { SENTRY_REASONS, setReasonTag } = require("./sentry-reasons");

/**
 * The args the check judges, per tool, in the order Claude sees them.
 * - saved: what the write will store. Rules 1 (name) and 2 (date/time) apply.
 * - identify: what only finds the existing appointment, so rules 1 and 2 do
 *   not apply: reschedule's `name` is "for identity verification only"
 *   (services/tool-executor.js), and update_appointment's `datetime` picks this
 *   call's booking (its time changes go through reschedule, SCRUM-558).
 * - practitioner: the write saves practitioner_id, which goes to Claude as the
 *   practitioner's NAME (see practitionerName), never the opaque id. Not for
 *   update_appointment, which cannot change the practitioner.
 * Everything else stays out of the prompt: phone, email, free-text notes,
 * service ids, codes and the raw practitioner id. Less PII sent offshore, and no
 * free text for the checker to misjudge or be steered by.
 * @type {Record<string, { saved: string[], identify: string[], practitioner: boolean }>}
 */
const DECISION_FIELDS = {
  book_appointment: { saved: ["first_name", "last_name", "datetime"], identify: [], practitioner: true },
  reschedule_appointment: { saved: ["new_datetime", "first_name", "last_name"], identify: ["name", "current_datetime", "current_date"], practitioner: true },
  update_appointment: { saved: ["first_name", "last_name"], identify: ["datetime"], practitioner: false },
};
const PRECHECKED_TOOLS = new Set(Object.keys(DECISION_FIELDS));
const MAX_HOLDS = 2;
const PRECHECK_TIMEOUT_MS = 3000;
const PRECHECK_MAX_TOKENS = 300;
/** Sonnet/Opus 5.5 cannot disable thinking, and thinking counts against max_tokens: leave room for it. */
const PRECHECK_MAX_TOKENS_WITH_THINKING = 1024;
const MAX_TRANSCRIPT_CHARS = 12000;
/** Of a call longer than MAX_TRANSCRIPT_CHARS, this much of its START is kept (the rest of the cap is its end). */
const TRANSCRIPT_HEAD_CHARS = 3000;
/** A staff name is quoted at most this many code points long. */
const MAX_PRACTITIONER_NAME = 80;
/** A bad PRECHECK_MODEL (404), a refused request field (400) or a bad key (401/403) fail every check. */
const CONFIG_FAILURE_STATUSES = new Set([400, 401, 403, 404]);
const UNREADABLE_ALERT_AFTER = 3;
/** What a no-verdict does to the write: the usual fail-open, or a hold on a fix already read. */
const LET_THROUGH = "letting the write through";
const HOLD_ON_FIRST = "holding on the first verdict";

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
  practitioner_mismatch:
    "The practitioner you were about to book is not the one the caller asked for. Confirm with the caller which practitioner they want.",
  not_agreed: "The caller has not agreed to this yet. Tell them the details and ask whether they want to go ahead.",
  other: "Confirm the booking details with the caller before saving them.",
};

/**
 * How a hold's tool result opens: fixed server text chosen by the write, never
 * the model's (Ruling 7). A reschedule, an update or the RebookGuard's name fix
 * is held while a booking already stands, so "nothing was saved" could make
 * Gemini tell a booked caller they have no appointment.
 */
const HOLD_OPENING = {
  newBooking: "NOT DONE YET — nothing was saved.",
  change: "NOT CHANGED YET — the existing booking still stands exactly as it was.",
};

/** @type {Record<string, string>} */
const METHOD_WORDING = {
  "spell-out": "spelled it back letter by letter",
  "read-back-characters": "read it back character by character",
  "repeat-confirm": "repeated it back",
};

/**
 * SCRUM-593: structured outputs — the reply can only be this JSON. With
 * thinking off, Haiku 5.5 otherwise writes its reasoning before the JSON; those
 * replies were unreadable and failed open (8/18 in the live replay).
 * "none" is the problem of an allow; parsePrecheck maps it (like any other
 * unknown value) to "other" when it arrives on a fix.
 */
const VERDICT_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["allow", "fix"] },
      problem: { type: "string", enum: ["none", "name_unconfirmed", "name_mismatch", "date_mismatch", "practitioner_mismatch", "not_agreed"] },
    },
    required: ["verdict", "problem"],
    additionalProperties: false,
  },
};

/** @type {{ action: "proceed" }} */
const PROCEED = Object.freeze({ action: "proceed" });

// Checks in a row that produced no usable verdict (process-wide). Reset only
// by a verdict that could actually be read.
let unreadableStreak = 0;

// An unrecognised PRECHECK_MODE is reported once per process (see precheckMode).
let warnedUnknownMode = false;
// The raw PRECHECK_MODE when it is not one we know, for the boot report (reportPrecheckConfig).
let unknownModeRaw = "";

/** "off" and the obvious negatives: the kill switch fails toward off however it was typed. */
const OFF_MODES = new Set(["off", "disabled", "disable", "false", "0", "no", "n", "none", "skip", "bypass", "stop"]);

/**
 * An operator-set value, echoed into a log line or page: JSON-quoted (no
 * line breaks), brackets stripped (it cannot forge an [ALERT:…] marker) and
 * capped.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function echoConfig(value, max) {
  return JSON.stringify(String(value)).replace(/[\[\]]/g, "").slice(0, max);
}

/**
 * Unset, empty and "enforce" enforce; "shadow" shadows; "off" and the obvious
 * negatives (OFF_MODES, trimmed, any case) switch the check off. Any other
 * value ALSO enforces, and says so: once here, and as a page at boot
 * (reportPrecheckConfig), because an operator who typed it may believe the
 * check is off or shadowed.
 * @returns {"enforce" | "shadow" | "off"}
 */
function precheckMode() {
  const raw = String(process.env.PRECHECK_MODE || "").trim();
  const v = raw.toLowerCase();
  if (v === "shadow") return "shadow";
  if (OFF_MODES.has(v)) return "off";
  if (raw && v !== "enforce") {
    unknownModeRaw = raw;
    if (!warnedUnknownMode) {
      warnedUnknownMode = true;
      console.warn(`[Precheck] unknown PRECHECK_MODE=${echoConfig(raw, 40)} — enforcing`);
    }
  }
  return "enforce";
}

/**
 * Says at boot what the pre-check will do, as one line, and pages for the two
 * settings that silently defeat it: an unrecognised PRECHECK_MODE (the check
 * ENFORCES while the operator likely meant something else) and a missing
 * ANTHROPIC_API_KEY while the check is on (every write goes through unchecked).
 */
function reportPrecheckConfig() {
  const mode = precheckMode();
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const key = hasKey ? "set" : mode === "off" ? "unset" : "MISSING";
  console.log(`[Precheck] mode=${mode} model=${precheckModel()} key=${key}`);
  if (unknownModeRaw) {
    Sentry.withScope((scope) => {
      scope.setTag("service", "booking_precheck");
      scope.setExtras({ mode_value: echoConfig(unknownModeRaw, 40) });
      Sentry.captureMessage("PRECHECK_MODE is not recognised: the booking pre-check is ENFORCING", "error");
    });
  }
  if (key === "MISSING") {
    Sentry.withScope((scope) => {
      scope.setTag("service", "booking_precheck");
      Sentry.captureMessage("Booking pre-check is on but ANTHROPIC_API_KEY is not set: writes go through unchecked", "error");
    });
  }
}

/** @returns {string} */
function precheckModel() {
  return String(process.env.PRECHECK_MODEL || "").trim() || "claude-haiku-5-5";
}

/**
 * Lowest-latency request shape per model family, both asking for the verdict
 * schema (VERDICT_FORMAT): Haiku takes thinking disabled (claudeLatencyParams),
 * its default effort and a small token cap; Sonnet/Opus 5.5 reject disabled
 * thinking, so they run at low effort with a cap that leaves room for it.
 * @param {string} model
 * @returns {Record<string, unknown>}
 */
function precheckModelParams(model) {
  return /^claude-haiku-/i.test(model)
    ? { max_tokens: PRECHECK_MAX_TOKENS, ...claudeLatencyParams(model), output_config: { format: VERDICT_FORMAT } }
    : { max_tokens: PRECHECK_MAX_TOKENS_WITH_THINKING, output_config: { effort: "low", format: VERDICT_FORMAT } };
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

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/**
 * A NAIVE local ISO date-time (optional seconds and fraction, nothing after).
 * The writer appends the business's offset only to such a value; one with Z or
 * +/-HH:MM is an absolute instant to it (src/lib/calendar/tool-handlers.ts,
 * ensureTimezoneOffset), so its digits are not the business's wall clock.
 */
const ISO_WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
/** The saved fields that hold a date and time, spelled out for Claude (see spokenDateTime). */
const SPOKEN_DATE_FIELDS = ["datetime", "new_datetime"];

/**
 * A saved ISO date-time with its spoken form beside it:
 * "2026-10-17T09:00 = Saturday, October 17, 2026, 9:00 AM". Without reasoning,
 * Haiku missed ISO-date arithmetic in the live replay ("tomorrow, Friday
 * October 16" was allowed against 2026-10-17T09:00, 3 of 3). Read from the
 * wall-clock fields alone, with the weekday from Date.UTC on the date: tool
 * args carry the business's local time, so no zone conversion applies.
 * Anything that is not a real date and time comes back unchanged.
 * @param {unknown} value
 * @returns {unknown}
 */
function spokenDateTime(value) {
  if (typeof value !== "string") return value;
  const m = ISO_WALL_CLOCK.exec(value);
  if (!m) return value;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const realDate = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!realDate || hour > 23 || minute > 59) return value;
  const clock = `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  return `${value} = ${WEEKDAY_NAMES[date.getUTCDay()]}, ${MONTH_NAMES[month - 1]} ${day}, ${year}, ${clock}`;
}

/**
 * Just these keys of a tool call's args, in this order.
 * @param {Record<string, unknown> | undefined} args
 * @param {string[]} keys
 * @returns {Record<string, unknown>}
 */
function pickArgs(args, keys) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (args && typeof args === "object") {
    for (const key of keys) {
      if (!Object.hasOwn(args, key)) continue;
      const value = args[key];
      // Blank is absent, as the writers treat it (`?.trim()` / `||`): the model does send empty
      // optional args, and a blank name must not read as a name being saved.
      if (value === undefined || value === null || (typeof value === "string" && !value.trim())) continue;
      out[key] = value;
    }
  }
  return out;
}

/**
 * Org-controlled free text (a staff name, from the dashboard or Cliniko) made
 * safe to quote in the prompt: one line, bounded. Line breaks and other
 * controls (C0, DEL, C1 incl. NEL, the Unicode line/paragraph separators)
 * become one space; characters with no visible form (zero-width, bidi, tags,
 * lone surrogates) are dropped; the cut is by code point. The treatment
 * lib/owner-prompt.js gives org names, kept local like that one (prompt-
 * builder's sanitizeForPrompt is private and weaker).
 * @param {unknown} value
 * @returns {string}
 */
function promptSafeName(value) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/[\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, MAX_PRACTITIONER_NAME).join("").trim();
}

/**
 * The practitioner a write will save, by name. The model takes practitioner_id
 * from the PRACTITIONERS ON STAFF list built from this call's schedule snapshot,
 * so the same list turns it back into the name the caller would have asked for.
 * An id it cannot resolve (no snapshot, as for a Cliniko org; an unknown id; a
 * nameless entry) gives "": the field is left out and the check runs as usual.
 * @param {Record<string, unknown> | undefined} args
 * @param {unknown} practitioners - session.scheduleSnapshot.practitioners: [{ id, name, ... }]
 * @returns {string}
 */
function practitionerName(args, practitioners) {
  const id = args && typeof args.practitioner_id === "string" ? args.practitioner_id.trim() : "";
  if (!id || !Array.isArray(practitioners)) return "";
  const entry = practitioners.find((/** @type {any} */ p) => p && typeof p === "object" && p.id === id);
  return entry ? promptSafeName(entry.name) : "";
}

/**
 * The decision fields of a tool call's args (see DECISION_FIELDS): what it will
 * save, and what only identifies the existing appointment.
 * @param {string} toolName - one of PRECHECKED_TOOLS
 * @param {Record<string, unknown> | undefined} args
 * @param {unknown} [practitioners] - the call's staff list, to name the practitioner being saved
 * @returns {{ saved: Record<string, unknown>, identify: Record<string, unknown> }}
 */
function decisionArgs(toolName, args, practitioners) {
  const fields = DECISION_FIELDS[toolName];
  const saved = pickArgs(args, fields.saved);
  for (const key of SPOKEN_DATE_FIELDS) {
    if (Object.hasOwn(saved, key)) saved[key] = spokenDateTime(saved[key]);
  }
  const practitioner = fields.practitioner ? practitionerName(args, practitioners) : "";
  if (practitioner) saved.practitioner = practitioner;
  return { saved, identify: pickArgs(args, fields.identify) };
}

/**
 * The call so far as CALLER/AI lines: system prompt excluded, the turn still
 * in progress appended (Gemini adds it to the transcript only at
 * turnComplete). A call longer than MAX_TRANSCRIPT_CHARS keeps its first
 * 3,000 characters and its last 9,000, in whole lines around one
 * "[middle of the call omitted]" line: the name is usually confirmed early,
 * and a tail-only cut held a correct booking as unconfirmed (live replay).
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
  const out = lines.join("\n");
  if (out.length <= MAX_TRANSCRIPT_CHARS) return out;
  const head = wholeLinesFromStart(out, TRANSCRIPT_HEAD_CHARS);
  const tail = wholeLinesFromEnd(out, MAX_TRANSCRIPT_CHARS - TRANSCRIPT_HEAD_CHARS);
  return `${head}\n[middle of the call omitted]\n${tail}`;
}

/**
 * The longest run of whole lines within the first n characters (a single
 * longer line is cut).
 * @param {string} text
 * @param {number} n
 * @returns {string}
 */
function wholeLinesFromStart(text, n) {
  if (text.length <= n || text[n] === "\n") return text.slice(0, n);
  const nl = text.lastIndexOf("\n", n - 1);
  return nl > 0 ? text.slice(0, nl) : text.slice(0, n);
}

/**
 * The longest run of whole lines within the last n characters (a single
 * longer line is cut).
 * @param {string} text
 * @param {number} n
 * @returns {string}
 */
function wholeLinesFromEnd(text, n) {
  if (text.length <= n) return text;
  const start = text.length - n;
  if (text[start - 1] === "\n") return text.slice(start);
  const nl = text.indexOf("\n", start);
  return nl >= 0 ? text.slice(nl + 1) : text.slice(start);
}

/**
 * Everything the caller has said so far, one trimmed line per turn: the
 * transcript's caller lines, then the turn in progress. If it grows while a
 * check runs, the caller spoke during it. The same words moving from the turn
 * in progress into the transcript (the turn completed) are not a change.
 * @param {Array<{ role?: string, content?: unknown }>} messages
 * @param {string} pendingUser
 * @returns {string}
 */
function callerWords(messages, pendingUser) {
  /** @type {string[]} */
  const lines = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = m && m.role === "user" && typeof m.content === "string" ? m.content.trim() : "";
    if (text) lines.push(text);
  }
  const u = pendingUser.trim();
  if (u) lines.push(u);
  return lines.join("\n");
}

/**
 * The turn still in progress: read live through the handler's getter when it
 * passed one, else the static text.
 * @param {PrecheckInput} input
 * @returns {{ user: string, ai: string }}
 */
function turnInProgress(input) {
  const p = typeof input.getPending === "function" ? input.getPending() : { user: input.pendingUser, ai: input.pendingAi };
  return { user: typeof p?.user === "string" ? p.user : "", ai: typeof p?.ai === "string" ? p.ai : "" };
}

/**
 * @param {{ toolName: string, saved: Record<string, unknown>, identify: Record<string, unknown>, conversation: string, now: string, nameMethod: string, nameCorrection?: boolean }} p
 *   nameCorrection - the RebookGuard's fix of the name on this call's booking: without saying so, the
 *   re-sent book_appointment read as a second booking and its corrected name as a mismatch with the old one
 * @returns {string}
 */
function buildPrecheckPrompt({ toolName, saved, identify, conversation, now, nameMethod, nameCorrection }) {
  const readBack = METHOD_WORDING[nameMethod] || METHOD_WORDING["repeat-confirm"];
  const opening = nameCorrection
    ? "You check a phone receptionist AI's change BEFORE it is saved. The AI already booked this caller earlier in this call and is about to CORRECT the caller's name on that booking (same appointment, same time). Decide whether the corrected name is what the caller said and confirmed."
    : `You check a phone receptionist AI's booking change BEFORE it is saved. The AI is about to call ${toolName} with the details below. Decide whether the details are what the caller actually said and confirmed.`;
  const tool = nameCorrection ? `${toolName} (name correction on the booking already made in this call)` : toolName;
  // A new booking identifies nothing: no section, rather than an empty one about an "existing appointment".
  const identifyLine = Object.keys(identify).length
    ? `\nDETAILS THAT ONLY IDENTIFY THE EXISTING APPOINTMENT (rules 1 and 2 do NOT apply to these): ${JSON.stringify(identify)}`
    : "";
  return `${opening}

NOW (the business's timezone): ${now}
TOOL: ${tool}
DETAILS THAT WILL BE SAVED: ${JSON.stringify(saved)}${identifyLine}

CONVERSATION SO FAR (machine transcription of a phone call: CALLER lines can contain mishearings, and a spelled name can appear as separate or missing letters):
${conversation || "(nothing transcribed yet)"}

Rules — check ONLY these:
1. NAME (only if DETAILS THAT WILL BE SAVED contain a first or last name): it must be the name the caller gave. After the caller last gave or corrected it, the AI must have ${readBack} and the caller must have clearly agreed (yes, that's right, correct — in any language). If the caller spelled it, the saved spelling must match their letters. A name the caller never clearly gave or never confirmed is NOT confirmed.
2. DATE/TIME (only a date or time in DETAILS THAT WILL BE SAVED): it must be the slot the caller agreed to. Work out "today", "tomorrow" and weekday names from NOW.
3. AGREEMENT: the caller must have asked for or agreed to this booking or change — not only asked what is free.
4. PRACTITIONER (only if DETAILS THAT WILL BE SAVED contain a practitioner AND the caller asked for a specific person): the saved practitioner must be the person the caller asked for. Otherwise answer fix with "practitioner_mismatch".
Ignore wording, email, notes, phone number and service.

Answer with "verdict" and "problem" ("none" when you allow). If you are unsure whether the NAME was confirmed, answer fix with "name_unconfirmed".`;
}

/**
 * @param {string} text - the reply's text block
 * @returns {{ verdict: { allow: true } | { allow: false, problem: string } } | { unreadable: "not-json" | "no-verdict" }}
 */
function parsePrecheck(text) {
  // With structured outputs (VERDICT_FORMAT) the reply is bare JSON; the fence
  // strip is a harmless guard for a model or API that ignores the schema.
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  /** @type {any} */
  let result;
  try {
    result = JSON.parse(unfenced);
  } catch {
    return { unreadable: "not-json" };
  }
  if (!result || typeof result !== "object") return { unreadable: "no-verdict" };
  // The schema makes an allow carry problem "none"; whatever it says is ignored.
  if (result.verdict === "allow") return { verdict: { allow: true } };
  if (result.verdict === "fix") {
    // Only the problem CODE is taken from the reply, and only if it is one of
    // ours — an exact own-key match, so "none" (the schema's no-problem value),
    // "constructor" and other inherited names are not codes and become "other".
    // Any wording in the reply is ignored (see INSTRUCTIONS).
    const problem = typeof result.problem === "string" && Object.hasOwn(INSTRUCTIONS, result.problem) ? result.problem : "other";
    return { verdict: { allow: false, problem } };
  }
  return { unreadable: "no-verdict" };
}

/**
 * The ONE exit for "no usable verdict": never quiet. Config failures page at
 * once; anything else from the 3rd in a row. The result is allow:true but
 * unchecked:true, so callers never log it as a verdict that was read. The write
 * goes through, except after a fix verdict (a failed re-check holds on it).
 * @param {{ cause: string, config?: boolean, status?: number, stopReason?: string, errorType?: string, errorMessage?: string, ms?: number }} info
 *   Shape only (ms is a number) — never model output, tool args or caller words.
 * @param {string} model
 * @param {string} [outcome] - what happens to the write, for the log line
 * @returns {{ allow: true, unchecked: true }}
 */
function noVerdict(info, model, outcome = LET_THROUGH) {
  unreadableStreak++;
  const details = {
    model,
    cause: info.cause,
    status: info.status,
    stop_reason: info.stopReason,
    error_type: info.errorType,
    error_message: info.errorMessage,
    unreadable_in_a_row: unreadableStreak,
    ms: info.ms,
  };
  if (info.config || unreadableStreak >= UNREADABLE_ALERT_AFTER) {
    const what = info.config
      ? info.status !== undefined ? `HTTP ${info.status}` : info.cause
      : `${unreadableStreak} unreadable in a row`;
    // What happened to THIS write: a failed re-check held on the first verdict.
    const result = outcome === HOLD_ON_FIRST ? "held on the first verdict" : "writes go through unchecked";
    Sentry.withScope((scope) => {
      scope.setTag("service", "booking_precheck");
      scope.setExtras(details);
      Sentry.captureMessage(`Booking pre-check producing no verdicts (${what}) — ${result}`, "error");
    });
  } else {
    const shown = Object.entries(details)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.warn(`[Precheck] No usable verdict (${shown}) — ${outcome}`);
  }
  return { allow: true, unchecked: true };
}

/**
 * @param {string} prompt
 * @param {string} [outcome] - what happens to the write if no verdict comes back (see noVerdict)
 * @returns {Promise<{ allow: true, unchecked?: true } | { allow: false, problem: string }>}
 */
async function requestVerdict(prompt, outcome = LET_THROUGH) {
  const model = precheckModel();
  const started = Date.now();
  /** Every way out without a verdict, timed from the request start. */
  const failed = (/** @type {Parameters<typeof noVerdict>[0]} */ info) => noVerdict({ ...info, ms: Date.now() - started }, model, outcome);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return failed({ cause: "ANTHROPIC_API_KEY not set", config: true });
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        ...precheckModelParams(model),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(PRECHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      const { errorType, errorMessage } = await readAnthropicError(res);
      return failed({ cause: "http-error", status: res.status, config: CONFIG_FAILURE_STATUSES.has(res.status), errorType, errorMessage });
    }
    const data = /** @type {{ content?: unknown, stop_reason?: string }} */ (await res.json());
    const text = claudeResponseText(data.content).trim();
    if (!text) return failed({ cause: "no-text", stopReason: data.stop_reason ?? "unknown" });
    const parsed = parsePrecheck(text);
    if ("unreadable" in parsed) return failed({ cause: parsed.unreadable, stopReason: data.stop_reason ?? "unknown" });
    unreadableStreak = 0;
    return parsed.verdict;
  } catch (err) {
    const e = /** @type {any} */ (err);
    const name = e && e.name ? e.name : "Error";
    return failed({ cause: "request-failed", errorType: name, errorMessage: name === "SyntaxError" ? "response body is not JSON" : String(e && e.message).slice(0, 200) });
  }
}

/**
 * One tool call to pre-check. The turn in progress comes from getPending when
 * it is given (read live, so a fix can be asked again with words that arrived
 * during the check), else from the static pendingUser/pendingAi.
 * @typedef {{
 *   toolName: string,
 *   args: Record<string, unknown>,
 *   messages: Array<{ role?: string, content?: unknown }>,
 *   pendingUser?: string,
 *   pendingAi?: string,
 *   getPending?: () => { user?: unknown, ai?: unknown },
 *   practitioners?: unknown,
 *   correction?: boolean,
 *   timezone?: string,
 *   nameMethod?: string,
 *   holds: Map<string, number>,
 *   callSid?: string,
 *   now?: Date,
 * }} PrecheckInput
 *   correction - a book_appointment that is the RebookGuard's name fix on a booking that stands
 */

/**
 * Claude's verdict on one write. On a fix (enforce only), asks ONCE more if
 * the caller's words grew during the check: Gemini's transcription of them has
 * no guaranteed order against its tool calls (SCRUM-587), so the "yes" that
 * confirmed a booking can land after the call it confirmed. Words that shrank
 * or changed are no new evidence (cleanup clears the turn in progress), so the
 * first verdict stands. An allow never waits for any of this.
 * A re-check that reads a verdict is final. One that produces none (an error,
 * a timeout, an unreadable reply) holds on the first verdict: a real verdict
 * already found a problem, and failing open there could save the very data it
 * caught. That failure still counts and pages like any other.
 * @param {PrecheckInput} input
 * @param {Record<string, unknown>} saved
 * @param {Record<string, unknown>} identify
 * @param {boolean} recheck - false in shadow mode, which logs the first verdict only
 * @returns {Promise<{ allow: true, unchecked?: true } | { allow: false, problem: string }>}
 */
async function decide(input, saved, identify, recheck) {
  const now = safeNowLine(input.timezone, input.now);
  const ask = (/** @type {{ user: string, ai: string }} */ turn, /** @type {string} */ outcome = LET_THROUGH) =>
    requestVerdict(
      buildPrecheckPrompt({
        toolName: input.toolName,
        saved,
        identify,
        conversation: conversationText(input.messages, turn.user, turn.ai),
        now,
        nameMethod: input.nameMethod || "repeat-confirm",
        nameCorrection: input.toolName === "book_appointment" && input.correction === true,
      }),
      outcome
    );
  const turn = turnInProgress(input);
  const heard = callerWords(input.messages, turn.user);
  const verdict = await ask(turn);
  if (verdict.allow === true || !recheck) return verdict;
  // A real verdict found a problem: from here nothing may turn it into a write.
  const recheckStarted = Date.now();
  try {
    const fresh = turnInProgress(input);
    // callerWords is trimmed line by line, so growth means the same words and more.
    const heardNow = callerWords(input.messages, fresh.user);
    if (!(heardNow.length > heard.length && heardNow.startsWith(heard))) return verdict;
    console.log(`[Precheck] caller spoke during the check — re-checking ${input.toolName} once. callSid=${input.callSid}`);
    const second = await ask(fresh, HOLD_ON_FIRST);
    if (!(second.allow === true && second.unchecked)) return second;
  } catch (err) {
    const e = /** @type {any} */ (err);
    noVerdict({ cause: "unexpected-error", errorType: e?.name, errorMessage: String(e?.message).slice(0, 200), ms: Date.now() - recheckStarted }, precheckModel(), HOLD_ON_FIRST);
  }
  console.warn(`[Precheck] re-check failed — holding on the first verdict ${input.toolName}: ${verdict.problem}. callSid=${input.callSid}`);
  return verdict;
}

/**
 * Pre-check one tool call. Never throws. A call that saves no name or date (an
 * update of only phone, email or notes) proceeds without asking Claude.
 * @param {PrecheckInput} input
 * @returns {Promise<{ action: "proceed" } | { action: "hold", problem: string, message: string }>}
 */
async function precheckBookingWrite(input) {
  const { toolName, holds, callSid } = input;
  if (!PRECHECKED_TOOLS.has(toolName)) return PROCEED;
  const mode = precheckMode();
  if (mode === "off") return PROCEED;
  const started = Date.now();
  // Fails open THROUGH noVerdict like every other way of not getting a verdict, so an
  // unexpected error counts toward the streak and pages from the third in a row.
  const unexpected = (/** @type {any} */ e) =>
    noVerdict({ cause: "unexpected-error", errorType: e?.name, errorMessage: String(e?.message).slice(0, 200), ms: Date.now() - started }, precheckModel());
  // "unchecked" = no verdict could be read (noVerdict already logged or paged why). Logging
  // that as "allow" would count writes nobody checked as checked ones.
  const logAllow = (/** @type {{ unchecked?: true }} */ verdict) =>
    console.log(`[Precheck] ${verdict.unchecked ? "unchecked" : "allow"} ${toolName} (${Date.now() - started}ms). callSid=${callSid}`);
  try {
    // Nothing to check: a call that saves no name and no date (an update of only the phone, email
    // or notes, even one that names its booking's datetime) has nothing to compare with the call,
    // and asking could only produce a false hold. Not a hold and not a failure: no request, no
    // count, no page. It comes before the hold cap, so a capped tool with nothing to check is not
    // reported as let through.
    const { saved, identify } = decisionArgs(toolName, input.args, input.practitioners);
    if (Object.keys(saved).length === 0) {
      console.log(`[Precheck] skip ${toolName} (no name or date to save). callSid=${callSid}`);
      return PROCEED;
    }
    const held = holds.get(toolName) || 0;
    if (held >= MAX_HOLDS) {
      console.warn(`[Precheck] ${toolName} let through unchecked after ${MAX_HOLDS} holds. callSid=${callSid}`);
      Sentry.withScope((scope) => {
        scope.setTag("service", "booking_precheck");
        setReasonTag(scope, SENTRY_REASONS.PRECHECK_HOLD_CAP);
        scope.setExtras({ callSid, toolName, holds: held });
        // Error, not warning: no alert rule pages on warnings, and a check that holds every
        // booking until the cap lets it through must not go unnoticed.
        Sentry.captureMessage(`Booking pre-check: ${toolName} let through unchecked after ${MAX_HOLDS} holds`, "error");
      });
      return PROCEED;
    }
    // Started here, so the prompt is built from the call as it stands at the tool call.
    const pending = decide(input, saved, identify, mode === "enforce");
    if (mode === "shadow") {
      // Shadow only reports what enforce would do, so it never makes the write wait: the
      // check runs on, and its would-be verdict is logged when it lands.
      pending
        .then((verdict) => {
          // `=== true`: see the enforce branch below.
          if (verdict.allow === true) logAllow(verdict);
          else console.warn(`[Precheck] (shadow) would hold ${toolName}: ${verdict.problem} (${Date.now() - started}ms). callSid=${callSid}`);
        })
        .catch(unexpected);
      return PROCEED;
    }
    const verdict = await pending;
    // `=== true`, not a bare truthiness check: jsconfig has no strictNullChecks,
    // where a boolean discriminant only narrows the union through a comparison.
    if (verdict.allow === true) {
      logAllow(verdict);
      return PROCEED;
    }
    // Read the count again: another check of this tool may have held while we awaited.
    const count = (holds.get(toolName) || 0) + 1;
    holds.set(toolName, count);
    console.warn(`[Precheck] Holding ${toolName}: ${verdict.problem} — hold ${count}/${MAX_HOLDS} (${Date.now() - started}ms). callSid=${callSid}`);
    const opening = toolName === "book_appointment" && !input.correction ? HOLD_OPENING.newBooking : HOLD_OPENING.change;
    return {
      action: "hold",
      problem: verdict.problem,
      message: `${opening} ${INSTRUCTIONS[verdict.problem]} Then call ${toolName} again with the confirmed details.`,
    };
  } catch (err) {
    unexpected(err);
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
 * @param {{ pendingUser?: string, pendingAi?: string, getPending?: () => { user?: unknown, ai?: unknown }, promptConfig?: any, audit?: boolean, correction?: boolean }} turn
 *   getPending - the handler's live transcript buffers (preferred over the static pendingUser/pendingAi);
 *   correction - the RebookGuard's name fix: its hold says the booking still stands
 * @returns {Promise<{ message: string } | null>}
 */
async function applyBookingPrecheck(session, toolCall, turn) {
  try {
    if (!PRECHECKED_TOOLS.has(toolCall.name)) return null;
    if (!(session.precheckHolds instanceof Map)) session.precheckHolds = new Map();
    const result = await precheckBookingWrite({
      toolName: toolCall.name,
      args: toolCall.args || {},
      // The whole call: session.messages keeps only the last 20, and on a longer call the name
      // read-back and the caller's yes fall out of it (a correct booking then reads as unconfirmed).
      // restoreFrom (a failed transfer's reconnect) restores only the windowed copy, hence the fallback.
      messages: session.fullTranscriptMessages?.length ? session.fullTranscriptMessages : session.messages,
      pendingUser: turn.pendingUser,
      pendingAi: turn.pendingAi,
      getPending: turn.getPending,
      correction: turn.correction === true,
      // The staff list the model took practitioner_id from (PRACTITIONERS ON STAFF).
      practitioners: session.scheduleSnapshot?.practitioners,
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
  } catch (err) {
    // Runs in front of a booking write inside the tool handler: never throw into it. One page
    // (no error message: it could carry caller words), and the write goes through unchecked.
    const e = /** @type {any} */ (err);
    Sentry.withScope((scope) => {
      scope.setTag("service", "booking_precheck");
      scope.setExtras({ callSid: session?.callSid, toolName: toolCall?.name, errorType: e && e.name ? e.name : "Error" });
      Sentry.captureMessage("Booking pre-check glue threw — write went through unchecked", "error");
    });
    return null;
  }
}

module.exports = {
  precheckBookingWrite,
  applyBookingPrecheck,
  nameVerificationMethod,
  precheckMode,
  reportPrecheckConfig,
  spokenDateTime,
  PRECHECKED_TOOLS,
  MAX_HOLDS,
};
