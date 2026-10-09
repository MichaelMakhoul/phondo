// SCRUM-586: the "when" in the PIN-lockout email. The email is a "was this me?"
// alert, so the time is the ORG's local time written the Australian way
// ("Thursday 15 October at 3:04 pm"). It is never the server's clock: on Vercel
// that is UTC, which would put a 3 pm Sydney call at 4 am. Kept free of imports so
// the call-completed route can use it without pulling in the calendar handlers.

/** The owner tools' default zone (DEFAULT_TZ in tool-handlers.ts) for an org with none stored. */
export const LOCK_EMAIL_DEFAULT_TIMEZONE = "Australia/Sydney";

/** True when Intl accepts `zone` as an IANA time zone (it throws a RangeError otherwise). */
function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function render(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((p) => p.type === type)?.value;
    if (!value) throw new Error(`Intl returned no ${type} for the lockout time`);
    return value;
  };
  // Assembled from the parts rather than format(): the connector between the date
  // and the time (" at " vs ", "), the space before am/pm and the case of am/pm all
  // vary with the runtime's ICU data, and this string goes into an email.
  return `${get("weekday")} ${get("day")} ${get("month")} at ${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`;
}

/**
 * `instant` as the org's local time, e.g. "Thursday 15 October at 3:04 pm".
 * A null, empty or non-string `timezone` reads as Sydney, like the owner tools. A
 * zone Intl rejects also reads as Sydney (and is logged so the bad row is findable)
 * rather than throwing or quietly switching to the server's zone. An invalid
 * `instant` throws.
 */
export function formatOwnerLockTime(instant: Date, timezone?: string | null): string {
  const zone = typeof timezone === "string" ? timezone.trim() : "";
  if (zone && isKnownZone(zone)) return render(instant, zone);
  if (zone) {
    console.warn("[owner-assistant] unusable org timezone for the PIN-lockout email — using the default:", {
      timezone: zone,
      fallback: LOCK_EMAIL_DEFAULT_TIMEZONE,
    });
  }
  return render(instant, LOCK_EMAIL_DEFAULT_TIMEZONE);
}
