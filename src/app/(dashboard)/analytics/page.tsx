import { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { subDays, startOfDay, format, getDay } from "date-fns";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  PhoneCall,
  PhoneIncoming,
  Calendar,
  Clock,
  DollarSign,
  TrendingUp,
  Lock,
} from "lucide-react";
import { RecentCallsList } from "./recent-calls-list";
import { AnimatedStat } from "@/components/marketing/animated-stat";
import { AnalyticsCharts } from "./analytics-charts";
import { OutcomeChart } from "./outcome-chart";
import { DurationChart } from "./duration-chart";
import { CallHeatmap } from "./call-heatmap";
import { ExportButton } from "./export-button";

export const metadata: Metadata = {
  title: "Analytics | Hola Recep",
  description: "View call metrics and ROI insights",
};

interface CallStats {
  total: number;
  answered: number;
  missed: number;
  voicemail: number;
  spam: number;
  transferred: number;
  totalDuration: number;
  appointments: number;
}

interface DailyStats {
  date: string;
  calls: number;
  answered: number;
  appointments: number;
}

export default async function AnalyticsPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    redirect("/onboarding");
  }

  const organizationId = membership.organization_id as string;

  const showAdvanced = await hasFeatureAccess(organizationId, "advancedAnalytics");

  const { data: organization } = await (supabase as any)
    .from("organizations")
    .select("industry, business_name")
    .eq("id", organizationId)
    .single();

  const thirtyDaysAgo = startOfDay(subDays(new Date(), 30));

  const { data: calls } = await (supabase as any)
    .from("calls")
    .select("id, status, is_spam, duration_seconds, created_at, outcome, action_taken")
    .eq("organization_id", organizationId)
    .gte("created_at", thirtyDaysAgo.toISOString())
    .order("created_at", { ascending: false });

  const { data: appointments } = await (supabase as any)
    .from("appointments")
    .select("id, created_at")
    .eq("organization_id", organizationId)
    .gte("created_at", thirtyDaysAgo.toISOString());

  const callsList = calls || [];
  const appointmentsList = appointments || [];

  const stats: CallStats = {
    total: callsList.length,
    answered: callsList.filter((c: any) => c.status === "completed" && !c.is_spam).length,
    missed: callsList.filter((c: any) => c.status === "no-answer" || c.status === "busy").length,
    voicemail: callsList.filter((c: any) => c.outcome === "voicemail").length,
    spam: callsList.filter((c: any) => c.is_spam === true).length,
    transferred: callsList.filter((c: any) => c.action_taken === "transferred").length,
    totalDuration: callsList.reduce((sum: number, c: any) => sum + (c.duration_seconds || 0), 0),
    appointments: appointmentsList.length,
  };

  // Daily stats for bar chart
  const dailyStatsMap = new Map<string, DailyStats>();
  for (let i = 29; i >= 0; i--) {
    const date = format(subDays(new Date(), i), "yyyy-MM-dd");
    dailyStatsMap.set(date, { date, calls: 0, answered: 0, appointments: 0 });
  }

  callsList.forEach((call: any) => {
    const date = format(new Date(call.created_at), "yyyy-MM-dd");
    const dayStats = dailyStatsMap.get(date);
    if (dayStats) {
      dayStats.calls++;
      if (call.status === "completed" && !call.is_spam) {
        dayStats.answered++;
      }
    }
  });

  appointmentsList.forEach((apt: any) => {
    const date = format(new Date(apt.created_at), "yyyy-MM-dd");
    const dayStats = dailyStatsMap.get(date);
    if (dayStats) {
      dayStats.appointments++;
    }
  });

  const dailyStats: DailyStats[] = Array.from(dailyStatsMap.values());

  // 7x24 heatmap data (day of week x hour)
  const heatmapData: { day: number; hour: number; count: number }[] = [];
  const heatmapMap = new Map<string, number>();
  callsList.forEach((call: any) => {
    const d = new Date(call.created_at);
    // getDay returns 0=Sun, convert to 0=Mon
    const rawDay = getDay(d);
    const day = rawDay === 0 ? 6 : rawDay - 1;
    const hour = d.getHours();
    const key = `${day}-${hour}`;
    heatmapMap.set(key, (heatmapMap.get(key) || 0) + 1);
  });
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      heatmapData.push({ day, hour, count: heatmapMap.get(`${day}-${hour}`) || 0 });
    }
  }

  // Duration trends: avg call duration per day
  const durationByDate = new Map<string, { total: number; count: number }>();
  callsList.forEach((call: any) => {
    if (call.status === "completed" && !call.is_spam && call.duration_seconds) {
      const date = format(new Date(call.created_at), "yyyy-MM-dd");
      const entry = durationByDate.get(date) || { total: 0, count: 0 };
      entry.total += call.duration_seconds;
      entry.count++;
      durationByDate.set(date, entry);
    }
  });
  const durationData = dailyStats
    .filter((d) => durationByDate.has(d.date))
    .map((d) => {
      const entry = durationByDate.get(d.date)!;
      return { date: d.date, avgSeconds: Math.round(entry.total / entry.count) };
    });

  // Outcome data for donut chart
  const outcomeData = [
    { name: "Answered", value: stats.answered, color: "hsl(142, 71%, 45%)" },
    { name: "Missed", value: stats.missed, color: "hsl(0, 84%, 60%)" },
    { name: "Voicemail", value: stats.voicemail, color: "hsl(48, 96%, 53%)" },
    { name: "Transferred", value: stats.transferred, color: "hsl(221, 83%, 53%)" },
    { name: "Spam", value: stats.spam, color: "hsl(25, 95%, 53%)" },
  ];

  // ROI calculation
  const callValues: Record<string, number> = {
    dental: 850,
    legal: 500,
    home_services: 350,
    medical: 400,
    real_estate: 750,
    other: 300,
  };
  const industry = organization?.industry || "other";
  const avgCallValue = callValues[industry] || 300;
  const estimatedMissedWithoutAI = Math.round(stats.answered * 0.6);
  const estimatedRevenueSaved = estimatedMissedWithoutAI * avgCallValue;

  const avgDuration = stats.answered > 0
    ? Math.round(stats.totalDuration / stats.answered)
    : 0;

  const answerRate = stats.total > 0
    ? Math.min(100, Math.round((stats.answered / Math.max(stats.total - stats.spam, 1)) * 100))
    : 0;

  // Conversion rate: appointments / answered calls (capped at 100%)
  const conversionRate = stats.answered > 0
    ? Math.min(100, Math.round((stats.appointments / stats.answered) * 100))
    : 0;

  const recentCalls = callsList.slice(0, 10);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-muted-foreground">
            Track your AI receptionist's performance and ROI (Last 30 days)
          </p>
        </div>
        {showAdvanced && <ExportButton />}
      </div>

      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Calls</CardTitle>
            <PhoneCall className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <AnimatedStat value={String(stats.total)} className="text-2xl font-bold" />
            <p className="text-xs text-muted-foreground">
              {stats.spam} spam filtered
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Answered</CardTitle>
            <PhoneIncoming className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <AnimatedStat value={String(stats.answered)} className="text-2xl font-bold" />
            <p className="text-xs text-muted-foreground">
              {answerRate}% answer rate
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Appointments</CardTitle>
            <Calendar className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <AnimatedStat value={String(stats.appointments)} className="text-2xl font-bold" />
            <p className="text-xs text-muted-foreground">
              Booked by AI
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Duration</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <AnimatedStat
              value={`${Math.floor(avgDuration / 60)}:${String(avgDuration % 60).padStart(2, "0")}`}
              className="text-2xl font-bold"
            />
            <p className="text-xs text-muted-foreground">
              Per call
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Advanced Analytics — gated by plan */}
      {showAdvanced ? (
        <>
          {/* ROI Estimate */}
          <Card className="bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950 dark:to-emerald-950 border-green-200 dark:border-green-800">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-green-600" />
                Estimated Value
              </CardTitle>
              <CardDescription>
                Revenue protected by your AI receptionist
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <p className="text-sm text-muted-foreground">Calls Answered</p>
                  <p className="text-2xl font-bold">{stats.answered}</p>
                  <p className="text-xs text-muted-foreground">
                    That might have been missed
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">
                    Avg. {industry.replace("_", " ")} Call Value
                  </p>
                  <p className="text-2xl font-bold">${avgCallValue}</p>
                  <p className="text-xs text-muted-foreground">
                    Industry average
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Est. Revenue Protected</p>
                  <p className="text-3xl font-bold text-green-600">
                    ${estimatedRevenueSaved.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Based on ~60% missed call prevention
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Charts Row 1: Call Volume + Outcome Donut */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Call Volume (30 Days)</CardTitle>
                <CardDescription>Daily call trends</CardDescription>
              </CardHeader>
              <CardContent>
                <AnalyticsCharts dailyStats={dailyStats} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Call Outcomes</CardTitle>
                <CardDescription>How calls were handled</CardDescription>
              </CardHeader>
              <CardContent>
                <OutcomeChart data={outcomeData} />
              </CardContent>
            </Card>
          </div>

          {/* Charts Row 2: Duration Trends + Conversion Rate */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Avg Call Duration</CardTitle>
                <CardDescription>Daily average over the last 30 days</CardDescription>
              </CardHeader>
              <CardContent>
                {durationData.length > 0 ? (
                  <DurationChart data={durationData} />
                ) : (
                  <div className="flex items-center justify-center h-[280px] text-muted-foreground text-sm">
                    No duration data yet
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-blue-600" />
                  Conversion Rate
                </CardTitle>
                <CardDescription>Calls that led to appointments</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col items-center justify-center h-[280px]">
                  <AnimatedStat value={`${conversionRate}%`} className="text-5xl font-bold" />
                  <p className="text-muted-foreground mt-2">
                    {stats.appointments} appointments from {stats.answered} answered calls
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* 7x24 Heatmap */}
          <Card>
            <CardHeader>
              <CardTitle>Peak Call Hours</CardTitle>
              <CardDescription>
                Call distribution by day of week and hour
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CallHeatmap data={heatmapData} />
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Lock className="h-10 w-10 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-1">Advanced Analytics</h3>
            <p className="text-sm text-muted-foreground text-center max-w-md mb-4">
              Unlock ROI estimates, call volume trends, outcome breakdowns, duration charts,
              heatmap, and CSV export with a Professional or Business plan.
            </p>
            <Button asChild>
              <Link href="/billing">View Plans</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Recent Calls */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Calls</CardTitle>
          <CardDescription>
            Quick overview of the latest calls
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RecentCallsList calls={recentCalls} />
        </CardContent>
      </Card>
    </div>
  );
}
