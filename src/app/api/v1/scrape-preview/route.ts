import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scrapeWebsite, generateKnowledgeBase, extractBusinessInfoWithLLM } from "@/lib/scraper/website-scraper";
import { isUrlAllowedAsync } from "@/lib/security/validation";
import { withRateLimit } from "@/lib/security/rate-limiter";

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
  try {
    // Rate limit - expensive operation
    const { allowed, headers } = withRateLimit(request, "/api/v1/scrape-preview", "expensive");
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers }
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
    const { url } = body;

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

    // LLM extraction for rich business info (non-fatal — must never fail the scrape)
    let llmInfo: Awaited<ReturnType<typeof extractBusinessInfoWithLLM>> = {};
    try {
      llmInfo = await extractBusinessInfoWithLLM(scrapedData.pages);
    } catch (err) {
      // Should never happen — extractBusinessInfoWithLLM catches internally.
      console.error('[scrape-preview] BUG: extractBusinessInfoWithLLM threw unexpectedly:', err);
    }

    // Regex extracts phone/email only; all other fields come from LLM.
    // Regex takes priority where both exist.
    const regexInfo = scrapedData.businessInfo;
    const mergedInfo = {
      name: regexInfo.name || llmInfo.name,
      phone: regexInfo.phone || llmInfo.phone,
      email: regexInfo.email || llmInfo.email,
      address: regexInfo.address || llmInfo.address,
      hours: regexInfo.hours?.length ? regexInfo.hours : llmInfo.hours,
      services: regexInfo.services?.length ? regexInfo.services : llmInfo.services,
      about: regexInfo.about || llmInfo.about,
    };

    // Mutate scrapedData so generateKnowledgeBase picks up merged info
    scrapedData.businessInfo = mergedInfo;
    const content = generateKnowledgeBase(scrapedData);

    return NextResponse.json({
      businessInfo: mergedInfo,
      content,
      totalPages: scrapedData.totalPages,
    });
  } catch (error) {
    console.error("Scrape preview error:", error);
    return NextResponse.json({ error: "Failed to scrape website" }, { status: 500 });
  }
}
