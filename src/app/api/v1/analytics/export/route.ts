import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { subDays, startOfDay, format } from "date-fns";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    return NextResponse.json({ error: "No organization" }, { status: 403 });
  }

  const orgId = membership.organization_id as string;

  const hasAccess = await hasFeatureAccess(orgId, "advancedAnalytics");
  if (!hasAccess) {
    return NextResponse.json({ error: "Upgrade to Professional or Business to export data" }, { status: 403 });
  }

  const thirtyDaysAgo = startOfDay(subDays(new Date(), 30));

  const { data: calls, error } = await (supabase as any)
    .from("calls")
    .select("id, status, is_spam, duration_seconds, created_at, outcome, action_taken, caller_phone, caller_name, summary")
    .eq("organization_id", orgId)
    .gte("created_at", thirtyDaysAgo.toISOString())
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch calls" }, { status: 500 });
  }

  const rows = (calls || []).map((c: any) => {
    const date = new Date(c.created_at);
    const duration = c.duration_seconds || 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    return [
      format(date, "yyyy-MM-dd"),
      format(date, "HH:mm:ss"),
      `${mins}:${String(secs).padStart(2, "0")}`,
      c.status || "",
      c.outcome || "",
      c.caller_name || "",
      c.caller_phone || "",
      c.is_spam ? "Yes" : "No",
      c.action_taken || "",
      (c.summary || "").replace(/"/g, '""'),
    ];
  });

  const header = "Date,Time,Duration,Status,Outcome,Caller Name,Caller Phone,Spam,Action,Summary";
  const csv = [header, ...rows.map((r: string[]) => r.map((v) => `"${v}"`).join(","))].join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="calls-export-${format(new Date(), "yyyy-MM-dd")}.csv"`,
    },
  });
}
