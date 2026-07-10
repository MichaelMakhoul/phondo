/**
 * SCRUM-532 — the Settings-import route had no tests at all, and its
 * merge+mode wiring is the higher-stakes copy: it PERSISTS the entry. The
 * assertions here are on the captured INSERT payload, not just the HTTP
 * response — "mode hardcoded to structured" or "metadata.extraction lost"
 * are silent-regression classes the response alone would not catch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { SENTRY_REASONS } from "@/lib/security/error-ids";

const state = vi.hoisted(() => ({
  llmShouldThrow: null as Error | null,
  llmReturnsNull: false,
  insertError: null as { message: string } | null,
  insertedRows: [] as Record<string, unknown>[],
}));

const pageSentryMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimitDistributed: vi.fn(async () => ({ allowed: true, headers: {} })),
}));
vi.mock("@/lib/security/validation", () => ({ isUrlAllowedAsync: vi.fn(async () => true) }));
vi.mock("@/lib/observability/page-sentry", () => ({ pageSentry: pageSentryMock }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
    from: vi.fn((table: string) => {
      if (table === "org_members") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          single: async () => ({ data: { organization_id: "org-1" }, error: null }),
        };
        return chain;
      }
      if (table === "knowledge_bases") {
        return {
          insert: async (row: Record<string, unknown>) => {
            state.insertedRows.push(row);
            return { error: state.insertError };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

vi.mock("@/lib/scraper/website-scraper", () => ({
  scrapeWebsite: vi.fn(async () => ({
    pages: [{ url: "https://example.com", title: "Home", content: "hello" }],
    businessInfo: { phone: "02 8555 1234" },
    totalPages: 1,
    baseUrl: "https://example.com",
    scrapedAt: "2026-07-10T00:00:00.000Z",
  })),
  extractBusinessInfoWithLLM: vi.fn(async () => {
    if (state.llmShouldThrow) throw state.llmShouldThrow;
    if (state.llmReturnsNull) return null;
    return {
      about: "A dental practice.",
      faqs: [{ question: "Q?", answer: "A." }],
      staff: [{ name: "Dr Chen", role: "Dentist" }],
    };
  }),
  finalizeScrape: vi.fn((scrapedData: { businessInfo: object }, llmResult: object | null) => {
    const businessInfo = { ...scrapedData.businessInfo, ...(llmResult ?? {}) };
    scrapedData.businessInfo = businessInfo;
    return {
      businessInfo,
      content: llmResult !== null ? "STRUCTURED KB" : "RAW FALLBACK KB",
      extraction: llmResult !== null ? "structured" : "raw-fallback",
    };
  }),
}));

import { POST } from "../route";

function makeRequest(): NextRequest {
  return { json: async () => ({ url: "https://example.com" }) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.llmShouldThrow = null;
  state.llmReturnsNull = false;
  state.insertError = null;
  state.insertedRows = [];
});

describe("POST /api/v1/knowledge-base/scrape (SCRUM-532)", () => {
  it("success: stores the STRUCTURED content with metadata.extraction, faqs reach the stored businessInfo", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const row = state.insertedRows[0];
    expect(row.content).toBe("STRUCTURED KB");
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.extraction).toBe("structured");
    expect((metadata.businessInfo as { faqs: unknown }).faqs).toEqual([{ question: "Q?", answer: "A." }]);
    // SCRUM-534: staff is display-only for the approve screen and must never
    // be persisted — not even into metadata (security review caveat).
    expect((metadata.businessInfo as { staff?: unknown }).staff).toBeUndefined();
    const body = await res.json();
    expect(body.data.extraction).toBe("structured");
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("extraction returns NULL → raw-fallback stored, flagged in metadata AND response, paged at warning", async () => {
    state.llmReturnsNull = true;
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const row = state.insertedRows[0];
    expect(row.content).toBe("RAW FALLBACK KB");
    expect((row.metadata as Record<string, unknown>).extraction).toBe("raw-fallback");
    expect((await res.json()).data.extraction).toBe("raw-fallback");
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: SENTRY_REASONS.SCRAPE_EXTRACTION_FALLBACK,
        level: "warning",
        extras: expect.objectContaining({ organizationId: "org-1", llmFailed: true }),
      })
    );
  });

  it("extractor THROWS (contract violation) → its OWN reason at error level, fallback stored, import still succeeds", async () => {
    state.llmShouldThrow = new Error("outer try removed");
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect((state.insertedRows[0].metadata as Record<string, unknown>).extraction).toBe("raw-fallback");
    // Review finding: reusing scrape-preview's reason sent on-call to the
    // wrong route first.
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: SENTRY_REASONS.KB_SCRAPE_LLM_EXTRACT_BUG, level: "error" })
    );
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: SENTRY_REASONS.SCRAPE_EXTRACTION_FALLBACK, level: "warning" })
    );
  });

  it("insert failure → 500 with KB_SCRAPE_FAILED (the user already paid for the scrape)", async () => {
    state.insertError = { message: "RLS regression" };
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: SENTRY_REASONS.KB_SCRAPE_FAILED })
    );
  });
});
