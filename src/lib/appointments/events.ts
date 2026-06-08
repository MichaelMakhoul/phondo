import * as Sentry from "@sentry/nextjs";
import type { ServiceRoleSupabaseClient } from "@/lib/supabase/admin";

// SCRUM-398: append-only appointment audit events. ALL appointment writes run
// server-side inside Next.js (dashboard routes + the AI's /api/internal/tool-call →
// tool-handlers), so this one emit helper covers every mutation path. Writes go
// through the service-role client (the table has no INSERT policy — service_role only).

// Synthetic placeholder emails (`booking-<uuid>@noreply.phondo.ai`) aren't real
// addresses — normalize to null so "added a real email" diffs cleanly and a
// synthetic→blank no-op produces no change.
const SYNTHETIC_EMAIL_DOMAIN = "@noreply.phondo.ai";
function normalizeEmail(email: string | null | undefined): string | null {
  if (!email || email.includes(SYNTHETIC_EMAIL_DOMAIN)) return null;
  return email;
}

/** A normalized, name-resolved view of an appointment, for diffing. */
export interface AppointmentSnapshot {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  startTime?: string | null; // ISO
  practitioner?: string | null; // resolved name (not the FK)
  service?: string | null; // resolved name (not the FK)
  status?: string | null;
}

/** One field-level change with resolved, human-readable values. */
export interface FieldChange {
  field: "name" | "phone" | "email" | "notes" | "time" | "practitioner" | "service" | "status";
  from: string | null;
  to: string | null;
}

// Tracked fields, in display order. `time`/`practitioner`/`service` carry the
// industry-generic meaning; the UI maps the field key → an industry label.
const TRACKED: { key: keyof AppointmentSnapshot; field: FieldChange["field"] }[] = [
  { key: "name", field: "name" },
  { key: "phone", field: "phone" },
  { key: "email", field: "email" },
  { key: "startTime", field: "time" },
  { key: "practitioner", field: "practitioner" },
  { key: "service", field: "service" },
  { key: "status", field: "status" },
  { key: "notes", field: "notes" },
];

// Normalize a value for comparison: trim strings, treat "" as null so a cleared
// field vs an absent field don't read as a change.
function norm(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Diff two appointment snapshots → the changed fields with resolved from/to values.
 * Pure. Unchanged fields and no-op null/"" pairs are omitted; `email` is
 * synthetic-normalized on both sides.
 */
export function diffAppointmentFields(
  before: AppointmentSnapshot,
  after: AppointmentSnapshot
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const { key, field } of TRACKED) {
    const b = field === "email" ? normalizeEmail(before[key] as string | null) : norm(before[key]);
    const a = field === "email" ? normalizeEmail(after[key] as string | null) : norm(after[key]);
    if (b !== a) changes.push({ field, from: b, to: a });
  }
  return changes;
}

export type AppointmentEventType =
  | "created"
  | "edited"
  | "rescheduled"
  | "cancelled"
  | "status_changed"
  | "restored";

/**
 * Classify an in-place edit by its changed fields: a status-only change is
 * `status_changed`; anything else is `edited`. The structural types (`created`,
 * `rescheduled`, `cancelled`) are emitted explicitly by their handlers, not here.
 */
export function classifyEditEvent(changes: FieldChange[]): "edited" | "status_changed" {
  if (changes.length > 0 && changes.every((c) => c.field === "status")) return "status_changed";
  return "edited";
}

export type ActorType = "ai" | "staff" | "system";
export type EventChannel =
  | "voice"
  | "dashboard"
  | "cal_com"
  | "calendly"
  | "google_calendar"
  | "system";

export interface AppointmentEventInput {
  appointmentId: string;
  organizationId: string;
  eventType: AppointmentEventType;
  actorType: ActorType;
  actorId?: string | null;
  channel: EventChannel;
  changedFields?: FieldChange[];
  note?: string | null;
  callId?: string | null;
}

/**
 * Insert one audit event. BEST-EFFORT: never throws — a failed audit write must not
 * break the mutation it records. Requires the service-role client (the table has no
 * INSERT policy; only service_role writes). An `edited`/`status_changed` event with
 * no actual field changes is skipped so the log isn't polluted with no-ops.
 */
export async function recordAppointmentEvent(
  admin: ServiceRoleSupabaseClient,
  input: AppointmentEventInput
): Promise<void> {
  if (
    (input.eventType === "edited" || input.eventType === "status_changed") &&
    (!input.changedFields || input.changedFields.length === 0)
  ) {
    return;
  }
  try {
    const { error } = await (admin as any).from("appointment_events").insert({
      appointment_id: input.appointmentId,
      organization_id: input.organizationId,
      event_type: input.eventType,
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      channel: input.channel,
      changed_fields: input.changedFields ?? [],
      note: input.note ?? null,
      call_id: input.callId ?? null,
    });
    if (error) {
      console.error("[appointment-events] insert failed (non-fatal):", error.message);
      Sentry.captureMessage("appointment_events insert failed", {
        level: "warning",
        extra: { error: error.message, eventType: input.eventType },
      });
    }
  } catch (err) {
    console.error("[appointment-events] insert threw (non-fatal):", err);
    Sentry.captureException(err);
  }
}
