// SCRUM-399: pure helpers for the reschedule lifecycle, shared by the AI path
// (`handleRescheduleAppointment` in tool-handlers) and the dashboard path
// (`PATCH /api/v1/appointments/[id]`). The DB-touching orchestration (lookup,
// ordering, rollback) stays in each caller — only the field-carryover and the
// leg-vs-in-place classification are extracted here so they're unit-tested once
// and stay consistent across both paths.

import type { FieldChange } from "@/lib/appointments/events";

/**
 * SCRUM-386: resolve the attendee identity to carry into a reschedule's new
 * booking. A reschedule MOVES an already-identified appointment, so it must reuse
 * that appointment's name rather than re-demand it — only a COMPLETE new name
 * (both parts, or a full `name`) from the caller overrides. The stored name is
 * split into first/last because the booking validation checks the `last_name`
 * field specifically (a combined `name` alone does NOT satisfy a required-last-
 * name org), which otherwise traps a known caller in a "what's your last name?"
 * loop when the model only relays a partial name from garbled speech.
 *
 * (Moved here from tool-handlers in SCRUM-399 so both reschedule paths share it;
 * tool-handlers re-exports it for backward-compatible imports.)
 */
export function resolveRescheduleIdentity(
  args: { first_name?: string; last_name?: string; name?: string },
  existingName?: string | null
): { first_name?: string; last_name?: string; name?: string } {
  const first = args.first_name?.trim();
  const last = args.last_name?.trim();
  // Explicit, complete new name → caller is renaming the booking; honour it.
  if (first && last) return { first_name: first, last_name: last };
  // Otherwise reuse a full caller-supplied name, else the existing appointment's.
  const full = (args.name?.trim() || existingName || "").trim();
  if (!full) return {};
  const parts = full.split(/\s+/);
  if (parts.length === 1) return { name: parts[0] };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

export interface RescheduleCarryover {
  first_name?: string;
  last_name?: string;
  name?: string;
  phone?: string;
  email?: string;
  notes?: string;
  service_type_id?: string;
  practitioner_id?: string;
  /**
   * SCRUM-444 review: which refs were CARRIED from the existing appointment
   * (the caller did not supply them). A carried ref must be validated
   * org-scope-only — NOT `requireActive` — otherwise a time-only reschedule of
   * an appointment whose service type/practitioner was since deactivated
   * dead-ends unrecoverably (every retry re-carries the same ref). A ref the
   * caller explicitly supplied still has to be active.
   */
  carried_refs: { service_type: boolean; practitioner: boolean };
}

interface ExistingForCarryover {
  attendee_name?: string | null;
  attendee_phone?: string | null;
  attendee_email?: string | null;
  notes?: string | null;
  service_type_id?: string | null;
  practitioner_id?: string | null;
}

/**
 * SCRUM-390/399: build the field set for a reschedule's NEW booking, defaulting
 * every field to the existing appointment unless the caller explicitly supplied a
 * new value — a move changes ONLY what was asked for. Used by the AI path to feed
 * `handleBookAppointment`. (`||` for phone/service mirrors the original handler:
 * an empty string falls through to the existing value.)
 */
export function resolveRescheduledBooking(
  args: {
    first_name?: string;
    last_name?: string;
    name?: string;
    phone?: string;
    email?: string;
    notes?: string;
    service_type_id?: string;
    practitioner_id?: string;
  },
  existing: ExistingForCarryover
): RescheduleCarryover {
  const identity = resolveRescheduleIdentity(args, existing.attendee_name);
  return {
    ...identity,
    phone: args.phone || existing.attendee_phone || undefined,
    email: args.email ?? existing.attendee_email ?? undefined,
    notes: args.notes ?? existing.notes ?? undefined,
    service_type_id: args.service_type_id || existing.service_type_id || undefined,
    practitioner_id: args.practitioner_id ?? existing.practitioner_id ?? undefined,
    // Mirrors the fallbacks above: a ref is "carried" exactly when the value
    // came from `existing`, not from the caller's args.
    carried_refs: {
      service_type: !args.service_type_id && !!existing.service_type_id,
      practitioner: args.practitioner_id == null && existing.practitioner_id != null,
    },
  };
}

// ─── Dashboard reschedule (in-place edit → structural leg) ────────────────────

export interface RescheduleLegDecision {
  isLeg: boolean;
  timeChanged: boolean;
  practitionerChanged: boolean;
  serviceChanged: boolean;
}

interface LegBefore {
  start_time?: string | null;
  practitioner_id?: string | null;
  service_type_id?: string | null;
}

/**
 * SCRUM-399: decide whether a dashboard edit is a structural MOVE (→ a new
 * reschedule leg, mirroring how the AI models a reschedule) rather than an
 * in-place detail edit. A change to the time, practitioner, or service is
 * leg-worthy; name/phone/email/notes/status are not.
 *
 * A field counts as changed only if its key is PRESENT in `updates` AND differs
 * from `before`. Time is compared by instant — the datetime picker round-trips
 * the timestamp format ("+00:00" → ".000Z"), so a string compare would wrongly
 * flag an untouched time as a move. `null` (clearing a value) is a real change.
 */
export function decideRescheduleLeg(
  before: LegBefore,
  updates: Record<string, unknown>
): RescheduleLegDecision {
  const timeChanged =
    "start_time" in updates &&
    typeof updates.start_time === "string" &&
    new Date(updates.start_time).getTime() !== new Date(before.start_time ?? "").getTime();

  const practitionerChanged =
    "practitioner_id" in updates &&
    (updates.practitioner_id ?? null) !== (before.practitioner_id ?? null);

  const serviceChanged =
    "service_type_id" in updates &&
    (updates.service_type_id ?? null) !== (before.service_type_id ?? null);

  return {
    timeChanged,
    practitionerChanged,
    serviceChanged,
    isLeg: timeChanged || practitionerChanged || serviceChanged,
  };
}

interface LegRowBefore {
  attendee_name?: string | null;
  attendee_first_name?: string | null;
  attendee_last_name?: string | null;
  attendee_phone?: string | null;
  attendee_email?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  duration_minutes?: number | null;
  status?: string | null;
  notes?: string | null;
  service_type_id?: string | null;
  practitioner_id?: string | null;
}

export interface RescheduleLegFields {
  attendee_name: string | null;
  attendee_first_name: string | null;
  attendee_last_name: string | null;
  attendee_phone: string | null;
  attendee_email: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  status: string;
  notes: string | null;
  service_type_id: string | null;
  practitioner_id: string | null;
}

// Pull `key` from `updates` if present, else carry it over from the old row.
function carry<T>(updates: Record<string, unknown>, before: Record<string, unknown>, key: string): T {
  return (key in updates ? updates[key] : before[key]) as T;
}

/**
 * SCRUM-399: build the destination leg's column values for a dashboard reschedule
 * — the old row's fields with the staff edits applied on top. The caller adds
 * org_id, provider, a fresh confirmation_code, metadata, and rescheduled_from_id.
 *
 * The new leg's status defaults to `confirmed` (a freshly-moved appointment is the
 * active one, like the AI path's new booking) unless the edit explicitly set a
 * status.
 */
export function buildRescheduleLegFields(
  before: LegRowBefore,
  updates: Record<string, unknown>
): RescheduleLegFields {
  const b = before as Record<string, unknown>;
  return {
    attendee_name: carry<string | null>(updates, b, "attendee_name"),
    attendee_first_name: carry<string | null>(updates, b, "attendee_first_name"),
    attendee_last_name: carry<string | null>(updates, b, "attendee_last_name"),
    attendee_phone: carry<string | null>(updates, b, "attendee_phone"),
    attendee_email: carry<string | null>(updates, b, "attendee_email"),
    start_time: carry<string | null>(updates, b, "start_time"),
    end_time: carry<string | null>(updates, b, "end_time"),
    duration_minutes: carry<number | null>(updates, b, "duration_minutes"),
    status: ("status" in updates ? (updates.status as string) : "confirmed"),
    notes: carry<string | null>(updates, b, "notes"),
    service_type_id: carry<string | null>(updates, b, "service_type_id"),
    practitioner_id: carry<string | null>(updates, b, "practitioner_id"),
  };
}

const LEG_WORTHY_DIFF_FIELDS: ReadonlySet<FieldChange["field"]> = new Set([
  "time",
  "practitioner",
  "service",
]);
const IN_PLACE_DIFF_FIELDS: ReadonlySet<FieldChange["field"]> = new Set([
  "name",
  "phone",
  "email",
  "notes",
]);

/**
 * SCRUM-399: split a field diff into the structural part (time/practitioner/
 * service — represented by the new leg) and the in-place part (name/phone/email/
 * notes — emitted as a standalone `edited` event ON the new leg, so a name typo
 * fixed alongside a time move still shows in the history). `status` is in neither
 * bucket — the new leg's status badge already reflects it.
 */
export function partitionRescheduleChanges(changes: FieldChange[]): {
  legWorthy: FieldChange[];
  inPlace: FieldChange[];
} {
  return {
    legWorthy: changes.filter((c) => LEG_WORTHY_DIFF_FIELDS.has(c.field)),
    inPlace: changes.filter((c) => IN_PLACE_DIFF_FIELDS.has(c.field)),
  };
}
