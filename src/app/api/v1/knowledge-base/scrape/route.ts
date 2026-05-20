import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { scrapeWebsite, generateKnowledgeBase } from "@/lib/scraper/website-scraper";
import { isUrlAllowed } from "@/lib/security/validation";
import { withRateLimitDistributed } from "@/lib/security/rate-limiter";
import { resyncOrgAssistants } from "@/lib/knowledge-base";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { pageSentry } from "@/lib/observability/page-sentry";

/**
 * POST /api/v1/knowledge-base/scrape
 *
 * Scrapes a website and generates knowledge base content
 *
 * Body:
 * - url: string (required) - The website URL to scrape
 * - title: string (optional) - Title for the KB entry (defaults to domain name)
 * - maxPages: number (optional) - Maximum pages to scrape (default: 20)
 */
export async function POST(request: NextRequest) {
  try {
    // Rate limit — KB scrape is paid-action (Web Unlocker / proxy
    // pool charges per request). SCRUM-290: shared Postgres-backed
    // limiter, `expensive` profile is `costControl: true`.
    const rl = await withRateLimitDistributed(
      createAdminClient(),
      request,
      "/api/v1/knowledge-base/scrape",
      "expensive",
    );
    if (!rl.allowed) {
      // SCRUM-302: brownout-deny vs quota-deny UX distinction.
      const error = rl.failReason === "service-degraded"
        ? "Service temporarily unavailable. Please try again in a moment."
        : "Too many requests. Please try again later.";
      return NextResponse.json(
        { error, failReason: rl.failReason },
        { status: 429, headers: rl.headers }
      );
    }

    const supabase = await createClient();

    // Check authentication
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get user's organization
    const { data: membership, error: membershipError } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single();

    if (membershipError || !membership) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 403 }
      );
    }

    const organizationId = membership.organization_id as string;

    // Parse request body
    const body = await request.json();
    const { url, title, maxPages = 20 } = body;

    if (!url) {
      return NextResponse.json(
        { error: "URL is required" },
        { status: 400 }
      );
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return NextResponse.json(
        { error: "Invalid URL provided" },
        { status: 400 }
      );
    }

    // SSRF Protection: Prevent scraping internal/private networks
    if (!isUrlAllowed(url)) {
      return NextResponse.json(
        { error: "URL not allowed - internal or private addresses are blocked" },
        { status: 400 }
      );
    }

    // Scrape the website
    const scrapedData = await scrapeWebsite(url, {
      maxPages: Math.min(maxPages, 50), // Cap at 50 pages
      maxDepth: 2,
    });

    // Generate knowledge base content
    const knowledgeBaseContent = generateKnowledgeBase(scrapedData);

    // Derive title from domain if not provided
    let entryTitle = title;
    if (!entryTitle) {
      try {
        entryTitle = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        entryTitle = "Website Import";
      }
    }

    // Save as org-level KB entry (no assistant_id)
    const { error: insertError } = await (supabase as any)
      .from("knowledge_bases")
      .insert({
        organization_id: organizationId,
        assistant_id: null,
        title: entryTitle,
        source_type: "website",
        source_url: url,
        content: knowledgeBaseContent,
        metadata: {
          totalPages: scrapedData.totalPages,
          scrapedAt: scrapedData.scrapedAt,
          businessInfo: scrapedData.businessInfo,
        },
        is_active: true,
      });

    if (insertError) {
      console.error("Failed to save knowledge base:", insertError);
      // SCRUM-300 review: the user has already paid for the full
      // scrape + LLM extract by the time we reach here. A user
      // pressing "try again" re-spends. If insert is wedged (column
      // rename in a migration, RLS regression, etc.) the user burns
      // money in a retry loop with no on-call signal. Page Sentry.
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.KB_SCRAPE_FAILED,
        err: insertError,
        extras: { organizationId, url },
      });
      return NextResponse.json(
        { error: "Scraped successfully but failed to save. Please try again." },
        { status: 500 }
      );
    }

    // Resync all org assistants with updated KB
    let resyncWarning: string | undefined;
    try {
      await resyncOrgAssistants(supabase, organizationId);
    } catch (err) {
      console.error("Failed to resync assistants:", err);
      // SCRUM-300: KB is saved but the assistant prompt didn't refresh.
      // User sees the `resyncWarning` in the response, but without
      // Sentry on-call wouldn't know a systemic regression in
      // resyncOrgAssistants is happening across orgs.
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.KB_SCRAPE_RESYNC_FAILED,
        err,
        extras: { organizationId },
      });
      resyncWarning = "Knowledge base saved, but assistants may take a moment to reflect changes.";
    }

    return NextResponse.json({
      success: true,
      ...(resyncWarning && { warning: resyncWarning }),
      data: {
        url: scrapedData.baseUrl,
        totalPages: scrapedData.totalPages,
        businessInfo: scrapedData.businessInfo,
        content: knowledgeBaseContent,
        contentLength: knowledgeBaseContent.length,
        pages: scrapedData.pages.map((p) => ({
          url: p.url,
          title: p.title,
          contentLength: p.content.length,
        })),
      },
    });
  } catch (error: any) {
    console.error("Scrape error:", error);
    // SCRUM-300: route-level catch now pages Sentry. `url` and
    // `organizationId` are declared inside the try and not in scope
    // here — adding them requires hoisting, tracked separately to
    // keep this change focused.
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.KB_SCRAPE_FAILED,
      err: error,
    });
    // Don't expose internal error details to client
    return NextResponse.json(
      { error: "Failed to scrape website" },
      { status: 500 }
    );
  }
}
