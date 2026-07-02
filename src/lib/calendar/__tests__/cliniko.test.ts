import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseClinikoApiKey,
  ClinikoClient,
  ClinikoApiKeyError,
  ClinikoAuthError,
  ClinikoRateLimitError,
  ClinikoValidationError,
  ClinikoUnavailableError,
} from "../cliniko";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeClient(overrides: Partial<{ apiKey: string; shard: string; timeoutMs: number }> = {}) {
  return new ClinikoClient({ apiKey: "MS0xLWl0c2Fu-au2", shard: "au2", timeoutMs: 500, ...overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseClinikoApiKey", () => {
  it("extracts the shard from a valid suffixed key", () => {
    expect(parseClinikoApiKey("MS0xLWl0c2Fu-au2")).toEqual({ key: "MS0xLWl0c2Fu-au2", shard: "au2" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseClinikoApiKey("  MS0xLWl0c2Fu-uk1\n")).toEqual({ key: "MS0xLWl0c2Fu-uk1", shard: "uk1" });
  });

  it("throws ClinikoApiKeyError when the shard suffix is missing", () => {
    expect(() => parseClinikoApiKey("MS0xLWl0c2Fu")).toThrow(ClinikoApiKeyError);
  });

  it("throws on empty input", () => {
    expect(() => parseClinikoApiKey("   ")).toThrow(ClinikoApiKeyError);
  });

  it("rejects hostile shard-shaped input that could steer the hostname", () => {
    expect(() => parseClinikoApiKey("key-evil.com/au1")).toThrow(ClinikoApiKeyError);
    expect(() => parseClinikoApiKey("key-AU1")).toThrow(ClinikoApiKeyError); // uppercase shard not valid
    expect(() => parseClinikoApiKey("key-au12345")).toThrow(ClinikoApiKeyError); // too many digits
  });
});

describe("ClinikoClient request basics", () => {
  it("sends Basic auth, User-Agent, Accept headers to the shard host", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { businesses: [], links: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await makeClient().listBusinesses();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://api.au2.cliniko.com/v1/businesses");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("MS0xLWl0c2Fu-au2:").toString("base64")}`);
    expect(headers["User-Agent"]).toMatch(/Phondo \(.+@.+\)/);
    expect(headers.Accept).toBe("application/json");
  });

  it("retries a GET once on 500 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(200, { businesses: [{ id: 7, business_name: "Clinic" }], links: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const businesses = await makeClient().listBusinesses();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(businesses).toEqual([{ id: "7", business_name: "Clinic" }]);
  });

  it("does NOT retry a write on 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      makeClient().createPatient({ firstName: "Jo", lastName: "Bloggs", phone: "0412345678" })
    ).rejects.toBeInstanceOf(ClinikoUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 429 to ClinikoRateLimitError with resetAtMs from X-RateLimit-Reset", async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, {}, { "x-ratelimit-reset": String(reset) }))
    );
    const err = await makeClient().listBusinesses().catch((e) => e);
    expect(err).toBeInstanceOf(ClinikoRateLimitError);
    expect((err as ClinikoRateLimitError).resetAtMs).toBe(reset * 1000);
  });

  it("maps 401 to ClinikoAuthError and 422 to ClinikoValidationError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));
    await expect(makeClient().listBusinesses()).rejects.toBeInstanceOf(ClinikoAuthError);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(422, { errors: { starts_at: ["is invalid"] } })));
    await expect(
      makeClient().createAppointment({
        businessId: "1",
        practitionerId: "2",
        appointmentTypeId: "3",
        patientId: "4",
        startsAtIso: "not-a-date",
      })
    ).rejects.toBeInstanceOf(ClinikoValidationError);
  });

  it("maps aborts/network failures to ClinikoUnavailableError", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortErr)));
    await expect(makeClient().listBusinesses()).rejects.toBeInstanceOf(ClinikoUnavailableError);
  });

  it("never leaks the API key in thrown error messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {})));
    const err = await makeClient().createPatient({ firstName: "A", lastName: "B" }).catch((e) => e);
    expect(String(err.message)).not.toContain("MS0xLWl0c2Fu");
  });
});

describe("ClinikoClient resources", () => {
  it("paginates list endpoints via links.next", async () => {
    const page1 = {
      practitioners: [{ id: 1, first_name: "Sue", last_name: "Smith", active: true }],
      links: { next: "https://api.au2.cliniko.com/v1/practitioners?page=2" },
    };
    const page2 = {
      practitioners: [{ id: 2, first_name: "Ali", last_name: "Vu", active: false }],
      links: {},
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, page1))
      .mockResolvedValueOnce(jsonResponse(200, page2));
    vi.stubGlobal("fetch", fetchMock);

    const practitioners = await makeClient().listPractitioners();
    expect(practitioners.map((p) => p.id)).toEqual(["1", "2"]);
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[0]).toContain("page=2");
  });

  it("availableTimes returns appointment_start ISO strings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          available_times: [{ appointment_start: "2026-07-06T23:00:00Z" }, { appointment_start: "2026-07-06T23:30:00Z" }],
          links: {},
        })
      )
    );
    const times = await makeClient().availableTimes("1", "2", "3", "2026-07-07", "2026-07-07");
    expect(times).toEqual(["2026-07-06T23:00:00Z", "2026-07-06T23:30:00Z"]);
  });

  it("findPatientsByName sends q[] filters and normalizes ids", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        patients: [
          {
            id: 99,
            first_name: "Jo",
            last_name: "Bloggs",
            patient_phone_numbers: [{ phone_type: "Mobile", number: "0412 345 678" }],
          },
        ],
        links: {},
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const patients = await makeClient().findPatientsByName("Jo", "Bloggs");
    expect(patients[0].id).toBe("99");
    const url = decodeURIComponent(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0]));
    expect(url).toContain("q[]=first_name:=Jo");
    expect(url).toContain("q[]=last_name:=Bloggs");
  });

  it("getPatient returns null on 404 (allow404)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, {})));
    await expect(makeClient().getPatient("123")).resolves.toBeNull();
  });

  it("treats a 404 on list/availability endpoints as a failure, NOT empty results", async () => {
    // A stale practitioner/appointment-type id must not silently read as
    // 'no availability'; a catalog 404 must not read as an empty catalog.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, {})));
    await expect(makeClient().availableTimes("1", "2", "3", "2026-07-07", "2026-07-07")).rejects.toBeInstanceOf(
      ClinikoUnavailableError
    );
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, {})));
    await expect(makeClient().listPractitioners()).rejects.toBeInstanceOf(ClinikoUnavailableError);
  });

  it("scopes listPractitioners to a business when given", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { practitioners: [], links: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await makeClient().listPractitioners("77");
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain("/businesses/77/practitioners");
  });

  it("throws rather than minting a poison 'undefined' id when a record has no id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { businesses: [{ business_name: "No Id Clinic" }], links: {} }))
    );
    await expect(makeClient().listBusinesses()).rejects.toBeInstanceOf(ClinikoUnavailableError);
  });

  it("createAppointment posts snake_case numeric-friendly payload and returns normalized appointment", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        id: 555,
        starts_at: "2026-07-07T00:00:00Z",
        ends_at: "2026-07-07T00:30:00Z",
        cancelled_at: null,
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const appt = await makeClient().createAppointment({
      businessId: "1",
      practitionerId: "2",
      appointmentTypeId: "3",
      patientId: "4",
      startsAtIso: "2026-07-07T00:00:00Z",
      notes: "Toothache",
    });
    expect(appt.id).toBe("555");
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string);
    expect(body).toMatchObject({
      business_id: "1",
      practitioner_id: "2",
      appointment_type_id: "3",
      patient_id: "4",
      starts_at: "2026-07-07T00:00:00Z",
      notes: "Toothache",
    });
  });

  it("cancelAppointment PATCHes reason 50 and treats 404 as success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(204, {}));
    vi.stubGlobal("fetch", fetchMock);
    await makeClient().cancelAppointment("555", "Cancelled by caller via Phondo");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/individual_appointments/555/cancel");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toMatchObject({
      cancellation_reason: 50,
      cancellation_note: "Cancelled by caller via Phondo",
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, {})));
    await expect(makeClient().cancelAppointment("555")).resolves.toBeUndefined();
  });

  it("updateAppointmentTime PUTs starts_at", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { id: 555, starts_at: "2026-07-08T01:00:00Z", ends_at: "2026-07-08T01:30:00Z", cancelled_at: null })
    );
    vi.stubGlobal("fetch", fetchMock);
    const appt = await makeClient().updateAppointmentTime("555", "2026-07-08T01:00:00Z");
    expect(appt.starts_at).toBe("2026-07-08T01:00:00Z");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/individual_appointments/555");
    expect(init.method).toBe("PUT");
  });
});
