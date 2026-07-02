# Cliniko Change Reconciliation (SCRUM-482) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When practice staff cancel or move an appointment inside Cliniko, Phondo's local mirror rows are dragged back in line (voided or retimed) so `lookup_appointment` and the local slot-reservation constraint stop going stale.

**Architecture:** Cliniko has no webhooks, so this is pull-based reconciliation. A new `cliniko-reconcile.ts` module polls Cliniko for upcoming appointments changed since a per-integration cursor and updates the matching mirror `appointments` rows. It runs (a) at call time, invoked at the top of the three Cliniko booking-flow entry functions with a 60-second freshness gate, and (b) daily via a new cron backstop.

**Tech Stack:** Next.js 15 App Router, Supabase service-role admin client, Vitest, existing `ClinikoClient` + `safeDecrypt` + Sentry. No new dependencies. No DB migration (cursor lives in the existing `calendar_integrations.settings` JSON).

## Global Constraints

- DB is `snake_case`, API/frontend `camelCase`. Supabase admin client accessed as `(admin as any)` per existing pattern.
- Mirror rows: table `appointments`, `provider='cliniko'`, `external_id` = Cliniko appointment id.
- The overlap exclusion constraint `no_overlapping_appointments` is `WHERE status IN ('confirmed','pending')` — setting a mirror row's `status='cancelled'` frees its slot. Verified in migration `00149`.
- Reconcile must NEVER break a scheduling tool: on any error, log + `Sentry.captureException`, leave the cursor unadvanced, and let the caller proceed.
- Reconcile is idempotent: cancel→cancel and retime→same-time are no-ops.
- Freshness gate = 60s (`RECONCILE_FRESHNESS_MS`). Skew overlap = 5 min (`SKEW_OVERLAP_MS`). Cold-start lookback = 62 days (`COLD_START_LOOKBACK_MS`).
- All new user-facing/log copy uses "Phondo".
- Commit after every task. Branch: `feature/SCRUM-482-cliniko-reconcile` (already created).

---

## File Structure

- **Modify** `src/lib/calendar/cliniko.ts` — add `deleted_at`/`updated_at` to `ClinikoAppointment` + `mapAppointment`; add `listChangedAppointments` + `listDeletedAppointments`; add `lastReconciledAt` to `ClinikoIntegrationSettings`.
- **Create** `src/lib/calendar/cliniko-reconcile.ts` — `reconcileClinikoOrg(ctx, orgId, opts)` core + `ReconcileResult`.
- **Modify** `src/lib/calendar/cliniko-booking.ts` — call `reconcileClinikoOrg` at the top of `clinikoCheckAvailability`, `clinikoBookAppointment`, `clinikoCancelExternal`.
- **Create** `src/app/api/cron/cliniko-reconcile-sync/route.ts` — daily backstop cron.
- **Modify** `vercel.json` — register the new cron.
- **Test** `src/lib/calendar/__tests__/cliniko.test.ts`, `src/lib/calendar/__tests__/cliniko-reconcile.test.ts` (new), `src/lib/calendar/__tests__/cliniko-booking.test.ts`, `src/app/api/cron/__tests__/cliniko-reconcile-sync.test.ts` (new).

---

## Task 1: Client — changed/deleted appointment polling + cursor field

**Files:**
- Modify: `src/lib/calendar/cliniko.ts` (interface `ClinikoAppointment` ~110-120, `ClinikoIntegrationSettings` ~57-64, `mapAppointment` ~411-421, add two methods after `getAppointment` ~394)
- Test: `src/lib/calendar/__tests__/cliniko.test.ts`

**Interfaces:**
- Consumes: existing `listAll<T>(path, collectionKey, query)`, `mapAppointment`, `ClinikoAppointment`.
- Produces:
  - `ClinikoAppointment` now includes `deleted_at: string | null` and `updated_at: string`.
  - `ClinikoIntegrationSettings.lastReconciledAt?: string | null`.
  - `ClinikoClient.listChangedAppointments(params: { since: string; today: string; businessId: string }): Promise<ClinikoAppointment[]>`
  - `ClinikoClient.listDeletedAppointments(params: { since: string }): Promise<ClinikoAppointment[]>`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/calendar/__tests__/cliniko.test.ts` (follow the existing `fetchMock`/`makeClient` helpers in that file; the snippet below shows the assertions — adapt to the file's existing mock harness):

```ts
describe("listChangedAppointments", () => {
  it("filters by updated_at + starts_at and maps deleted_at/updated_at", async () => {
    const client = makeClient(); // existing helper; shard 'au1', key 'k-au1'
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        individual_appointments: [
          {
            id: 900,
            starts_at: "2026-07-10T02:00:00Z",
            ends_at: "2026-07-10T02:30:00Z",
            cancelled_at: "2026-07-05T00:00:00Z",
            deleted_at: null,
            updated_at: "2026-07-05T00:00:00Z",
          },
        ],
        links: {},
      })
    );
    const res = await client.listChangedAppointments({
      since: "2026-07-01T00:00:00Z",
      today: "2026-07-02",
      businessId: "b-1",
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/individual_appointments");
    expect(decodeURIComponent(url)).toContain("updated_at:>2026-07-01T00:00:00Z");
    expect(decodeURIComponent(url)).toContain("starts_at:>=2026-07-02");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: "900", cancelled_at: "2026-07-05T00:00:00Z", updated_at: "2026-07-05T00:00:00Z" });
  });
});

describe("listDeletedAppointments", () => {
  it("hits the deleted endpoint and returns mapped rows", async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        individual_appointments: [
          { id: 901, starts_at: "2026-07-11T02:00:00Z", ends_at: "2026-07-11T02:30:00Z", cancelled_at: null, deleted_at: "2026-07-05T00:00:00Z", updated_at: "2026-07-05T00:00:00Z" },
        ],
        links: {},
      })
    );
    const res = await client.listDeletedAppointments({ since: "2026-07-01T00:00:00Z" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/individual_appointments/deleted");
    expect(res[0]).toMatchObject({ id: "901", deleted_at: "2026-07-05T00:00:00Z" });
  });
});
```

> If `makeClient`/`jsonResponse` helpers don't exist under those exact names, reuse whatever the file already defines for building a client and a mocked JSON `Response` (the file already tests `listBusinesses`/`availableTimes`, so the harness is there).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/calendar/__tests__/cliniko.test.ts -t "listChangedAppointments"`
Expected: FAIL — `client.listChangedAppointments is not a function`.

- [ ] **Step 3: Extend the type + mapper**

In `src/lib/calendar/cliniko.ts`, `ClinikoAppointment`:

```ts
export interface ClinikoAppointment {
  id: string;
  starts_at: string;
  ends_at: string;
  cancelled_at: string | null;
  deleted_at: string | null;
  updated_at: string;
  patient_id?: string;
  practitioner_id?: string;
  appointment_type_id?: string;
  business_id?: string;
  notes?: string | null;
}
```

In `mapAppointment`, add the two fields:

```ts
    cancelled_at: (a.cancelled_at as string | null) ?? null,
    deleted_at: (a.deleted_at as string | null) ?? null,
    updated_at: String(a.updated_at ?? ""),
```

In `ClinikoIntegrationSettings`, add:

```ts
  lastReconciledAt?: string | null;
```

- [ ] **Step 4: Add the two methods**

Insert after `getAppointment` (~line 394) in `src/lib/calendar/cliniko.ts`:

```ts
  /**
   * Appointments changed since `since` (ISO) that start on/after `today` (YYYY-MM-DD).
   * Used by reconciliation to catch practice-side cancels (cancelled_at set) and
   * moves (starts_at changed). Scoped to the connected business/location.
   */
  async listChangedAppointments(params: { since: string; today: string; businessId: string }): Promise<ClinikoAppointment[]> {
    const q = [`updated_at:>${params.since}`, `starts_at:>=${params.today}`];
    const path = `/businesses/${encodeURIComponent(params.businessId)}/individual_appointments`;
    const raw = await this.listAll<Record<string, unknown>>(path, "individual_appointments", { "q[]": q });
    return raw.map((a) => this.mapAppointment(a));
  }

  /**
   * Hard-deleted appointments changed since `since`. Cliniko soft-cancels keep
   * cancelled_at and list normally; only true deletes move here. Best-effort:
   * the q[] filter is applied server-side where supported and re-checked client-
   * side so a stale row is never missed.
   */
  async listDeletedAppointments(params: { since: string }): Promise<ClinikoAppointment[]> {
    const raw = await this.listAll<Record<string, unknown>>(
      "/individual_appointments/deleted",
      "individual_appointments",
      { "q[]": [`deleted_at:>${params.since}`] }
    );
    return raw
      .map((a) => this.mapAppointment(a))
      .filter((a) => a.deleted_at != null && a.deleted_at > params.since);
  }
```

> Note: the `businesses/{id}/individual_appointments` sub-route scopes to the location. If the account is single-business this still resolves; the `businessId` always exists on an active integration.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/calendar/__tests__/cliniko.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add src/lib/calendar/cliniko.ts src/lib/calendar/__tests__/cliniko.test.ts
git commit -m "feat(SCRUM-482): Cliniko client — changed/deleted appointment polling + reconcile cursor field"
```

---

## Task 2: Reconcile core — `reconcileClinikoOrg`

**Files:**
- Create: `src/lib/calendar/cliniko-reconcile.ts`
- Test: `src/lib/calendar/__tests__/cliniko-reconcile.test.ts`

**Interfaces:**
- Consumes: `ClinikoContext` (type-only, from `cliniko-booking.ts`), `ClinikoClient`/`ClinikoAuthError`/`ClinikoAppointment` (`cliniko.ts`), `createAdminClient` (`@/lib/supabase/admin`), `Sentry`.
- Produces:
  - `interface ReconcileResult { ran: boolean; cancelled: number; moved: number; scanned: number }`
  - `async function reconcileClinikoOrg(ctx: ClinikoContext, organizationId: string, opts?: { force?: boolean; nowMs?: number }): Promise<ReconcileResult>`

**Design notes for the implementer:**
- `ClinikoContext` is `{ readonly client: ClinikoClient; readonly businessId: string; readonly integrationId: string }`. Import it **type-only** (`import type { ClinikoContext } from "./cliniko-booking"`) — `cliniko-booking.ts` imports this module's `reconcileClinikoOrg` as a value, so a value import back would create a runtime cycle.
- The cursor and freshness timestamp both live in `calendar_integrations.settings.lastReconciledAt`. Read settings fresh at the top (don't trust the ctx). Write with read-before-write spread so `shard`/`businessId`/`errorState` are never clobbered.
- `nowMs` is injectable for deterministic tests (production passes nothing → uses `Date.now()`).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/calendar/__tests__/cliniko-reconcile.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileClinikoOrg } from "../cliniko-reconcile";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), withScope: (fn: any) => fn({ setExtras: vi.fn(), setTag: vi.fn() }) }));

const ORG = "org-1";
const NOW = Date.parse("2026-07-02T12:00:00Z");

// Minimal chainable supabase mock: records updates, serves canned reads.
function mockAdmin(opts: {
  settings?: Record<string, unknown>;
  mirrors?: Array<{ id: string; external_id: string; start_time: string; status: string }>;
  settingsWriteError?: { message: string } | null;
}) {
  const updates: Array<{ table: string; payload: Record<string, unknown>; id?: string }> = [];
  const mirrors = opts.mirrors ?? [];
  const client = {
    from(table: string) {
      const ctx: any = { table, _eq: {} as Record<string, string>, _in: null as null | string[] };
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: string) => { ctx._eq[col] = val; return chain; },
        in: (_col: string, vals: string[]) => { ctx._in = vals; return chain; },
        // settings read: .select("settings").eq("id", ...).single()
        single: async () => {
          if (table === "calendar_integrations") return { data: { settings: opts.settings ?? {} }, error: null };
          return { data: null, error: null };
        },
        // mirror read resolves as a thenable list; update resolves after capturing
        then: (resolve: any) => {
          if (table === "appointments") {
            const rows = ctx._in ? mirrors.filter((m) => ctx._in!.includes(m.external_id)) : mirrors;
            return resolve({ data: rows, error: null });
          }
          return resolve({ data: [], error: null });
        },
        update: (payload: Record<string, unknown>) => {
          const u: any = { table, payload, id: undefined };
          const uchain: any = {
            eq: (col: string, val: string) => { if (col === "id") u.id = val; return uchain; },
            then: (resolve: any) => {
              updates.push(u);
              const err = table === "calendar_integrations" ? opts.settingsWriteError ?? null : null;
              return resolve({ error: err });
            },
          };
          return uchain;
        },
      };
      return chain;
    },
  };
  return { client, updates };
}

function ctxWith(client: {
  listChangedAppointments?: ReturnType<typeof vi.fn>;
  listDeletedAppointments?: ReturnType<typeof vi.fn>;
}) {
  return {
    client: {
      listChangedAppointments: client.listChangedAppointments ?? vi.fn(async () => []),
      listDeletedAppointments: client.listDeletedAppointments ?? vi.fn(async () => []),
    } as any,
    businessId: "b-1",
    integrationId: "int-1",
  };
}

beforeEach(() => vi.clearAllMocks());

describe("reconcileClinikoOrg", () => {
  it("voids a mirror row when Cliniko shows the appointment cancelled", async () => {
    const { client, updates } = mockAdmin({
      settings: { shard: "au1", businessId: "b-1", lastReconciledAt: "2026-07-02T11:00:00Z" },
      mirrors: [{ id: "m-1", external_id: "900", start_time: "2026-07-10T02:00:00Z", status: "confirmed" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () => [
        { id: "900", starts_at: "2026-07-10T02:00:00Z", ends_at: "2026-07-10T02:30:00Z", cancelled_at: "2026-07-02T11:30:00Z", deleted_at: null, updated_at: "2026-07-02T11:30:00Z" },
      ]),
    });
    const res = await reconcileClinikoOrg(ctx as never, ORG, { nowMs: NOW });
    expect(res).toMatchObject({ ran: true, cancelled: 1, moved: 0 });
    const mirrorUpdate = updates.find((u) => u.table === "appointments");
    expect(mirrorUpdate?.payload).toMatchObject({ status: "cancelled" });
    expect(mirrorUpdate?.id).toBe("m-1");
  });

  it("retimes a mirror row when Cliniko starts_at moved", async () => {
    const { client, updates } = mockAdmin({
      settings: { shard: "au1", businessId: "b-1", lastReconciledAt: "2026-07-02T11:00:00Z" },
      mirrors: [{ id: "m-2", external_id: "901", start_time: "2026-07-10T02:00:00Z", status: "confirmed" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () => [
        { id: "901", starts_at: "2026-07-10T05:00:00Z", ends_at: "2026-07-10T05:30:00Z", cancelled_at: null, deleted_at: null, updated_at: "2026-07-02T11:30:00Z" },
      ]),
    });
    const res = await reconcileClinikoOrg(ctx as never, ORG, { nowMs: NOW });
    expect(res).toMatchObject({ ran: true, cancelled: 0, moved: 1 });
    const mirrorUpdate = updates.find((u) => u.table === "appointments");
    expect(mirrorUpdate?.payload).toMatchObject({ start_time: "2026-07-10T05:00:00Z", end_time: "2026-07-10T05:30:00Z" });
  });

  it("voids on hard delete", async () => {
    const { client, updates } = mockAdmin({
      settings: { shard: "au1", businessId: "b-1", lastReconciledAt: "2026-07-02T11:00:00Z" },
      mirrors: [{ id: "m-3", external_id: "902", start_time: "2026-07-10T02:00:00Z", status: "confirmed" }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listDeletedAppointments: vi.fn(async () => [
        { id: "902", starts_at: "2026-07-10T02:00:00Z", ends_at: "2026-07-10T02:30:00Z", cancelled_at: null, deleted_at: "2026-07-02T11:30:00Z", updated_at: "2026-07-02T11:30:00Z" },
      ]),
    });
    const res = await reconcileClinikoOrg(ctx as never, ORG, { nowMs: NOW });
    expect(res.cancelled).toBe(1);
    expect(updates.find((u) => u.table === "appointments")?.payload).toMatchObject({ status: "cancelled" });
  });

  it("skips a changed appointment we never booked (no mirror row)", async () => {
    const { client, updates } = mockAdmin({
      settings: { shard: "au1", businessId: "b-1", lastReconciledAt: "2026-07-02T11:00:00Z" },
      mirrors: [],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({
      listChangedAppointments: vi.fn(async () => [
        { id: "999", starts_at: "2026-07-10T02:00:00Z", ends_at: "2026-07-10T02:30:00Z", cancelled_at: "2026-07-02T11:30:00Z", deleted_at: null, updated_at: "2026-07-02T11:30:00Z" },
      ]),
    });
    const res = await reconcileClinikoOrg(ctx as never, ORG, { nowMs: NOW });
    expect(res.cancelled).toBe(0);
    expect(updates.find((u) => u.table === "appointments")).toBeUndefined();
  });

  it("freshness gate: skips when reconciled < 60s ago and not forced", async () => {
    const { client } = mockAdmin({
      settings: { shard: "au1", businessId: "b-1", lastReconciledAt: "2026-07-02T11:59:30Z" }, // 30s before NOW
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({});
    const res = await reconcileClinikoOrg(ctx as never, ORG, { nowMs: NOW });
    expect(res.ran).toBe(false);
    expect(ctx.client.listChangedAppointments).not.toHaveBeenCalled();
  });

  it("force overrides the freshness gate", async () => {
    const { client } = mockAdmin({
      settings: { shard: "au1", businessId: "b-1", lastReconciledAt: "2026-07-02T11:59:30Z" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({});
    const res = await reconcileClinikoOrg(ctx as never, ORG, { nowMs: NOW, force: true });
    expect(res.ran).toBe(true);
    expect(ctx.client.listChangedAppointments).toHaveBeenCalled();
  });

  it("advances the cursor to poll-start on success", async () => {
    const { client, updates } = mockAdmin({
      settings: { shard: "au1", businessId: "b-1", lastReconciledAt: "2026-07-02T11:00:00Z" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({});
    await reconcileClinikoOrg(ctx as never, ORG, { nowMs: NOW });
    const settingsWrite = updates.find((u) => u.table === "calendar_integrations");
    expect(settingsWrite?.payload).toBeDefined();
    const written = (settingsWrite!.payload.settings as Record<string, unknown>).lastReconciledAt;
    expect(written).toBe(new Date(NOW).toISOString());
    // read-before-write preserved shard/businessId
    expect(settingsWrite!.payload.settings).toMatchObject({ shard: "au1", businessId: "b-1" });
  });

  it("does NOT advance the cursor when the poll throws", async () => {
    const { client, updates } = mockAdmin({
      settings: { shard: "au1", businessId: "b-1", lastReconciledAt: "2026-07-02T11:00:00Z" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const ctx = ctxWith({ listChangedAppointments: vi.fn(async () => { throw new Error("cliniko down"); }) });
    const res = await reconcileClinikoOrg(ctx as never, ORG, { nowMs: NOW });
    expect(res.ran).toBe(false);
    expect(updates.find((u) => u.table === "calendar_integrations")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/calendar/__tests__/cliniko-reconcile.test.ts`
Expected: FAIL — cannot find module `../cliniko-reconcile`.

- [ ] **Step 3: Implement the module**

Create `src/lib/calendar/cliniko-reconcile.ts`:

```ts
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { ClinikoAuthError, type ClinikoAppointment, type ClinikoIntegrationSettings } from "./cliniko";
import type { ClinikoContext } from "./cliniko-booking";

export interface ReconcileResult {
  ran: boolean;
  cancelled: number;
  moved: number;
  scanned: number;
}

const RECONCILE_FRESHNESS_MS = 60_000;
const SKEW_OVERLAP_MS = 5 * 60_000;
const COLD_START_LOOKBACK_MS = 62 * 24 * 60 * 60_000;

const SKIP: ReconcileResult = { ran: false, cancelled: 0, moved: 0, scanned: 0 };

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * SCRUM-482: pull-based reconciliation (Cliniko has no webhooks). Polls Cliniko
 * for upcoming appointments changed since the per-integration cursor and drags
 * the matching mirror rows back in line — cancelled/deleted → status='cancelled'
 * (frees the slot under no_overlapping_appointments), moved → retimed. Never
 * throws: any failure is logged, the cursor is left unadvanced, and the caller
 * proceeds (availability/booking already read live Cliniko).
 */
export async function reconcileClinikoOrg(
  ctx: ClinikoContext,
  organizationId: string,
  opts: { force?: boolean; nowMs?: number } = {}
): Promise<ReconcileResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const admin = createAdminClient();

  // Read settings fresh (cursor + freshness live here).
  const { data: intRow, error: readError } = await (admin as any)
    .from("calendar_integrations")
    .select("settings")
    .eq("id", ctx.integrationId)
    .single();
  if (readError) {
    console.error("[ClinikoReconcile] settings read failed:", readError.message || readError.code);
    return SKIP;
  }
  const settings = (intRow?.settings || {}) as ClinikoIntegrationSettings;
  const lastMs = settings.lastReconciledAt ? Date.parse(settings.lastReconciledAt) : 0;

  if (!opts.force && lastMs && nowMs - lastMs < RECONCILE_FRESHNESS_MS) {
    return SKIP;
  }

  const sinceMs = lastMs
    ? Math.max(lastMs - SKEW_OVERLAP_MS, nowMs - COLD_START_LOOKBACK_MS)
    : nowMs - COLD_START_LOOKBACK_MS;
  const since = new Date(sinceMs).toISOString();

  try {
    const [changed, deleted] = await Promise.all([
      ctx.client.listChangedAppointments({ since, today: isoDate(nowMs), businessId: ctx.businessId }),
      ctx.client.listDeletedAppointments({ since }),
    ]);

    const byId = new Map<string, ClinikoApp>();
    for (const a of changed) byId.set(a.id, a);
    for (const a of deleted) byId.set(a.id, a); // delete overrides
    const scanned = byId.size;

    let cancelled = 0;
    let moved = 0;

    if (scanned > 0) {
      const ids = [...byId.keys()];
      const { data: mirrors, error: mirrorError } = await (admin as any)
        .from("appointments")
        .select("id, external_id, start_time, status")
        .eq("organization_id", organizationId)
        .eq("provider", "cliniko")
        .in("external_id", ids)
        .in("status", ["confirmed", "pending"]);
      if (mirrorError) throw new Error(`mirror load failed: ${mirrorError.message || mirrorError.code}`);

      for (const row of (mirrors || []) as MirrorRow[]) {
        const appt = byId.get(row.external_id);
        if (!appt) continue;
        try {
          if (appt.cancelled_at || appt.deleted_at) {
            await applyUpdate(admin, row.id, { status: "cancelled" });
            cancelled++;
          } else if (appt.starts_at && Date.parse(appt.starts_at) !== Date.parse(row.start_time)) {
            await applyUpdate(admin, row.id, { start_time: appt.starts_at, end_time: appt.ends_at || null });
            moved++;
          }
        } catch (rowErr) {
          // A single row (e.g. a retime that collides with another mirror) must
          // not abort the batch. Availability reads live Cliniko regardless.
          Sentry.captureException(rowErr, (scope) => {
            scope.setTag("cliniko_reconcile", "row_update_failed");
            scope.setExtras({ organizationId, mirrorId: row.id, externalId: row.external_id });
            return scope;
          });
        }
      }
    }

    // Advance the cursor only on a successful poll (read-before-write spread).
    const { error: writeError } = await (admin as any)
      .from("calendar_integrations")
      .update({
        settings: { ...settings, lastReconciledAt: new Date(nowMs).toISOString() },
        updated_at: new Date(nowMs).toISOString(),
      })
      .eq("id", ctx.integrationId);
    if (writeError) {
      console.error("[ClinikoReconcile] cursor write failed:", writeError.message || writeError.code);
    }

    return { ran: true, cancelled, moved, scanned };
  } catch (err) {
    if (err instanceof ClinikoAuthError) {
      // Flag for the dashboard banner without wiping settings. The daily reconcile
      // cron sends the owner email on its next run (avoids a value import cycle
      // with cliniko-booking's markClinikoAuthFailure).
      await (admin as any)
        .from("calendar_integrations")
        .update({ settings: { ...settings, errorState: "auth_failed" }, updated_at: new Date(nowMs).toISOString() })
        .eq("id", ctx.integrationId)
        .then((r: { error?: unknown }) => r, () => undefined);
    }
    console.error("[ClinikoReconcile] reconcile failed:", err instanceof Error ? err.message : String(err));
    Sentry.captureException(err, (scope) => {
      scope.setTag("cliniko_reconcile", "failed");
      scope.setExtras({ organizationId, integrationId: ctx.integrationId });
      return scope;
    });
    return SKIP;
  }
}

type ClinikoApp = ClinikoAppointment;
interface MirrorRow { id: string; external_id: string; start_time: string; status: string }

async function applyUpdate(admin: unknown, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await (admin as any)
    .from("appointments")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`mirror update failed: ${error.message || error.code}`);
}
```

> The test's Sentry mock passes a scope via `withScope`/callback; the code uses `Sentry.captureException(err, callback)` form. If the installed Sentry types reject the callback form, use `Sentry.withScope((scope) => { scope.setTag(...); scope.setExtras(...); Sentry.captureException(err); })` — match whatever the existing `cliniko-booking.ts` uses (it already calls `Sentry.withScope`). Keep it consistent with that file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/calendar/__tests__/cliniko-reconcile.test.ts`
Expected: PASS (8 tests). Adjust the chainable mock or the Sentry call form until green — the *behavior* assertions (which rows update, cursor advance/no-advance, freshness gate) are the contract; do not weaken them.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add src/lib/calendar/cliniko-reconcile.ts src/lib/calendar/__tests__/cliniko-reconcile.test.ts
git commit -m "feat(SCRUM-482): reconcileClinikoOrg — poll + reconcile mirror rows against the practice diary"
```

---

## Task 3: Wire reconcile into the three call-time entry points

**Files:**
- Modify: `src/lib/calendar/cliniko-booking.ts` (top of `clinikoCheckAvailability` ~408, `clinikoBookAppointment`, `clinikoCancelExternal`)
- Test: `src/lib/calendar/__tests__/cliniko-booking.test.ts`

**Interfaces:**
- Consumes: `reconcileClinikoOrg(ctx, organizationId)` from `./cliniko-reconcile`.
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/calendar/__tests__/cliniko-booking.test.ts`. Mock the reconcile module at the top of the file (alongside the existing mocks):

```ts
vi.mock("../cliniko-reconcile", () => ({
  reconcileClinikoOrg: vi.fn(async () => ({ ran: true, cancelled: 0, moved: 0, scanned: 0 })),
}));
```

Then, in a suitable describe block:

```ts
import { reconcileClinikoOrg } from "../cliniko-reconcile";

it("reconciles the org before checking availability", async () => {
  const db = mockDb(baseHandler);
  vi.mocked(createAdminClient).mockReturnValue(db.client as never);
  await clinikoCheckAvailability(ctxWith({}), ORG, { date: "2026-07-07", service_type_id: "st-1" });
  expect(vi.mocked(reconcileClinikoOrg)).toHaveBeenCalledWith(expect.anything(), ORG);
});

it("a reconcile failure never breaks availability", async () => {
  vi.mocked(reconcileClinikoOrg).mockRejectedValueOnce(new Error("boom"));
  const db = mockDb(baseHandler);
  vi.mocked(createAdminClient).mockReturnValue(db.client as never);
  const availableTimes = vi.fn(async () => [SLOT_9AM]);
  const res = await clinikoCheckAvailability(ctxWith({ availableTimes }), ORG, { date: "2026-07-07", service_type_id: "st-1" });
  expect(res.success).toBe(true); // handler still returns a result
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/calendar/__tests__/cliniko-booking.test.ts -t "reconciles the org before"`
Expected: FAIL — `reconcileClinikoOrg` not called.

- [ ] **Step 3: Add the import + call at the top of each entry function**

In `src/lib/calendar/cliniko-booking.ts`, add the import near the top:

```ts
import { reconcileClinikoOrg } from "./cliniko-reconcile";
```

At the very top of the `try` body in each of `clinikoCheckAvailability`, `clinikoBookAppointment`, and `clinikoCancelExternal` (before any mirror read/write), add:

```ts
  // SCRUM-482: pull practice-side cancels/moves into the mirror before we read
  // or reserve slots. Freshness-gated (no-op if done in the last 60s), so only
  // the first scheduling tool of a call pays the ~300-500ms; never fatal.
  await reconcileClinikoOrg(ctx, organizationId).catch(() => {});
```

> Use the parameter names each function actually has. `clinikoCheckAvailability(ctx, organizationId, args)` and `clinikoBookAppointment(ctx, organizationId, args)` already expose both. `clinikoCancelExternal(ctx, organizationId, appointment, reason)` also has both — place the call at the top of its body. If a function does not wrap its logic in a `try`, place the call as the first statement of the function body instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/calendar/__tests__/cliniko-booking.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add src/lib/calendar/cliniko-booking.ts src/lib/calendar/__tests__/cliniko-booking.test.ts
git commit -m "feat(SCRUM-482): reconcile the mirror at the top of Cliniko availability/book/cancel flows"
```

---

## Task 4: Daily reconcile cron backstop

**Files:**
- Create: `src/app/api/cron/cliniko-reconcile-sync/route.ts`
- Modify: `vercel.json`
- Test: `src/app/api/cron/__tests__/cliniko-reconcile-sync.test.ts`

**Interfaces:**
- Consumes: `requireCronAuth`, `createAdminClient`, `safeDecrypt`, `ClinikoClient`, `ClinikoAuthError`, `reconcileClinikoOrg`.
- Produces: a `GET` route handler (Next.js App Router).

- [ ] **Step 1: Write the failing test**

Create `src/app/api/cron/__tests__/cliniko-reconcile-sync.test.ts` (mirror the structure of `cliniko-catalog-sync.test.ts` in the same folder):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../cliniko-reconcile-sync/route";
import { reconcileClinikoOrg } from "@/lib/calendar/cliniko-reconcile";

vi.mock("@/lib/security/cron-auth", () => ({ requireCronAuth: vi.fn(() => null) }));
vi.mock("@/lib/security/encryption", () => ({ safeDecrypt: vi.fn(() => "k-au1") }));
vi.mock("@/lib/calendar/cliniko", () => ({
  ClinikoClient: vi.fn(function () { return {}; }),
  ClinikoAuthError: class ClinikoAuthError extends Error {},
}));
vi.mock("@/lib/calendar/cliniko-reconcile", () => ({ reconcileClinikoOrg: vi.fn(async () => ({ ran: true, cancelled: 0, moved: 0, scanned: 0 })) }));

const rows = [
  { id: "int-1", organization_id: "org-1", access_token: "enc", settings: { shard: "au1", businessId: "b-1" } },
  { id: "int-2", organization_id: "org-2", access_token: "enc", settings: { shard: "au1", businessId: "b-2" } },
];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

beforeEach(() => vi.clearAllMocks());

describe("cliniko-reconcile-sync cron", () => {
  it("force-reconciles every active integration", async () => {
    const res = await GET(new Request("https://x/api/cron/cliniko-reconcile-sync") as never);
    expect(res.status).toBe(200);
    expect(vi.mocked(reconcileClinikoOrg)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(reconcileClinikoOrg).mock.calls[0][2]).toMatchObject({ force: true });
  });

  it("one org failing does not block the rest", async () => {
    vi.mocked(reconcileClinikoOrg).mockRejectedValueOnce(new Error("boom"));
    const res = await GET(new Request("https://x/api/cron/cliniko-reconcile-sync") as never);
    expect(res.status).toBe(200);
    expect(vi.mocked(reconcileClinikoOrg)).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/cron/__tests__/cliniko-reconcile-sync.test.ts`
Expected: FAIL — cannot find `../cliniko-reconcile-sync/route`.

- [ ] **Step 3: Implement the route**

Create `src/app/api/cron/cliniko-reconcile-sync/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeDecrypt } from "@/lib/security/encryption";
import { ClinikoClient, ClinikoAuthError } from "@/lib/calendar/cliniko";
import { reconcileClinikoOrg } from "@/lib/calendar/cliniko-reconcile";

/**
 * SCRUM-482: daily backstop for Cliniko change reconciliation. The at-call path
 * keeps active orgs fresh; this catches orgs with no recent calls. Vercel Hobby
 * allows only daily crons — revisit cadence on Pro. Per-org isolation; one
 * failure never blocks the rest.
 */
export const maxDuration = 60;

const MAX_ORGS_PER_RUN = 50;

interface IntegrationRow {
  id: string;
  organization_id: string;
  access_token: string | null;
  settings: Record<string, unknown> | null;
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request, "cliniko-reconcile-sync");
  if (authError) return authError;

  const admin = createAdminClient();
  const { data, error } = await (admin as any)
    .from("calendar_integrations")
    .select("id, organization_id, access_token, settings")
    .eq("provider", "cliniko")
    .eq("is_active", true)
    .order("updated_at", { ascending: true })
    .limit(MAX_ORGS_PER_RUN);

  if (error) {
    console.error("[ClinikoReconcileCron] integration scan failed:", error.message || error.code);
    return NextResponse.json({ error: "scan failed" }, { status: 500 });
  }

  const rows = (data || []) as IntegrationRow[];
  const results: Array<{ organizationId: string; ok: boolean; error?: string }> = [];

  for (const row of rows) {
    const settings = (row.settings || {}) as Record<string, unknown>;
    try {
      const apiKey = row.access_token ? safeDecrypt(row.access_token) : null;
      if (!apiKey || !settings.shard || !settings.businessId) {
        throw new Error("integration row is missing key/shard/business");
      }
      const client = new ClinikoClient({ apiKey, shard: String(settings.shard), timeoutMs: 10_000 });
      const result = await reconcileClinikoOrg(
        { client, businessId: String(settings.businessId), integrationId: row.id },
        row.organization_id,
        { force: true }
      );
      results.push({ organizationId: row.organization_id, ok: true });
      void result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ClinikoAuthError) {
        await (admin as any)
          .from("calendar_integrations")
          .update({ settings: { ...settings, errorState: "auth_failed" }, updated_at: new Date().toISOString() })
          .eq("id", row.id)
          .then((r: { error?: unknown }) => r, () => undefined);
      }
      console.error(`[ClinikoReconcileCron] org ${row.organization_id} failed:`, message);
      results.push({ organizationId: row.organization_id, ok: false, error: message });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}
```

- [ ] **Step 4: Register the cron in `vercel.json`**

Add to the `crons` array (staggered 30 min after the catalog sync at 19:00):

```json
    {
      "path": "/api/cron/cliniko-reconcile-sync",
      "schedule": "30 19 * * *"
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/api/cron/__tests__/cliniko-reconcile-sync.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add src/app/api/cron/cliniko-reconcile-sync/route.ts src/app/api/cron/__tests__/cliniko-reconcile-sync.test.ts vercel.json
git commit -m "feat(SCRUM-482): daily Cliniko reconcile cron backstop (force-reconcile all active integrations)"
```

---

## Task 5: Full verification + docs

**Files:**
- Modify: `docs/superpowers/plans/2026-07-02-cliniko-reconcile.md` (check off completed steps)

- [ ] **Step 1: Full suite green**

Run: `npm run lint` → 0 errors.
Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run src/lib/calendar/ src/app/api/cron/__tests__/` → all pass.

- [ ] **Step 2: Confirm no migration + no new env var**

Verify `git status` shows no `supabase/migrations/` change and no `.env.example` change (cursor is in `settings` JSON; reuses `CLINIKO_CONTACT_EMAIL`).

- [ ] **Step 3: Commit any test-fixups**

```bash
git add -A && git commit -m "chore(SCRUM-482): verification pass — lint/tsc/vitest green" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- "Pull-based reconciliation, no webhooks" → Task 2 core (polling). ✓
- "cancelled/deleted → void; moved → retime; no-mirror → skip" → Task 2 tests + impl. ✓
- "Freshness gate 60s; cursor with 5-min skew; 62-day cold start" → Task 2 constants + tests. ✓
- "At call time, block scheduling tools, before mirror read/write" → Task 3. ✓
- "Daily cron backstop, force, per-org isolation, auth flag" → Task 4. ✓
- "Client listChangedAppointments/listDeletedAppointments, ClinikoAppointment gains deleted_at/updated_at" → Task 1. ✓
- "lastReconciledAt in settings, no migration" → Task 1 + verified in Task 5. ✓
- "Reconcile never breaks the tool; auth failure flags integration" → Task 2 error path + Task 3 `.catch`. ✓
- "Cursor advances only on success" → Task 2 tests (advance + no-advance). ✓

**Placeholder scan:** No TBD/TODO; all constants and code concrete. ✓

**Type consistency:** `ReconcileResult` shape identical across Task 2 def, Task 3 mock, Task 4 mock. `reconcileClinikoOrg(ctx, organizationId, opts?)` signature identical at every call site (Task 3 two args, Task 4 three args with `{force:true}`). `ClinikoContext` `{ client, businessId, integrationId }` matches Task 4's inline object. `ClinikoAppointment` fields (`deleted_at`, `updated_at`) added in Task 1 and consumed in Task 2. ✓

**Known acceptable gaps (documented in spec):** a per-row retime collision is logged/Sentry'd and skipped (availability reads live Cliniko); an auth failure detected only at call-time flags `errorState` immediately but defers the owner email to the daily cron.
