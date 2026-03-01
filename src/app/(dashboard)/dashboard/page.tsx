import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Phone, PhoneCall, Clock, TrendingUp, Plus, Bot, User } from "lucide-react";
import Link from "next/link";
import { formatDuration } from "@/lib/utils";
import { AnimatedStat } from "@/components/marketing/animated-stat";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardGreeting } from "@/components/dashboard/greeting";
import { CallsScene } from "@/components/ui/empty-state-scenes";

interface RecentCall {
  id: string;
  caller_phone: string | null;
  status: string;
  duration_seconds: number | null;
  assistants: { name: string } | null;
  phone_numbers: { phone_number: string } | null;
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Fetch profile and org membership in parallel
  const [{ data: profile }, { data: membership }] = await Promise.all([
    supabase
      .from("user_profiles")
      .select("full_name")
      .eq("id", user!.id)
      .single() as unknown as Promise<{ data: { full_name: string | null } | null }>,
    supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user!.id)
      .single() as unknown as Promise<{ data: { organization_id: string } | null }>,
  ]);

  const firstName = profile?.full_name?.split(" ")[0] || null;

  const orgId = membership?.organization_id || "";

  // Get stats (only if orgId exists)
  let totalCalls: number | null = 0;
  let totalAssistants: number | null = 0;
  let totalPhoneNumbers: number | null = 0;
  let ownerAnsweredCalls: number | null = 0;
  let recentCalls: RecentCall[] | null = null;

  if (orgId) {
    const [callsResult, assistantsResult, phoneResult, ownerResult, recentResult] = await Promise.all([
      supabase
        .from("calls")
        .select("*", { count: "exact", head: true })
        .eq("organization_id", orgId),
      supabase
        .from("assistants")
        .select("*", { count: "exact", head: true })
        .eq("organization_id", orgId),
      supabase
        .from("phone_numbers")
        .select("*", { count: "exact", head: true })
        .eq("organization_id", orgId),
      supabase
        .from("calls")
        .select("*", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("metadata->>answeredBy", "owner"),
      supabase
        .from("calls")
        .select(`
          *,
          assistants (name),
          phone_numbers (phone_number)
        `)
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(5) as unknown as Promise<{ data: RecentCall[] | null }>,
    ]);
    totalCalls = callsResult.count;
    totalAssistants = assistantsResult.count;
    totalPhoneNumbers = phoneResult.count;
    ownerAnsweredCalls = ownerResult.count;
    recentCalls = recentResult.data;
  }

  // Calculate total call duration
  const { data: durationData } = orgId ? await supabase
    .from("calls")
    .select("duration_seconds")
    .eq("organization_id", orgId)
    .not("duration_seconds", "is", null) as { data: { duration_seconds: number }[] | null } : { data: null };

  const totalDuration = durationData?.reduce(
    (sum, call) => sum + (call.duration_seconds || 0),
    0
  ) || 0;

  const stats: Array<{
    name: string;
    value: string | number;
    icon: typeof PhoneCall;
    change: string;
    changeType: "positive" | "negative" | "neutral";
  }> = [
    {
      name: "Total Calls",
      value: totalCalls || 0,
      icon: PhoneCall,
      change: "+12%",
      changeType: "positive",
    },
    {
      name: "You Answered",
      value: ownerAnsweredCalls || 0,
      icon: User,
      change: "",
      changeType: "neutral",
    },
    {
      name: "Active Assistants",
      value: totalAssistants || 0,
      icon: Bot,
      change: "",
      changeType: "neutral",
    },
    {
      name: "Phone Numbers",
      value: totalPhoneNumbers || 0,
      icon: Phone,
      change: "",
      changeType: "neutral",
    },
    {
      name: "Total Talk Time",
      value: formatDuration(totalDuration),
      icon: Clock,
      change: "+8%",
      changeType: "positive",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <DashboardGreeting firstName={firstName} />
          <p className="text-muted-foreground">
            Here&apos;s how your AI receptionist is performing
          </p>
        </div>
        <Link href="/assistants/new">
          <Button className="btn-primary-glow">
            <Plus className="mr-2 h-4 w-4" />
            New Assistant
          </Button>
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {stats.map((stat, i) => {
          const delayClass = [
            "animate-fade-in-up-delay-1",
            "animate-fade-in-up-delay-2",
            "animate-fade-in-up-delay-3",
            "animate-fade-in-up-delay-4",
            "animate-fade-in-up-delay-5",
          ][i];
          return (
          <Card key={stat.name} className={`card-hover ${delayClass}`}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.name}
              </CardTitle>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                <stat.icon className="h-4 w-4 text-primary" />
              </div>
            </CardHeader>
            <CardContent>
              <AnimatedStat value={String(stat.value)} className="text-2xl font-bold" />
              {stat.change && (
                <p className="text-xs text-muted-foreground">
                  <span
                    className={
                      stat.changeType === "positive"
                        ? "text-green-600"
                        : stat.changeType === "negative"
                        ? "text-red-600"
                        : ""
                    }
                  >
                    {stat.change}
                  </span>{" "}
                  from last month
                </p>
              )}
            </CardContent>
          </Card>
          );
        })}
      </div>

      {/* Quick Actions & Recent Calls */}
      <div className="grid gap-6 lg:grid-cols-2 animate-fade-in-up-delay-2">
        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Get started with common tasks</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Link href="/assistants/new" className="block">
              <div className="flex items-center gap-4 rounded-lg border p-4 card-hover">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Bot className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">Create AI Assistant</p>
                  <p className="text-sm text-muted-foreground">
                    Set up a new AI receptionist
                  </p>
                </div>
              </div>
            </Link>
            <Link href="/phone-numbers" className="block">
              <div className="flex items-center gap-4 rounded-lg border p-4 card-hover">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Phone className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">Get Phone Number</p>
                  <p className="text-sm text-muted-foreground">
                    Purchase a phone number for your assistant
                  </p>
                </div>
              </div>
            </Link>
          </CardContent>
        </Card>

        {/* Recent Calls */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Recent Calls</CardTitle>
              <CardDescription>Your latest call activity</CardDescription>
            </div>
            <Link href="/calls">
              <Button variant="ghost" size="sm">
                View all
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {recentCalls && recentCalls.length > 0 ? (
              <div className="space-y-4">
                {recentCalls.map((call) => (
                  <div
                    key={call.id}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                        <PhoneCall className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          {call.caller_phone || "Unknown"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {call.assistants?.name || "Unknown Assistant"}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge
                        variant={
                          call.status === "completed"
                            ? "success"
                            : call.status === "failed"
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {call.status}
                      </Badge>
                      {call.duration_seconds && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatDuration(call.duration_seconds)}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={PhoneCall}
                title="Your AI is ready and waiting"
                description="Set up an assistant to get started"
                illustration={<CallsScene />}
                compact
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
