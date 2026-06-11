import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const checks: Record<string, string> = {};

  // Check Supabase connectivity using admin client (service-role key bypasses RLS)
  try {
    const supabase = createAdminClient();
    const { error } = await (supabase as any)
      .from("organizations")
      .select("id")
      .limit(1);
    if (error) {
      console.error("[HealthCheck] Database query error:", error.message, error.code);
      checks.database = "error";
    } else {
      checks.database = "ok";
    }
  } catch (error) {
    console.error("[HealthCheck] Database connection failed:", error);
    checks.database = "error";
  }

  // Check required env vars are set
  const requiredEnvVars = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missingCount = requiredEnvVars.filter((key) => !process.env[key]).length;
  if (missingCount > 0) {
    console.error("[HealthCheck] Missing", missingCount, "required env var(s)");
  }
  checks.config = missingCount === 0 ? "ok" : "error";

  const healthy = Object.values(checks).every((status) => status === "ok");

  // Detailed response only for authenticated callers
  const authHeader = request.headers.get("authorization");
  const isAuthorized =
    process.env.HEALTH_CHECK_SECRET &&
    authHeader === `Bearer ${process.env.HEALTH_CHECK_SECRET}`;

  if (isAuthorized) {
    return NextResponse.json(
      {
        status: healthy ? "ok" : "degraded",
        checks,
        timestamp: new Date().toISOString(),
      },
      { status: healthy ? 200 : 503 }
    );
  }

  // Public response — minimal info
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded" },
    { status: healthy ? 200 : 503 }
  );
}
