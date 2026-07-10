/**
 * SCRUM-541: validation for the organizations.business_hours map at its
 * WRITE sites. The settings form saved whatever <input type="time"> held —
 * clearing a field stored {open: "", close: "17:00"}, which the voice
 * server's getHoursForDate reads as CLOSED while the dashboard checkbox
 * (!!businessHours[day]) shows the day OPEN. Callers were turned away from
 * a day the owner saw as open, with no signal anywhere.
 *
 * Pure module so the decision is pinnable (no component-test harness,
 * SCRUM-530). Mirrors the approve panel's validateHoursSelections rules.
 */

export interface DayWindow {
  open: string;
  close: string;
}

export type BusinessHoursMap = Record<string, DayWindow | null | undefined>;

export interface HoursMapError {
  day: string;
  error: string;
}

const TIME_RE = /^(\d{2}):(\d{2})$/;

function isValidTime(t: unknown): t is string {
  if (typeof t !== "string") return false;
  const m = TIME_RE.exec(t);
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/**
 * Errors for every OPEN day whose window a call could not honor. Closed
 * days (null/undefined) are never errors.
 */
const CANONICAL_DAYS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

export function validateBusinessHoursMap(hours: BusinessHoursMap): HoursMapError[] {
  const errors: HoursMapError[] = [];
  for (const [day, window] of Object.entries(hours ?? {})) {
    // A stray non-canonical key (legacy data) is dead weight no reader looks
    // at — flagging it would block the save with an error the UI renders
    // nowhere and the owner can't fix.
    if (!CANONICAL_DAYS.has(day)) continue;
    if (window === null || window === undefined) continue;
    if (!isValidTime(window.open) || !isValidTime(window.close)) {
      errors.push({ day, error: "Set both an opening and a closing time" });
    } else if (window.close <= window.open) {
      errors.push({ day, error: "Closing time must be after opening time" });
    }
  }
  return errors;
}
