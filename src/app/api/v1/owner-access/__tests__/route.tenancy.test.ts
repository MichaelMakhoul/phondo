import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tenancy and secrecy for the owner line route (SCRUM-585). route.test.ts
 * answers every read with one canned row whatever filter it was given, so it
 * cannot show a filter doing its job. Here the admin client is a tiny
 * in-memory `owner_access` TABLE with real .eq() filtering, PostgREST's
 * one-row rules for maybeSingle()/single(), a UNIQUE(organization_id)
 * constraint, NOT NULL / CHECK enforcement on insert, ON CONFLICT merge and
 * column projection from .select(). Two orgs live in it side by side, so a
 * dropped filter, a body-supplied org, a missing onConflict or a wider select
 * changes the outcome.
 *
 * Covers:
 *   - org-1's owner never sees or touches org-2's line, on any verb
 *   - the first-save race converges through ON CONFLICT (organization_id)
 *   - a PIN save rotates salt and hash (PR C keys its lockout buckets by the
 *     salt prefix, so "saving a new PIN unlocks it" depends on that); saves
 *     without a PIN leave them byte-identical
 *   - no response and no console output, on any path, contains a PIN, the
 *     stored hash or salt, or a failing row's details
 */

type Row = {
  id: string;
  organization_id: string;
  phone_e164: string;
  pin_hash: string;
  pin_salt: string;
  pin_length: number;
  enabled: boolean;
  last_verified_at: string | null;
  created_by: string | null;
  updated_at: string;
};

const world = vi.hoisted(() => ({
  rows: [] as any[],
  seq: 0,
  staleReadOnce: false,
  users: {
    "owner-1": { organization_id: "org-1", role: "owner" },
    "admin-1": { organization_id: "org-1", role: "admin" },
    "owner-2": { organization_id: "org-2", role: "owner" },
  } as Record<string, { organization_id: string; role: string }>,
  orgCountry: { "org-1": "AU", "org-2": "US" } as Record<string, string>,
  currentUser: "owner-1",
  failWrites: null as null | { code: string; message: string },
  failReads: null as null | { code: string; message: string },
  limited: false,
  throwCountry: null as unknown,
}));

vi.mock("@/lib/feature-flags", () => ({ isOwnerAssistantUiEnabled: () => true }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: !world.limited, headers: { "Retry-After": "60" } })),
}));
vi.mock("@/lib/auth/membership", () => ({
  // Keyed on the user id the route passes, like the real org_members lookup.
  getPrimaryMembership: vi.fn(async (_c: unknown, userId: string) => world.users[userId] ?? null),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: world.currentUser } } }) },
    // organizations.country by id — the id the route asks about matters.
    from: () => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          single: async () => {
            if (world.throwCountry) throw world.throwCountry;
            return id in world.orgCountry
              ? { data: { country: world.orgCountry[id] }, error: null }
              : { data: null, error: { message: "no such org" } };
          },
        }),
      }),
    }),
  })),
}));

const E164 = /^\+[1-9][0-9]{7,14}$/;
function checkRow(r: Partial<Row>) {
  for (const c of ["organization_id", "phone_e164", "pin_hash", "pin_salt", "pin_length"] as const) {
    if (r[c] === undefined || r[c] === null) return { code: "23502", message: `null value in column "${c}"` };
  }
  if (!E164.test(r.phone_e164!)) return { code: "23514", message: "phone check" };
  if (!/^[0-9a-f]{64}$/.test(r.pin_hash!)) return { code: "23514", message: "pin_hash check" };
  if (!/^[0-9a-f]{32}$/.test(r.pin_salt!)) return { code: "23514", message: "pin_salt check" };
  if (!(r.pin_length! >= 4 && r.pin_length! <= 8)) return { code: "23514", message: "pin_length check" };
  return null;
}
const project = (row: any, cols: string) => {
  if (cols.trim() === "*") return { ...row };
  const out: Record<string, unknown> = {};
  for (const c of cols.split(",").map((s) => s.trim())) out[c] = row[c];
  return out;
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "owner_access") throw new Error(`unexpected table ${table}`);
      let op: "select" | "update" | "delete" | "upsert" = "select";
      let patch: any;
      let upsertRow: any;
      let onConflict: string | undefined;
      let cols = "*";
      const filters: [string, unknown][] = [];
      const matched = () => world.rows.filter((r) => filters.every(([c, v]) => r[c] === v));
      const oneRow = (rows: any[], allowNone: boolean) => {
        if (rows.length === 0 && allowNone) return { data: null, error: null };
        if (rows.length !== 1) return { data: null, error: { code: "PGRST116", message: `The result contains ${rows.length} rows` } };
        return { data: project(rows[0], cols), error: null };
      };
      const run = (allowNone: boolean) => {
        if (op === "select" && world.failReads) {
          // Reads select only public columns, but no error is ever logged raw: any stage's
          // `details` could carry a row, so the fake makes every failure look like the worst case.
          return { data: null, error: { ...world.failReads, details: "Failing row contains (pin_hash, pin_salt)" } };
        }
        if ((op === "update" || op === "upsert") && world.failWrites) {
          return { data: null, error: { ...world.failWrites, details: `Failing row contains (${JSON.stringify(op === "update" ? patch : upsertRow)})` } };
        }
        if (op === "select") {
          const stale = world.staleReadOnce;
          world.staleReadOnce = false;
          return oneRow(stale ? [] : matched(), allowNone);
        }
        if (op === "update") {
          const rows = matched();
          // .single() needs exactly one row; PostgREST rolls the UPDATE back otherwise.
          if (rows.length !== 1) return oneRow(rows, false);
          const bad = checkRow({ ...rows[0], ...patch });
          if (bad) return { data: null, error: bad };
          Object.assign(rows[0], patch, { updated_at: "now" });
          return oneRow(rows, false);
        }
        if (op === "upsert") {
          const existing = onConflict === "organization_id" ? world.rows.find((r) => r.organization_id === upsertRow.organization_id) : undefined;
          if (existing) {
            const next = { ...existing, ...upsertRow };
            const bad = checkRow(next);
            if (bad) return { data: null, error: bad };
            Object.assign(existing, upsertRow, { updated_at: "now" });
            return oneRow([existing], false);
          }
          const fresh = { id: `row-${++world.seq}`, enabled: true, last_verified_at: null, created_by: null, updated_at: "now", ...upsertRow };
          const bad = checkRow(fresh);
          if (bad) return { data: null, error: bad };
          if (world.rows.some((r) => r.organization_id === fresh.organization_id)) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          world.rows.push(fresh);
          return oneRow([fresh], false);
        }
        return { data: null, error: null };
      };
      const b: any = {
        select: (c: string) => {
          cols = c;
          return b;
        },
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return b;
        },
        update: (p: any) => {
          op = "update";
          patch = p;
          return b;
        },
        upsert: (row: any, opts?: { onConflict?: string }) => {
          op = "upsert";
          upsertRow = row;
          onConflict = opts?.onConflict;
          return b;
        },
        delete: () => {
          op = "delete";
          return b;
        },
        maybeSingle: async () => run(true),
        single: async () => run(false),
        // awaiting a delete chain (no .single()) executes it
        then: (resolve: (v: unknown) => void) => {
          if (op === "delete" && world.failWrites) return resolve({ error: { ...world.failWrites, details: "Failing row contains (pin_hash, pin_salt)" } });
          if (op === "delete") {
            const doomed = matched();
            world.rows = world.rows.filter((r) => !doomed.includes(r));
            return resolve({ error: null });
          }
          return resolve({ data: null, error: null });
        },
      };
      return b;
    },
  }),
}));

import { GET, PUT, DELETE } from "@/app/api/v1/owner-access/route";
import { verifyPin } from "@/lib/owner-assistant/pin";

const H = "a".repeat(64);
const S = "b".repeat(32);
const row = (org: string, over: Partial<Row> = {}): Row => ({
  id: `seed-${org}`,
  organization_id: org,
  phone_e164: org === "org-1" ? "+61412345678" : "+14155551234",
  pin_hash: H,
  pin_salt: S,
  pin_length: org === "org-1" ? 6 : 4,
  enabled: true,
  last_verified_at: null,
  created_by: null,
  updated_at: "seed",
  ...over,
});
const put = (body: unknown) =>
  PUT(new Request("http://localhost/api/v1/owner-access", { method: "PUT", body: JSON.stringify(body) }));
const snapshot = (org: string) => JSON.parse(JSON.stringify(world.rows.find((r) => r.organization_id === org) ?? null));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  world.rows = [];
  world.seq = 0;
  world.staleReadOnce = false;
  world.currentUser = "owner-1";
  world.failWrites = null;
  world.failReads = null;
  world.limited = false;
  world.throwCountry = null;
});

describe("tenancy: org-1's owner never sees or touches org-2's line", () => {
  it("GET: org-2 has a line, org-1 has none -> configured:false", async () => {
    world.rows = [row("org-2")];
    const res = await GET();
    expect(await res.json()).toEqual({ configured: false });
  });

  it("PUT {}: does not echo org-2's line back (a pre-read without the org filter would)", async () => {
    world.rows = [row("org-2")];
    const res = await put({});
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("+14155551234");
  });

  it("first save for org-1 while org-2 is configured: creates org-1's row, leaves org-2 byte-identical", async () => {
    world.rows = [row("org-2")];
    const before = snapshot("org-2");
    const res = await put({ phone: "0412 345 678", pin: "9753" });
    expect(res.status).toBe(200);
    expect(world.rows).toHaveLength(2);
    expect(snapshot("org-2")).toEqual(before);
    const mine = world.rows.find((r) => r.organization_id === "org-1");
    expect(verifyPin("9753", mine.pin_salt, mine.pin_hash)).toBe(true);
  });

  it("both configured: GET, patch, new PIN and DELETE only ever move org-1's row", async () => {
    world.rows = [row("org-1"), row("org-2")];
    const org2 = snapshot("org-2");

    expect((await (await GET()).json()).phoneE164).toBe("+61412345678");

    expect((await put({ enabled: false })).status).toBe(200);
    expect(world.rows.find((r) => r.organization_id === "org-1").enabled).toBe(false);

    expect((await put({})).status).toBe(200); // no-op patch returns org-1's own row
    expect((await put({ pin: "40271958" })).status).toBe(200);
    expect(snapshot("org-2")).toEqual(org2);

    expect((await DELETE()).status).toBe(204);
    expect(world.rows.map((r) => r.organization_id)).toEqual(["org-2"]);
    expect(snapshot("org-2")).toEqual(org2);
  });

  it("a body-supplied organization_id is ignored on an existing row too (update path)", async () => {
    world.rows = [row("org-1"), row("org-2")];
    const org2 = snapshot("org-2");
    const res = await put({ enabled: false, organization_id: "org-2" });
    expect(res.status).toBe(200);
    expect(world.rows.find((r) => r.organization_id === "org-1").enabled).toBe(false);
    expect(snapshot("org-2")).toEqual(org2);
  });

  it("the phone is validated against the CALLER's org country, not another org's", async () => {
    world.rows = [];
    // org-1 is AU: a US-formatted number must be refused even though org-2 is US.
    const bad = await put({ phone: "415-555-1234", pin: "9753" });
    expect(bad.status).toBe(400);
    world.currentUser = "owner-2";
    const ok = await put({ phone: "415-555-1234", pin: "9753" });
    expect(ok.status).toBe(200);
  });

  it("an admin of org-1 is refused on every verb and nothing changes", async () => {
    world.rows = [row("org-1")];
    const before = snapshot("org-1");
    world.currentUser = "admin-1";
    expect((await GET()).status).toBe(403);
    expect((await put({ enabled: false })).status).toBe(403);
    expect((await DELETE()).status).toBe(403);
    expect(snapshot("org-1")).toEqual(before);
  });
});

describe("first-save race: the pre-read saw no row but one landed before the write", () => {
  it("converges on one row (needs ON CONFLICT (organization_id)) instead of failing with a unique violation", async () => {
    world.rows = [row("org-1", { phone_e164: "+61400000000" })];
    world.staleReadOnce = true; // pre-read misses the row a concurrent request just created
    const res = await put({ phone: "0412 345 678", pin: "9753" });
    expect(res.status).toBe(200);
    expect(world.rows.filter((r) => r.organization_id === "org-1")).toHaveLength(1);
    expect(world.rows.find((r) => r.organization_id === "org-1").phone_e164).toBe("+61412345678");
  });
});

describe("salt rotation on an existing line (what makes 'saving a new PIN unlocks it' true)", () => {
  it("rotates salt AND hash on every PIN save, even when the PIN is re-entered unchanged", async () => {
    world.rows = [row("org-1")];
    const salts = new Set<string>([world.rows[0].pin_salt]);
    const hashes = new Set<string>([world.rows[0].pin_hash]);
    for (let i = 0; i < 3; i++) {
      expect((await put({ pin: "9753" })).status).toBe(200);
      const r = world.rows[0];
      salts.add(r.pin_salt);
      hashes.add(r.pin_hash);
      expect(verifyPin("9753", r.pin_salt, r.pin_hash)).toBe(true);
    }
    expect(salts.size).toBe(4);
    expect(hashes.size).toBe(4);
    // PR C's lockout buckets are keyed owner-pin:<org>:<first 8 salt chars>, so
    // the prefix itself must change with every save for the old counters to be dropped.
    expect(new Set([...salts].map((salt) => salt.slice(0, 8))).size).toBe(4);
  });

  it("leaves salt and hash alone when no PIN is sent", async () => {
    world.rows = [row("org-1")];
    for (const body of [{ enabled: false }, { phone: "0499 111 222" }, { phone: "0499 111 222", enabled: true }]) {
      expect((await put(body)).status).toBe(200);
      expect(world.rows[0].pin_salt).toBe(S);
      expect(world.rows[0].pin_hash).toBe(H);
    }
  });
});

describe("secrets never leave: every response body and every console method, every path", () => {
  const SECRET_PINS = ["9753", "40271958", "805214", "0000"];
  let sink: string[];
  beforeEach(() => {
    sink = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        sink.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v)));
      });
    }
  });

  const cases: [string, () => Promise<Response>, () => void][] = [
    ["first save ok", () => put({ phone: "0412 345 678", pin: "9753" }), () => {}],
    ["new PIN on existing ok", () => put({ pin: "40271958" }), () => (world.rows = [row("org-1")])],
    ["enabled-only patch ok", () => put({ enabled: false }), () => (world.rows = [row("org-1")])],
    ["no-op patch ok", () => put({}), () => (world.rows = [row("org-1")])],
    ["weak PIN 400", () => put({ phone: "0412 345 678", pin: "0000" }), () => {}],
    ["malformed PIN 400", () => put({ phone: "0412 345 678", pin: "805214a" }), () => {}],
    ["numeric PIN 400", () => put({ phone: "0412 345 678", pin: 9753 }), () => {}],
    ["bad phone 400 with a PIN", () => put({ phone: "12", pin: "9753" }), () => {}],
    ["first-save write fails 500", () => put({ phone: "0412 345 678", pin: "9753" }), () => (world.failWrites = { code: "23514", message: "check violation" })],
    ["update write fails 500", () => put({ pin: "40271958" }), () => { world.rows = [row("org-1")]; world.failWrites = { code: "57014", message: "timeout" }; }],
    ["pre-save read fails 500", () => put({ phone: "0412 345 678", pin: "9753" }), () => (world.failReads = { code: "57014", message: "timeout" })],
    ["GET ok", () => GET(), () => (world.rows = [row("org-1")])],
    ["GET read fails 500", () => GET(), () => (world.failReads = { code: "57014", message: "timeout" })],
    ["delete fails 500", () => DELETE(), () => { world.rows = [row("org-1")]; world.failWrites = { code: "57014", message: "timeout" }; }],
    ["rate limited 429", () => put({ phone: "0412 345 678", pin: "9753" }), () => (world.limited = true)],
    ["country lookup throws 500", () => put({ phone: "0412 345 678", pin: "9753" }), () => (world.throwCountry = new Error("boom"))],
  ];

  it.each(cases)("%s", async (_label, call, arrange) => {
    arrange();
    const res = await call();
    const text = res.status === 204 ? "" : await res.text();
    const stored = world.rows.flatMap((r) => [r.pin_hash, r.pin_salt]);
    for (const secret of [...SECRET_PINS, ...stored, "Failing row", "pin_hash", "pin_salt"]) {
      expect(text, `response leaks ${secret}`).not.toContain(secret);
      expect(sink.join("\n"), `console leaks ${secret}`).not.toContain(secret);
    }
  });
});
