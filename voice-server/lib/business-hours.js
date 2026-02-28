/**
 * Business hours utility — shared across tool-executor and call-context.
 */

/**
 * Check if the current time is within configured business hours.
 * Fails open (returns true) if no timezone or hours are configured.
 *
 * @param {string|undefined} timezone - IANA timezone (e.g. "Australia/Sydney")
 * @param {object|undefined} businessHours - Map of day name → { open, close } or null
 * @returns {boolean}
 */
function isWithinBusinessHours(timezone, businessHours) {
  if (!timezone || !businessHours || Object.keys(businessHours).length === 0) {
    return true; // fail open
  }

  try {
    const now = new Date();
    // Get current day and time in the business timezone
    const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone });
    const hourFormatter = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });

    const dayName = dayFormatter.format(now).toLowerCase();
    const timeStr = hourFormatter.format(now); // "HH:MM" in 24h format
    const [hours, minutes] = timeStr.split(":").map(Number);
    const currentMinutes = hours * 60 + minutes;

    const dayHours = businessHours[dayName];
    if (!dayHours || dayHours.closed) {
      return false; // closed today
    }

    const openParts = (dayHours.open || "09:00").split(":").map(Number);
    const closeParts = (dayHours.close || "17:00").split(":").map(Number);
    const openMinutes = openParts[0] * 60 + (openParts[1] || 0);
    const closeMinutes = closeParts[0] * 60 + (closeParts[1] || 0);

    if (Number.isNaN(openMinutes) || Number.isNaN(closeMinutes)) {
      console.error("[BusinessHours] Malformed open/close time — failing open:", {
        dayName, open: dayHours.open, close: dayHours.close,
      });
      return true;
    }

    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  } catch (err) {
    console.error("[BusinessHours] Failed to check business hours — failing open:", {
      error: err.message, timezone, businessHours,
    });
    return true; // fail open on error
  }
}

module.exports = { isWithinBusinessHours };
