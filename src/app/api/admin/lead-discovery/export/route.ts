import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { loadFilteredBusinesses } from "@/lib/lead-discovery/search-orchestrator";
import type { CrmDetails } from "@/lib/lead-discovery/types";

export async function GET(req: NextRequest) {
  // Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isPlatformAdmin(user.id)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Rate limit
  const rl = withRateLimit(req, "admin-lead-discovery-export", "adminExpensive");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: rl.headers }
    );
  }

  // Parse query params
  const url = new URL(req.url);
  const location = url.searchParams.get("location") ?? undefined;
  const professionsRaw = url.searchParams.get("professions");
  const professions = professionsRaw ? professionsRaw.split(",").filter(Boolean) : undefined;
  const crmFilter = url.searchParams.get("crmFilter") ?? undefined;

  try {
    const businesses = await loadFilteredBusinesses({
      location,
      professions,
      crmFilter,
    });

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
      },
    });
  } catch (err) {
    console.error("[Lead Discovery Export] Error:", err);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
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
