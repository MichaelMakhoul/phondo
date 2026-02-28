import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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
