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
  isCurrent: boolean;           // the leg the user opened
}

// Columns the walk must select for assembly.
export const LIFECYCLE_COLS =
  "id, status, start_time, created_at, updated_at, provider, metadata, rescheduled_from_id";

// A leg is "superseded" (no longer live) when it was moved or cancelled.
export function isSupersededStatus(status: string): boolean {
  return status === "rescheduled" || status === "cancelled";
}

export function deriveChannel(row: { provider?: string | null }): string {
  const p = row.provider;
  if (p === "manual") return "dashboard";
  if (p && p !== "internal") return p; // external calendar provider (cal_com, …)
  return "voice"; // internal / ai_receptionist
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
    isCurrent: r.id === opened.id,
  }));
}
