import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { scanBusinessCRMs } from "@/lib/lead-discovery/search-orchestrator";
import { isValidUUID } from "@/lib/security/validation";

export async function POST(req: NextRequest) {
  // Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isPlatformAdmin(user.id)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Rate limit
  const rl = withRateLimit(req, "admin-lead-discovery-scan", "adminExpensive");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: rl.headers }
    );
  }

  // Parse body
  let body: { businessIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = body.businessIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "businessIds array is required" }, { status: 400 });
  }
  if (ids.length > 100) {
    return NextResponse.json({ error: "Max 100 businesses per scan" }, { status: 400 });
  }
  if (!ids.every(isValidUUID)) {
    return NextResponse.json({ error: "Invalid business ID format" }, { status: 400 });
  }

  try {
    const businesses = await scanBusinessCRMs(ids);
    return NextResponse.json({ businesses }, { headers: rl.headers });
  } catch (err) {
    console.error("[Lead Discovery Scan] Error:", err);
    return NextResponse.json({ error: "Scan failed" }, { status: 500 });
  }
}
