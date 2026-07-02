import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => true) }));
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })),
}));
vi.mock("@/lib/calendar/cliniko-booking", () => ({ getActiveClinikoIntegration: vi.fn() }));
vi.mock("@/lib/calendar/cliniko-sync", () => ({ syncClinikoCatalog: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { getActiveClinikoIntegration } from "@/lib/calendar/cliniko-booking";
import { syncClinikoCatalog } from "@/lib/calendar/cliniko-sync";
import { ClinikoAuthError } from "@/lib/calendar/cliniko";
import { POST } from "../route";

const ORG = "66666666-6666-4666-a666-666666666666";
const CTX = { client: {}, businessId: "b-1", integrationId: "int-1" } as never;

function userClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: { organization_id: ORG } }),
      };
      return chain;
    },
  };
}

function adminCapture() {
  const updates: Array<Record<string, unknown>> = [];
  const from = () => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (p: Record<string, unknown>) => {
        updates.push(p);
        return chain;
      },
      eq: () => chain,
      maybeSingle: async () => ({ data: { settings: { shard: "au2" } } }),
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    };
    return chain;
  };
  return { client: { from }, updates };
}

function req() {
  return new Request("http://localhost/api/v1/integrations/cliniko/sync", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockResolvedValue(userClient() as never);
  vi.mocked(hasFeatureAccess).mockResolvedValue(true);
});

describe("POST /api/v1/integrations/cliniko/sync", () => {
  it("gates on plan access", async () => {
    vi.mocked(hasFeatureAccess).mockResolvedValue(false);
    expect((await POST(req())).status).toBe(403);
  });

  it("409s when no active integration", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(null);
    expect((await POST(req())).status).toBe(409);
  });

  it("syncs and stamps lastSyncedAt, clearing errorState", async () => {
    const admin = adminCapture();
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(CTX);
    vi.mocked(syncClinikoCatalog).mockResolvedValue({ practitionersUpserted: 1, serviceTypesUpserted: 2, deactivated: 0 });

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).sync.serviceTypesUpserted).toBe(2);
    const settingsUpdate = admin.updates.find((u) => u.settings) as { settings: Record<string, unknown> };
    expect(settingsUpdate.settings.errorState).toBeNull();
    expect(settingsUpdate.settings.lastSyncedAt).toBeTruthy();
  });

  it("maps an auth failure to 401 and errorState auth_failed", async () => {
    const admin = adminCapture();
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(CTX);
    vi.mocked(syncClinikoCatalog).mockRejectedValue(new ClinikoAuthError("bad"));

    const res = await POST(req());
    expect(res.status).toBe(401);
    const settingsUpdate = admin.updates.find((u) => u.settings) as { settings: Record<string, unknown> };
    expect(settingsUpdate.settings.errorState).toBe("auth_failed");
  });
});
