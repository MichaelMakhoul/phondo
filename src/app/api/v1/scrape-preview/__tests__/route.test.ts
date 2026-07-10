import { describe, it, expect, vi, beforeEach } from "vitest";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import type { NextRequest } from "next/server";

/**
 * SCRUM-307: contract-violation coverage for the
 * SCRAPE_PREVIEW_LLM_EXTRACT_BUG Sentry capture.
 *
 * `extractBusinessInfoWithLLM` catches internally on every error path (returning null, SCRUM-532)
 * (returns `{}`), so the route's inner try/catch around it is a
 * "should never happen" guard that fires 0× in production. This test
 * proves that IF that catch-internally contract breaks (an OpenAI SDK
 * upgrade removes the outer try, a refactor lets an error bubble), the
 * route still (a) pages Sentry at error level with the right reason and
 * (b) treats the failure as NON-FATAL — the scrape still returns 200.
 */

const scraperState = vi.hoisted(() => ({
  llmShouldThrow: null as Error | null,
  scrapeShouldThrow: null as Error | null,
  // SCRUM-532: null = extraction FAILED (distinct from {} = found little).
  llmReturnsNull: false,
}));

const pageSentryMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ rpc: vi.fn() })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })),
    },
  })),
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimitDistributed: vi.fn(async () => ({ allowed: true, headers: {} })),
}));

vi.mock("@/lib/security/validation", () => ({
  isUrlAllowedAsync: vi.fn(async () => true),
}));

vi.mock("@/lib/scraper/website-scraper", () => ({
  scrapeWebsite: vi.fn(async () => {
    // Lever for the OUTER-catch test: a scrape failure (proxy pool
    // exhausted, target 403, DNS fail) is the realistic trigger.
    if (scraperState.scrapeShouldThrow) throw scraperState.scrapeShouldThrow;
    return {
      pages: [{ url: "https://example.com", title: "Home", content: "hello" }],
      businessInfo: {
        name: "Test Biz",
        phone: "",
        email: "",
        address: "",
        hours: [],
        services: [],
        about: "",
      },
      totalPages: 1,
      baseUrl: "https://example.com",
      scrapedAt: "2026-05-20T00:00:00.000Z",
    };
  }),
  generateKnowledgeBase: vi.fn(() => "KB content"),
  finalizeScrape: vi.fn((scrapedData: { businessInfo: object }, llmResult: object | null) => ({
    businessInfo: { ...scrapedData.businessInfo, ...(llmResult ?? {}) },
    content: "KB content",
    extraction: llmResult !== null ? "structured" : "raw-fallback",
  })),
  extractBusinessInfoWithLLM: vi.fn(async () => {
    if (scraperState.llmShouldThrow) throw scraperState.llmShouldThrow;
    if (scraperState.llmReturnsNull) return null;
    return { summary: "Free parking.", faqs: [{ question: "Q?", answer: "A." }] };
  }),
}));

vi.mock("@/lib/observability/page-sentry", () => ({
  pageSentry: pageSentryMock,
}));

import { POST } from "../route";

function makeRequest(url = "https://example.com"): NextRequest {
  return { json: async () => ({ url }) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  scraperState.llmShouldThrow = null;
  scraperState.scrapeShouldThrow = null;
  scraperState.llmReturnsNull = false;
});

describe("POST /api/v1/scrape-preview — LLM-extract-bug contract (SCRUM-307)", () => {
  it("happy path: extraction succeeds → no Sentry page, 200", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // The contract holds in production today, so the detector must NOT fire.
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("contract violation: extractBusinessInfoWithLLM throws → pages SCRAPE_PREVIEW_LLM_EXTRACT_BUG at error level, scrape still succeeds (non-fatal)", async () => {
    scraperState.llmShouldThrow = new Error("extractor regression: outer try removed");
    const res = await POST(makeRequest());

    // Non-fatal: the route swallows the LLM failure and still returns 200
    // with regex-only business info. This is the invariant the inner
    // try/catch protects — a broken LLM extractor must never fail the scrape.
    expect(res.status).toBe(200);
    // Prove "non-fatal" at the data level, not just the HTTP-status level:
    // the regex-derived business info must survive the LLM failure so the
    // user still gets usable data.
    const body = await res.json();
    expect(body.businessInfo.name).toBe("Test Biz");
    expect(body.content).toBe("KB content");
    expect(body.totalPages).toBe(1);
    // SCRUM-532: a THROWN extractor is a failed extraction — the KB must be
    // built in the flagged raw-fallback mode, never as an empty structured one.
    expect(body.extraction).toBe("raw-fallback");

    // The contract-violation detector fired with the right reason + level +
    // the `url` triage breadcrumb; the SECOND call is the raw-fallback
    // degradation warning (a thrown extractor is a failed extraction). The
    // outer route catch must NOT also fire.
    expect(pageSentryMock).toHaveBeenCalledTimes(2);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: SENTRY_REASONS.SCRAPE_EXTRACTION_FALLBACK, level: "warning" }),
    );
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "next-api",
        reason: SENTRY_REASONS.SCRAPE_PREVIEW_LLM_EXTRACT_BUG,
        level: "error",
        extras: { url: "https://example.com" },
      }),
    );
  });

  it("SCRUM-532: extraction success → finalizeScrape gets the result verbatim, response is structured", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extraction).toBe("structured");
    expect(body.businessInfo.summary).toBe("Free parking.");
    expect(body.businessInfo.faqs).toEqual([{ question: "Q?", answer: "A." }]);
    const { finalizeScrape } = await import("@/lib/scraper/website-scraper");
    expect(vi.mocked(finalizeScrape)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ summary: "Free parking." }),
    );
    // Structured success must NOT fire the degradation warning.
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("SCRUM-532: extraction returning NULL (failed, not thrown) → raw-fallback, flagged AND paged at warning", async () => {
    scraperState.llmReturnsNull = true;
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extraction).toBe("raw-fallback");
    const { finalizeScrape } = await import("@/lib/scraper/website-scraper");
    expect(vi.mocked(finalizeScrape)).toHaveBeenCalledWith(expect.anything(), null);
    // A failed extraction is not the contract-violation BUG, but a fleet of
    // silent raw-fallbacks during launch must page — warning level.
    expect(pageSentryMock).toHaveBeenCalledTimes(1);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: SENTRY_REASONS.SCRAPE_EXTRACTION_FALLBACK,
        level: "warning",
      }),
    );
  });

  it("outer catch: a scrape failure pages SCRAPE_PREVIEW_FAILED and returns 500", async () => {
    // Distinct from the inner LLM-bug path: a scrapeWebsite throw is a
    // real (fatal) failure. Asserting the DISTINCT reason here is what
    // makes the contract-violation test above meaningful — if someone
    // deleted the inner try/catch, the LLM throw would land here with
    // SCRAPE_PREVIEW_FAILED instead, flipping both tests.
    scraperState.scrapeShouldThrow = new Error("proxy pool exhausted");
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect(pageSentryMock).toHaveBeenCalledTimes(1);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "next-api",
        reason: SENTRY_REASONS.SCRAPE_PREVIEW_FAILED,
      }),
    );
  });
});
