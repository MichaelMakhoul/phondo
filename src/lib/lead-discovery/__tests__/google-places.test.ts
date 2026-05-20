import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchPlaces, searchMultipleProfessions } from "../google-places";
import { PlacesApiError } from "../errors";

function okResponse(places: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ places }),
  };
}

function errResponse(status: number) {
  return {
    ok: false,
    status,
    text: async () => `error ${status}`,
  };
}

const onePlace = [{ id: "p1", displayName: { text: "Biz 1" }, formattedAddress: "1 St" }];

beforeEach(() => {
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchPlaces (SCRUM-314)", () => {
  it("throws PlacesApiError carrying the status on a 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errResponse(429)));
    const err = await searchPlaces({ location: "Sydney", profession: "dentist", limit: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(PlacesApiError);
    expect((err as PlacesApiError).status).toBe(429);
    expect((err as PlacesApiError).failureKind).toBe("google-places");
  });

  it("throws PlacesApiError with status 503 on a 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errResponse(503)));
    const err = await searchPlaces({ location: "Sydney", profession: "dentist", limit: 10 }).catch((e) => e);
    expect((err as PlacesApiError).status).toBe(503);
  });

  it("throws (missing key) when GOOGLE_PLACES_API_KEY is unset", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    await expect(searchPlaces({ location: "Sydney", profession: "dentist", limit: 10 })).rejects.toThrow();
  });

  it("returns normalised places on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(onePlace)));
    const out = await searchPlaces({ location: "Sydney", profession: "dentist", limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ placeId: "p1", name: "Biz 1" });
  });
});

describe("searchMultipleProfessions (SCRUM-314)", () => {
  it("rethrows the PlacesApiError when ZERO results accumulated (first profession fails)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errResponse(429)));
    const err = await searchMultipleProfessions("Sydney", ["dentist"], 10).catch((e) => e);
    expect(err).toBeInstanceOf(PlacesApiError);
    expect((err as PlacesApiError).status).toBe(429);
  });

  it("returns PARTIAL results when a later profession fails after earlier ones succeeded", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        // 1st profession's page → data; 2nd profession → 429.
        return call === 1 ? okResponse(onePlace) : errResponse(429);
      }),
    );
    const out = await searchMultipleProfessions("Sydney", ["dentist", "lawyer"], 10);
    // Profession 1's result survived; profession 2's quota error did NOT
    // nuke it (logged + returned partial).
    expect(out).toHaveLength(1);
    expect(out[0].placeId).toBe("p1");
  });
});
