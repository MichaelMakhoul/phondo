import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[Cron] CRON_SECRET not configured — cron route cannot authenticate");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data, error } = await (supabase as any)
    .from("callback_requests")
    .update({ status: "expired", expired_at: new Date().toISOString() })
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .select("id");

  if (error) {
    console.error("[Cron] Failed to expire callbacks:", error);
    return NextResponse.json({ error: "Failed to expire callbacks" }, { status: 500 });
  }

  const count = data?.length ?? 0;
  console.log(`[Cron] Expired ${count} stale callbacks`);

  return NextResponse.json({ expired: count });
}
