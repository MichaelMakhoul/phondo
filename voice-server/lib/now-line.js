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

/**
 * nowLine for a business timezone that may be missing or malformed in org
 * data: falls back to Australia/Sydney instead of throwing, so a bad zone
 * degrades the NOW anchor rather than switching a checker off (SCRUM-593).
 * @param {string | undefined | null} timezone
 * @param {Date} [now]
 * @returns {string}
 */
function safeNowLine(timezone, now = new Date()) {
  if (timezone) {
    try {
      return nowLine(timezone, now);
    } catch {
      // invalid IANA zone in org data — fall through to the default
    }
  }
  return nowLine("Australia/Sydney", now);
}

module.exports = { nowLine, safeNowLine };
