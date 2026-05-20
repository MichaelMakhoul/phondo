import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";
import { withRateLimitDistributed } from "@/lib/security/rate-limiter";
import { executeSearch } from "@/lib/lead-discovery/search-orchestrator";
import { classifyLeadDiscoveryFailure } from "@/lib/lead-discovery/errors";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { pageSentry } from "@/lib/observability/page-sentry";

const VALID_LIMITS = [10, 25, 50, 100] as const;

export async function POST(req: NextRequest) {
  // SCRUM-301: construct ONCE per request — see scan/route.ts for
  // the full rationale.
  const adminClient = createAdminClient();

  // SCRUM-301: rate-limit BEFORE auth. Google Places API charges per
  // call → `adminExpensive` is costControl.
  const rl = await withRateLimitDistributed(
    adminClient,
    req,
    "admin-lead-discovery-search",
    "adminExpensive",
  );
  if (!rl.allowed) {
    // SCRUM-302: brownout vs quota distinction.
    // SCRUM-301 review: harmonised wording with scan/export (the old
    // "Max 3 searches per minute" leaked the exact cap to unauthenticated
    // probes; the standard X-RateLimit-* headers already carry the
    // contract for legitimate clients).
    const error = rl.failReason === "service-degraded"
      ? "Service temporarily unavailable. Please try again in a moment."
      : "Rate limit exceeded";
    return NextResponse.json(
      { error, failReason: rl.failReason },
      { status: 429, headers: rl.headers }
    );
  }

  // SCRUM-301: auth + admin gates run AFTER rate-limit.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isPlatformAdmin(user.id, adminClient)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Parse & validate body
  let body: { location?: string; professions?: string[]; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const location = body.location?.trim();
  if (!location || location.length < 2 || location.length > 200) {
    return NextResponse.json({ error: "Location must be 2-200 characters" }, { status: 400 });
  }

  const professions = body.professions;
  if (!Array.isArray(professions) || professions.length === 0) {
    return NextResponse.json({ error: "At least one profession is required" }, { status: 400 });
  }
  if (professions.length > 25) {
    return NextResponse.json({ error: "Max 25 professions per search" }, { status: 400 });
  }
  if (professions.some((p: unknown) => typeof p !== "string" || (p as string).trim().length === 0 || (p as string).length > 100)) {
    return NextResponse.json({ error: "Invalid profession value" }, { status: 400 });
  }

  const limit = body.limit ?? 25;
  if (!VALID_LIMITS.includes(limit as (typeof VALID_LIMITS)[number])) {
    return NextResponse.json(
      { error: `Limit must be one of: ${VALID_LIMITS.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const result = await executeSearch({ location, professions, limit }, adminClient);
    return NextResponse.json(result, { headers: rl.headers });
  } catch (err) {
    console.error("[Lead Discovery Search] Error:", err);
    // SCRUM-300: catch-all pages Sentry.
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.LEAD_DISCOVERY_SEARCH_FAILED,
      err,
      // SCRUM-309: failureKind discriminator as a filterable TAG
      // (google-places | db-query | unknown). `location` stays an
      // extra — it's free-text and would pollute the tag index.
      tags: { failureKind: classifyLeadDiscoveryFailure(err) },
      extras: { location, professionCount: professions.length, limit },
    });
    // SCRUM-301 review: include `rl.headers` on the 500 path so the
    // admin client doesn't lose its quota state when executeSearch
    // throws (matches export-route behaviour from SCRUM-290).
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500, headers: rl.headers },
    );
  }
}
