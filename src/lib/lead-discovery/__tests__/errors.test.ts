import { describe, it, expect } from "vitest";
import {
  LeadDiscoveryError,
  PlacesApiError,
  LeadDiscoveryDbError,
  classifyLeadDiscoveryFailure,
} from "../errors";

describe("lead-discovery typed errors (SCRUM-309)", () => {
  it("PlacesApiError carries failureKind=google-places", () => {
    // SCRUM-314: searchPlaces now THROWS a PlacesApiError (carrying the
    // HTTP status) on a non-2xx — quota (429), outage (5xx), key/project
    // (403) — as well as on a missing key / hard network failure (no
    // status). This case exercises the no-status (missing-key) path.
    const err = new PlacesApiError("GOOGLE_PLACES_API_KEY not configured");
    expect(err).toBeInstanceOf(LeadDiscoveryError);
    expect(err).toBeInstanceOf(Error);
    expect(err.failureKind).toBe("google-places");
    expect(err.name).toBe("PlacesApiError");
  });

  it("LeadDiscoveryDbError carries failureKind=db-query", () => {
    const err = new LeadDiscoveryDbError("query failed");
    expect(err).toBeInstanceOf(LeadDiscoveryError);
    expect(err.failureKind).toBe("db-query");
    expect(err.name).toBe("LeadDiscoveryDbError");
  });

  it("PlacesApiError carries the optional HTTP status (SCRUM-314)", () => {
    const err = new PlacesApiError("Google Places API returned 429", { status: 429 });
    expect(err.status).toBe(429);
    expect(err.failureKind).toBe("google-places");
    // status is optional — undefined for network/parse failures.
    expect(new PlacesApiError("network fail").status).toBeUndefined();
  });

  it("preserves the underlying cause for stack triage", () => {
    const root = new Error("ECONNREFUSED");
    const err = new PlacesApiError("Google Places search failed", { cause: root });
    expect(err.cause).toBe(root);
  });

  describe("classifyLeadDiscoveryFailure", () => {
    it("returns the typed kind for a PlacesApiError", () => {
      expect(classifyLeadDiscoveryFailure(new PlacesApiError("x"))).toBe("google-places");
    });

    it("returns the typed kind for a LeadDiscoveryDbError", () => {
      expect(classifyLeadDiscoveryFailure(new LeadDiscoveryDbError("x"))).toBe("db-query");
    });

    it("returns 'unknown' for a raw Error we didn't wrap", () => {
      expect(classifyLeadDiscoveryFailure(new Error("boom"))).toBe("unknown");
    });

    it("returns 'unknown' for a non-Error throw (string, undefined)", () => {
      expect(classifyLeadDiscoveryFailure("boom")).toBe("unknown");
      expect(classifyLeadDiscoveryFailure(undefined)).toBe("unknown");
    });

    it("returns 'unknown' for a typed error re-wrapped in a plain Error (documents the one-level contract)", () => {
      // The classifier does NOT walk err.cause. If a future layer wraps
      // a typed error in a plain Error, the kind is lost. This test
      // pins that contract so the limitation is a tested decision, not
      // an accident — flip it (and walk the cause chain) deliberately
      // if that wrapping pattern is ever introduced.
      const wrapped = new Error("scan failed", { cause: new PlacesApiError("x") });
      expect(classifyLeadDiscoveryFailure(wrapped)).toBe("unknown");
    });
  });
});
