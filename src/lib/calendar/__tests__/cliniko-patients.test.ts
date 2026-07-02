import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import type { ClinikoClient, ClinikoPatient } from "../cliniko";
import {
  normalizePhoneForMatch,
  namesLooselyMatch,
  findOrCreateClinikoPatient,
} from "../cliniko-patients";

interface Captured {
  upserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

/** Chainable admin-client mock: cacheRow drives the crm_patient_links lookup. */
function adminClient(captured: Captured, cacheRow: Record<string, unknown> | null = null, lookupError: unknown = null) {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    const api = {
      select: () => api,
      eq: () => api,
      maybeSingle: async () => (lookupError ? { data: null, error: lookupError } : { data: cacheRow, error: null }),
      upsert: (row: Record<string, unknown>, opts?: Record<string, unknown>) => {
        captured.upserts.push({ table, row, opts });
        return { then: (r: (v: { error: null }) => void) => r({ error: null }) };
      },
      update: (row: Record<string, unknown>) => {
        captured.updates.push({ table, row });
        return api;
      },
      ...self,
    };
    return api;
  };
  return { from: vi.fn((table: string) => chain(table)) };
}

function patient(id: string, first: string, last: string, phones: string[] = [], archived: string | null = null): ClinikoPatient {
  return {
    id,
    first_name: first,
    last_name: last,
    archived_at: archived,
    patient_phone_numbers: phones.map((number) => ({ phone_type: "Mobile", number })),
  };
}

function fakeClient(overrides: Partial<Record<keyof ClinikoClient, unknown>> = {}): ClinikoClient {
  return {
    getPatient: vi.fn(async () => null),
    findPatientsByName: vi.fn(async () => []),
    createPatient: vi.fn(async () => patient("900", "New", "Patient")),
    ...overrides,
  } as unknown as ClinikoClient;
}

const ORG = "11111111-1111-4111-a111-111111111111";

let captured: Captured;
beforeEach(() => {
  captured = { upserts: [], updates: [] };
  vi.mocked(createAdminClient).mockReturnValue(adminClient(captured) as never);
});

describe("normalizePhoneForMatch", () => {
  it("normalizes AU formats to the same key", () => {
    expect(normalizePhoneForMatch("0412 345 678")).toBe("412345678");
    expect(normalizePhoneForMatch("+61412345678")).toBe("412345678");
    expect(normalizePhoneForMatch("61-412-345-678")).toBe("412345678");
  });
  it("returns null for short or empty input", () => {
    expect(normalizePhoneForMatch("1234567")).toBeNull();
    expect(normalizePhoneForMatch("")).toBeNull();
    expect(normalizePhoneForMatch(undefined)).toBeNull();
  });
});

describe("namesLooselyMatch", () => {
  it("matches case- and diacritic-insensitively on last name + first initial", () => {
    expect(namesLooselyMatch("José", "García", "jose", "garcia")).toBe(true);
    expect(namesLooselyMatch("Jo", "Bloggs", "Joanne", "BLOGGS")).toBe(true);
    expect(namesLooselyMatch("Jo", "Bloggs", "Mo", "Bloggs")).toBe(false);
    expect(namesLooselyMatch("Jo", "Bloggs", "Jo", "Smith")).toBe(false);
  });
  it("falls back to last-name equality when a first name is missing", () => {
    expect(namesLooselyMatch("", "Bloggs", "Jo", "Bloggs")).toBe(true);
  });
});

describe("findOrCreateClinikoPatient", () => {
  it("cache hit: verifies name via getPatient and returns without searching", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(captured, { external_patient_id: "42", patient_name: "Jo Bloggs" }) as never
    );
    const client = fakeClient({
      getPatient: vi.fn(async () => patient("42", "Jo", "Bloggs", ["0412345678"])),
    });
    const res = await findOrCreateClinikoPatient({
      client, organizationId: ORG, firstName: "Jo", lastName: "Bloggs", phone: "+61412345678",
    });
    expect(res).toEqual({ patientId: "42", created: false });
    expect(client.findPatientsByName).not.toHaveBeenCalled();
    expect(client.createPatient).not.toHaveBeenCalled();
  });

  it("cache hit with name drift falls through to name search", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(captured, { external_patient_id: "42", patient_name: "Someone Else" }) as never
    );
    const client = fakeClient({
      getPatient: vi.fn(async () => patient("42", "Someone", "Else", ["0412345678"])),
      findPatientsByName: vi.fn(async () => [patient("77", "Jo", "Bloggs", ["0412 345 678"])]),
    });
    const res = await findOrCreateClinikoPatient({
      client, organizationId: ORG, firstName: "Jo", lastName: "Bloggs", phone: "0412345678",
    });
    expect(res.patientId).toBe("77");
    expect(client.findPatientsByName).toHaveBeenCalled();
  });

  it("single phone-corroborated name match wins over uncorroborated ones", async () => {
    const client = fakeClient({
      findPatientsByName: vi.fn(async () => [
        patient("1", "Jo", "Bloggs", ["0499 999 999"]),
        patient("2", "Jo", "Bloggs", ["0412345678"]),
      ]),
    });
    const res = await findOrCreateClinikoPatient({
      client, organizationId: ORG, firstName: "Jo", lastName: "Bloggs", phone: "+61412345678",
    });
    expect(res).toEqual({ patientId: "2", created: false });
    expect(captured.upserts).toHaveLength(1);
    expect((captured.upserts[0].row as Record<string, unknown>).phone_key).toBe("412345678");
  });

  it("name matches without phone corroboration create a new patient with duplicateWarning", async () => {
    const client = fakeClient({
      findPatientsByName: vi.fn(async () => [patient("1", "Jo", "Bloggs", ["0499 999 999"])]),
      createPatient: vi.fn(async () => patient("900", "Jo", "Bloggs", ["0412345678"])),
    });
    const res = await findOrCreateClinikoPatient({
      client, organizationId: ORG, firstName: "Jo", lastName: "Bloggs", phone: "0412345678",
    });
    expect(res.created).toBe(true);
    expect(res.patientId).toBe("900");
    expect(res.duplicatePatientId).toBe("1");
  });

  it("archived patients are never matched", async () => {
    const client = fakeClient({
      findPatientsByName: vi.fn(async () => [patient("1", "Jo", "Bloggs", ["0412345678"], "2025-01-01T00:00:00Z")]),
    });
    const res = await findOrCreateClinikoPatient({
      client, organizationId: ORG, firstName: "Jo", lastName: "Bloggs", phone: "0412345678",
    });
    expect(res.created).toBe(true);
  });

  it("no-phone caller: exactly one name match is used, two matches create new", async () => {
    const one = fakeClient({ findPatientsByName: vi.fn(async () => [patient("5", "Jo", "Bloggs")]) });
    const resOne = await findOrCreateClinikoPatient({
      client: one, organizationId: ORG, firstName: "Jo", lastName: "Bloggs",
    });
    expect(resOne).toEqual({ patientId: "5", created: false });

    const two = fakeClient({
      findPatientsByName: vi.fn(async () => [patient("5", "Jo", "Bloggs"), patient("6", "Joanne", "Bloggs")]),
    });
    const resTwo = await findOrCreateClinikoPatient({
      client: two, organizationId: ORG, firstName: "Jo", lastName: "Bloggs",
    });
    expect(resTwo.created).toBe(true);
    expect(resTwo.duplicatePatientId).toBe("5");
  });

  it("falls back to contains search when exact search is empty", async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce([]) // exact
      .mockResolvedValueOnce([patient("8", "Jo-Anne", "Bloggs", ["0412345678"])]); // contains
    const client = fakeClient({ findPatientsByName: find });
    const res = await findOrCreateClinikoPatient({
      client, organizationId: ORG, firstName: "Jo", lastName: "Bloggs", phone: "0412345678",
    });
    expect(res.patientId).toBe("8");
    expect(find).toHaveBeenNthCalledWith(2, "Jo", "Bloggs", { contains: true });
  });

  it("creates and caches when nothing matches; cache write failure is non-fatal", async () => {
    const client = fakeClient({
      createPatient: vi.fn(async () => patient("900", "Jo", "Bloggs", ["0412345678"])),
    });
    const res = await findOrCreateClinikoPatient({
      client, organizationId: ORG, firstName: "Jo", lastName: "Bloggs", phone: "0412345678",
    });
    expect(res).toEqual({ patientId: "900", created: true });
    expect(captured.upserts).toHaveLength(1);
    const upsert = captured.upserts[0] as { row: Record<string, unknown>; opts: Record<string, unknown> };
    expect(upsert.row).toMatchObject({
      organization_id: ORG,
      provider: "cliniko",
      phone_key: "412345678",
      external_patient_id: "900",
    });
    expect(upsert.opts).toMatchObject({ onConflict: "organization_id,provider,phone_key" });
  });

  it("cache read errors are treated as a miss, not a failure", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(captured, null, { message: "boom" }) as never
    );
    const client = fakeClient({
      findPatientsByName: vi.fn(async () => [patient("2", "Jo", "Bloggs", ["0412345678"])]),
    });
    const res = await findOrCreateClinikoPatient({
      client, organizationId: ORG, firstName: "Jo", lastName: "Bloggs", phone: "0412345678",
    });
    expect(res.patientId).toBe("2");
  });
});
