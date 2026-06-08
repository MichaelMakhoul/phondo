// SCRUM-389: pure helpers for an appointment's reschedule lifecycle (the supersede
// chain booked → moved → … → current/cancelled). The DB walk lives in the API route;
// the order-assembly + projection is extracted here so the correctness-sensitive
// ordering is unit-tested independently of Supabase.

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
  label: string; // "Booked" | "Time changed" | "Doctor changed" | "Service changed" | "Time & Doctor changed" | "Cancelled" | "Updated"
  at: string;    // ISO date the change happened
}

/**
 * SCRUM-391: describe WHAT changed to arrive at `leg` versus the previous (older)
 * leg, for the history timeline — so a same-time doctor change reads "Doctor changed"
 * rather than a confusing duplicate "Moved to <same time>".
 *
 * `at` is dated by the destination leg's booking time (when the move into it
 * happened), except a cancellation — which has no successor leg, so it uses its own
 * supersede time.
 */
export function describeChange(leg: LifecycleLeg, prev: LifecycleLeg | null): LifecycleChange {
  const at = leg.status === "cancelled" && leg.supersededAt ? leg.supersededAt : leg.bookedAt;
  if (!prev) return { label: "Booked", at };
  if (leg.status === "cancelled") return { label: "Cancelled", at };
  const parts: string[] = [];
  if (prev.startTime !== leg.startTime) parts.push("Time");
  if (prev.practitioner !== leg.practitioner) parts.push("Doctor");
  if (prev.serviceType !== leg.serviceType) parts.push("Service");
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
