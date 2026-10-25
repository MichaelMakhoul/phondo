"use strict";

// SCRUM-594 (phone test F10): the names on the appointments a call made, for the
// post-call analysis. The booking said "Michael Dunn", spelled back and confirmed
// on the call, but the call log said "Michael Gunn": the re-analysis of the
// recording's transcript had heard the spelled "D" as "G". The appointment rows
// (appointments.call_id) hold the final name on every pipeline: update_appointment
// fixes a name in place, and a failed booking leaves no row.

const MAX_NAMES = 5;
const MAX_NAME_LENGTH = 80;
const NEAR_MISS_LETTERS = 2;

/**
 * A booked name made safe for one prompt line: no control characters or double
 * quotes, single spaces, at most 80 characters. "" when nothing usable is left.
 * @param {unknown} name
 * @returns {string}
 */
function cleanBookedName(name) {
  if (typeof name !== "string") return "";
  const cleaned = name.replace(/[\u0000-\u001f\u007f"]+/g, " ").replace(/\s+/g, " ").trim();
  // Cut by character, not UTF-16 unit, so an emoji is never split in two.
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join("").trim();
}

/**
 * The names on the appointments this call made, cleaned, one per name whatever
 * its case, oldest booking first, at most 5.
 * @param {any} supabase - a Supabase client
 * @param {string|null|undefined} callId - calls.id
 * @param {string|null|undefined} organizationId
 * @returns {Promise<string[]>}
 * @throws when the lookup fails; callers go on without names
 */
async function fetchBookedNames(supabase, callId, organizationId) {
  if (!callId || !organizationId) return [];
  const { data, error } = await supabase
    .from("appointments")
    .select("attendee_name")
    .eq("call_id", callId)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`appointments lookup failed: ${error.message}`);
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const row of Array.isArray(data) ? data : []) {
    const name = cleanBookedName(row && row.attendee_name);
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return [...names.values()].slice(0, MAX_NAMES);
}

/**
 * Levenshtein distance between two short strings.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * The caller's name for the call log. When the analysis names the person this
 * call's one booking was made under, the booking's spelling wins: it is what was
 * saved after the receptionist took it down, often spelling it back, while a
 * transcript can mishear spelled letters. The same person means the same first
 * name and a surname that is missing or at most 2 letters off ("Gunn" for
 * "Dunn"); anyone else keeps their own name (a booking can be for someone else).
 * Unchanged with no booked name or several, or a one-word booked name.
 * @param {unknown} callerName - the analysis' caller_name
 * @param {unknown} bookedNames - from fetchBookedNames
 * @returns {any} the booked name, or callerName as given
 */
function preferBookedName(callerName, bookedNames) {
  if (typeof callerName !== "string" || !callerName.trim()) return callerName;
  const names = (Array.isArray(bookedNames) ? bookedNames : []).map(cleanBookedName).filter(Boolean);
  if (names.length !== 1) return callerName;
  const [booked] = names;
  const [bookedFirst, ...bookedRest] = booked.split(" ");
  if (bookedRest.length === 0) return callerName;
  const [callerFirst, ...callerRest] = callerName.trim().split(/\s+/);
  if (callerFirst.toLowerCase() !== bookedFirst.toLowerCase()) return callerName;
  if (callerRest.length === 0) return booked;
  const distance = editDistance(callerRest.join(" ").toLowerCase(), bookedRest.join(" ").toLowerCase());
  return distance <= NEAR_MISS_LETTERS ? booked : callerName;
}

module.exports = { fetchBookedNames, preferBookedName, cleanBookedName };
