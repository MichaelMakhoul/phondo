"use strict";

// SCRUM-594 (phone test F10): the names on the appointments a call made, for the
// post-call analysis. The booking said "Michael Dunn", spelled back and confirmed
// on the call, but the call log said "Michael Gunn": the re-analysis of the
// recording's transcript had heard the spelled "D" as "G". The appointment rows
// (appointments.call_id) hold the final name: update_appointment fixes a name in
// place, and a failed booking leaves no row. Only bookings in our own calendar
// carry the call's id; Cliniko's mirror rows and Cal.com's don't yet, so those
// calls get no names (and run as before).

const { Sentry } = require("./sentry");
const { SENTRY_REASONS, setReasonTag } = require("./sentry-reasons");

const MAX_NAMES = 5;
const MAX_NAME_LENGTH = 80;
// The codes of a failure that passes: a statement timeout, a database or pool
// PostgREST can't reach, Postgres' connection and resource classes, a retryable
// clash. Every other code is a rejection that fails the same way for every call.
const PASSING_CODES = /^(57014|57P0[0-9]|PGRST00[0-3]|08[0-9A-Z]{3}|53[0-9A-Z]{3}|40001|40P01)$/;

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
 * The names on this call's live (confirmed or pending) appointments, cleaned,
 * one per name whatever its case, oldest booking first, at most 5. A cancelled
 * booking, or the old row a reschedule leaves behind, may carry the spelling a
 * correction replaced.
 * @param {any} supabase - a Supabase client
 * @param {string|null|undefined} callId - calls.id
 * @param {string|null|undefined} organizationId
 * @returns {Promise<string[]>}
 * @throws when the lookup fails; a PostgREST rejection keeps its `code`
 */
async function fetchBookedNames(supabase, callId, organizationId) {
  if (!callId || !organizationId) return [];
  const { data, error } = await supabase
    .from("appointments")
    .select("attendee_name")
    .eq("call_id", callId)
    .eq("organization_id", organizationId)
    .in("status", ["confirmed", "pending"])
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) {
    const err = /** @type {Error & { code?: string }} */ (new Error(`appointments lookup failed: ${error.message}`));
    if (error.code) err.code = error.code;
    throw err;
  }
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const row of Array.isArray(data) ? data : []) {
    const name = cleanBookedName(row && row.attendee_name);
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return [...names.values()].slice(0, MAX_NAMES);
}

/**
 * fetchBookedNames for a post-call analysis, which goes on without names when
 * the lookup fails, as it did before the lookup existed. Never throws. A PostgREST
 * rejection (a renamed column, a revoked grant) fails the same way for every call,
 * so it pages at error level; a failure that passes (a timeout, a database that is
 * down or busy, a dropped connection, missing Supabase env) is a warning.
 * @param {() => any} getClient - returns a Supabase client (may throw)
 * @param {string|null|undefined} callId
 * @param {string|null|undefined} organizationId
 * @param {string} where - the caller's log tag, e.g. "PostCall"
 * @returns {Promise<string[]>}
 */
async function bookedNamesForAnalysis(getClient, callId, organizationId, where) {
  try {
    return await fetchBookedNames(getClient(), callId, organizationId);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const code = err && err.code ? String(err.code) : null;
    if (code && !PASSING_CODES.test(code)) {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.BOOKED_NAMES_LOOKUP_REJECTED);
        scope.setExtras({ callId, organizationId, code });
        Sentry.captureMessage(
          `[${where}] booked-names lookup REJECTED (${code}): ${message} — every call's post-call analysis goes without names`.slice(0, 300),
          "error",
        );
      });
    } else {
      console.warn(`[${where}] Booked names unavailable — analysing without them (callId=${callId}${code ? `, code=${code}` : ""}): ${message}`);
    }
    return [];
  }
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
 * name and a surname that is missing or a near miss: 1 letter off when either
 * surname has 4 letters or fewer ("Gunn" for "Dunn"), 2 when both are longer.
 * Anyone else keeps their own name (a booking can be for someone else: "Maria
 * Lopez" booking for "Maria Garcia", "Jenny Lee" for "Jenny Lam"). Unchanged with
 * no booked name or several, or a one-word booked name.
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
  const callerSurname = callerRest.join(" ").toLowerCase();
  const bookedSurname = bookedRest.join(" ").toLowerCase();
  const nearMiss = Math.min(callerSurname.length, bookedSurname.length) <= 4 ? 1 : 2;
  return editDistance(callerSurname, bookedSurname) <= nearMiss ? booked : callerName;
}

module.exports = { fetchBookedNames, bookedNamesForAnalysis, preferBookedName, cleanBookedName };
