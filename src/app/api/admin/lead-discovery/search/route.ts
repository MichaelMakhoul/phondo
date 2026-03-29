import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { executeSearch } from "@/lib/lead-discovery/search-orchestrator";

const VALID_LIMITS = [10, 25, 50, 100] as const;

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
  const rl = withRateLimit(req, "admin-lead-discovery-search", "adminExpensive");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Max 3 searches per minute." },
      { status: 429, headers: rl.headers }
    );
  }

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
    const result = await executeSearch({ location, professions, limit });
    return NextResponse.json(result, { headers: rl.headers });
  } catch (err) {
    console.error("[Lead Discovery Search] Error:", err);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
