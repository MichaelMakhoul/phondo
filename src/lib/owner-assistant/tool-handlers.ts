// src/lib/owner-assistant/tool-handlers.ts
// SCRUM-586: the business owner's tools — what the AI can do once a call has
// passed the owner PIN gate (spec: docs/superpowers/specs/2026-10-09-owner-
// assistant-design.md §2-§4). Reached ONLY through the internal tool-call
// route's owner dispatch (envelope `ownerVerified` + production call). Every
// query is org-scoped in SQL; ids come back in `data` so the model never has
// to speak them. SMS to customers is paused (SCRUM-264) — every change says so.
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResult, toLocalIsoMinute, type ToolResult } from "@/lib/calendar/tool-handlers";
import { pickName } from "@/lib/calendar/appointment-lifecycle";
import { OWNER_RANGES, type OwnerRange, ownerRangeBounds, localDayRange, todayISO, formatWhen } from "./time";

export const OWNER_TOOL_NAMES = [
  "owner_list_appointments",
  "owner_list_messages",
  "owner_reschedule_appointment",
  "owner_cancel_appointment",
] as const;
export type OwnerToolName = (typeof OWNER_TOOL_NAMES)[number];

/** Set by the internal route from the request ENVELOPE (never from model arguments). */
export interface OwnerCallContext {
  callId: string;
}

export interface OwnerAppointmentItem {
  appointment_id: string;
  confirmation_code: string | null;
  /** Org-local "YYYY-MM-DDTHH:mm" — the format `owner_reschedule_appointment` reads back. */
  start_local: string;
  end_local: string | null;
  /** Spoken form, e.g. "Thursday, October 15 at 2:00 PM". */
  when: string;
  customer_name: string;
  customer_phone: string | null;
  service: string | null;
  practitioner: string | null;
  notes: string | null;
  status: "confirmed" | "pending";
}
export interface OwnerListAppointmentsData {
  range: OwnerRange;
  /** First org-local day of the window ("YYYY-MM-DD"). */
  date: string;
  /** Jobs in the window — can exceed `appointments.length` (capped at 20). */
  count: number;
  appointments: OwnerAppointmentItem[];
}
export interface OwnerCallbackItem {
  callback_id: string;
  caller_name: string;
  caller_phone: string;
  reason: string;
  /** Spoken form of the time the caller asked to be rung, if any. */
  requested: string | null;
  urgency: "low" | "medium" | "high";
  /** Spoken form of when the request came in. */
  received: string;
}
export interface OwnerCallItem {
  call_id: string;
  /** Spoken form of when the call came in. */
  at: string;
  caller_name: string | null;
  caller_phone: string | null;
  summary: string;
}
export interface OwnerListMessagesData {
  callbacks: OwnerCallbackItem[];
  calls: OwnerCallItem[];
}

const DEFAULT_TZ = "Australia/Sydney";
const TROUBLE = "I'm having trouble reaching the calendar right now. Try again in a moment.";
const LIST_LIMIT = 20;
const MESSAGES_LIMIT = 10;
/** Calls fetched before the in-process owner/summary filter (≤ MESSAGES_LIMIT survive). */
const CALLS_FETCH_LIMIT = 30;

const APPOINTMENT_COLS =
  "id, confirmation_code, start_time, end_time, status, attendee_name, attendee_phone, notes, " +
  "service_types(name), practitioners(name)";

/**
 * The org's IANA zone. A NULL/empty column reads as the platform default, like
 * every other calendar path; a failed lookup returns null so the caller reports a
 * fault — guessing a zone on a DB blip would hand the owner the wrong day.
 */
async function getOrgTimezone(supabase: any, organizationId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", organizationId)
    .single();
  if (error) {
    console.error("[owner-assistant] failed to load org timezone:", { organizationId, error });
    return null;
  }
  return data?.timezone || DEFAULT_TZ;
}

function toItem(row: any, tz: string): OwnerAppointmentItem {
  const start = new Date(row.start_time);
  return {
    appointment_id: row.id,
    confirmation_code: row.confirmation_code ?? null,
    start_local: toLocalIsoMinute(start, tz),
    end_local: row.end_time ? toLocalIsoMinute(new Date(row.end_time), tz) : null,
    when: formatWhen(start, tz),
    customer_name: row.attendee_name ?? "Unknown",
    customer_phone: row.attendee_phone ?? null,
    service: pickName(row.service_types),
    practitioner: pickName(row.practitioners),
    notes: row.notes ?? null,
    status: row.status,
  };
}

function describeItem(i: OwnerAppointmentItem): string {
  const parts = [`${i.when}: ${i.customer_name}`];
  if (i.service) parts.push(`— ${i.service}`);
  if (i.practitioner) parts.push(`with ${i.practitioner}`);
  if (i.customer_phone) parts.push(`(${i.customer_phone})`);
  if (i.notes) parts.push(`— notes: ${i.notes}`);
  if (i.status === "pending") parts.push("[pending]");
  return `- ${parts.join(" ")} (id ${i.appointment_id})`;
}

export async function handleOwnerListAppointments(
  organizationId: string,
  args: { range?: string; date?: string }
): Promise<ToolResult> {
  const range = args.range as OwnerRange;
  if (!OWNER_RANGES.includes(range)) {
    return { success: false, message: "Which period: today, tomorrow, this week, or a specific date (year-month-day)?" };
  }
  const supabase = createAdminClient();
  const tz = await getOrgTimezone(supabase, organizationId);
  if (!tz) return errorResult(TROUBLE);

  const bounds = ownerRangeBounds(range, tz, args.date);
  if (!bounds) {
    return { success: false, message: "Which date? Give it as year-month-day, like 2026-10-20." };
  }

  const { data, error, count } = await (supabase as any)
    .from("appointments")
    .select(APPOINTMENT_COLS, { count: "exact" })
    .eq("organization_id", organizationId)
    .in("status", ["confirmed", "pending"])
    .gte("start_time", bounds.start)
    .lt("start_time", bounds.end)
    .order("start_time", { ascending: true })
    .limit(LIST_LIMIT);

  if (error) {
    console.error("[owner-assistant] list_appointments failed:", { organizationId, range, error });
    return errorResult(TROUBLE);
  }

  const items = (data ?? []).map((row: any) => toItem(row, tz));
  const total = typeof count === "number" ? count : items.length;
  const payload: OwnerListAppointmentsData = { range, date: bounds.firstDate, count: total, appointments: items };

  if (total === 0) {
    return { success: true, message: `Nothing booked ${bounds.label}.`, data: payload as unknown as Record<string, unknown> };
  }
  const head = `${total} ${total === 1 ? "job" : "jobs"} ${bounds.label}${total > items.length ? ` (first ${items.length} listed)` : ""}:`;
  return {
    success: true,
    message: [head, ...items.map(describeItem)].join("\n"),
    data: payload as unknown as Record<string, unknown>,
  };
}

export async function handleOwnerListMessages(organizationId: string): Promise<ToolResult> {
  const supabase = createAdminClient();
  const tz = await getOrgTimezone(supabase, organizationId);
  if (!tz) return errorResult(TROUBLE);
  const today = localDayRange(todayISO(tz), tz);

  const { data: cbs, error: cbErr } = await (supabase as any)
    .from("callback_requests")
    .select("id, caller_name, caller_phone, reason, requested_time, urgency, created_at")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(MESSAGES_LIMIT);
  if (cbErr) {
    console.error("[owner-assistant] list_messages callbacks failed:", { organizationId, error: cbErr });
    return errorResult(TROUBLE);
  }

  const { data: calls, error: callErr } = await (supabase as any)
    .from("calls")
    .select("id, caller_name, caller_phone, summary, created_at, metadata")
    .eq("organization_id", organizationId)
    .gte("created_at", today.start)
    .lt("created_at", today.end)
    .order("created_at", { ascending: false })
    .limit(CALLS_FETCH_LIMIT);
  if (callErr) {
    console.error("[owner-assistant] list_messages calls failed:", { organizationId, error: callErr });
    return errorResult(TROUBLE);
  }

  const callbacks: OwnerCallbackItem[] = (cbs ?? []).map((c: any) => ({
    callback_id: c.id,
    caller_name: c.caller_name,
    caller_phone: c.caller_phone,
    reason: c.reason,
    requested: c.requested_time ? formatWhen(new Date(c.requested_time), tz) : null,
    urgency: c.urgency,
    received: formatWhen(new Date(c.created_at), tz),
  }));
  // The owner's own calls are not messages; a call without a summary has nothing to relay.
  const customerCalls: OwnerCallItem[] = (calls ?? [])
    .filter((c: any) => (c.metadata?.call_type ?? null) !== "owner" && typeof c.summary === "string" && c.summary.trim())
    .slice(0, MESSAGES_LIMIT)
    .map((c: any) => ({
      call_id: c.id,
      at: formatWhen(new Date(c.created_at), tz),
      caller_name: c.caller_name ?? null,
      caller_phone: c.caller_phone ?? null,
      summary: c.summary.trim(),
    }));

  const payload: OwnerListMessagesData = { callbacks, calls: customerCalls };
  if (callbacks.length === 0 && customerCalls.length === 0) {
    return { success: true, message: "No messages waiting and no customer calls yet today.", data: payload as unknown as Record<string, unknown> };
  }
  const lines: string[] = [];
  lines.push(`${callbacks.length} ${callbacks.length === 1 ? "callback" : "callbacks"} waiting${callbacks.length ? ":" : "."}`);
  for (const c of callbacks) {
    lines.push(`- ${c.caller_name} (${c.caller_phone}), ${c.urgency} urgency: ${c.reason}${c.requested ? ` — wants ${c.requested}` : ""} (received ${c.received})`);
  }
  lines.push(`${customerCalls.length} customer ${customerCalls.length === 1 ? "call" : "calls"} today${customerCalls.length ? ":" : "."}`);
  for (const c of customerCalls) {
    lines.push(`- ${c.at}: ${c.caller_name ?? "Unknown caller"}${c.caller_phone ? ` (${c.caller_phone})` : ""} — ${c.summary}`);
  }
  return { success: true, message: lines.join("\n"), data: payload as unknown as Record<string, unknown> };
}
