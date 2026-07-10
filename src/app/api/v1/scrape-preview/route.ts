import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { scrapeWebsite, generateKnowledgeBase, extractBusinessInfoWithLLM } from "@/lib/scraper/website-scraper";
import { isUrlAllowedAsync } from "@/lib/security/validation";
import { withRateLimitDistributed } from "@/lib/security/rate-limiter";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { pageSentry } from "@/lib/observability/page-sentry";

/**
 * POST /api/v1/scrape-preview
 *
 * Lightweight scrape endpoint for onboarding — returns scraped data
 * without saving to DB. No org required.
 *
 * Body:
 * - url: string (required) - The website URL to scrape
 */
export async function POST(request: NextRequest) {
  // SCRUM-311: hoisted above the try so the outer catch can attach it
  // to the Sentry extras — the most likely failure (scrapeWebsite:
  // proxy pool exhausted, target 403, DNS fail) needs the URL for
  // on-call to cluster events by site pattern.
  let url: string | undefined;
  try {
    // Rate limit — scrape is a paid-action endpoint (Web Unlocker /
    // proxy pool charges per request). SCRUM-290: shared Postgres-
    // backed limiter, `expensive` profile is `costControl: true`.
    const rl = await withRateLimitDistributed(
      createAdminClient(),
      request,
      "/api/v1/scrape-preview",
      "expensive",
    );
    if (!rl.allowed) {
      // SCRUM-302: scrape-preview fires during onboarding — a user
      // mid-wizard during a Supabase brownout would see "Too many
      // requests" for their first click. Distinguish the two cases.
      const error = rl.failReason === "service-degraded"
        ? "Service temporarily unavailable. Please try again in a moment."
        : "Too many requests. Please try again later.";
      return NextResponse.json(
        { error, failReason: rl.failReason },
        { status: 429, headers: rl.headers }
      );
    }

    const supabase = await createClient();

    // Require auth (for abuse prevention)
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    url = body.url;

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: "Invalid URL provided" }, { status: 400 });
    }

    // SSRF protection — resolves DNS to block private IPs (prevents DNS rebinding)
    if (!(await isUrlAllowedAsync(url))) {
      return NextResponse.json(
        { error: "URL not allowed — internal or private addresses are blocked" },
        { status: 400 }
      );
    }

    // Lighter scrape than full KB import (10 pages, depth 1)
    const scrapedData = await scrapeWebsite(url, {
      maxPages: 10,
      maxDepth: 1,
    });

    // LLM extraction for rich business info (non-fatal — must never fail the
    // scrape). SCRUM-532: null means extraction FAILED (vs found-little) —
    // that switches the KB output to the flagged raw-fallback mode below.
    let llmResult: Awaited<ReturnType<typeof extractBusinessInfoWithLLM>> = null;
    try {
      llmResult = await extractBusinessInfoWithLLM(scrapedData.pages);
    } catch (err) {
      // Should never happen — extractBusinessInfoWithLLM catches internally.
      console.error('[scrape-preview] BUG: extractBusinessInfoWithLLM threw unexpectedly:', err);
      // SCRUM-300: the comment correctly calls this a BUG. Page at
      // ERROR level so the next time the catch-internally contract
      // breaks (OpenAI SDK change, retry-exhaustion, etc.) on-call
      // sees it instead of just a console line.
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.SCRAPE_PREVIEW_LLM_EXTRACT_BUG,
        level: "error",
        err,
        extras: { url },
      });
    }

    // Regex extracts phone/email only; all other fields come from LLM.
    // Regex takes priority where both exist.
    const llmInfo = llmResult ?? {};
    const regexInfo = scrapedData.businessInfo;
    const mergedInfo = {
      name: regexInfo.name || llmInfo.name,
      phone: regexInfo.phone || llmInfo.phone,
      email: regexInfo.email || llmInfo.email,
      address: regexInfo.address || llmInfo.address,
      hours: regexInfo.hours?.length ? regexInfo.hours : llmInfo.hours,
      services: regexInfo.services?.length ? regexInfo.services : llmInfo.services,
      about: regexInfo.about || llmInfo.about,
      faqs: llmInfo.faqs,
      summary: llmInfo.summary,
    };

    // Mutate scrapedData so generateKnowledgeBase picks up merged info
    scrapedData.businessInfo = mergedInfo;
    const extraction = llmResult !== null ? ('structured' as const) : ('raw-fallback' as const);
    const content = generateKnowledgeBase(scrapedData, { mode: extraction });

    return NextResponse.json({
      businessInfo: mergedInfo,
      content,
      totalPages: scrapedData.totalPages,
      // "raw-fallback" = the site was crawled but could not be read into
      // structured form (LLM outage/timeout) — the UI can say so.
      extraction,
    });
  } catch (error) {
    console.error("Scrape preview error:", error);
    // SCRUM-300: route-level catch now pages Sentry.
    // SCRUM-311: `url` is hoisted above the try so it's in scope here
    // for triage. Best-effort: it's absent when the throw originated
    // BEFORE assignment — most realistically a malformed request body
    // making `request.json()` throw, but also a client-construction or
    // auth-SDK throw. A missing `url` extra therefore means "failed
    // during pre-parse/auth", not "Sentry dropped it". pageSentry
    // tolerates an undefined extra value.
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.SCRAPE_PREVIEW_FAILED,
      err: error,
      extras: { url },
    });
    return NextResponse.json({ error: "Failed to scrape website" }, { status: 500 });
  }
}
