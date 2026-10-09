// src/lib/owner-assistant/time.ts
// SCRUM-586: date/time helpers for the owner assistant tools. Every range is
// computed in the ORG's zone (the owner says "tomorrow" meaning their tomorrow)
// and returned as UTC instants for the `start_time`/`created_at` filters.
import { ensureTimezoneOffset, addDaysISO } from "@/lib/calendar/tool-handlers";

export const OWNER_RANGES = ["today", "tomorrow", "this_week", "date"] as const;
export type OwnerRange = (typeof OWNER_RANGES)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Naive org-local wall time ("2026-10-15T09:00" / with seconds), or an
// explicit offset — the model is told to send org-local time.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * True only for a real calendar day. "2026-13-45" makes `Date` invalid (and
 * `toISOString()` throw), while "2026-02-30" parses fine and silently rolls over
 * to March 2 — neither may reach the owner's day range or a reschedule target.
 */
function isRealCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function todayISO(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * `[local midnight of dateISO, local midnight of the next day)` as UTC ISO strings.
 * `dateISO` must be a real "YYYY-MM-DD" day (this throws a RangeError otherwise):
 * callers pass `todayISO()` output or a date they have already validated.
 */
export function localDayRange(dateISO: string, timezone: string): { start: string; end: string } {
  const start = new Date(ensureTimezoneOffset(`${dateISO}T00:00:00`, timezone));
  const end = new Date(ensureTimezoneOffset(`${addDaysISO(dateISO, 1)}T00:00:00`, timezone));
  return { start: start.toISOString(), end: end.toISOString() };
}

function formatDay(dateISO: string, timezone: string): string {
  // Noon avoids a DST-edge day shift; the date is already org-local.
  return new Date(ensureTimezoneOffset(`${dateISO}T12:00:00`, timezone)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });
}

/**
 * Bounds for an `owner_list_appointments` range. `this_week` means the next 7
 * local days starting today (spec §2). Returns null for `range === "date"`
 * without a real calendar `date`, and for a range the model invented.
 */
export function ownerRangeBounds(
  range: OwnerRange,
  timezone: string,
  date?: string,
  now: Date = new Date()
): { start: string; end: string; label: string; firstDate: string } | null {
  const today = todayISO(timezone, now);
  switch (range) {
    case "today": {
      return { ...localDayRange(today, timezone), label: "today", firstDate: today };
    }
    case "tomorrow": {
      const d = addDaysISO(today, 1);
      return { ...localDayRange(d, timezone), label: "tomorrow", firstDate: d };
    }
    case "this_week": {
      const { start } = localDayRange(today, timezone);
      const { start: end } = localDayRange(addDaysISO(today, 7), timezone);
      return { start, end, label: "over the next 7 days", firstDate: today };
    }
    case "date": {
      if (!date || !isRealCalendarDate(date)) return null;
      const { start, end } = localDayRange(date, timezone);
      return { start, end, label: `on ${formatDay(date, timezone)}`, firstDate: date };
    }
    default:
      return null;
  }
}

/** Parse the model's `new_datetime` (org-local wall time) into an instant; null if unusable. */
export function parseOwnerLocalDatetime(input: string | undefined, timezone: string): Date | null {
  if (!input || !DATETIME_RE.test(input)) return null;
  if (!isRealCalendarDate(input.slice(0, 10))) return null;
  const withSeconds = input.length === 16 ? `${input}:00` : input;
  const d = new Date(ensureTimezoneOffset(withSeconds, timezone));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Thursday, October 15 at 2:00 PM" in the org's zone — what the model reads back. */
export function formatWhen(d: Date, timezone: string): string {
  const day = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: timezone });
  // Node 20 / newer ICU builds put a narrow no-break space (U+202F) before AM/PM;
  // normalise it so the string is identical on every runtime.
  const time = d
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: timezone })
    .replace(/\u202f/g, " ");
  return `${day} at ${time}`;
}
