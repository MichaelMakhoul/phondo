import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileClinikoOrg } from "../cliniko-reconcile";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: (fn: (scope: { setLevel: () => void; setTag: () => void; setExtras: () => void }) => void) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() }),
}));

const ORG = "org-1";
const NOW = Date.parse("2026-07-02T12:00:00Z");

interface MirrorSeed {
  id: string;
  external_id: string;
  start_time: string;
  status: string;
}

/**
 * Minimal chainable Supabase admin mock. Records every .update() with the row id
 * it targeted, and serves a canned settings read + mirror list. Both reads and
 * updates resolve as thenables so `await` works on the chain.
 */
function mockAdmin(opts: {
  settings?: Record<string, unknown>;
  mirrors?: MirrorSeed[];
  settingsWriteError?: { message: string } | null;
  mirrorWriteError?: { message: string } | null;
}) {
  const updates: Array<{ table: string; payload: Record<string, unknown>; id?: string }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const mirrors = opts.mirrors ?? [];
  const client = {
    // SCRUM-489: settings writes go through the merge RPC, not .update().
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { error: fn === "merge_calendar_integration_settings" ? opts.settingsWriteError ?? null : null };
    },
    from(table: string) {
      const state = { table, externalIds: null as null | string[] };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: (col: string, vals: string[]) => {
          if (col === "external_id") state.externalIds = vals;
          return chain;
        },
        single: async () => {
          if (table === "calendar_integrations") {
            return { data: { settings: opts.settings ?? {} }, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
          if (table === "appointments") {
            const rows = state.externalIds
              ? mirrors.filter((m) => state.externalIds!.includes(m.external_id))
              : mirrors;
            return resolve({ data: rows, error: null });
          }
          return resolve({ data: [], error: null });
        },
        update: (payload: Record<string, unknown>) => {
          const record: { table: string; payload: Record<string, unknown>; id?: string } = { table, payload };
          const uchain: Record<string, unknown> = {
            eq: (col: string, val: string) => {
              if (col === "id") record.id = val;
              return uchain;
            },
            then: (resolve: (v: { error: unknown }) => unknown) => {
              updates.push(record);
              const err =
                table === "calendar_integrations"
                  ? opts.settingsWriteError ?? null
                  : table === "appointments"
                    ? opts.mirrorWriteError ?? null
                    : null;
              return resolve({ error: err });
            },
          };
          return uchain;
        },
      };
      return chain;
    },
  };
  return { client, updates, rpcCalls };
}

// The settings patch sent to the merge RPC on this run (undefined if not called).
function settingsPatch(rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>) {
  return rpcCalls.find((c) => c.fn === "merge_calendar_integration_settings")?.args.p_patch as
    | Record<string, unknown>
    | undefined;
}

function ctxWith(client: {
  listChangedAppointments?: ReturnType<typeof vi.fn>;
  listDeletedAppointments?: ReturnType<typeof vi.fn>;
}) {
  return {
    client: {
      listChangedAppointments: client.listChangedAppointments ?? vi.fn(async () => ({ items: [], truncated: false })),
      listDeletedAppointments: client.listDeletedAppointments ?? vi.fn(async () => ({ items: [], truncated: false })),
    },
    businessId: "b-1",
    integrationId: "int-1",
    organizationId: ORG,
  };
}

// Wrap a list of appointments as a non-truncated PagedResult.
function page(items: unknown[], truncated = false) {
  return { items, truncated };
}

const BASE_SETTINGS = { shard: "au1", businessId: "b-1", lastReconciledAt: "2026-07-02T11:00:00Z" };

beforeEach(() => vi.clearAllMocks());

describe("reconcileClinikoOrg", () => {
  it("voids a mirror row when Cliniko shows the appointment cancelled", async () => {
    const { client, updates } = mockAdmin({
      settings: { ...BASE_SETTINGS },
      mirrors: [{ id: "m-1", external_id: "900", start_time: "2026-07-10T02:00:00Z", status: "confirmed" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () => page([
        {
          id: "900",
          starts_at: "2026-07-10T02:00:00Z",
          ends_at: "2026-07-10T02:30:00Z",
          cancelled_at: "2026-07-02T11:30:00Z",
          deleted_at: null,
          updated_at: "2026-07-02T11:30:00Z",
        },
      ])),
    });
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    expect(res).toMatchObject({ ran: true, cancelled: 1, moved: 0 });
    const mirrorUpdate = updates.find((u) => u.table === "appointments");
    expect(mirrorUpdate?.payload).toMatchObject({ status: "cancelled" });
    expect(mirrorUpdate?.id).toBe("m-1");
  });

  it("retimes a mirror row when Cliniko starts_at moved", async () => {
    const { client, updates } = mockAdmin({
      settings: { ...BASE_SETTINGS },
      mirrors: [{ id: "m-2", external_id: "901", start_time: "2026-07-10T02:00:00Z", status: "confirmed" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () => page([
        {
          id: "901",
          starts_at: "2026-07-10T05:00:00Z",
          ends_at: "2026-07-10T05:30:00Z",
          cancelled_at: null,
          deleted_at: null,
          updated_at: "2026-07-02T11:30:00Z",
        },
      ])),
    });
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    expect(res).toMatchObject({ ran: true, cancelled: 0, moved: 1 });
    const mirrorUpdate = updates.find((u) => u.table === "appointments");
    expect(mirrorUpdate?.payload).toMatchObject({ start_time: "2026-07-10T05:00:00Z", end_time: "2026-07-10T05:30:00Z" });
  });

  it("voids on hard delete", async () => {
    const { client, updates } = mockAdmin({
      settings: { ...BASE_SETTINGS },
      mirrors: [{ id: "m-3", external_id: "902", start_time: "2026-07-10T02:00:00Z", status: "confirmed" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listDeletedAppointments: vi.fn(async () => page([
        {
          id: "902",
          starts_at: "2026-07-10T02:00:00Z",
          ends_at: "2026-07-10T02:30:00Z",
          cancelled_at: null,
          deleted_at: "2026-07-02T11:30:00Z",
          updated_at: "2026-07-02T11:30:00Z",
        },
      ])),
    });
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    expect(res.cancelled).toBe(1);
    expect(updates.find((u) => u.table === "appointments")?.payload).toMatchObject({ status: "cancelled" });
  });

  it("skips a changed appointment we never booked (no mirror row)", async () => {
    const { client, updates } = mockAdmin({
      settings: { ...BASE_SETTINGS },
      mirrors: [],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () => page([
        {
          id: "999",
          starts_at: "2026-07-10T02:00:00Z",
          ends_at: "2026-07-10T02:30:00Z",
          cancelled_at: "2026-07-02T11:30:00Z",
          deleted_at: null,
          updated_at: "2026-07-02T11:30:00Z",
        },
      ])),
    });
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    expect(res.cancelled).toBe(0);
    expect(updates.find((u) => u.table === "appointments")).toBeUndefined();
  });

  it("freshness gate: skips when reconciled < 60s ago and not forced", async () => {
    const { client } = mockAdmin({
      settings: { ...BASE_SETTINGS, lastReconciledAt: "2026-07-02T11:59:30Z" }, // 30s before NOW
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({});
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    expect(res.ran).toBe(false);
    expect(ctx.client.listChangedAppointments).not.toHaveBeenCalled();
  });

  it("force overrides the freshness gate", async () => {
    const { client } = mockAdmin({
      settings: { ...BASE_SETTINGS, lastReconciledAt: "2026-07-02T11:59:30Z" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({});
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW, force: true });
    expect(res.ran).toBe(true);
    expect(ctx.client.listChangedAppointments).toHaveBeenCalled();
  });

  it("advances the cursor via an atomic single-key merge (no full-blob write)", async () => {
    const { client, rpcCalls } = mockAdmin({
      settings: { ...BASE_SETTINGS },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({});
    await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    const patch = settingsPatch(rpcCalls);
    expect(patch).toEqual({ lastReconciledAt: new Date(NOW).toISOString() });
    // shard/businessId are NOT in the patch — the DB `settings || patch` preserves them.
    expect(patch).not.toHaveProperty("shard");
    expect(patch).not.toHaveProperty("errorState");
  });

  it("does NOT advance the cursor when the poll throws", async () => {
    const { client, rpcCalls } = mockAdmin({
      settings: { ...BASE_SETTINGS },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () => {
        throw new Error("cliniko down");
      }),
    });
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    expect(res.ran).toBe(false);
    expect(settingsPatch(rpcCalls)).toBeUndefined();
  });

  it("holds the cursor when truncated with no fetched records (can't make progress)", async () => {
    const { client, rpcCalls } = mockAdmin({ settings: { ...BASE_SETTINGS } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () => page([], true)), // truncated, empty
    });
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    expect(res.ran).toBe(true);
    expect(settingsPatch(rpcCalls)).toBeUndefined();
  });

  it("advances the cursor to the newest FETCHED change on a truncated poll (SCRUM-490 progress)", async () => {
    const { client, rpcCalls } = mockAdmin({
      settings: { ...BASE_SETTINGS },
      mirrors: [{ id: "m-1", external_id: "900", start_time: "2026-07-10T02:00:00Z", status: "confirmed" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const NEWEST = "2026-07-02T11:45:00Z"; // between the cursor (11:00) and NOW (12:00)
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () =>
        page(
          [
            { id: "900", starts_at: "2026-07-10T02:00:00Z", ends_at: "2026-07-10T02:30:00Z", cancelled_at: "2026-07-02T11:40:00Z", deleted_at: null, updated_at: NEWEST },
          ],
          true // truncated — more (newer) records remain
        )
      ),
    });
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    expect(res).toMatchObject({ ran: true, cancelled: 1 });
    // Cursor moves forward to the newest record we fetched — NOT to NOW (dropped
    // tail is newer) and NOT held (that would re-read the same 2000 forever).
    expect(settingsPatch(rpcCalls)).toEqual({ lastReconciledAt: new Date(NEWEST).toISOString() });
  });

  it("holds the cursor on a per-row failure even if not truncated (retry next run)", async () => {
    const { client, rpcCalls } = mockAdmin({
      settings: { ...BASE_SETTINGS },
      mirrors: [{ id: "m-1", external_id: "900", start_time: "2026-07-10T02:00:00Z", status: "confirmed" }],
      mirrorWriteError: { message: "deadlock" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () =>
        page([
          { id: "900", starts_at: "2026-07-10T02:00:00Z", ends_at: "2026-07-10T02:30:00Z", cancelled_at: "2026-07-02T11:40:00Z", deleted_at: null, updated_at: "2026-07-02T11:40:00Z" },
        ])
      ),
    });
    const res = await reconcileClinikoOrg(ctx as never, { nowMs: NOW });
    expect(res.failed).toBe(1);
    expect(settingsPatch(rpcCalls)).toBeUndefined(); // held for retry
  });

  it("clears a stale auth_failed flag once a poll succeeds", async () => {
    const { client, rpcCalls } = mockAdmin({
      settings: { ...BASE_SETTINGS, errorState: "auth_failed" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    await reconcileClinikoOrg(ctxWith({}) as never, { nowMs: NOW });
    expect(settingsPatch(rpcCalls)).toMatchObject({ errorState: null });
  });

  it("leaves a sync_failed flag intact (patch omits errorState so the merge preserves it)", async () => {
    const { client, rpcCalls } = mockAdmin({
      settings: { ...BASE_SETTINGS, errorState: "sync_failed" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    await reconcileClinikoOrg(ctxWith({}) as never, { nowMs: NOW });
    expect(settingsPatch(rpcCalls)).not.toHaveProperty("errorState");
  });
});
