import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchPlaces, searchMultipleProfessions } from "../google-places";
import { PlacesApiError } from "../errors";

function okResponse(places: unknown[], nextPageToken?: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ places, nextPageToken }),
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
const twentyPlaces = Array.from({ length: 20 }, (_, i) => ({
  id: `p${i}`,
  displayName: { text: `Biz ${i}` },
}));

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

  it("returns normalised places on 200, not partial", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(onePlace)));
    const out = await searchPlaces({ location: "Sydney", profession: "dentist", limit: 10 });
    expect(out.places).toHaveLength(1);
    expect(out.places[0]).toMatchObject({ placeId: "p1", name: "Biz 1" });
    expect(out.partial).toBe(false);
  });

  it("SCRUM-318: preserves page-1 results when a LATER page fails (partial, not throw)", async () => {
    // Page 1 → 20 places + a nextPageToken (forces a page 2); page 2 → 503.
    // Old behaviour discarded all 20; now we return them flagged partial.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return call === 1 ? okResponse(twentyPlaces, "tok-2") : errResponse(503);
      }),
    );
    const out = await searchPlaces({ location: "Sydney", profession: "dentist", limit: 25 });
    expect(out.places).toHaveLength(20);
    expect(out.partial).toBe(true);
    expect(out.failedStatus).toBe(503);
  });

  it("SCRUM-321: flags partial on an empty `places` page that still has a nextPageToken (soft truncation)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        // page 1 → 20 places + token; page 2 → 200 with [] but STILL a token.
        return call === 1 ? okResponse(twentyPlaces, "tok-2") : okResponse([], "tok-3");
      }),
    );
    const out = await searchPlaces({ location: "Sydney", profession: "dentist", limit: 25 });
    expect(out.places).toHaveLength(20);
    expect(out.partial).toBe(true);
    expect(out.failedReason).toBe("empty-page");
    expect(out.failedStatus).toBeUndefined();
  });

  it("SCRUM-321: an empty FIRST page (no results yet) is a complete empty result, not partial", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([], "tok")));
    const out = await searchPlaces({ location: "Sydney", profession: "dentist", limit: 25 });
    expect(out.places).toHaveLength(0);
    expect(out.partial).toBe(false);
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
    expect(out.places).toHaveLength(1);
    expect(out.places[0].placeId).toBe("p1");
    // SCRUM-318: the truncation is now signalled so executeSearch can skip
    // the durable cache + page a warning.
    expect(out.partial).toBe(true);
    expect(out.failedStatus).toBe(429);
  });

  it("is NOT partial when every profession succeeds", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        // Two professions, distinct placeIds so neither is deduped away.
        return call === 1
          ? okResponse([{ id: "a1", displayName: { text: "A" } }])
          : okResponse([{ id: "b1", displayName: { text: "B" } }]);
      }),
    );
    const out = await searchMultipleProfessions("Sydney", ["dentist", "lawyer"], 10);
    expect(out.places).toHaveLength(2);
    expect(out.partial).toBe(false);
    expect(out.failedStatus).toBeUndefined();
  });

  it("SCRUM-321: a raw (non-HTTP) throw after results carries failedReason for triage", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) return okResponse(onePlace);
        throw new Error("socket hang up"); // raw network throw on profession 2
      }),
    );
    const out = await searchMultipleProfessions("Sydney", ["dentist", "lawyer"], 10);
    expect(out.places).toHaveLength(1);
    expect(out.partial).toBe(true);
    expect(out.failedStatus).toBeUndefined();
    expect(out.failedReason).toBe("network-or-parse:Error");
  });
});
