/**
 * SCRUM-534: the pure decision core behind the scrape approve screen.
 *
 * The UI collects per-day selections (include? what hours? closed?) and this
 * module turns them into normalized hour lines that the STRICT parser
 * (parse-business-hours.ts) provably accepts. That keeps the server contract
 * unchanged — scrapedHours still flows through parseBusinessHours at org
 * creation — while letting the owner confirm readings the strict parser
 * would refuse unattended.
 *
 * Lives outside the component because component state is unpinnable
 * (SCRUM-530: no component-test harness); the round-trip guarantee
 * ("whatever the approve screen emits, the strict parser accepts") is the
 * load-bearing invariant and it is pinned here.
 */

import type { HoursLineReading } from "./parse-business-hours";

export type { DayHours } from "./parse-business-hours";
import type { DayHours } from "./parse-business-hours";

export interface HoursDaySelection {
  /** lowercase day key: "monday" ... "sunday" */
  day: string;
  /** Whether the owner confirmed this day. Unconfirmed days are omitted. */
  include: boolean;
  /** null = closed; otherwise the confirmed window. */
  hours: DayHours | null;
  /** Carried through for the UI: why this day started unconfirmed. */
  warning?: string;
  /** The verbatim scraped line this day came from, for provenance display. */
  sourceLine?: string;
}

const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const DAY_LABELS: Record<string, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

/** "14:00" → "2:00pm", "09:30" → "9:30am". Invalid input returns null. */
export function formatTime12h(t: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(String(t ?? ""));
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const meridiem = hour < 12 ? "am" : "pm";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")}${meridiem}`;
}

/**
 * Map the parser's line readings onto per-day selection rows.
 *
 * parsed/closed lines arrive pre-confirmed; ambiguous lines carry their
 * candidate but start UNCONFIRMED (the whole point: the owner must look);
 * unparsed lines with a recognisable day start unconfirmed and empty.
 * Lines whose day label itself failed cannot be represented per-day — the
 * UI shows them separately; they are not this function's output.
 *
 * A later line for the same day replaces the earlier row (matching the
 * duplicate-day semantics of the detailed parser, which already marks the
 * conflict ambiguous).
 */
export function readingsToDaySelections(readings: HoursLineReading[]): HoursDaySelection[] {
  const byDay = new Map<string, HoursDaySelection>();
  for (const reading of readings) {
    for (const day of reading.days) {
      if (!DAY_ORDER.includes(day)) continue;
      if (reading.status === "parsed" || reading.status === "closed") {
        byDay.set(day, {
          day,
          include: true,
          hours: reading.status === "closed" ? null : reading.hours,
          sourceLine: reading.line,
        });
      } else {
        byDay.set(day, {
          day,
          include: false,
          hours: reading.status === "ambiguous" ? reading.hours : null,
          warning:
            reading.warning ??
            (reading.status === "unparsed" ? "We couldn't read this line — set the hours yourself" : undefined),
          sourceLine: reading.line,
        });
      }
    }
  }
  return DAY_ORDER.filter((d) => byDay.has(d)).map((d) => byDay.get(d) as HoursDaySelection);
}

export interface HoursSelectionError {
  day: string;
  error: string;
}

/**
 * Validate included rows BEFORE emitting (SCRUM-534 review, F1 — HIGH).
 * A confirmed row with a missing or inverted window must block Apply, not
 * be dropped silently: once five OTHER days parse, an omitted day is read
 * as CLOSED, so silent omission turns an owner-configured day into a day
 * the AI turns callers away from — under a green "Applied" tick.
 */
export function validateHoursSelections(selections: HoursDaySelection[]): HoursSelectionError[] {
  const errors: HoursSelectionError[] = [];
  for (const s of selections) {
    if (!s.include) continue;
    if (s.hours === null) {
      // A GENUINE closed row (from a "closed" line, no warning) is valid.
      // But an unparsed row still carries its warning — ticking it with the
      // time fields left empty would silently emit "Day: closed" for a day
      // the owner meant to fill in (re-verify pass, residual 2).
      if (s.warning) {
        errors.push({ day: s.day, error: "Set the hours, or untick this day" });
      }
      continue;
    }
    const open = formatTime12h(s.hours.open);
    const close = formatTime12h(s.hours.close);
    if (!open || !close) {
      errors.push({ day: s.day, error: "Set both an opening and a closing time" });
    } else if (s.hours.close <= s.hours.open) {
      errors.push({ day: s.day, error: "Closing time must be after opening time" });
    }
  }
  return errors;
}

/**
 * Turn confirmed selections into normalized hour lines.
 *
 * INVARIANT (pinned by test): every emitted line is accepted by the strict
 * parseBusinessHours, and a set with >= 5 confirmed days round-trips into a
 * non-null ParsedBusinessHours whose windows equal the selections. Rows the
 * owner did not confirm are omitted. Malformed included rows are ALSO
 * omitted as a last line of defense, but callers must run
 * validateHoursSelections first and refuse to apply while it reports
 * errors — silent omission here is NOT safe once five other days parse
 * (the omitted day becomes CLOSED, not the default).
 */
export function buildApprovedHoursLines(selections: HoursDaySelection[]): string[] {
  const lines: string[] = [];
  for (const s of selections) {
    if (!s.include) continue;
    const label = DAY_LABELS[s.day];
    if (!label) continue;
    if (s.hours === null) {
      lines.push(`${label}: closed`);
      continue;
    }
    const open = formatTime12h(s.hours.open);
    const close = formatTime12h(s.hours.close);
    // A malformed or inverted window must not survive into the strict
    // parser's input looking authoritative. Drop the day instead.
    if (!open || !close || s.hours.close <= s.hours.open) continue;
    lines.push(`${label}: ${open} - ${close}`);
  }
  return lines;
}
