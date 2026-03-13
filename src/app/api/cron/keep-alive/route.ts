import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = createAdminClient();

  // Simple query to keep the Supabase project active
  const { error } = await (supabase as any)
    .from("organizations")
    .select("id")
    .limit(1);

  if (error) {
    console.error("[KeepAlive] DB ping failed:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  console.log("[KeepAlive] DB ping successful");
  return NextResponse.json({ ok: true, timestamp: new Date().toISOString() });
}
