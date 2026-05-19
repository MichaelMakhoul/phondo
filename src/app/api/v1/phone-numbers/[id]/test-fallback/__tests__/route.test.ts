import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/nextjs";

// ──────────────────────────────────────────────────────────────────────────
// Module mocks. Vitest hoists these above all `import` statements, so the
// route under test sees the mocked clients on its first require.
//
// Note on test isolation: the `*State` singletons below are module-level
// mutables that beforeEach() resets to known defaults. Vitest serializes
// tests in a single file by default; do NOT enable `test.concurrent` for
// this file — concurrent runs would race on these globals.
// ──────────────────────────────────────────────────────────────────────────

interface EqCall {
  col: string;
  val: unknown;
}

/** Per-table accumulator so tests can assert which filters the route applied. */
interface TableQuery {
  selects: string[];
  eqs: EqCall[];
}

const supabaseState: {
  user: { id: string } | null;
  // phone_numbers row, optionally keyed by id+orgId for multi-row scenarios
  phoneRow: any;
  phoneError: any;
  // org_members result — also a function so tests can return DIFFERENT rows
  // based on the filters the route applied (org_id, user_id). This is how
  // the SCRUM-276 regression test verifies the route really scopes by
  // organization_id, not just by user_id.
  roleResolver: (eqs: EqCall[]) => { data: any; error: any };
  // Per-table query log so tests can assert the route's filter shape.
  queries: Record<string, TableQuery>;
} = {
  user: null,
  phoneRow: null,
  phoneError: null,
  roleResolver: () => ({ data: null, error: null }),
  queries: {},
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: supabaseState.user }, error: null })),
    },
    from: (table: string) => {
      // Record per-table chain calls so assertions can verify the actual
      // .select()/.eq() shape the route used. This catches regressions
      // (e.g., SCRUM-276) where a critical filter is dropped.
      if (!supabaseState.queries[table]) {
        supabaseState.queries[table] = { selects: [], eqs: [] };
      }
      const tableQuery = supabaseState.queries[table];
      const chain: any = {
        select: (s: string) => {
          tableQuery.selects.push(s);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          tableQuery.eqs.push({ col, val });
          return chain;
        },
        single: async () => {
          if (table === "phone_numbers") {
            return { data: supabaseState.phoneRow, error: supabaseState.phoneError };
          }
          if (table === "org_members") {
            return supabaseState.roleResolver(tableQuery.eqs);
          }
          return { data: null, error: { message: `unexpected table ${table}` } };
        },
      };
      return chain;
    },
  })),
}));

// Twilio client mock — toggle shouldThrow / nextSid per test.
const twilioState: { shouldThrow: Error | null; nextSid: string } = {
  shouldThrow: null,
  nextSid: "CA_TEST_SID",
};
const twilioCreate = vi.fn(async () => {
  if (twilioState.shouldThrow) throw twilioState.shouldThrow;
  return { sid: twilioState.nextSid };
});
vi.mock("@/lib/twilio/client", () => ({
  getTwilioClient: vi.fn(() => ({
    calls: { create: twilioCreate },
  })),
}));

// Rate-limiter mock — track call args so tests can verify the per-org key.
const rateLimitState: { allowed: boolean } = { allowed: true };
const rateLimitMock = vi.fn(() => ({
  allowed: rateLimitState.allowed,
  headers: { "Retry-After": "60" },
}));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimit: rateLimitMock,
}));

vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: any) => void) =>
    fn({
      setTag: vi.fn(),
      setLevel: vi.fn(),
      setExtras: vi.fn(),
    }),
  ),
  captureException: vi.fn(),
}));

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function makeParams(id = "ph-1") {
  return { params: Promise.resolve({ id }) };
}

function makePhoneRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ph-1",
    phone_number: "+14155551234",
    fallback_forward_number: "+14155559999",
    twilio_sid: "TW_SID_123",
    source_type: "purchased",
    organization_id: "org-1",
    organizations: { country: "US" },
    ...overrides,
  };
}

/** Default role resolver: returns the configured row regardless of filters. */
function staticRoleRow(role: string | null): (eqs: EqCall[]) => { data: any; error: any } {
  return () => ({ data: { role }, error: null });
}

/** Resolver that returns role ONLY when the route filters by the expected
 *  (user_id, organization_id) pair. Lets the SCRUM-276 regression test
 *  catch a real `.eq()` drop. */
function orgScopedRoleRow(
  expectedUserId: string,
  expectedOrgId: string,
  role: string,
): (eqs: EqCall[]) => { data: any; error: any } {
  return (eqs) => {
    const userFiltered = eqs.some((e) => e.col === "user_id" && e.val === expectedUserId);
    const orgFiltered = eqs.some((e) => e.col === "organization_id" && e.val === expectedOrgId);
    if (userFiltered && orgFiltered) {
      return { data: { role }, error: null };
    }
    // Filters missing → simulate "no row" — same as if the user is not a
    // member of this org. A regression that drops the org_id filter would
    // hit this branch and the test would 404 (wrong outcome vs. expected 200).
    return { data: null, error: { code: "PGRST116", message: "no rows" } };
  };
}

async function callRoute(id = "ph-1") {
  const { POST } = await import("../route");
  return POST(new Request("http://localhost/test"), makeParams(id));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults: authenticated admin, phone-number found, no Twilio
  // failure, rate-limit not exhausted. Role resolver returns admin for
  // any filter shape — individual tests override with orgScopedRoleRow
  // when filter-shape assertions matter.
  supabaseState.user = { id: "user-1" };
  supabaseState.phoneRow = makePhoneRow();
  supabaseState.phoneError = null;
  supabaseState.roleResolver = staticRoleRow("admin");
  supabaseState.queries = {};
  twilioState.shouldThrow = null;
  twilioState.nextSid = "CA_TEST_SID";
  rateLimitState.allowed = true;
});

// ──────────────────────────────────────────────────────────────────────────
// Auth gates
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/phone-numbers/[id]/test-fallback — auth gates", () => {
  it("401 when not authenticated", async () => {
    supabaseState.user = null;
    const res = await callRoute();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("403 when authenticated but not org admin (e.g., role=viewer)", async () => {
    supabaseState.roleResolver = staticRoleRow("viewer");
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("403 when role is null (membership exists with no role)", async () => {
    supabaseState.roleResolver = staticRoleRow(null);
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(twilioCreate).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Resource gates
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/phone-numbers/[id]/test-fallback — resource gates", () => {
  it("404 when phone-number row not found (RLS hides or wrong id)", async () => {
    supabaseState.phoneRow = null;
    supabaseState.phoneError = { code: "PGRST116", message: "no rows" };
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it("404 when role lookup returns null after a successful row load (RLS-hole defense)", async () => {
    // Row found (so user has SOME access via RLS) but role lookup returns
    // null. Defense-in-depth: don't leak existence of the resource.
    supabaseState.roleResolver = () => ({ data: null, error: { code: "PGRST116", message: "no rows" } });
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("404 for cross-org admin (admin in org-B but resource is in org-A)", async () => {
    // SCRUM-276 contract: user is admin in org-B, but the phone number's
    // org_id is org-1. The role lookup is scoped by row.organization_id,
    // so it returns "no row" → 404. Verifies the role lookup actually
    // uses the resource's org, not whichever org the user happens to be in.
    supabaseState.roleResolver = orgScopedRoleRow("user-1", "org-B", "admin");
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(twilioCreate).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Validation gates
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/phone-numbers/[id]/test-fallback — validation", () => {
  it("400 when no fallback saved (empty string)", async () => {
    supabaseState.phoneRow = makePhoneRow({ fallback_forward_number: "" });
    const res = await callRoute();
    expect(res.status).toBe(400);
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("400 when no fallback saved (null)", async () => {
    supabaseState.phoneRow = makePhoneRow({ fallback_forward_number: null });
    const res = await callRoute();
    expect(res.status).toBe(400);
  });

  it("400 when saved fallback is whitespace only (trim → empty)", async () => {
    supabaseState.phoneRow = makePhoneRow({ fallback_forward_number: "   " });
    const res = await callRoute();
    expect(res.status).toBe(400);
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("400 when saved fallback is malformed E.164", async () => {
    // Defense-in-depth: PATCH validates writes, but a stale row could have
    // a bad value that should be rejected at dial time.
    supabaseState.phoneRow = makePhoneRow({ fallback_forward_number: "not-a-number" });
    const res = await callRoute();
    expect(res.status).toBe(400);
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("400 when fallback === own phone_number (self-dial)", async () => {
    supabaseState.phoneRow = makePhoneRow({
      phone_number: "+14155551234",
      fallback_forward_number: "+14155551234",
    });
    const res = await callRoute();
    expect(res.status).toBe(400);
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("400 with carrier-specific message for Telnyx (no twilio_sid)", async () => {
    supabaseState.phoneRow = makePhoneRow({ twilio_sid: null, source_type: "purchased" });
    const res = await callRoute();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/carrier/i);
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("400 with forwarded-specific message when source_type=forwarded and no twilio_sid", async () => {
    supabaseState.phoneRow = makePhoneRow({ twilio_sid: null, source_type: "forwarded" });
    const res = await callRoute();
    expect(res.status).toBe(400);
    const body = await res.json();
    // Distinguishes the forwarded carrier case from the generic Telnyx case.
    expect(body.error).toMatch(/forwarded/i);
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("400 on cross-country (US org dialing AU number)", async () => {
    supabaseState.phoneRow = makePhoneRow({
      organizations: { country: "US" },
      fallback_forward_number: "+61412345678", // AU number for US org
    });
    const res = await callRoute();
    expect(res.status).toBe(400);
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("400 on unknown org country (helper returns null prefix)", async () => {
    supabaseState.phoneRow = makePhoneRow({
      organizations: { country: "ZZ" }, // not in expectedE164PrefixForCountry map
    });
    const res = await callRoute();
    expect(res.status).toBe(400);
    expect(twilioCreate).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Rate limit + ordering
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/phone-numbers/[id]/test-fallback — rate limit", () => {
  it("429 when the per-org rate limit is exhausted", async () => {
    rateLimitState.allowed = false;
    const res = await callRoute();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("rate-limit keyed on resource's org (verifies SCRUM-268 ordering: limit AFTER row+role checks)", async () => {
    // Combine rate-limit-exhausted with NO user. Auth check must fire
    // BEFORE the rate-limit check, so the response should be 401 — proving
    // the limiter doesn't run before auth.
    rateLimitState.allowed = false;
    supabaseState.user = null;
    const res = await callRoute();
    expect(res.status).toBe(401);
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("rate-limit keyed on row.organization_id (not membership) — SCRUM-268 contract", async () => {
    supabaseState.phoneRow = makePhoneRow({ organization_id: "org-xyz" });
    rateLimitState.allowed = true;
    await callRoute();
    expect(rateLimitMock).toHaveBeenCalled();
    const args = (rateLimitMock.mock.calls as any[][])[0];
    // Identifier is the FIRST positional arg
    expect(args[0]).toBe("org-xyz");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Twilio integration
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/phone-numbers/[id]/test-fallback — Twilio integration", () => {
  it("502 + Sentry capture when Twilio.calls.create throws", async () => {
    const twErr = new Error("insufficient balance");
    twilioState.shouldThrow = twErr;
    const res = await callRoute();
    expect(res.status).toBe(502);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(twErr);
  });

  it("200 happy path returns { ok: true, callSid } with non-empty sid", async () => {
    twilioState.nextSid = "CA_HAPPY_PATH";
    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.callSid).toBe("CA_HAPPY_PATH");
    // Defense against a future regression where the route accidentally
    // returns an empty/undefined sid (would surface as `body.callSid`
    // missing or empty string).
    expect(typeof body.callSid).toBe("string");
    expect(body.callSid.length).toBeGreaterThan(0);
  });

  it("Twilio call args: from = phone_number, to = fallback, timeLimit caps cost", async () => {
    await callRoute();
    expect(twilioCreate).toHaveBeenCalledTimes(1);
    const args = (twilioCreate.mock.calls as any[][])[0][0];
    expect(args.from).toBe("+14155551234");
    expect(args.to).toBe("+14155559999");
    // Hard-cap on call duration so a runaway dial cannot rack up cost.
    // Lock the exact value — bumping this is a product decision worth
    // catching in a test, not a silent line edit.
    expect(args.timeLimit).toBe(10);
    expect(args.twiml).toContain("<Say");
    expect(args.twiml).toContain("<Hangup");
    // <Say> must come before <Hangup/> for the message to actually play
    expect(args.twiml.indexOf("<Say")).toBeLessThan(args.twiml.indexOf("<Hangup"));
  });

  it("happy path does NOT page Sentry", async () => {
    await callRoute();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Multi-org regression (SCRUM-276 lock-in)
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/phone-numbers/[id]/test-fallback — multi-org regression", () => {
  it("succeeds when role resolver requires BOTH user_id AND organization_id filters", async () => {
    // This is the SCRUM-276 lock-in. The resolver only returns admin when
    // the route applies BOTH `.eq("user_id", "user-1")` AND
    // `.eq("organization_id", "org-1")`. If a future regression drops the
    // org-id filter, the resolver returns "no row" → 404, and this test
    // fails. The earlier "static role resolver" tests would NOT catch that.
    supabaseState.roleResolver = orgScopedRoleRow("user-1", "org-1", "owner");
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(twilioCreate).toHaveBeenCalled();
  });

  it("queries org_members with BOTH user_id AND organization_id (filter shape lock-in)", async () => {
    await callRoute();
    const orgQuery = supabaseState.queries.org_members;
    expect(orgQuery).toBeDefined();
    const userEq = orgQuery.eqs.find((e) => e.col === "user_id");
    const orgEq = orgQuery.eqs.find((e) => e.col === "organization_id");
    expect(userEq?.val).toBe("user-1");
    expect(orgEq?.val).toBe("org-1");
  });

  it("queries phone_numbers WITHOUT a .eq('organization_id', ...) (RLS scopes the read)", async () => {
    // Resource-first pattern: load by id only — RLS filters to the user's
    // accessible orgs. A regression that re-introduced an explicit
    // org_id filter on the phone_numbers lookup would break for multi-org
    // users (the .eq() would scope to the WRONG org from the old buggy
    // membership lookup, which no longer exists).
    await callRoute();
    const phoneQuery = supabaseState.queries.phone_numbers;
    expect(phoneQuery).toBeDefined();
    const orgEq = phoneQuery.eqs.find((e) => e.col === "organization_id");
    expect(orgEq).toBeUndefined();
    // But it MUST still filter by id
    const idEq = phoneQuery.eqs.find((e) => e.col === "id");
    expect(idEq?.val).toBe("ph-1");
  });
});
