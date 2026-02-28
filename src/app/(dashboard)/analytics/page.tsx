import { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { subDays, startOfDay, format } from "date-fns";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  Calendar,
  Clock,
  DollarSign,
  TrendingUp,
  ShieldAlert,
  Users,
  Lock,
} from "lucide-react";
import { AnalyticsCharts } from "./analytics-charts";
import { RecentCallsList } from "./recent-calls-list";
import { AnimatedStat } from "@/components/marketing/animated-stat";

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

interface HourlyStats {
  hour: number;
  calls: number;
}

export default async function AnalyticsPage() {
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

  const showAdvanced = await hasFeatureAccess(organizationId, "advancedAnalytics");

  // Get organization details for industry-specific ROI
  const { data: organization } = await (supabase as any)
    .from("organizations")
    .select("industry, business_name")
    .eq("id", organizationId)
    .single();

  // Get calls from the last 30 days
  const thirtyDaysAgo = startOfDay(subDays(new Date(), 30));

  const { data: calls } = await (supabase as any)
    .from("calls")
    .select("id, status, is_spam, duration_seconds, created_at, outcome, action_taken")
    .eq("organization_id", organizationId)
    .gte("created_at", thirtyDaysAgo.toISOString())
    .order("created_at", { ascending: false });

  // Get appointments from the last 30 days
  const { data: appointments } = await (supabase as any)
    .from("appointments")
    .select("id, created_at")
    .eq("organization_id", organizationId)
    .gte("created_at", thirtyDaysAgo.toISOString());

  // Calculate stats
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

  // Calculate daily stats for chart
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

  // Calculate hourly distribution for heatmap
  const hourlyStats: HourlyStats[] = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    calls: 0,
  }));

  callsList.forEach((call: any) => {
    const hour = new Date(call.created_at).getHours();
    hourlyStats[hour].calls++;
  });

  // Calculate ROI estimate
  // Industry-specific call values (average revenue per call)
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

  // Estimate: calls that would have been missed without AI
  // Assumption: without AI, 60% of calls would be missed
  const estimatedMissedWithoutAI = Math.round(stats.answered * 0.6);
  const estimatedRevenueSaved = estimatedMissedWithoutAI * avgCallValue;

  // Average call duration
  const avgDuration = stats.answered > 0
    ? Math.round(stats.totalDuration / stats.answered)
    : 0;

  // Answer rate
  const answerRate = stats.total > 0
    ? Math.round((stats.answered / (stats.total - stats.spam)) * 100)
    : 0;

  // Recent calls for quick access
  const recentCalls = callsList.slice(0, 10);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-muted-foreground">
          Track your AI receptionist's performance and ROI (Last 30 days)
        </p>
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

          {/* Charts */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Call Volume (30 Days)</CardTitle>
                <CardDescription>
                  Daily call trends
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AnalyticsCharts dailyStats={dailyStats} hourlyStats={hourlyStats} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Call Outcomes</CardTitle>
                <CardDescription>
                  How calls were handled
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-green-500" />
                      <span>Answered</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{stats.answered}</span>
                      <span className="text-muted-foreground">
                        ({stats.total > 0 ? Math.round((stats.answered / stats.total) * 100) : 0}%)
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-red-500" />
                      <span>Missed</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{stats.missed}</span>
                      <span className="text-muted-foreground">
                        ({stats.total > 0 ? Math.round((stats.missed / stats.total) * 100) : 0}%)
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-yellow-500" />
                      <span>Voicemail</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{stats.voicemail}</span>
                      <span className="text-muted-foreground">
                        ({stats.total > 0 ? Math.round((stats.voicemail / stats.total) * 100) : 0}%)
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-blue-500" />
                      <span>Transferred</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{stats.transferred}</span>
                      <span className="text-muted-foreground">
                        ({stats.total > 0 ? Math.round((stats.transferred / stats.total) * 100) : 0}%)
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-orange-500" />
                      <span>Spam Filtered</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{stats.spam}</span>
                      <span className="text-muted-foreground">
                        ({stats.total > 0 ? Math.round((stats.spam / stats.total) * 100) : 0}%)
                      </span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Hourly Heatmap */}
          <Card>
            <CardHeader>
              <CardTitle>Peak Call Hours</CardTitle>
              <CardDescription>
                When do you receive the most calls?
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1">
                {hourlyStats.map((stat) => {
                  const maxCalls = Math.max(...hourlyStats.map((s) => s.calls));
                  const intensity = maxCalls > 0 ? stat.calls / maxCalls : 0;
                  return (
                    <div
                      key={stat.hour}
                      className="flex flex-col items-center"
                      title={`${stat.calls} calls at ${stat.hour}:00`}
                    >
                      <div
                        className="w-6 h-6 rounded"
                        style={{
                          backgroundColor: `rgba(34, 197, 94, ${0.1 + intensity * 0.9})`,
                        }}
                      />
                      <span className="text-xs text-muted-foreground mt-1">
                        {stat.hour}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                Darker = more calls. Times shown in 24-hour format.
              </p>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Lock className="h-10 w-10 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-1">Advanced Analytics</h3>
            <p className="text-sm text-muted-foreground text-center max-w-md mb-4">
              Unlock ROI estimates, call volume trends, outcome breakdowns, and peak hours
              heatmap with a Professional or Business plan.
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
