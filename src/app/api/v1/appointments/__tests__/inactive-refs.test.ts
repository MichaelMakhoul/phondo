import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-444: pin the dashboard semantics for deactivated (is_active=false)
// practitioner/service refs:
//
//   - PATCH validates ONLY the refs present in the payload (and the UI sends
//     only dirty fields — SCRUM-397), so a time-only edit / status change on an
//     appointment that CARRIES a since-deactivated practitioner must succeed
//     without the practitioners table ever being consulted.
//   - Explicitly CHANGING a ref to a deactivated row (PATCH) or attaching one
//     on manual creation (POST) is rejected with requireActive's 400.
//
// The supabase fake is filter-AWARE: the practitioner row exists and is
// org-owned but deactivated, so it resolves ONLY when no is_active filter was
// applied. A regression that drops requireActive would resolve the row, pass
// validation, and fail these tests downstream.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  // after() throws outside a real request scope; the deferred work it wraps
  // (cache invalidation, audit emit, SMS) is not under test here.
  return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn() }));
vi.mock("@/lib/sms/caller-sms", () => ({ sendAppointmentConfirmationSMS: vi.fn() }));
vi.mock("@/lib/clients/client-history", () => ({ getClientHistory: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { PATCH } from "../[id]/route";
import { POST } from "../route";

const APPT_ID = "44444444-5555-4666-8777-888888888888";
const NEW_LEG_ID = "55555555-6666-4777-8888-999999999999";
const INACTIVE_PRAC = "33333333-4444-4555-8666-777777777777";

// Future instants relative to "now" so the past-time / horizon guards never rot.
const OLD_TIME = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
const NEW_TIME = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

interface Touch {
  table: string;
  method: string;
  op: "select" | "update" | "insert";
  eqs: Array<[string, unknown]>;
}

const state: {
  user: { id: string } | null;
  beforeRow: Record<string, unknown> | null;
  insertedRow: Record<string, unknown> | null;
  updatedRow: Record<string, unknown> | null;
  touches: Touch[];
} = { user: null, beforeRow: null, insertedRow: null, updatedRow: null, touches: [] };

function makeBuilder(table: string) {
  const eqs: Array<[string, unknown]> = [];
  let op: Touch["op"] = "select";
  const b: Record<string, unknown> = {};
  const chain = () => b;
  const resolve = (method: string): { data: unknown; error: unknown } => {
    state.touches.push({ table, method, op, eqs });
    if (table === "org_members") return { data: { organization_id: "org-1" }, error: null };
    if (table === "practitioners") {
      // Org-owned but DEACTIVATED — visible only WITHOUT the is_active filter.
      const activeFiltered = eqs.some(([c, v]) => c === "is_active" && v === true);
      return activeFiltered ? { data: null, error: null } : { data: { id: INACTIVE_PRAC }, error: null };
    }
    if (table === "appointments") {
      if (op === "insert") return { data: state.insertedRow, error: null };
      if (op === "update") {
        // rescheduleViaLeg's free step awaits `.select("id")` (then); the
        // in-place edit ends `.select().single()`.
        return method === "single"
          ? { data: state.updatedRow, error: null }
          : { data: [{ id: APPT_ID }], error: null };
      }
      return { data: state.beforeRow, error: null };
    }
    return { data: null, error: null };
  };
  Object.assign(b, {
    select: chain, in: chain, is: chain, not: chain, or: chain, order: chain,
    limit: chain, range: chain, gte: chain, lte: chain, lt: chain, gt: chain,
    eq: (col: string, val: unknown) => {
      eqs.push([col, val]);
      return b;
    },
    update: () => {
      op = "update";
      return b;
    },
    insert: () => {
      op = "insert";
      return b;
    },
    single: async () => resolve("single"),
    maybeSingle: async () => resolve("maybeSingle"),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve("then")).then(onF, onR),
  });
  return b;
}

function makeBeforeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPT_ID,
    attendee_name: "Jane Smith",
    attendee_first_name: "Jane",
    attendee_last_name: "Smith",
    attendee_phone: "+61412345678",
    attendee_email: null,
    notes: null,
    start_time: OLD_TIME,
    end_time: new Date(new Date(OLD_TIME).getTime() + 30 * 60_000).toISOString(),
    duration_minutes: 30,
    status: "confirmed",
    service_type_id: null,
    practitioner_id: INACTIVE_PRAC, // since-deactivated, carried on the row
    service_types: null,
    practitioners: { name: "Dr Departed" },
    ...overrides,
  };
}

async function callPatch(body: Record<string, unknown>) {
  return PATCH(
    new Request(`http://localhost/api/v1/appointments/${APPT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: APPT_ID }) },
  );
}

async function callPost(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/v1/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

beforeEach(() => {
  state.user = { id: "user-1" };
  state.beforeRow = makeBeforeRow();
  state.insertedRow = null;
  state.updatedRow = null;
  state.touches = [];
  vi.mocked(createClient).mockImplementation(async () =>
    ({
      auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) },
      from: (table: string) => makeBuilder(table),
    }) as never,
  );
});

describe("PATCH /appointments/[id] — deactivated refs (SCRUM-444)", () => {
  it("time-only edit succeeds when the stored practitioner is deactivated (ref carried, never re-validated)", async () => {
    state.insertedRow = makeBeforeRow({
      id: NEW_LEG_ID,
      start_time: NEW_TIME,
      end_time: new Date(new Date(NEW_TIME).getTime() + 30 * 60_000).toISOString(),
    });

    const res = await callPatch({ start_time: NEW_TIME });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Reschedule leg created, deactivated practitioner carried onto it.
    expect(body.rescheduled).toEqual({ fromId: APPT_ID, toId: NEW_LEG_ID });
    expect(body.practitioner_id).toBe(INACTIVE_PRAC);
    // The route never consulted the practitioners table — the carried ref is
    // exempt from the requireActive check by construction.
    expect(state.touches.filter((t) => t.table === "practitioners")).toHaveLength(0);
  });

  it("status-only change succeeds when the stored practitioner is deactivated", async () => {
    state.updatedRow = makeBeforeRow({ status: "completed" });

    const res = await callPatch({ status: "completed" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(state.touches.filter((t) => t.table === "practitioners")).toHaveLength(0);
  });

  it("explicitly CHANGING to a deactivated practitioner is rejected with 400", async () => {
    const res = await callPatch({ practitioner_id: INACTIVE_PRAC });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/practitioner_id/);
    expect(body.error).toMatch(/inactive/);
    // Rejected by the is_active-filtered validator lookup, before any write —
    // the appointments table was never touched.
    const validatorLookup = state.touches.find((t) => t.table === "practitioners");
    expect(validatorLookup?.eqs).toContainEqual(["is_active", true]);
    expect(state.touches.filter((t) => t.table === "appointments")).toHaveLength(0);
  });
});

describe("POST /appointments — deactivated refs (SCRUM-444)", () => {
  it("manual creation with a deactivated practitioner is rejected with 400", async () => {
    const res = await callPost({
      first_name: "Jane",
      phone: "+61412345678",
      start_time: NEW_TIME,
      practitioner_id: INACTIVE_PRAC,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/practitioner_id/);
    expect(body.error).toMatch(/inactive/);
    const validatorLookup = state.touches.find((t) => t.table === "practitioners");
    expect(validatorLookup?.eqs).toContainEqual(["is_active", true]);
    expect(state.touches.filter((t) => t.table === "appointments")).toHaveLength(0);
  });
});
