import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";
import { withRateLimitDistributed } from "@/lib/security/rate-limiter";
import { scanBusinessCRMs } from "@/lib/lead-discovery/search-orchestrator";
import { isValidUUID } from "@/lib/security/validation";

export async function POST(req: NextRequest) {
  // SCRUM-301: construct the admin client ONCE per request so it can
  // be threaded through the rate-limit RPC, the isPlatformAdmin check,
  // and the orchestrator without each layer spinning up a new
  // SupabaseClient + GoTrueClient + RealtimeClient + Postgrest stack.
  const adminClient = createAdminClient();

  // SCRUM-301: rate-limit BEFORE auth so unauthenticated attackers
  // hammering the endpoint hit the limiter (cheap, IP-keyed) rather
  // than the auth + isPlatformAdmin Postgres lookups. Google Places
  // API charges per call → `adminExpensive` is costControl (fails
  // CLOSED on RPC error rather than reopening the per-instance bypass).
  const rl = await withRateLimitDistributed(
    adminClient,
    req,
    "admin-lead-discovery-scan",
    "adminExpensive",
  );
  if (!rl.allowed) {
    // SCRUM-302: brownout-deny vs quota-deny.
    const error = rl.failReason === "service-degraded"
      ? "Service temporarily unavailable. Please try again in a moment."
      : "Rate limit exceeded";
    return NextResponse.json(
      { error, failReason: rl.failReason },
      { status: 429, headers: rl.headers }
    );
  }

  // Auth + admin gates run AFTER the rate-limit check.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isPlatformAdmin(user.id, adminClient)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
    const businesses = await scanBusinessCRMs(ids, adminClient);
    return NextResponse.json({ businesses }, { headers: rl.headers });
  } catch (err) {
    console.error("[Lead Discovery Scan] Error:", err);
    // SCRUM-301 review: include `rl.headers` on the 500 path so the
    // admin client doesn't lose its quota state when scanBusinessCRMs
    // throws (matches export-route behaviour from SCRUM-290).
    return NextResponse.json(
      { error: "Scan failed" },
      { status: 500, headers: rl.headers },
    );
  }
}
