import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-599 (test lens G2): the owner's booking through the REAL booking path, over a
// fake that keeps rows and applies filters like PostgREST. The handler's own tests only
// ever meet hand-written booking results, so this is where the repeat guard meets the
// row the booking path really writes: a second "yes" to the same booking finds it by
// the call, the start time and the number it was stored with, and never books (or
// texts) twice. Only the senders and the outside services are stubbed.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({ rateLimitDistributed: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({ sendAppointmentNotification: vi.fn(), getOrganizationOwnerEmail: vi.fn(async () => null) }));
vi.mock("@/lib/calendar/cliniko-booking", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveClinikoIntegration: vi.fn(async () => ({ kind: "none" })),
}));
vi.mock("@/lib/calendar/cal-com", async (importOriginal) => ({ ...(await importOriginal<object>()), getCalComClient: vi.fn(async () => null) }));
vi.mock("@/lib/sms/caller-sms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/caller-sms")>();
  return { ...actual, sendAppointmentConfirmationSMS: vi.fn(), sendCancellationSMS: vi.fn() };
});
vi.mock("@/lib/observability/page-sentry", () => ({ pageSentry: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), withScope: vi.fn() }));
vi.mock("../customer-call", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../customer-call")>()),
  checkCustomerCall: vi.fn(),
  placeCustomerCall: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { sendAppointmentNotification } from "@/lib/notifications/notification-service";
import { confirmationIdempotencyKey, sendAppointmentConfirmationSMS } from "@/lib/sms/caller-sms";
import { handleOwnerBookAppointment } from "../tool-handlers";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
let nextId = 1;

/** Only the requested columns (an embed like `practitioners(name)` comes back empty). */
function project(row: Row, cols: string): Row {
  if (cols.trim() === "*") return { ...row };
  const out: Row = {};
  for (const c of cols.split(",").map((s) => s.trim()).filter(Boolean)) out[c] = row[c];
  return out;
}

/** Rows kept per table; eq/neq/in/is/lt/gt/gte/lte really filter; a write without .select() returns no rows. */
function postgrestAdmin() {
  return {
    from(table: string) {
      let kind: "select" | "insert" | "update" = "select";
      let payload: Row | undefined;
      let cols: string | null = null;
      let mode: "many" | "single" | "maybe" = "many";
      let limit: number | null = null;
      const preds: Array<(r: Row) => boolean> = [];
      const run = () => {
        const rows = tables[table] ?? (tables[table] = []);
        let hit: Row[];
        if (kind === "insert") {
          const row = { id: `${table}-${nextId++}`, ...payload };
          rows.push(row);
          hit = [row];
        } else {
          hit = rows.filter((r) => preds.every((p) => p(r)));
          if (limit !== null) hit = hit.slice(0, limit);
          if (kind === "update") for (const r of hit) Object.assign(r, payload);
        }
        if (kind !== "select" && cols === null) return { data: null, error: null };
        const out = hit.map((r) => project(r, cols ?? "*"));
        if (mode === "many") return { data: out, error: null };
        if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "more than one row" } };
        if (out.length === 0) return mode === "maybe" ? { data: null, error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
        return { data: out[0], error: null };
      };
      const time = (v: unknown) => new Date(String(v)).getTime();
      const b: any = {
        select(c?: string) { cols = c ?? "*"; return b; },
        insert(p: Row) { kind = "insert"; payload = p; return b; },
        update(p: Row) { kind = "update"; payload = p; return b; },
        eq(k: string, v: unknown) { preds.push((r) => r[k] === v); return b; },
        in(k: string, vs: unknown[]) { preds.push((r) => vs.includes(r[k])); return b; },
        lt(k: string, v: unknown) { preds.push((r) => time(r[k]) < time(v)); return b; },
        gt(k: string, v: unknown) { preds.push((r) => time(r[k]) > time(v)); return b; },
        lte(k: string, v: unknown) { preds.push((r) => time(r[k]) <= time(v)); return b; },
        gte(k: string, v: unknown) { preds.push((r) => time(r[k]) >= time(v)); return b; },
        neq(k: string, v: unknown) { preds.push((r) => r[k] !== v); return b; },
        is(k: string, v: unknown) { preds.push((r) => (v === null ? r[k] == null : r[k] === v)); return b; },
        not(k: string, op: string, v: unknown) { preds.push((r) => (op === "is" && v === null ? r[k] != null : true)); return b; },
        // Not modelled (no row this test writes depends on them): they match everything.
        or() { return b; },
        ilike() { return b; },
        order() { return b; },
        limit(n: number) { limit = n; return b; },
        single() { mode = "single"; return Promise.resolve(run()); },
        maybeSingle() { mode = "maybe"; return Promise.resolve(run()); },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return b;
    },
  };
}

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const TZ = "Australia/Sydney";
const NOW = new Date("2026-10-15T03:00:00Z"); // Thu 2026-10-15 14:00 AEDT
const OPEN = { open: "09:00", close: "17:00" };
const HOURS = { monday: OPEN, tuesday: OPEN, wednesday: OPEN, thursday: OPEN, friday: OPEN, saturday: null, sunday: null };
const ASK = { customer_name: "Jane Smith", customer_phone: "0412 345 678", start: "2026-10-16T10:00", confirmed: true, notify_customer: "text" };

beforeEach(() => {
  nextId = 1;
  tables = {
    organizations: [{ id: ORG, timezone: TZ, country: "AU", business_hours: HOURS, default_appointment_duration: 60 }],
  };
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(postgrestAdmin() as any);
  // The sender writes its log row, as the real one does (sendCallerSMS's upsert).
  vi.mocked(sendAppointmentConfirmationSMS).mockImplementation(async (orgId, _phone, startTime, _tz, _code, appointmentId) => {
    (tables.appointment_confirmations ??= []).push({
      organization_id: orgId,
      appointment_id: appointmentId,
      idempotency_key: confirmationIdempotencyKey(appointmentId as string, "sms", "confirmation", startTime.toISOString()),
      status: "sent",
    });
    return { sent: true, status: "sent" } as any;
  });
  process.env.CALLER_SMS_ENABLED = "true";
  vi.useFakeTimers({ now: NOW });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.CALLER_SMS_ENABLED;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("owner_book_appointment through the real booking path (test lens G2)", () => {
  it("one yes: ONE row on the owner's call (owner_voice, E.164), one audit row, the owner's text and no automatic notice", async () => {
    const r = await handleOwnerBookAppointment(ORG, ASK, { callId: CALL });
    expect(r.data).toMatchObject({ outcome: "booked", customer_contact: { method: "text", status: "sent" } });
    expect(tables.appointments).toHaveLength(1);
    expect(tables.appointments[0]).toMatchObject({
      organization_id: ORG,
      call_id: CALL,
      attendee_phone: "+61412345678",
      start_time: "2026-10-15T23:00:00.000Z",
      status: "confirmed",
      metadata: { source: "owner_voice" },
    });
    expect(tables.appointment_events).toHaveLength(1);
    expect(tables.appointment_events[0]).toMatchObject({ appointment_id: tables.appointments[0].id, event_type: "created", call_id: CALL });
    expect(sendAppointmentConfirmationSMS).toHaveBeenCalledTimes(1);
    expect(sendAppointmentNotification).not.toHaveBeenCalled();
  });

  it("the same yes again (its result never came back): handed back — still one row, one audit row, one text", async () => {
    await handleOwnerBookAppointment(ORG, ASK, { callId: CALL });
    const again = await handleOwnerBookAppointment(ORG, ASK, { callId: CALL });
    expect(again.message).toBe("Jane Smith is already booked for Friday, October 16 at 10:00 AM — that's the booking from a moment ago. I've texted Jane Smith to let them know.");
    expect(again.data).toMatchObject({ outcome: "booked", appointment_id: tables.appointments[0].id, customer_contact: { method: "text", status: "sent" } });
    expect(tables.appointments).toHaveLength(1);
    expect(tables.appointment_events).toHaveLength(1);
    expect(sendAppointmentConfirmationSMS).toHaveBeenCalledTimes(1);
  });

  it("silent lens r2 F3: a first attempt cut off after its booking, before its audit row and text — the repeat writes both", async () => {
    tables.appointments = [{
      id: "appt-1", organization_id: ORG, call_id: CALL, attendee_first_name: "Jane", attendee_name: "Jane Smith", attendee_phone: "+61412345678",
      start_time: "2026-10-15T23:00:00.000Z", status: "confirmed", confirmation_code: "123456", service_type_id: null, notes: null,
    }];
    const again = await handleOwnerBookAppointment(ORG, ASK, { callId: CALL });
    expect(again.message).toContain("that's the booking from a moment ago. I've texted Jane Smith to let them know.");
    expect(tables.appointments).toHaveLength(1);
    expect(tables.appointment_events).toHaveLength(1);
    expect(tables.appointment_events[0]).toMatchObject({ appointment_id: "appt-1", event_type: "created", call_id: CALL });
    expect(sendAppointmentConfirmationSMS).toHaveBeenCalledTimes(1);
  });

  it("the number said another way (+61…) is the same customer: still handed back", async () => {
    await handleOwnerBookAppointment(ORG, ASK, { callId: CALL });
    const again = await handleOwnerBookAppointment(ORG, { ...ASK, customer_phone: "+61 412 345 678" }, { callId: CALL });
    expect(again.message).toContain("that's the booking from a moment ago");
    expect(tables.appointments).toHaveLength(1);
  });

  it("security lens r2: a second child on the same mobile at the same time is booked, not taken for a repeat", async () => {
    await handleOwnerBookAppointment(ORG, ASK, { callId: CALL });
    const sibling = await handleOwnerBookAppointment(ORG, { ...ASK, customer_name: "Tom Smith", notify_customer: "none" }, { callId: CALL });
    expect(sibling.message).toMatch(/^Booked Tom Smith for /);
    expect(tables.appointments.map((a) => a.attendee_name)).toEqual(["Jane Smith", "Tom Smith"]);
  });

  it("another call's booking at that time is never this one's repeat", async () => {
    await handleOwnerBookAppointment(ORG, ASK, { callId: CALL });
    const other = await handleOwnerBookAppointment(ORG, { ...ASK, notify_customer: "none" }, { callId: "99999999-8888-4777-8666-555555555555" });
    expect(other.message).not.toContain("from a moment ago");
  });
});
