import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  startOfDay,
  endOfDay,
  parseISO,
} from "date-fns";

/**
 * GET /api/v1/calendar/appointments?month=2026-02
 *
 * Returns appointments for the visible calendar grid range and stats.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's organization
    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single();

    if (!membership) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }

    const organizationId = membership.organization_id as string;

    // Parse month param (YYYY-MM format)
    const monthParam = request.nextUrl.searchParams.get("month");
    let targetDate: Date;
    if (monthParam) {
      targetDate = parseISO(`${monthParam}-01`);
      if (isNaN(targetDate.getTime())) {
        return NextResponse.json(
          { error: "Invalid month format. Use YYYY-MM." },
          { status: 400 }
        );
      }
    } else {
      targetDate = new Date();
    }

    // Compute visible date range for calendar grid (Monday start)
    const weekOptions = { weekStartsOn: 1 as const };
    const monthStart = startOfMonth(targetDate);
    const monthEnd = endOfMonth(targetDate);
    const gridStart = startOfWeek(monthStart, weekOptions);
    const gridEnd = endOfWeek(monthEnd, weekOptions);

    // Fetch active appointments in range. SCRUM-388: exclude both terminal states
    // (cancelled + the superseded `rescheduled` leg) so a month-nav refetch matches
    // the server's initial load (calendar/page.tsx) — the day-detail list and grid
    // must not show moved-away/cancelled rows as if they were live.
    const { data: appointments, error: apptError } = await (supabase as any)
      .from("appointments")
      .select("*")
      .eq("organization_id", organizationId)
      .neq("status", "cancelled")
      .neq("status", "rescheduled")
      .gte("start_time", gridStart.toISOString())
      .lte("start_time", gridEnd.toISOString())
      .order("start_time", { ascending: true });

    if (apptError) {
      // SCRUM-430 (finding #40): log detail server-side, return generic.
      console.error("Calendar appointments DB error:", apptError);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }

    // Compute stats (today / this week / this month), excluding cancelled + rescheduled (SCRUM-388)
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const weekStart = startOfWeek(now, weekOptions);
    const weekEnd = endOfWeek(now, weekOptions);
    const thisMonthStart = startOfMonth(now);
    const thisMonthEnd = endOfMonth(now);

    const [todayResult, weekResult, monthResult] = await Promise.all([
      (supabase as any)
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .neq("status", "cancelled")
        .neq("status", "rescheduled")
        .gte("start_time", todayStart.toISOString())
        .lte("start_time", todayEnd.toISOString()),
      (supabase as any)
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .neq("status", "cancelled")
        .neq("status", "rescheduled")
        .gte("start_time", weekStart.toISOString())
        .lte("start_time", weekEnd.toISOString()),
      (supabase as any)
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .neq("status", "cancelled")
        .neq("status", "rescheduled")
        .gte("start_time", thisMonthStart.toISOString())
        .lte("start_time", thisMonthEnd.toISOString()),
    ]);

    const stats = {
      today: todayResult.count ?? 0,
      thisWeek: weekResult.count ?? 0,
      thisMonth: monthResult.count ?? 0,
    };

    return NextResponse.json({ appointments: appointments || [], stats });
  } catch (error) {
    console.error("Error fetching calendar appointments:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
