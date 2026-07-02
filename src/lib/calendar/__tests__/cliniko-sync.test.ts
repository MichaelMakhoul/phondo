import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import type { ClinikoClient } from "../cliniko";
import { syncClinikoCatalog } from "../cliniko-sync";

interface DbCall {
  table: string;
  op: "upsert" | "select" | "update" | null;
  payload: unknown;
  opts: unknown;
  filters: Record<string, unknown>;
  inIds: unknown[] | null;
}

type Handler = (call: DbCall) => { data?: unknown; error?: { message: string } | null };

function mockDb(handler: Handler) {
  const calls: DbCall[] = [];
  const from = vi.fn((table: string) => {
    const call: DbCall = { table, op: null, payload: null, opts: null, filters: {}, inIds: null };
    calls.push(call);
    const qb: Record<string, unknown> = {
      select: () => qb,
      upsert: (payload: unknown, opts: unknown) => {
        call.op = "upsert";
        call.payload = payload;
        call.opts = opts;
        return qb;
      },
      update: (payload: unknown) => {
        call.op = "update";
        call.payload = payload;
        return qb;
      },
      eq: (k: string, v: unknown) => {
        if (!call.op) call.op = "select";
        call.filters[k] = v;
        return qb;
      },
      in: (_k: string, v: unknown[]) => {
        call.inIds = v;
        return qb;
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        if (!call.op) call.op = "select";
        try {
          const res = handler(call) || {};
          resolve({ data: res.data ?? null, error: res.error ?? null });
        } catch (e) {
          reject(e);
        }
      },
    };
    return qb;
  });
  return { client: { from }, calls };
}

const ORG = "22222222-2222-4222-a222-222222222222";

const PRACTITIONERS = [
  { id: "10", first_name: "Sue", last_name: "Smith", active: true },
  { id: "11", first_name: "Ali", last_name: "Vu", active: true },
  { id: "12", first_name: "Old", last_name: "Timer", active: false },
];
const TYPES = [
  { id: "20", name: "Check-up", duration_in_minutes: 30, archived_at: null },
  { id: "21", name: "Cleaning", duration_in_minutes: 45, archived_at: null },
  { id: "22", name: "Legacy", duration_in_minutes: 60, archived_at: "2025-01-01T00:00:00Z" },
];

function fakeClient(): ClinikoClient {
  return {
    listPractitioners: vi.fn(async () => PRACTITIONERS),
    listAppointmentTypes: vi.fn(async () => TYPES),
  } as unknown as ClinikoClient;
}

describe("syncClinikoCatalog business scoping", () => {
  it("forwards the selected businessId to listPractitioners (multi-location isolation)", async () => {
    const db = mockDb(defaultHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const client = fakeClient();
    await syncClinikoCatalog(ORG, client, "biz-7");
    expect(client.listPractitioners).toHaveBeenCalledWith("biz-7");
  });
});

/** Default handler: upserts return local rows, selects return no stale rows. */
const defaultHandler: Handler = (call) => {
  if (call.op === "upsert" && call.table === "practitioners") {
    return { data: [{ id: "lp-1", external_id: "10" }, { id: "lp-2", external_id: "11" }] };
  }
  if (call.op === "upsert" && call.table === "service_types") {
    return { data: [{ id: "ls-1", external_id: "20" }, { id: "ls-2", external_id: "21" }] };
  }
  if (call.op === "select") return { data: [] };
  return { data: null };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncClinikoCatalog", () => {
  it("imports active practitioners and non-archived types with external refs, without touching is_active", async () => {
    const db = mockDb(defaultHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);

    const result = await syncClinikoCatalog(ORG, fakeClient());

    const pUpsert = db.calls.find((c) => c.op === "upsert" && c.table === "practitioners")!;
    const rows = pUpsert.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2); // inactive practitioner not imported
    expect(rows[0]).toMatchObject({
      organization_id: ORG,
      name: "Sue Smith",
      external_provider: "cliniko",
      external_id: "10",
    });
    expect(rows[0]).not.toHaveProperty("is_active"); // local toggles preserved
    expect(pUpsert.opts).toMatchObject({ onConflict: "organization_id,external_provider,external_id" });

    const sUpsert = db.calls.find((c) => c.op === "upsert" && c.table === "service_types")!;
    const sRows = sUpsert.payload as Array<Record<string, unknown>>;
    expect(sRows).toHaveLength(2); // archived type not imported
    expect(sRows[1]).toMatchObject({ name: "Cleaning", duration_minutes: 45, external_id: "21" });
    expect(sRows[1]).not.toHaveProperty("is_active");

    expect(result.practitionersUpserted).toBe(2);
    expect(result.serviceTypesUpserted).toBe(2);
    expect(vi.mocked(invalidateVoiceScheduleCache)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invalidateVoiceScheduleCache)).toHaveBeenCalledWith(ORG);
  });

  it("links every imported practitioner to every imported service type, ignoring duplicates", async () => {
    const db = mockDb(defaultHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);

    await syncClinikoCatalog(ORG, fakeClient());

    const link = db.calls.find((c) => c.op === "upsert" && c.table === "practitioner_services")!;
    expect(link).toBeTruthy();
    const linkRows = link.payload as Array<Record<string, unknown>>;
    expect(linkRows).toHaveLength(4); // 2 practitioners x 2 services
    expect(linkRows).toContainEqual({ practitioner_id: "lp-1", service_type_id: "ls-2" });
    expect(link.opts).toMatchObject({ onConflict: "practitioner_id,service_type_id", ignoreDuplicates: true });
  });

  it("deactivates cliniko-linked local rows whose external counterpart vanished", async () => {
    const handler: Handler = (call) => {
      if (call.op === "select" && call.table === "practitioners") {
        return { data: [{ id: "lp-stale", external_id: "99" }, { id: "lp-1", external_id: "10" }] };
      }
      if (call.op === "select" && call.table === "service_types") {
        return { data: [{ id: "ls-stale", external_id: "22" }] }; // archived upstream
      }
      return defaultHandler(call);
    };
    const db = mockDb(handler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);

    const result = await syncClinikoCatalog(ORG, fakeClient());

    const updates = db.calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(2);
    const pUpdate = updates.find((c) => c.table === "practitioners")!;
    expect(pUpdate.payload).toMatchObject({ is_active: false });
    expect(pUpdate.inIds).toEqual(["lp-stale"]);
    expect(pUpdate.filters.organization_id).toBe(ORG);
    const sUpdate = updates.find((c) => c.table === "service_types")!;
    expect(sUpdate.inIds).toEqual(["ls-stale"]);
    expect(result.deactivated).toBe(2);
  });

  it("continues past a failed phase, still invalidates cache, then throws an aggregate error", async () => {
    const handler: Handler = (call) => {
      if (call.op === "upsert" && call.table === "practitioners") {
        return { error: { message: "practitioner upsert boom" } };
      }
      return defaultHandler(call);
    };
    const db = mockDb(handler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);

    const err = await syncClinikoCatalog(ORG, fakeClient()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain("practitioner upsert boom");
    // Service types were still processed despite the practitioner failure
    expect(db.calls.some((c) => c.op === "upsert" && c.table === "service_types")).toBe(true);
    expect(vi.mocked(invalidateVoiceScheduleCache)).toHaveBeenCalledTimes(1);
  });

  it("handles an org with no active practitioners without upserting empty arrays", async () => {
    const db = mockDb(defaultHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const client = {
      listPractitioners: vi.fn(async () => []),
      listAppointmentTypes: vi.fn(async () => TYPES),
    } as unknown as ClinikoClient;

    const result = await syncClinikoCatalog(ORG, client);
    expect(result.practitionersUpserted).toBe(0);
    expect(db.calls.some((c) => c.op === "upsert" && c.table === "practitioners")).toBe(false);
    expect(db.calls.some((c) => c.op === "upsert" && c.table === "practitioner_services")).toBe(false);
    expect(result.serviceTypesUpserted).toBe(2);
  });
});
