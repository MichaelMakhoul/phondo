import { createAdminClient } from "@/lib/supabase/admin";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/admin/stat-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PhoneCall,
  Clock,
  CheckCircle2,
  ShieldAlert,
} from "lucide-react";

interface CallRow {
  id: string;
  caller_name: string | null;
  caller_phone: string | null;
  duration_seconds: number | null;
  outcome: string | null;
  status: string;
  is_spam: boolean | null;
  created_at: string;
  organization_id: string;
}

export default async function AdminCallsPage() {
  const supabase = createAdminClient();

  const [callsResult, totalResult, spamResult] = await Promise.all([
    (supabase as any)
      .from("calls")
      .select(
        "id, caller_name, caller_phone, duration_seconds, outcome, status, is_spam, created_at, organization_id"
      )
      .order("created_at", { ascending: false })
      .limit(50),
    (supabase as any)
      .from("calls")
      .select("*", { count: "exact", head: true }),
    (supabase as any)
      .from("calls")
      .select("*", { count: "exact", head: true })
      .eq("is_spam", true),
  ]);

  const calls: CallRow[] = callsResult.data ?? [];
  const totalCalls = totalResult.count ?? 0;
  const spamCalls = spamResult.count ?? 0;

  // Calculate stats from the fetched calls (representative sample)
  const callsWithDuration = calls.filter((c) => c.duration_seconds != null);
  const avgDuration =
    callsWithDuration.length > 0
      ? Math.round(
          callsWithDuration.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0) /
            callsWithDuration.length
        )
      : 0;

  const successfulCalls = calls.filter(
    (c) => c.outcome === "answered" || c.outcome === "transferred"
  ).length;
  const successRate = calls.length > 0 ? ((successfulCalls / calls.length) * 100).toFixed(1) : "0.0";
  const spamRate = totalCalls > 0 ? ((spamCalls / totalCalls) * 100).toFixed(1) : "0.0";

  // Fetch org names
  const orgIds = [...new Set(calls.map((c) => c.organization_id))];
  let orgNameMap: Record<string, string> = {};
  if (orgIds.length > 0) {
    const { data: orgs } = await (supabase as any)
      .from("organizations")
      .select("id, name")
      .in("id", orgIds);
    if (orgs) {
      orgNameMap = Object.fromEntries(
        (orgs as { id: string; name: string }[]).map((o) => [o.id, o.name])
      );
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Calls</h1>
        <p className="text-muted-foreground">
          Platform-wide call activity and analytics
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Calls"
          value={totalCalls}
          icon={PhoneCall}
        />
        <StatCard
          title="Avg Duration"
          value={
            avgDuration > 0
              ? `${Math.floor(avgDuration / 60)}m ${avgDuration % 60}s`
              : "--"
          }
          subtitle="last 50 calls"
          icon={Clock}
        />
        <StatCard
          title="Success Rate"
          value={`${successRate}%`}
          subtitle="last 50 calls"
          icon={CheckCircle2}
        />
        <StatCard
          title="Spam Rate"
          value={`${spamRate}%`}
          subtitle="all time"
          icon={ShieldAlert}
        />
      </div>

      {/* Calls Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Calls</CardTitle>
          <CardDescription>Last 50 calls across all organizations</CardDescription>
        </CardHeader>
        <CardContent>
          {calls.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <PhoneCall className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No calls yet
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Caller</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Spam</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.map((call) => (
                  <TableRow key={call.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">
                          {call.caller_name || call.caller_phone || "Unknown"}
                        </p>
                        {call.caller_name && call.caller_phone && (
                          <p className="text-xs text-muted-foreground font-mono">
                            {call.caller_phone}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {orgNameMap[call.organization_id] || "Unknown"}
                    </TableCell>
                    <TableCell>
                      {call.duration_seconds != null
                        ? `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`
                        : "--"}
                    </TableCell>
                    <TableCell>
                      {call.outcome ? (
                        <Badge
                          variant={
                            call.outcome === "answered"
                              ? "success"
                              : call.outcome === "spam"
                                ? "destructive"
                                : call.outcome === "transferred"
                                  ? "default"
                                  : "secondary"
                          }
                        >
                          {call.outcome}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">--</span>
                      )}
                    </TableCell>
                    <TableCell className="capitalize">{call.status}</TableCell>
                    <TableCell>
                      {call.is_spam ? (
                        <Badge variant="destructive">Spam</Badge>
                      ) : (
                        <span className="text-muted-foreground">No</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(call.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
