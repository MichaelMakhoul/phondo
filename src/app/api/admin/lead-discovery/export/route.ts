import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";
import { withRateLimitDistributed } from "@/lib/security/rate-limiter";
import { loadFilteredBusinesses } from "@/lib/lead-discovery/search-orchestrator";
import type { CrmDetails } from "@/lib/lead-discovery/types";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { pageSentry } from "@/lib/observability/page-sentry";

export async function GET(req: NextRequest) {
  // SCRUM-301: construct ONCE per request — see scan/route.ts.
  const adminClient = createAdminClient();

  // SCRUM-301: rate-limit BEFORE auth so unauth abuse hits the
  // limiter rather than two Postgres lookups. Admin export hits the
  // DB at scale + may trigger downstream API calls →
  // `adminExpensive` is costControl.
  const rl = await withRateLimitDistributed(
    adminClient,
    req,
    "admin-lead-discovery-export",
    "adminExpensive",
  );
  if (!rl.allowed) {
    // SCRUM-302: brownout vs quota distinction.
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

  // Parse query params
  const url = new URL(req.url);
  const location = url.searchParams.get("location") ?? undefined;
  const professionsRaw = url.searchParams.get("professions");
  const professions = professionsRaw ? professionsRaw.split(",").filter(Boolean) : undefined;
  const crmFilter = url.searchParams.get("crmFilter") ?? undefined;

  try {
    const businesses = await loadFilteredBusinesses(
      { location, professions, crmFilter },
      adminClient,
    );

    // Build CSV
    const headers = [
      "Name",
      "Address",
      "Phone",
      "Website",
      "Google Rating",
      "Review Count",
      "Profession",
      "Detected CRM",
      "CRM Confidence",
      "Scan Error",
      "Scanned At",
    ];

    const rows = businesses.map((biz) => {
      const details = biz.detected_crm_details as CrmDetails | null;
      return [
        csvSafe(biz.name),
        csvSafe(biz.address),
        csvSafe(biz.phone),
        csvSafe(biz.website),
        biz.google_rating?.toString() ?? "",
        biz.google_review_count?.toString() ?? "",
        csvSafe(biz.profession),
        csvSafe(biz.detected_crm),
        csvSafe(details?.confidence as string | null),
        csvSafe(biz.website_scan_error),
        biz.website_scanned_at ?? "",
      ];
    });

    const csv = [
      headers.join(","),
      ...rows.map((r) => r.join(",")),
    ].join("\n");

    const filename = `lead-discovery-${new Date().toISOString().split("T")[0]}.csv`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // SCRUM-290 review fix: include rate-limit headers on success so
        // admin clients can back off proactively when nearing the
        // adminExpensive cap. Scan and search return these on 200 too —
        // export was the lone outlier.
        ...rl.headers,
      },
    });
  } catch (err) {
    console.error("[Lead Discovery Export] Error:", err);
    // SCRUM-300: catch-all pages Sentry.
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.LEAD_DISCOVERY_EXPORT_FAILED,
      err,
      extras: { location, professionCount: professions?.length, crmFilter },
    });
    return NextResponse.json(
      { error: "Export failed" },
      { status: 500, headers: rl.headers },
    );
  }
}

function csvSafe(value: string | null | undefined): string {
  if (!value) return "";
  let safe = value;
  // Prevent CSV formula injection (values starting with =, +, -, @, tab, CR)
  if (/^[=+\-@\t\r]/.test(safe)) {
    safe = "'" + safe;
  }
  // Escape double quotes and wrap in quotes if needed
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("'")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
