import { createAdminClient } from "@/lib/supabase/admin";
import { PLANS } from "@/lib/stripe/client";
import { StatCard } from "@/components/admin/stat-card";
import {
  Building2,
  CreditCard,
  PhoneCall,
  Phone,
  CalendarClock,
  TrendingUp,
  Activity,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type PlanType = keyof typeof PLANS;

interface SubscriptionRow {
  plan_type: string;
  status: string;
}

interface OrgRow {
  id: string;
  name: string;
  industry: string | null;
  created_at: string;
}

interface CallRow {
  id: string;
  caller_phone: string | null;
  duration_seconds: number | null;
  outcome: string | null;
  created_at: string;
  organization_id: string;
}

interface SystemHealthRow {
  service_name: string;
  status: string;
  last_check_at: string;
  details: Record<string, unknown> | null;
}

export default async function AdminOverviewPage() {
  const supabase = createAdminClient();

  // Fetch all stats in parallel
  const [
    orgsResult,
    subsResult,
    callsTodayResult,
    callsMonthResult,
    phoneNumbersResult,
    healthResult,
    recentOrgsResult,
    recentCallsResult,
  ] = await Promise.all([
    // Total organizations
    (supabase as any)
      .from("organizations")
      .select("*", { count: "exact", head: true }),
    // Active subscriptions
    (supabase as any)
      .from("subscriptions")
      .select("plan_type, status")
      .in("status", ["active", "trialing"]),
    // Calls today
    (supabase as any)
      .from("calls")
      .select("*", { count: "exact", head: true })
      .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
    // Calls this month
    (supabase as any)
      .from("calls")
      .select("*", { count: "exact", head: true })
      .gte(
        "created_at",
        new Date(
          new Date().getFullYear(),
          new Date().getMonth(),
          1
        ).toISOString()
      ),
    // Active phone numbers
    (supabase as any)
      .from("phone_numbers")
      .select("*", { count: "exact", head: true })
      .eq("is_active", true),
    // System health
    (supabase as any)
      .from("system_health")
      .select("service_name, status, last_check_at, details")
      .order("last_check_at", { ascending: false })
      .limit(5),
    // Recent signups (last 10 orgs)
    (supabase as any)
      .from("organizations")
      .select("id, name, industry, created_at")
      .order("created_at", { ascending: false })
      .limit(10),
    // Recent calls (last 10)
    (supabase as any)
      .from("calls")
      .select("id, caller_phone, duration_seconds, outcome, created_at, organization_id")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const totalOrgs = orgsResult.count ?? 0;
  const activeSubs: SubscriptionRow[] = subsResult.data ?? [];
  const callsToday = callsTodayResult.count ?? 0;
  const callsMonth = callsMonthResult.count ?? 0;
  const activePhoneNumbers = phoneNumbersResult.count ?? 0;
  const healthRecords: SystemHealthRow[] = healthResult.data ?? [];
  const recentOrgs: OrgRow[] = recentOrgsResult.data ?? [];
  const recentCalls: CallRow[] = recentCallsResult.data ?? [];

  // Calculate MRR from active subscriptions
  const mrr = activeSubs.reduce((sum: number, sub: SubscriptionRow) => {
    const plan = PLANS[sub.plan_type as PlanType];
    if (plan) {
      return sum + plan.price;
    }
    return sum;
  }, 0);
  const mrrDisplay = `$${(mrr / 100).toLocaleString("en-AU", { minimumFractionDigits: 0 })}`;

  // Fetch org names for recent calls
  const callOrgIds = [...new Set(recentCalls.map((c) => c.organization_id))];
  let orgNameMap: Record<string, string> = {};
  if (callOrgIds.length > 0) {
    const { data: callOrgs } = await (supabase as any)
      .from("organizations")
      .select("id, name")
      .in("id", callOrgIds);
    if (callOrgs) {
      orgNameMap = Object.fromEntries(
        (callOrgs as { id: string; name: string }[]).map((o) => [o.id, o.name])
      );
    }
  }

  // Fetch subscription plan_type for recent orgs
  const recentOrgIds = recentOrgs.map((o) => o.id);
  let orgPlanMap: Record<string, string> = {};
  if (recentOrgIds.length > 0) {
    const { data: orgSubs } = await (supabase as any)
      .from("subscriptions")
      .select("organization_id, plan_type")
      .in("organization_id", recentOrgIds);
    if (orgSubs) {
      orgPlanMap = Object.fromEntries(
        (orgSubs as { organization_id: string; plan_type: string }[]).map(
          (s) => [s.organization_id, s.plan_type]
        )
      );
    }
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Admin Overview</h1>
        <p className="text-muted-foreground">
          Platform-wide metrics and recent activity
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          title="Organizations"
          value={totalOrgs}
          icon={Building2}
        />
        <StatCard
          title="Active Subs"
          value={activeSubs.length}
          subtitle={`of ${totalOrgs} orgs`}
          icon={CreditCard}
        />
        <StatCard
          title="MRR"
          value={mrrDisplay}
          subtitle="AUD"
          icon={TrendingUp}
        />
        <StatCard
          title="Calls Today"
          value={callsToday}
          icon={PhoneCall}
        />
        <StatCard
          title="Calls This Month"
          value={callsMonth}
          icon={CalendarClock}
        />
        <StatCard
          title="Phone Numbers"
          value={activePhoneNumbers}
          subtitle="active"
          icon={Phone}
        />
      </div>

      {/* Voice Server Health */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Activity className="h-5 w-5 text-amber-600" />
            Voice Server Health
          </CardTitle>
          <CardDescription>Latest health check results</CardDescription>
        </CardHeader>
        <CardContent>
          {healthRecords.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No health records found. The health check cron may not have run
              yet.
            </p>
          ) : (
            <div className="space-y-3">
              {healthRecords.map((record) => (
                <div
                  key={`${record.service_name}-${record.last_check_at}`}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-3 w-3 rounded-full ${
                        record.status === "healthy"
                          ? "bg-emerald-500"
                          : record.status === "degraded"
                            ? "bg-amber-500"
                            : "bg-red-500"
                      }`}
                    />
                    <span className="text-sm font-medium">
                      {record.service_name}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span
                      className={`text-xs font-medium capitalize ${
                        record.status === "healthy"
                          ? "text-emerald-600"
                          : record.status === "degraded"
                            ? "text-amber-600"
                            : "text-red-600"
                      }`}
                    >
                      {record.status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(record.last_check_at).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Two-column layout: Recent Signups + Recent Calls */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Signups */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent Signups</CardTitle>
            <CardDescription>Last 10 organizations</CardDescription>
          </CardHeader>
          <CardContent>
            {recentOrgs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No organizations yet.
              </p>
            ) : (
              <div className="space-y-2">
                {recentOrgs.map((org) => (
                  <div
                    key={org.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{org.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {org.industry || "No industry"}{" "}
                        {orgPlanMap[org.id] && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                            {orgPlanMap[org.id]}
                          </span>
                        )}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(org.created_at).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Calls */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent Calls</CardTitle>
            <CardDescription>Last 10 calls across all orgs</CardDescription>
          </CardHeader>
          <CardContent>
            {recentCalls.length === 0 ? (
              <p className="text-sm text-muted-foreground">No calls yet.</p>
            ) : (
              <div className="space-y-2">
                {recentCalls.map((call) => (
                  <div
                    key={call.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {call.caller_phone || "Unknown caller"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {orgNameMap[call.organization_id] || "Unknown org"}
                        {call.duration_seconds != null && (
                          <span className="ml-2">
                            {Math.floor(call.duration_seconds / 60)}m{" "}
                            {call.duration_seconds % 60}s
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="text-right">
                      {call.outcome && (
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                            call.outcome === "answered"
                              ? "bg-emerald-500/10 text-emerald-700"
                              : call.outcome === "spam"
                                ? "bg-red-500/10 text-red-700"
                                : call.outcome === "transferred"
                                  ? "bg-blue-500/10 text-blue-700"
                                  : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {call.outcome}
                        </span>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(call.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
