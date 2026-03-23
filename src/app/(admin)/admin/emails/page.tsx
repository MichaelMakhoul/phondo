import { createAdminClient } from "@/lib/supabase/admin";
import { StatCard } from "@/components/admin/stat-card";
import { Mail, AlertTriangle } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";

interface EmailLogRow {
  id: string;
  recipient: string;
  subject: string;
  email_type: string;
  status: string;
  organization_id: string | null;
  created_at: string;
}

export default async function AdminEmailsPage() {
  const supabase = createAdminClient();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [emailsResult, todayResult, failedTodayResult] = await Promise.all([
    (supabase as any)
      .from("admin_email_log")
      .select("id, recipient, subject, email_type, status, organization_id, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    (supabase as any)
      .from("admin_email_log")
      .select("*", { count: "exact", head: true })
      .gte("created_at", todayStart.toISOString()),
    (supabase as any)
      .from("admin_email_log")
      .select("*", { count: "exact", head: true })
      .gte("created_at", todayStart.toISOString())
      .eq("status", "failed"),
  ]);

  const emails: EmailLogRow[] = emailsResult.data ?? [];
  const totalToday = todayResult.count ?? 0;
  const failedToday = failedTodayResult.count ?? 0;
  const failureRate =
    totalToday > 0 ? ((failedToday / totalToday) * 100).toFixed(1) : "0.0";

  // Fetch org names for emails that have an organization_id
  const orgIds = [
    ...new Set(emails.filter((e) => e.organization_id).map((e) => e.organization_id!)),
  ];
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

  function getStatusVariant(status: string) {
    switch (status) {
      case "sent":
      case "delivered":
        return "success" as const;
      case "failed":
      case "bounced":
        return "destructive" as const;
      case "pending":
        return "warning" as const;
      default:
        return "secondary" as const;
    }
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Email Management</h1>
        <p className="text-muted-foreground">
          System email logs and delivery status
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Sent Today"
          value={totalToday}
          icon={Mail}
        />
        <StatCard
          title="Failed Today"
          value={failedToday}
          icon={AlertTriangle}
        />
        <StatCard
          title="Failure Rate"
          value={`${failureRate}%`}
          subtitle="today"
          icon={AlertTriangle}
        />
      </div>

      {/* Email Log Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Email Log</CardTitle>
          <CardDescription>Last 100 system emails</CardDescription>
        </CardHeader>
        <CardContent>
          {emails.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Mail className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No emails logged yet
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Email logging will begin tracking all system emails from this
                point forward.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Sent At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emails.map((email) => (
                  <TableRow key={email.id}>
                    <TableCell className="font-medium">
                      {email.recipient}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {email.subject}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{email.email_type}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusVariant(email.status)}>
                        {email.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {email.organization_id
                        ? orgNameMap[email.organization_id] || "Unknown"
                        : "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(email.created_at).toLocaleString()}
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
