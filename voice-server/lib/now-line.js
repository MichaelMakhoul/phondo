"use strict";

/**
 * SCRUM-593: "now" in the business's timezone, worded exactly as the
 * get_current_datetime tool gives it to the voice model. The Tier-2 checker
 * and the booking pre-check need the same anchor to judge "today",
 * "tomorrow" and weekday names — without it the Tier-2 checker flagged a
 * correct "tomorrow" as a mismatch and the AI "corrected" a right booking
 * out loud (call 43d09f86, 2026-10-15).
 *
 * @param {string} timezone - IANA zone, e.g. "Australia/Sydney"
 * @param {Date} [now]
 * @returns {string}
 */
function nowLine(timezone, now = new Date()) {
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h12",
    timeZone: timezone,
  });
  const isoDateFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  });
  return `Current date and time: ${dateFormatter.format(now)}, ${timeFormatter.format(now)} (${timezone}). Today's date in YYYY-MM-DD format: ${isoDateFormatter.format(now)}.`;
}

// Bad org zones already reported: one warning per distinct value per process, not one per check.
// Org timezones are tenant-editable text, so the memory is keyed by the capped echo it logs and holds at
// most MAX_WARNED_ZONES values; past that, a new bad zone is neither remembered nor reported.
/** @type {Set<string>} */
const warnedZones = new Set();
const MAX_WARNED_ZONES = 100;

/**
 * nowLine for a business timezone that may be missing or malformed in org
 * data: falls back to Australia/Sydney instead of throwing, so a bad zone
 * degrades the NOW anchor rather than switching a checker off (SCRUM-593).
 * A malformed zone says so, once per distinct value: otherwise that org's
 * "today" and "tomorrow" are judged against Sydney's date in silence.
 * @param {string | undefined | null} timezone
 * @param {Date} [now]
 * @returns {string}
 */
function safeNowLine(timezone, now = new Date()) {
  if (timezone) {
    try {
      return nowLine(timezone, now);
    } catch {
      // Org data, echoed as server.js does: JSON-quoted (one line), no brackets, capped.
      const shown = JSON.stringify(String(timezone)).replace(/[\[\]]/g, "").slice(0, 60);
      if (warnedZones.size < MAX_WARNED_ZONES && !warnedZones.has(shown)) {
        warnedZones.add(shown);
        console.warn(`[NowLine] org timezone ${shown} is not a valid IANA zone — using Australia/Sydney`);
      }
    }
  }
  return nowLine("Australia/Sydney", now);
}

module.exports = { nowLine, safeNowLine };
