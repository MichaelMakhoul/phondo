import { describe, it, expect, vi, beforeEach } from "vitest";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import type { NextRequest } from "next/server";

/**
 * SCRUM-307: contract-violation coverage for the
 * SCRAPE_PREVIEW_LLM_EXTRACT_BUG Sentry capture.
 *
 * `extractBusinessInfoWithLLM` catches internally on every error path
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
  extractBusinessInfoWithLLM: vi.fn(async () => {
    if (scraperState.llmShouldThrow) throw scraperState.llmShouldThrow;
    return {};
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
});

describe("POST /api/v1/scrape-preview — LLM-extract-bug contract (SCRUM-307)", () => {
  it("happy path: extractBusinessInfoWithLLM returns {} → no Sentry page, 200", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // The contract holds in production today, so the detector must NOT fire.
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("contract violation: extractBusinessInfoWithLLM throws → pages SCRAPE_PREVIEW_LLM_EXTRACT_BUG at error level, scrape still succeeds (non-fatal)", async () => {
    scraperState.llmShouldThrow = new Error("OpenAI SDK regression: outer try removed");
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

    // The contract-violation detector fired exactly once with the right
    // reason + level + the `url` triage breadcrumb (the outer route catch
    // must NOT also fire — toHaveBeenCalledTimes(1) guards that).
    expect(pageSentryMock).toHaveBeenCalledTimes(1);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "next-api",
        reason: SENTRY_REASONS.SCRAPE_PREVIEW_LLM_EXTRACT_BUG,
        level: "error",
        extras: { url: "https://example.com" },
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
