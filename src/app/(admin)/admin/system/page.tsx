import { createAdminClient } from "@/lib/supabase/admin";
import { StatCard } from "@/components/admin/stat-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Server, Database, Activity, AlertTriangle } from "lucide-react";
import { formatAdminDate } from "@/lib/admin/format";

interface HealthRow {
  service: string;
  is_healthy: boolean;
  consecutive_failures: number;
  last_check_at: string;
  last_error: string | null;
}

export default async function AdminSystemPage() {
  const supabase = createAdminClient();

  // Fetch system health records
  const { data: healthData, error: healthError } = await (supabase as any)
    .from("system_health")
    .select("service, is_healthy, consecutive_failures, last_check_at, last_error")
    .order("service", { ascending: true });

  const healthRecords: HealthRow[] = healthData ?? [];

  // Supabase health check: time a simple query
  const dbStart = performance.now();
  const { error: dbError } = await (supabase as any)
    .from("organizations")
    .select("id", { count: "exact", head: true });
  const dbLatency = Math.round(performance.now() - dbStart);
  const dbHealthy = !dbError;

  const healthyCount = healthRecords.filter((r) => r.is_healthy).length;
  const unhealthyCount = healthRecords.filter((r) => !r.is_healthy).length;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">System Health</h1>
        <p className="text-muted-foreground">
          Service status and infrastructure monitoring
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Healthy Services"
          value={healthyCount}
          icon={Activity}
        />
        <StatCard
          title="Unhealthy Services"
          value={unhealthyCount}
          icon={AlertTriangle}
        />
        <StatCard
          title="DB Latency"
          value={`${dbLatency}ms`}
          subtitle={dbHealthy ? "connected" : "error"}
          icon={Database}
        />
        <StatCard
          title="Total Services"
          value={healthRecords.length}
          icon={Server}
        />
      </div>

      {/* Supabase Health Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Database className="h-5 w-5 text-amber-600" />
            Supabase Database
          </CardTitle>
          <CardDescription>
            Database connectivity and latency
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <div
                className={`h-3 w-3 rounded-full ${
                  dbHealthy ? "bg-emerald-500" : "bg-red-500"
                }`}
              />
              <div>
                <p className="text-sm font-medium">Supabase PostgreSQL</p>
                <p className="text-xs text-muted-foreground">
                  Response time: {dbLatency}ms
                </p>
              </div>
            </div>
            <Badge variant={dbHealthy ? "success" : "destructive"}>
              {dbHealthy ? "Connected" : "Error"}
            </Badge>
          </div>
          {dbError && (
            <p className="mt-3 text-sm text-destructive">
              Error: {dbError.message}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Voice Server & Services Health */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Server className="h-5 w-5 text-amber-600" />
            Service Health
          </CardTitle>
          <CardDescription>
            Voice server and external service status
          </CardDescription>
        </CardHeader>
        <CardContent>
          {healthError ? (
            <p className="text-sm text-destructive">
              Failed to load health records: {healthError.message}
            </p>
          ) : healthRecords.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Server className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No health records found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The health check cron may not have run yet.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {healthRecords.map((record) => (
                <div
                  key={record.service}
                  className="rounded-lg border p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-3 w-3 rounded-full ${
                          record.is_healthy ? "bg-emerald-500" : "bg-red-500"
                        }`}
                      />
                      <div>
                        <p className="text-sm font-medium">
                          {record.service}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Last checked:{" "}
                          {formatAdminDate(record.last_check_at)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {record.consecutive_failures > 0 && (
                        <span className="text-xs text-red-600">
                          {record.consecutive_failures} consecutive failure
                          {record.consecutive_failures !== 1 ? "s" : ""}
                        </span>
                      )}
                      <Badge
                        variant={record.is_healthy ? "success" : "destructive"}
                      >
                        {record.is_healthy ? "Healthy" : "Unhealthy"}
                      </Badge>
                    </div>
                  </div>
                  {record.last_error && (
                    <div className="mt-2 rounded bg-red-500/5 p-2">
                      <p className="text-xs text-red-700 dark:text-red-400 font-mono">
                        {record.last_error}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
