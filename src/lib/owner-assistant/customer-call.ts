// src/lib/owner-assistant/customer-call.ts
// SCRUM-598: the assistant's call to a customer — "call the client ... confirm the
// appointment or cancel it", "call them and get another time". The voice server
// decides whether a call may be placed and places it (voice-server/lib/customer-
// call.js); this is its client, plus what the owner hears when a call can't be made.
// Every failure to reach the voice server means "no call": a call is never assumed.
import { toNumberingPlanE164 } from "@/lib/sms/sms-capability";

export const CALL_PURPOSES = ["cancelled", "moved", "confirm", "find_new_time"] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

/** What the assistant may record about a call (record_call_outcome — the voice server's CALL_OUTCOMES; the parity test keeps them in step). */
export const CALL_OUTCOMES = ["confirmed", "rebooked", "declined", "will_call_back", "wrong_person", "do_not_call", "other"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export function parseCallOutcome(v: unknown): CallOutcome | null {
  return typeof v === "string" && (CALL_OUTCOMES as readonly string[]).includes(v) ? (v as CallOutcome) : null;
}

/**
 * find_new_time's window for the new time: structured fields only, so nothing the
 * owner session writes reaches the customer call as text (security lens F2).
 */
export const TIMES_OF_DAY = ["morning", "afternoon", "evening", "any"] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];
export interface TimeWindow {
  /** First day the new time may be on (YYYY-MM-DD, org-local), or null. */
  earliest: string | null;
  /** Last day (YYYY-MM-DD), or null. */
  latest: string | null;
  timeOfDay: TimeOfDay;
}

/** The voice server's reasons (its CALL_BLOCK_REASONS; the parity test keeps them in step). */
export const VOICE_CALL_BLOCK_REASONS = [
  "calls_disabled",
  "pipeline_unavailable",
  "invalid_request",
  "not_owner_session",
  "demo_org",
  "not_found",
  "wrong_state",
  "number_mismatch",
  "not_au",
  "outside_hours",
  "no_caller_number",
  "org_cap",
  "number_cap",
  "already_called",
  "do_not_call",
  "check_failed",
  "busy",
  "place_failed",
] as const;
type VoiceCallBlockReason = (typeof VOICE_CALL_BLOCK_REASONS)[number];

/**
 * Why a call isn't placed: the voice server's reasons, plus this side's own —
 * no_number (nothing to dial), not_callable_number (a number we may not ring: not
 * an AU mobile or landline), voice_unreachable (the request never got an answer
 * before anything was sent, or the check couldn't run) and place_unconfirmed (the
 * placement went out but no answer came back: the call may be ringing).
 */
export type CallBlockReason = VoiceCallBlockReason | "no_number" | "not_callable_number" | "voice_unreachable" | "place_unconfirmed";

export type CallCheck = { canCall: true } | { canCall: false; reason: CallBlockReason };
export type CallPlacement = { placed: true; callId: string } | { placed: false; reason: CallBlockReason };

/**
 * What the owner hears when a call can't be made, as "I couldn't call Jane: <why>".
 * Every reason (checked by the compiler).
 */
const CALL_WHY = {
  calls_disabled: "calling customers isn't available yet",
  pipeline_unavailable: "calls aren't available right now",
  invalid_request: "something went wrong on our side",
  not_owner_session: "calls can only be asked for from your own assistant",
  demo_org: "the demo can't call anyone",
  not_found: "I couldn't find that booking any more",
  wrong_state: "that booking has changed since",
  number_mismatch: "the number on the booking has changed",
  not_au: "I can only call Australian numbers for now",
  outside_hours: "it's outside calling hours (8 am to 8 pm), and I can't schedule calls for later yet — ask me again after 8 am",
  no_caller_number: "you don't have a Phondo phone number to call from yet — set one up under Phone Numbers",
  org_cap: "you've reached today's limit of 20 calls",
  number_cap: "they've already had two calls from you today",
  already_called: "I've already called them about this",
  do_not_call: "they've asked not to be called",
  check_failed: "I couldn't check whether a call is OK right now",
  busy: "too many calls are going out right now",
  place_failed: "the call couldn't be placed",
  no_number: "there's no number on the booking",
  not_callable_number: "I can only call Australian mobiles and landlines",
  voice_unreachable: "I couldn't reach the phone system",
  place_unconfirmed: "I couldn't confirm the call went out, so check Calls in the dashboard before you ring them",
} satisfies Record<CallBlockReason, string>;

/** The spoken reason a call wasn't (or can't be) placed. */
export function callWhy(reason: CallBlockReason): string {
  return CALL_WHY[reason];
}

/**
 * The refusals worth a word in the read-back: something about THIS customer or
 * the time of day that the owner can act on. The rest (calls not switched on, the
 * phone system unreachable, a fault) leave "call" out quietly — asked to call anyway,
 * the assistant gets the reason then.
 */
const NOTED_CALL_REASONS: ReadonlySet<CallBlockReason> = new Set<CallBlockReason>([
  "outside_hours",
  "org_cap",
  "number_cap",
  "already_called",
  "do_not_call",
  "not_au",
  "no_caller_number",
  "not_callable_number",
]);

/** Refusals that asking later won't change: said without "now" (clients lens S3). */
const LASTING_CALL_REASONS: ReadonlySet<CallBlockReason> = new Set<CallBlockReason>([
  "do_not_call",
  "not_au",
  "no_caller_number",
  "not_callable_number",
]);

/** The read-back's note when a call isn't offered, or null when it isn't worth saying. */
export function callNote(reason: CallBlockReason): string | null {
  if (!NOTED_CALL_REASONS.has(reason)) return null;
  return `I can't call them${LASTING_CALL_REASONS.has(reason) ? "" : " now"}: ${CALL_WHY[reason]}.`;
}

/** AU numbers the assistant may ring: geographic (02/03/07/08) and mobile (04) — the voice server's own rule. */
const AU_DIALABLE_RE = /^\+61[23478]\d{8}$/;

/** The booking's number as the voice server needs it (AU E.164, mobile or landline), or null. */
export function callablePhone(raw: string | null | undefined): string | null {
  const e164 = toNumberingPlanE164(raw);
  return e164 && AU_DIALABLE_RE.test(e164) ? e164 : null;
}

/** Why there's nothing to dial: no number at all, or one we may not ring (13/1300, overseas…). */
function noDialReason(raw: string | null | undefined): "no_number" | "not_callable_number" {
  return typeof raw === "string" && raw.replace(/\D/g, "").length > 0 ? "not_callable_number" : "no_number";
}

export interface CustomerCallRequest {
  organizationId: string;
  /** The booking the call is about: the cancelled one, the NEW leg of a move, or the one to confirm / move. */
  appointmentId: string;
  purpose: CallPurpose;
  /** The booking's stored number (normalised here). */
  phone: string | null | undefined;
  /** The owner session the request comes from (the envelope callId). */
  requestedByCallId: string;
  /** find_new_time only: the window for the new time. */
  window?: TimeWindow | null;
}

export interface CustomerCallDeps {
  fetch?: typeof fetch;
  voiceServerUrl?: string;
  internalSecret?: string;
}

const CHECK_TIMEOUT_MS = 4_000;
/**
 * Placing waits on Twilio, which the voice server gives 9 s: its own refusal arrives
 * first, and the whole change + call fits inside the owner's 15-second tool call.
 */
const PLACE_TIMEOUT_MS = 12_000;

function isVoiceReason(v: unknown): v is VoiceCallBlockReason {
  return typeof v === "string" && (VOICE_CALL_BLOCK_REASONS as readonly string[]).includes(v);
}

/**
 * The voice server's JSON answer, or why there is none: `sent` is true when the
 * request may have reached it (a timeout, a dropped connection, a 5xx), false when
 * nothing went out (unconfigured) or it was refused outright (4xx).
 */
type VoiceReply = { ok: true; json: Record<string, unknown> } | { ok: false; sent: boolean };

async function postToVoice(
  route: "/internal/customer-call/check" | "/internal/customer-call",
  body: Record<string, unknown>,
  timeoutMs: number,
  deps: CustomerCallDeps
): Promise<VoiceReply> {
  const url = deps.voiceServerUrl ?? process.env.VOICE_SERVER_PUBLIC_URL;
  const secret = deps.internalSecret ?? process.env.INTERNAL_API_SECRET;
  if (!url || !secret) {
    console.error("[customer-call] VOICE_SERVER_PUBLIC_URL or INTERNAL_API_SECRET unset — no customer calls", { route });
    return { ok: false, sent: false };
  }
  try {
    const res = await (deps.fetch ?? fetch)(`${url}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.error("[customer-call] voice server refused:", { route, status: res.status });
      return { ok: false, sent: res.status >= 500 };
    }
    const json = (await res.json()) as unknown;
    if (json && typeof json === "object") return { ok: true, json: json as Record<string, unknown> };
    console.error("[customer-call] voice server answered without a JSON object:", { route });
    return { ok: false, sent: true };
  } catch (err) {
    console.error("[customer-call] voice server unreachable:", { route, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, sent: true };
  }
}

function wireBody(req: CustomerCallRequest, phone: string): Record<string, unknown> {
  return {
    organizationId: req.organizationId,
    appointmentId: req.appointmentId,
    purpose: req.purpose,
    phone,
    requestedByCallId: req.requestedByCallId,
    ...(req.purpose === "find_new_time" && req.window ? { window: req.window } : {}),
  };
}

/** Can the assistant call this customer about this booking right now? Never throws. */
export async function checkCustomerCall(req: CustomerCallRequest, deps: CustomerCallDeps = {}): Promise<CallCheck> {
  const phone = callablePhone(req.phone);
  if (!phone) return { canCall: false, reason: noDialReason(req.phone) };
  const reply = await postToVoice("/internal/customer-call/check", wireBody(req, phone), CHECK_TIMEOUT_MS, deps);
  if (!reply.ok) return { canCall: false, reason: "voice_unreachable" };
  if (reply.json.canCall === true) return { canCall: true };
  return { canCall: false, reason: isVoiceReason(reply.json.reason) ? reply.json.reason : "check_failed" };
}

/**
 * Place the call. The voice server re-checks everything first. Never throws; an
 * unclear answer is "not placed" (the owner is told, and can ring the customer).
 */
export async function placeCustomerCall(req: CustomerCallRequest, deps: CustomerCallDeps = {}): Promise<CallPlacement> {
  const phone = callablePhone(req.phone);
  if (!phone) return { placed: false, reason: noDialReason(req.phone) };
  const reply = await postToVoice("/internal/customer-call", wireBody(req, phone), PLACE_TIMEOUT_MS, deps);
  // Sent but unanswered, the call may be ringing: never tell the owner it wasn't placed.
  if (!reply.ok) return { placed: false, reason: reply.sent ? "place_unconfirmed" : "voice_unreachable" };
  const json = reply.json;
  if (json.placed === true && typeof json.callId === "string" && json.callId) return { placed: true, callId: json.callId };
  if (json.placed === true) return { placed: false, reason: "place_unconfirmed" };
  return { placed: false, reason: isVoiceReason(json.reason) ? json.reason : "place_failed" };
}
