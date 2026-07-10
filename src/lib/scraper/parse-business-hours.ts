/**
 * (Two tiers since SCRUM-534: the STRICT functions below refuse ambiguity —
 * they are the only unattended write path — while the *Detailed functions at
 * the bottom surface candidates for the approve screen to confirm.)
 * SCRUM-515: turn the scraper's human-readable opening hours into the structured
 * shape the availability engine books from.
 *
 * The scraper (an LLM) returns lines like `"Monday: 8:30am - 5:30pm"`,
 * `"Mon-Fri: 9am-5pm"`, `"Saturday: Closed"`. Onboarding used to drop them into
 * free prose, so the assistant would happily RECITE a dealership's real 8:30
 * opening while OFFERING 9:00 slots from the untouched Mon-Fri 9-5 default. This
 * closes that split brain.
 *
 * Two rules govern everything here, because the cost of the two failure
 * directions is not symmetric:
 *
 *   A day we parse WRONG books callers into a closed business. A day we DON'T
 *   parse leaves the sensible default in place and the owner fixes it in
 *   Settings. So every ambiguity resolves to "don't parse".
 *
 *   A partially understood week is not a week. If any line is unintelligible we
 *   return null for the whole thing rather than persist a half-truth, because a
 *   silently missing Thursday reads as "closed Thursday" to the booking engine.
 */

export interface DayHours {
  open: string; // "HH:MM", 24-hour
  close: string;
}

/** Exactly the shape of `organizations.business_hours`. */
export type BusinessHoursMap = Record<string, DayHours | null>;

export interface ParsedBusinessHours {
  hours: BusinessHoursMap;
  /** Lines we could not understand. Non-empty means `hours` is not trustworthy. */
  unparsed: string[];
}

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const DAY_ALIASES: Record<string, string> = {
  mon: "monday",
  monday: "monday",
  tue: "tuesday",
  tues: "tuesday",
  tuesday: "tuesday",
  wed: "wednesday",
  weds: "wednesday",
  wednesday: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  thursday: "thursday",
  fri: "friday",
  friday: "friday",
  sat: "saturday",
  saturday: "saturday",
  sun: "sunday",
  sunday: "sunday",
};

/**
 * The WHOLE time-spec, not a token inside it.
 *
 * Matched as a substring this reads "Monday: 9am-5pm, closed for lunch 1-2pm"
 * as a closed Monday — a confident, silent, wrong answer that skips `unparsed`
 * and so never warns the owner. A line that mixes real times with a closed
 * token is a line we did not understand, and belongs in `unparsed`.
 */
const CLOSED_RE = /^(?:closed|close|by appointment(?: only)?|n\/?a)$/i;

/** Trailing punctuation the scraper carries over: "Closed." / "Closed;" */
function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,;!]+$/, "").trim();
}

/**
 * How many days a week must be named before we believe the week is complete.
 *
 * Unmentioned days become CLOSED, which is only sound if the page really listed
 * the whole week. A site whose hours live in an image may yield a single line —
 * `["Monday: 9am - 5pm"]` — and marking Tuesday to Sunday closed would have the
 * assistant turn callers away six days out of seven, silently, for a business
 * that is open. That is a worse outcome than the Mon-Fri 9-5 default it
 * replaced, and unlike a wrong default nothing prompts the owner to fix it.
 *
 * Five is the useful line: an ordinary "Mon-Fri: 9am-5pm" office clears it and
 * gets its real hours, while a one-line extraction falls back to the default
 * AND toasts the owner. A genuinely Mon/Wed/Fri business is refused too, which
 * costs it the import but tells it so.
 */
const MIN_DAYS_NAMED = 5;

/**
 * "8:30am", "8.30 am", "0830", "8", "17:30", "5pm", "noon", "midday", "midnight".
 * Returns "HH:MM" or null.
 */
function parseTime(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (s === "noon" || s === "midday" || s === "12noon") return "12:00";
  if (s === "midnight") return "00:00";

  // "0830", "1730": four contiguous digits are unambiguously 24-hour.
  const compact = /^(\d{2})(\d{2})$/.exec(s);
  if (compact) {
    const h = Number(compact[1]);
    const min = Number(compact[2]);
    if (h > 23 || min > 59) return null;
    return `${compact[1]}:${compact[2]}`;
  }

  const m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3]?.replace(/\./g, "");

  if (minute > 59) return null;

  if (meridiem === "am") {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0; // 12am = midnight
  } else if (meridiem === "pm") {
    if (hour < 1 || hour > 12) return null;
    if (hour !== 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  // A bare "9 - 5" is 09:00-05:00, which reads as a closed day. The range
  // parser repairs the obvious pm case; anything stranger is rejected there.

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * A 1-2 digit clock hour with no am/pm: "9", "5", "10:30". Its meridiem has to
 * be inferred. "17:30" and "0830" are not this — they state 24-hour time.
 */
function isBareClockHour(raw: string): boolean {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(s);
  if (!m) return false;
  const hour = Number(m[1]);
  return hour >= 1 && hour <= 12;
}

/** Expand "mon-fri" / "monday to friday" into the days it covers. */
function expandDayRange(from: string, to: string): string[] | null {
  const a = DAY_ALIASES[from];
  const b = DAY_ALIASES[to];
  if (!a || !b) return null;
  const start = DAYS.indexOf(a as (typeof DAYS)[number]);
  const end = DAYS.indexOf(b as (typeof DAYS)[number]);
  if (start === -1 || end === -1) return null;
  // Wrap-around ("sat-sun", "sun-thu") is legitimate.
  const out: string[] = [];
  for (let i = start; ; i = (i + 1) % DAYS.length) {
    out.push(DAYS[i]);
    if (i === end) break;
    if (out.length > DAYS.length) return null;
  }
  return out;
}

/** Days named at the start of a line: "Mon-Fri", "Saturday", "Mon, Wed, Fri". */
function parseDays(label: string): string[] | null {
  const cleaned = label.toLowerCase().replace(/\./g, "").trim();
  if (!cleaned) return null;

  const rangeMatch = /^([a-z]+)\s*(?:-|–|—|to|through|thru)\s*([a-z]+)$/.exec(cleaned);
  if (rangeMatch) return expandDayRange(rangeMatch[1], rangeMatch[2]);

  const parts = cleaned.split(/\s*(?:,|&|\band\b|\+)\s*/).filter(Boolean);
  const days: string[] = [];
  for (const part of parts) {
    const day = DAY_ALIASES[part];
    if (!day) return null;
    if (!days.includes(day)) days.push(day);
  }
  return days.length > 0 ? days : null;
}

/**
 * Parse the time half of a line. Multiple windows ("9-12, 1-5") collapse to the
 * outer envelope: the schema holds one interval per day, and a lunch break is
 * modelled as a blocked time, not as a closed business.
 */
/**
 * SCRUM-534: the detailed core behind parseTimeRanges. Where the strict
 * parser REFUSES an ambiguous line (correct with no human in the loop —
 * a wrong guess books callers into a closed business), this returns the
 * candidate reading plus a warning, so an approve screen can turn every
 * refusal into a one-tap confirm instead of a lost field.
 */
export interface TimeRangeReading {
  status: "ok" | "ambiguous" | "unparsed";
  /** The reading — for "ambiguous", the likeliest human interpretation. */
  hours: DayHours | null;
  /** Why this needs the owner's confirmation. Set iff status is "ambiguous". */
  warning?: string;
}

export function parseTimeRangesDetailed(spec: string): TimeRangeReading {
  const windows = spec.split(/\s*(?:,|&|\band\b)\s*/).filter(Boolean);
  const opens: string[] = [];
  const closes: string[] = [];
  let warning: string | undefined;

  for (const window of windows) {
    const m = /^(.+?)\s*(?:-|–|—|to|until|till|til)\s*(.+)$/.exec(window.trim());
    if (!m) return { status: "unparsed", hours: null };
    const open = parseTime(m[1]);
    let close = parseTime(m[2]);
    if (!open || !close) return { status: "unparsed", hours: null };

    // "9 - 5" with no meridiem: the close is plainly an afternoon time.
    // Only repair the unambiguous case, and only by shifting the close.
    if (close < open && !/am|pm/i.test(m[2])) {
      const shifted = parseTime(`${m[2].trim()}pm`);
      if (shifted && shifted > open) close = shifted;
    }
    // A business closing before it opens (or at the same minute) is a line we
    // did not understand. Overnight venues are out of scope, deliberately.
    if (close <= open) return { status: "unparsed", hours: null };

    // A bare ASCENDING range says nothing about its meridiem: "5 - 11" is a
    // bakery's morning or a bar's evening, and the page does not say which.
    // Reading it as AM would offer 5am slots at a venue that opens at 5pm —
    // the one direction that books callers into a closed business. Refuse.
    //
    // "9 - 5" escapes this: it was descending, and the pm repair above is the
    // only reading that works. "9 - 12" escapes it too, because 9pm-12pm is
    // not a window at all. Only a pair that reads sensibly BOTH ways is
    // ambiguous, and that needs the close before noon.
    if (isBareClockHour(m[1]) && isBareClockHour(m[2])) {
      const openHour = Number(open.slice(0, 2));
      const closeHour = Number(close.slice(0, 2));
      if (openHour < closeHour && closeHour < 12) {
        // Candidate: the literal AM reading; the warning names the PM one.
        // First ambiguity wins — a later window's warning must not overwrite
        // the one that explains the candidate (SCRUM-534 review, F6).
        warning ??= `"${window.trim()}" could mean ${openHour}am-${closeHour}am or ${openHour}pm-${closeHour}pm — confirm which`;
      }
    }

    // The same ambiguity runs the other way, and it is easier to miss because
    // only the OPEN is bare. "2 - 6pm" is 2pm-6pm to any human, but the bare
    // "2" parses as 02:00 and the pm repair never fires (the close already sits
    // after the open), so it lands as 02:00-18:00 and the assistant offers 2am
    // appointments. If reading the open as pm ALSO lands before the close, both
    // readings are valid and nothing on the page decides between them.
    //
    // "12 - 8pm" survives, because 12pm is 12:00 either way. "9 - 5pm" survives,
    // because 9pm is after 5pm and so cannot be meant.
    if (isBareClockHour(m[1])) {
      const openAsPm = parseTime(`${m[1].trim()}pm`);
      if (openAsPm && openAsPm !== open && openAsPm < close) {
        // Candidate: the PM reading — any human reads "2 - 6pm" as 2pm.
        warning ??= `"${window.trim()}" read as starting ${Number(openAsPm.slice(0, 2)) - 12}pm — the page could also mean ${Number(open.slice(0, 2))}am`;
        opens.push(openAsPm);
        closes.push(close);
        continue;
      }
    }

    opens.push(open);
    closes.push(close);
  }

  if (opens.length === 0) return { status: "unparsed", hours: null };
  const hours = {
    open: opens.reduce((a, b) => (a < b ? a : b)),
    close: closes.reduce((a, b) => (a > b ? a : b)),
  };
  return warning ? { status: "ambiguous", hours, warning } : { status: "ok", hours };
}

/** The strict reading: refuses (null) whatever is not unambiguous. */
function parseTimeRanges(spec: string): DayHours | null {
  const reading = parseTimeRangesDetailed(spec);
  return reading.status === "ok" ? reading.hours : null;
}

/**
 * Parse the scraper's `hours` lines into `organizations.business_hours`.
 *
 * Returns `null` when the result cannot be trusted: no lines, nothing
 * recognised, any line unintelligible, or a day claimed twice with conflicting
 * times. The caller then leaves the column at its default.
 */
export function parseBusinessHours(lines: string[] | undefined | null): ParsedBusinessHours | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;

  const hours: BusinessHoursMap = {};
  const unparsed: string[] = [];

  for (const rawLine of lines) {
    const line = String(rawLine ?? "").trim();
    if (!line) continue;

    // Split on the FIRST colon that separates the day label from the times.
    // "Monday: 8:30am - 5:30pm" → ["Monday", "8:30am - 5:30pm"].
    const sep = line.indexOf(":");
    const hasLabel = sep > 0 && parseDays(line.slice(0, sep)) !== null;
    const label = hasLabel ? line.slice(0, sep) : "";
    const rest = hasLabel ? line.slice(sep + 1).trim() : line;

    const days = hasLabel ? parseDays(label) : null;
    if (!days) {
      unparsed.push(line);
      continue;
    }

    // "Open 24 hours" / "24/7" carry no open-close pair, so they fall out of
    // parseTimeRanges as unintelligible and take the whole week down with them.
    // That is the intended outcome: inventing 00:00-23:59 would lie about one
    // end of the day. Pinned by test, not by a special case here.
    let value: DayHours | null;
    if (CLOSED_RE.test(stripTrailingPunctuation(rest))) {
      value = null;
    } else {
      value = parseTimeRanges(rest);
      if (!value) {
        unparsed.push(line);
        continue;
      }
    }

    for (const day of days) {
      const existing = hours[day];
      if (day in hours) {
        const same =
          (existing === null && value === null) ||
          (existing !== null && value !== null && existing.open === value.open && existing.close === value.close);
        if (!same) {
          // The same day given two different sets of times. We cannot know
          // which the business meant.
          unparsed.push(line);
          continue;
        }
      }
      hours[day] = value;
    }
  }

  if (unparsed.length > 0) return null;
  // Too few days named to conclude the rest are closed. See MIN_DAYS_NAMED.
  if (Object.keys(hours).length < MIN_DAYS_NAMED) return null;

  // Days the site never mentioned are closed. That is the ordinary reading of
  // an opening-hours table, and it is only reached when every listed line
  // parsed cleanly and the week is substantially complete.
  for (const day of DAYS) {
    if (!(day in hours)) hours[day] = null;
  }

  // A week with no open day at all is a parse failure wearing a disguise.
  if (DAYS.every((d) => hours[d] === null)) return null;

  return { hours, unparsed };
}

// ── SCRUM-534: per-line detail for the approve screen ───────────────────

export type HoursLineStatus = "parsed" | "closed" | "ambiguous" | "unparsed";

export interface HoursLineReading {
  /** The original scraped line, verbatim — the owner confirms against THIS. */
  line: string;
  /** Resolved day keys; [] when the day label itself was unintelligible. */
  days: string[];
  status: HoursLineStatus;
  /** The (candidate) reading. null for "closed" and "unparsed". */
  hours: DayHours | null;
  /** Why this line needs explicit confirmation. Set iff "ambiguous". */
  warning?: string;
}

/**
 * The approve-screen reading of scraped hours (SCRUM-534).
 *
 * Where parseBusinessHours refuses the WHOLE week on any ambiguity (correct
 * with no human in the loop), this returns every line with a status so the
 * owner confirms or fixes each one: "parsed" lines pre-check, "ambiguous"
 * lines carry the likeliest candidate plus a warning naming the alternative,
 * "unparsed" lines are shown for manual entry. Conflicting duplicate days
 * surface as ambiguous on the later line rather than sinking the week.
 *
 * The strict parser stays the ONLY path that writes hours without a human —
 * this function's output must always pass through the owner's confirmation.
 */
export function parseBusinessHoursDetailed(lines: string[] | undefined | null): HoursLineReading[] {
  if (!Array.isArray(lines)) return [];
  const readings: HoursLineReading[] = [];
  const seen: BusinessHoursMap = {};

  for (const rawLine of lines) {
    const line = String(rawLine ?? "").trim();
    if (!line) continue;

    const sep = line.indexOf(":");
    const hasLabel = sep > 0 && parseDays(line.slice(0, sep)) !== null;
    const rest = hasLabel ? line.slice(sep + 1).trim() : line;
    const days = hasLabel ? (parseDays(line.slice(0, sep)) as string[]) : null;

    if (!days) {
      readings.push({ line, days: [], status: "unparsed", hours: null });
      continue;
    }

    if (CLOSED_RE.test(stripTrailingPunctuation(rest))) {
      // Hours-then-closed is a conflict too (the reverse direction is caught
      // by the generic check below). Without this, "Monday: 9am - 5pm" then
      // "Monday: Closed" arrived PRE-CONFIRMED as closed — for a day the
      // site also listed with real hours (SCRUM-534 review, F3).
      const conflicted = days.some((day) => day in seen && seen[day] !== null);
      for (const day of days) seen[day] = null;
      if (conflicted) {
        readings.push({
          line,
          days,
          status: "ambiguous",
          hours: null,
          warning: "This day was listed twice with different times — confirm which is right",
        });
      } else {
        readings.push({ line, days, status: "closed", hours: null });
      }
      continue;
    }

    const reading = parseTimeRangesDetailed(rest);
    if (reading.status === "unparsed" || !reading.hours) {
      readings.push({ line, days, status: "unparsed", hours: null });
      continue;
    }

    // A day already claimed with DIFFERENT times: the later line needs the
    // owner's eyes even if it parsed cleanly on its own.
    const conflicted = days.some((day) => {
      const existing = seen[day];
      return (
        day in seen &&
        !(existing !== null && existing.open === reading.hours!.open && existing.close === reading.hours!.close)
      );
    });
    for (const day of days) seen[day] = reading.hours;

    if (conflicted) {
      readings.push({
        line,
        days,
        status: "ambiguous",
        hours: reading.hours,
        warning: "This day was listed twice with different times — confirm which is right",
      });
    } else if (reading.status === "ambiguous") {
      readings.push({ line, days, status: "ambiguous", hours: reading.hours, warning: reading.warning });
    } else {
      readings.push({ line, days, status: "parsed", hours: reading.hours });
    }
  }

  return readings;
}
