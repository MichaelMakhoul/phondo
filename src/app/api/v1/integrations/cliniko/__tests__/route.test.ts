import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => true) }));
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })),
}));
vi.mock("@/lib/security/encryption", () => ({
  safeEncrypt: vi.fn((v: string) => `enc:${v}`),
  safeDecrypt: vi.fn((v: string) => (v?.startsWith("enc:") ? v.slice(4) : null)),
}));
const listBusinessesMock = vi.fn();
vi.mock("@/lib/calendar/cliniko", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/cliniko")>();
  return {
    ...actual,
    ClinikoClient: vi.fn(function ClinikoClient() {
      return { listBusinesses: listBusinessesMock };
    }),
  };
});
vi.mock("@/lib/calendar/cliniko-sync", () => ({
  syncClinikoCatalog: vi.fn(async () => ({ practitionersUpserted: 2, serviceTypesUpserted: 3, deactivated: 0 })),
}));

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { ClinikoAuthError } from "@/lib/calendar/cliniko";
import { syncClinikoCatalog } from "@/lib/calendar/cliniko-sync";
import { POST, GET, PATCH, DELETE } from "../route";

const ORG = "55555555-5555-4555-a555-555555555555";
const VALID_KEY = "MS0xLWl0c2FuLXRlc3Q-au2";

function userClient(
  user: { id: string } | null = { id: "u1" },
  orgId: string | null = ORG,
  role: string = "owner"
) {
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({
          data: table === "org_members" && orgId ? { organization_id: orgId, role } : null,
        }),
      };
      return chain;
    },
  };
}

interface AdminCall {
  table: string;
  op: string | null;
  payload: unknown;
  filters: Record<string, unknown>;
}
type AdminHandler = (call: AdminCall) => { data?: unknown; error?: { message?: string } | null; count?: number };

function adminClient(handler: AdminHandler) {
  const calls: AdminCall[] = [];
  const from = vi.fn((table: string) => {
    const call: AdminCall = { table, op: null, payload: null, filters: {} };
    calls.push(call);
    const resolveWith = () => {
      const res = handler(call) || {};
      return { data: res.data ?? null, error: res.error ?? null, count: res.count ?? 0 };
    };
    const qb: Record<string, unknown> = {
      select: () => {
        if (!call.op) call.op = "select";
        return qb;
      },
      insert: (p: unknown) => {
        call.op = "insert";
        call.payload = p;
        return qb;
      },
      update: (p: unknown) => {
        call.op = "update";
        call.payload = p;
        return qb;
      },
      upsert: (p: unknown) => {
        call.op = "upsert";
        call.payload = p;
        return qb;
      },
      delete: () => {
        call.op = "delete";
        return qb;
      },
      eq: (k: string, v: unknown) => {
        call.filters[k] = v;
        return qb;
      },
      maybeSingle: async () => resolveWith(),
      single: async () => resolveWith(),
      then: (resolve: (v: unknown) => void) => resolve(resolveWith()),
    };
    return qb;
  });
  return { client: { from }, calls };
}

const noIntegration: AdminHandler = () => ({ data: null });

function req(method: string, body?: unknown) {
  return new Request("http://localhost/api/v1/integrations/cliniko", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockResolvedValue(userClient() as never);
  vi.mocked(hasFeatureAccess).mockResolvedValue(true);
  listBusinessesMock.mockResolvedValue([{ id: "b-1", business_name: "Main Clinic" }]);
});

describe("POST /api/v1/integrations/cliniko (connect)", () => {
  it("rejects unauthenticated requests", async () => {
    vi.mocked(createClient).mockResolvedValue(userClient(null) as never);
    const res = await POST(req("POST", { apiKey: VALID_KEY }));
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin org member (installing a CRM key redirects bookings)", async () => {
    vi.mocked(createClient).mockResolvedValue(userClient({ id: "u1" }, ORG, "member") as never);
    const res = await POST(req("POST", { apiKey: VALID_KEY }));
    expect(res.status).toBe(403);
    // Gate is BEFORE the entitlement check and any Cliniko call.
    expect(listBusinessesMock).not.toHaveBeenCalled();
  });

  it("gates on crmIntegrations plan access", async () => {
    vi.mocked(hasFeatureAccess).mockResolvedValue(false);
    const res = await POST(req("POST", { apiKey: VALID_KEY }));
    expect(res.status).toBe(403);
    expect(vi.mocked(hasFeatureAccess)).toHaveBeenCalledWith(ORG, "crmIntegrations");
  });

  it("rejects a malformed key with 400 before any Cliniko call", async () => {
    const db = adminClient(noIntegration);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const res = await POST(req("POST", { apiKey: "not-a-real-key" }));
    expect(res.status).toBe(400);
    expect(listBusinessesMock).not.toHaveBeenCalled();
  });

  it("returns 401-style error when Cliniko rejects the key", async () => {
    const db = adminClient(noIntegration);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    listBusinessesMock.mockRejectedValue(new ClinikoAuthError("nope"));
    const res = await POST(req("POST", { apiKey: VALID_KEY }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("rejected");
  });

  it("single-business connect activates, stores encrypted key only, and runs the initial sync", async () => {
    const db = adminClient(noIntegration);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);

    const res = await POST(req("POST", { apiKey: `  ${VALID_KEY}\n` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.sync).toMatchObject({ practitionersUpserted: 2 });
    expect(JSON.stringify(body)).not.toContain(VALID_KEY);
    expect(JSON.stringify(body)).not.toContain("enc:");

    const write = db.calls.find((c) => c.table === "calendar_integrations" && (c.op === "insert" || c.op === "upsert"));
    expect(write).toBeTruthy();
    const payload = write!.payload as Record<string, unknown>;
    expect(payload.access_token).toBe(`enc:${VALID_KEY}`); // trimmed before encrypt
    expect(payload.provider).toBe("cliniko");
    expect(payload.is_active).toBe(true);
    const settings = payload.settings as Record<string, unknown>;
    expect(settings.shard).toBe("au2");
    expect(settings.businessId).toBe("b-1");
    expect(String(settings.keyLast4)).toHaveLength(4);
    expect(vi.mocked(syncClinikoCatalog)).toHaveBeenCalledTimes(1);
  });

  it("multi-business connect stays inactive pending business selection and does NOT sync", async () => {
    const db = adminClient(noIntegration);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    listBusinessesMock.mockResolvedValue([
      { id: "b-1", business_name: "City Clinic" },
      { id: "b-2", business_name: "Suburb Clinic" },
    ]);

    const res = await POST(req("POST", { apiKey: VALID_KEY }));
    const body = await res.json();
    expect(body.active).toBe(false);
    expect(body.businesses).toHaveLength(2);
    expect(vi.mocked(syncClinikoCatalog)).not.toHaveBeenCalled();
    const write = db.calls.find((c) => c.table === "calendar_integrations" && (c.op === "insert" || c.op === "upsert"));
    expect((write!.payload as Record<string, unknown>).is_active).toBe(false);
  });
});

describe("PATCH /api/v1/integrations/cliniko (select business)", () => {
  it("activates with a validated business and runs the initial sync", async () => {
    const db = adminClient((call) => {
      if (call.table === "calendar_integrations" && call.op === "select") {
        return { data: { id: "int-1", access_token: `enc:${VALID_KEY}`, settings: { shard: "au2", keyLast4: "c3Q" } } };
      }
      return { data: null };
    });
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    listBusinessesMock.mockResolvedValue([
      { id: "b-1", business_name: "City Clinic" },
      { id: "b-2", business_name: "Suburb Clinic" },
    ]);

    const res = await PATCH(req("PATCH", { businessId: "b-2" }));
    expect(res.status).toBe(200);
    const update = db.calls.find((c) => c.table === "calendar_integrations" && c.op === "update");
    const payload = update!.payload as Record<string, unknown>;
    expect(payload.is_active).toBe(true);
    expect((payload.settings as Record<string, unknown>).businessId).toBe("b-2");
    expect(vi.mocked(syncClinikoCatalog)).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown businessId", async () => {
    const db = adminClient((call) => {
      if (call.table === "calendar_integrations" && call.op === "select") {
        return { data: { id: "int-1", access_token: `enc:${VALID_KEY}`, settings: { shard: "au2" } } };
      }
      return { data: null };
    });
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const res = await PATCH(req("PATCH", { businessId: "b-999" }));
    expect(res.status).toBe(400);
    expect(vi.mocked(syncClinikoCatalog)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/integrations/cliniko (status)", () => {
  it("reports not-connected with the gate flag for the upsell state", async () => {
    const db = adminClient(noIntegration);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    vi.mocked(hasFeatureAccess).mockResolvedValue(false);
    const res = await GET(req("GET"));
    const body = await res.json();
    expect(body.connected).toBe(false);
    expect(body.canConnect).toBe(false);
  });

  it("never returns the access token in any form", async () => {
    const db = adminClient((call) => {
      if (call.table === "calendar_integrations") {
        return {
          data: {
            id: "int-1",
            is_active: true,
            access_token: `enc:${VALID_KEY}`,
            settings: { shard: "au2", businessId: "b-1", businessName: "Main Clinic", keyLast4: "t3st" },
          },
        };
      }
      if (call.table === "practitioners" || call.table === "service_types") {
        return { data: [], count: 2 };
      }
      return { data: null };
    });
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const res = await GET(req("GET"));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain(VALID_KEY);
    expect(raw).not.toContain("enc:");
    expect(raw).not.toContain("access_token");
  });
});

describe("DELETE /api/v1/integrations/cliniko (disconnect)", () => {
  it("deactivates the integration, clears the token, and deactivates imported catalog rows", async () => {
    const db = adminClient((call) => {
      if (call.table === "calendar_integrations" && call.op === "select") {
        return { data: { id: "int-1", settings: { shard: "au2" } } };
      }
      return { data: null };
    });
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);

    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(200);

    const integrationUpdate = db.calls.find((c) => c.table === "calendar_integrations" && c.op === "update");
    const payload = integrationUpdate!.payload as Record<string, unknown>;
    expect(payload.is_active).toBe(false);
    expect(payload.access_token).toBeNull();

    for (const table of ["practitioners", "service_types"]) {
      const upd = db.calls.find((c) => c.table === table && c.op === "update");
      expect(upd, `${table} deactivation`).toBeTruthy();
      expect((upd!.payload as Record<string, unknown>).is_active).toBe(false);
      expect(upd!.filters.external_provider).toBe("cliniko");
      expect(upd!.filters.organization_id).toBe(ORG);
    }
  });
});
