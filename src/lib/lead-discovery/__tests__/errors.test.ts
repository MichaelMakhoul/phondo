import { describe, it, expect } from "vitest";
import {
  LeadDiscoveryError,
  PlacesApiError,
  LeadDiscoveryDbError,
  classifyLeadDiscoveryFailure,
} from "../errors";

describe("lead-discovery typed errors (SCRUM-309)", () => {
  it("PlacesApiError carries failureKind=google-places", () => {
    // Note: searchPlaces only throws on missing key / hard network
    // failure (non-2xx is swallowed upstream — see SCRUM-314), so this
    // message reflects what actually reaches the wrap, not "quota".
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
