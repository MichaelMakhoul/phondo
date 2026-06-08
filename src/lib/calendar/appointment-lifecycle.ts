// SCRUM-389: pure helpers for an appointment's reschedule lifecycle (the supersede
// chain booked → moved → … → current/cancelled). The DB walk lives in the API route;
// the order-assembly + projection is extracted here so the correctness-sensitive
// ordering is unit-tested independently of Supabase.

import type { FieldChange } from "@/lib/appointments/events";

export interface LifecycleLeg {
  id: string;
  status: string;
  startTime: string;
  bookedAt: string;             // created_at — when this leg was booked
  supersededAt: string | null;  // updated_at when it became terminal (moved/cancelled)
  channel: string;              // voice | dashboard | cal_com | calendly | google_calendar
  practitioner: string | null;  // SCRUM-391 — so the UI can show a doctor change
  serviceType: string | null;
  isCurrent: boolean;           // the leg the user opened
}

// Columns the walk must select for assembly (embeds practitioner/service names).
export const LIFECYCLE_COLS =
  "id, status, start_time, created_at, updated_at, provider, metadata, rescheduled_from_id, practitioners(name), service_types(name)";

// A leg is "superseded" (no longer live) when it was moved or cancelled.
export function isSupersededStatus(status: string): boolean {
  return status === "rescheduled" || status === "cancelled";
}

// A Supabase embedded to-one relation can come back as an object or a one-element
// array depending on the query; normalise to its `name` (or null).
export function pickName(rel: any): string | null {
  const r = Array.isArray(rel) ? rel[0] : rel;
  return r?.name ?? null;
}

export function deriveChannel(row: { provider?: string | null }): string {
  const p = row.provider;
  if (p === "manual") return "dashboard";
  if (p && p !== "internal") return p; // external calendar provider (cal_com, …)
  return "voice"; // internal / ai_receptionist
}

export interface LifecycleChange {
  label: string; // "Booked" | "Time changed" | "<Practitioner> changed" | "<Service> changed" | "Time & <Practitioner> changed" | "Cancelled" | "Updated"
  at: string;    // ISO date the change happened
}

// SCRUM-397: the practitioner/service words are industry-specific ("Dentist",
// "Attorney", "Technician", …). describeChange takes optional labels so the
// timeline isn't hardcoded to dental; defaults are neutral.
export interface ChangeLabels {
  practitioner?: string;
  service?: string;
}

/**
 * SCRUM-391: describe WHAT changed to arrive at `leg` versus the previous (older)
 * leg, for the history timeline — so a same-time practitioner change reads
 * "<Practitioner> changed" rather than a confusing duplicate "Moved to <same time>".
 *
 * `at` is dated by the destination leg's booking time (when the move into it
 * happened), except a cancellation — which has no successor leg, so it uses its own
 * supersede time.
 *
 * SCRUM-397: `labels` supplies industry-generic words (e.g. {practitioner:"Dentist"});
 * omitted, it falls back to neutral "Practitioner"/"Service".
 */
export function describeChange(
  leg: LifecycleLeg,
  prev: LifecycleLeg | null,
  labels?: ChangeLabels
): LifecycleChange {
  const at = leg.status === "cancelled" && leg.supersededAt ? leg.supersededAt : leg.bookedAt;
  if (!prev) return { label: "Booked", at };
  if (leg.status === "cancelled") return { label: "Cancelled", at };
  const parts: string[] = [];
  if (prev.startTime !== leg.startTime) parts.push("Time");
  if (prev.practitioner !== leg.practitioner) parts.push(labels?.practitioner ?? "Practitioner");
  if (prev.serviceType !== leg.serviceType) parts.push(labels?.service ?? "Service");
  if (parts.length === 0) return { label: "Updated", at };
  return { label: `${parts.join(" & ")} changed`, at };
}

/**
 * Assemble the ordered lifecycle (oldest → newest) from a back-walk and forward-walk.
 *
 * @param ancestors   rows walked back from `opened` via rescheduled_from_id, in
 *                    walk order (immediate parent first → root last).
 * @param opened      the appointment the user opened.
 * @param descendants rows walked forward via the reverse FK, in walk order
 *                    (immediate child first → tip last).
 * @returns legs oldest→newest, or null when the booking was never moved (a single leg).
 */
export function assembleLifecycle(
  ancestors: any[],
  opened: any,
  descendants: any[]
): LifecycleLeg[] | null {
  // ancestors are parent-first; reverse to root-first, then opened, then descendants.
  const chain = [...[...ancestors].reverse(), opened, ...descendants];
  if (chain.length <= 1) return null; // never moved — the status badge already says it all
  return chain.map((r) => ({
    id: r.id,
    status: r.status,
    startTime: r.start_time,
    bookedAt: r.created_at,
    supersededAt: isSupersededStatus(r.status) ? r.updated_at : null,
    channel: deriveChannel(r),
    // Supabase embeds may resolve to an object or a single-element array.
    practitioner: pickName(r.practitioners),
    serviceType: pickName(r.service_types),
    isCurrent: r.id === opened.id,
  }));
}

// SCRUM-398: an audit event (appointment_events row), camelCased for the UI.
export interface TimelineEvent {
  id: string;
  eventType: string; // edited | status_changed | created | rescheduled | cancelled | restored
  actorType: string; // ai | staff | system
  channel: string;
  changedFields: FieldChange[];
  createdAt: string; // ISO
}

// One row in the merged history timeline — either a structural reschedule leg or an
// in-place edit event.
export interface TimelineItem {
  key: string;
  kind: "leg" | "event";
  at: string; // ISO, for ordering
  // leg-only:
  leg?: LifecycleLeg;
  changeLabel?: string; // describeChange label
  // event-only:
  eventType?: string;
  actorType?: string;
  channel?: string;
  changes?: FieldChange[];
}

/**
 * SCRUM-398: merge the structural reschedule legs and the in-place edit events into
 * one chronological timeline, so manual edits show next to AI changes ("Name:
 * Michael → Mena · by staff" alongside "Time & Dentist changed · via AI call").
 *
 * Only `edited`/`status_changed` events render standalone — the structural events
 * (`created`/`rescheduled`/`cancelled`) are already represented by the legs (or the
 * Source section), so rendering them too would duplicate the leg lines. Returns null
 * when there's nothing to show (a single, never-edited appointment).
 */
export function mergeTimeline(
  legs: LifecycleLeg[] | null,
  events: TimelineEvent[],
  labels?: ChangeLabels
): TimelineItem[] | null {
  const items: TimelineItem[] = [];
  if (legs) {
    legs.forEach((leg, i) => {
      const change = describeChange(leg, i > 0 ? legs[i - 1] : null, labels);
      items.push({ key: `leg:${leg.id}:${i}`, kind: "leg", at: change.at, leg, changeLabel: change.label });
    });
  }
  // A cancellation on a multi-leg appointment is already shown by the cancelled leg,
  // so drop the redundant status→cancelled event to avoid a duplicate line.
  const hasCancelledLeg = (legs ?? []).some((l) => l.status === "cancelled");
  for (const e of events) {
    if (e.eventType !== "edited" && e.eventType !== "status_changed" && e.eventType !== "restored") continue;
    if (!e.changedFields || e.changedFields.length === 0) continue;
    if (
      hasCancelledLeg &&
      e.eventType === "status_changed" &&
      e.changedFields.every((c) => c.field === "status" && c.to === "cancelled")
    ) {
      continue;
    }
    items.push({
      key: `event:${e.id}`,
      kind: "event",
      at: e.createdAt,
      eventType: e.eventType,
      actorType: e.actorType,
      channel: e.channel,
      changes: e.changedFields,
    });
  }
  if (items.length === 0) return null;
  // Chronological; on a tie, legs before events (deterministic ordering).
  items.sort((x, y) => {
    const dx = new Date(x.at).getTime();
    const dy = new Date(y.at).getTime();
    if (dx !== dy) return dx - dy;
    if (x.kind !== y.kind) return x.kind === "leg" ? -1 : 1;
    return 0;
  });
  return items;
}
