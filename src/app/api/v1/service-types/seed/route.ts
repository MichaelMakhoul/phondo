import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getServiceDefaults } from "@/lib/service-types/defaults";
import { serviceTypesFromScraped } from "@/lib/service-types/from-scraped";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { organizationId, industry, scrapedServices } = await request.json();
    if (!organizationId) return NextResponse.json({ error: "organizationId required" }, { status: 400 });

    // Verify membership
    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .eq("organization_id", organizationId)
      .single();
    if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const admin = createAdminClient();

    // Check if service types already exist (idempotent)
    const { count, error: countError } = await (admin as any)
      .from("service_types")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);

    if (countError) {
      console.error("[ServiceTypes] Count query failed:", countError);
      return NextResponse.json({ error: "Failed to check existing service types" }, { status: 500 });
    }

    if (count && count > 0) {
      return NextResponse.json({ seeded: false, message: "Service types already exist" });
    }

    // SCRUM-515: prefer the services the business actually advertises. A Toyota
    // dealership seeded from the generic table offers callers a "standard
    // consultation" and denies knowing anything about car servicing, while the
    // knowledge base recites the real list — the AI reciting one thing and
    // booking another. Scraped names win; the industry table is the fallback
    // when the scrape found nothing usable (an org with no service types cannot
    // book at all).
    const industryDefaults = getServiceDefaults(industry || "other");
    // A scraped "Root Canal" adopts the 90 minutes the dental table already
    // knows about, rather than the neutral 30 — real knowledge, not a guess.
    const scraped = serviceTypesFromScraped(scrapedServices, industryDefaults);
    const source = scraped.length > 0 ? "scraped" : "industry-defaults";
    const defaults = scraped.length > 0 ? scraped : industryDefaults;

    const rows = defaults.map((d, i) => ({
      organization_id: organizationId,
      name: d.name,
      duration_minutes: d.duration_minutes,
      description: d.description || null,
      sort_order: i,
    }));

    const { error } = await (admin as any).from("service_types").insert(rows);
    if (error) {
      console.error("[ServiceTypes] Seed failed:", error);
      return NextResponse.json({ error: "Failed to seed service types" }, { status: 500 });
    }

    return NextResponse.json({ seeded: true, count: rows.length, source });
  } catch (err) {
    console.error("[ServiceTypes] Seed error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
