import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CalendarDashboard } from "./calendar-dashboard";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  startOfDay,
  endOfDay,
} from "date-fns";

export const metadata: Metadata = {
  title: "Calendar | Phondo",
  description: "View your appointment schedule",
};

export default async function CalendarPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Get user's organization
  const { data: membership } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    redirect("/onboarding");
  }

  const organizationId = membership.organization_id as string;

  // Compute date ranges
  const now = new Date();
  const weekOptions = { weekStartsOn: 1 as const };
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);
  const gridStart = startOfWeek(monthStart, weekOptions);
  const gridEnd = endOfWeek(monthEnd, weekOptions);
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const thisWeekStart = startOfWeek(now, weekOptions);
  const thisWeekEnd = endOfWeek(now, weekOptions);

  // Fetch all data in parallel
  const [
    appointmentsResult,
    orgResult,
    calendarResult,
    todayCount,
    weekCount,
    monthCount,
  ] = await Promise.all([
    // Appointments for visible grid range
    (supabase as any)
      .from("appointments")
      .select("*")
      .eq("organization_id", organizationId)
      .gte("start_time", gridStart.toISOString())
      .lte("start_time", gridEnd.toISOString())
      .order("start_time", { ascending: true }),

    // Organization details
    (supabase as any)
      .from("organizations")
      .select("business_hours, timezone, business_name")
      .eq("id", organizationId)
      .single(),

    // Calendar integration status
    (supabase as any)
      .from("calendar_integrations")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .limit(1),

    // Stats: today
    (supabase as any)
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .neq("status", "cancelled")
      .gte("start_time", todayStart.toISOString())
      .lte("start_time", todayEnd.toISOString()),

    // Stats: this week
    (supabase as any)
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .neq("status", "cancelled")
      .gte("start_time", thisWeekStart.toISOString())
      .lte("start_time", thisWeekEnd.toISOString()),

    // Stats: this month
    (supabase as any)
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .neq("status", "cancelled")
      .gte("start_time", monthStart.toISOString())
      .lte("start_time", monthEnd.toISOString()),
  ]);

  const appointments = appointmentsResult.data || [];
  const org = orgResult.data;
  const calendarConnected =
    calendarResult.data && calendarResult.data.length > 0;

  const stats = {
    today: todayCount.count ?? 0,
    thisWeek: weekCount.count ?? 0,
    thisMonth: monthCount.count ?? 0,
  };

  return (
    <CalendarDashboard
      initialAppointments={appointments}
      initialStats={stats}
      businessHours={org?.business_hours ?? null}
      timezone={org?.timezone ?? null}
      businessName={org?.business_name ?? null}
      calendarConnected={!!calendarConnected}
    />
  );
}
