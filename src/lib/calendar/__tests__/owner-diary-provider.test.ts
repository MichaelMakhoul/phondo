import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-599 test lens (review round 1): ownerDiaryProvider over a fake whose eq() filters really filter
// (owner-booking.test.ts's fake ignores every filter, so a dropped org, provider or
// is_active filter goes unseen). Picking "phondo" wrongly is the dangerous direction for
// a block: it lands in Phondo's blocked_times while callers keep booking in Cal.com.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/calendar/cliniko-booking", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveClinikoIntegration: vi.fn(async () => ({ kind: "none" })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { ownerDiaryProvider } from "@/lib/calendar/tool-handlers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = "11111111-2222-4333-a444-555555555555";
const OTHER_ORG = "22222222-3333-4444-a555-666666666666";
let tables: Record<string, Array<Record<string, unknown>>> = {};
function filteringAdmin() {
  return {
    from: (table: string) => {
      const preds: Array<(r: Record<string, unknown>) => boolean> = [];
      let limit: number | null = null;
      const b: any = {
        select: () => b,
        eq: (k: string, v: unknown) => { preds.push((r) => r[k] === v); return b; },
        limit: (n: number) => { limit = n; return b; },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          const rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
          return Promise.resolve({ data: limit === null ? rows : rows.slice(0, limit), error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
}
const CAL_COM = { organization_id: ORG, provider: "cal_com", is_active: true, access_token: "enc" };

beforeEach(() => {
  tables = {};
  vi.mocked(createAdminClient).mockReturnValue(filteringAdmin() as never);
});

describe("killers — ownerDiaryProvider reads only this org's ACTIVE service types and Cal.com account", () => {
  it("R33 / R53: inactive service types, or another org's, don't make it Phondo's diary — the org is on Cal.com", async () => {
    tables = { service_types: [{ organization_id: ORG, is_active: false }], calendar_integrations: [CAL_COM] };
    expect(await ownerDiaryProvider(ORG)).toBe("Cal.com");
    tables = { service_types: [{ organization_id: OTHER_ORG, is_active: true }], calendar_integrations: [CAL_COM] };
    expect(await ownerDiaryProvider(ORG)).toBe("Cal.com");
  });

  it("R31 / R32 / R52: an inactive Cal.com account, another provider, or another org's account is not Cal.com", async () => {
    tables = { calendar_integrations: [{ ...CAL_COM, is_active: false }] };
    expect(await ownerDiaryProvider(ORG)).toBe("phondo");
    tables = { calendar_integrations: [{ ...CAL_COM, provider: "google_calendar" }] };
    expect(await ownerDiaryProvider(ORG)).toBe("phondo");
    tables = { calendar_integrations: [{ ...CAL_COM, organization_id: OTHER_ORG }] };
    expect(await ownerDiaryProvider(ORG)).toBe("phondo");
  });
});
