import { createAdminClient } from "@/lib/supabase/admin";
import { PLANS } from "@/lib/stripe/client";
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
  TrendingUp,
  CreditCard,
  Clock,
  AlertTriangle,
} from "lucide-react";

type PlanType = keyof typeof PLANS;

interface SubscriptionRow {
  id: string;
  organization_id: string;
  plan_type: string;
  status: string;
  calls_used: number | null;
  calls_limit: number | null;
  current_period_end: string;
  trial_end: string | null;
}

export default async function AdminBillingPage() {
  const supabase = createAdminClient();

  const { data: subs } = await (supabase as any)
    .from("subscriptions")
    .select(
      "id, organization_id, plan_type, status, calls_used, calls_limit, current_period_end, trial_end"
    )
    .order("current_period_end", { ascending: false });

  const subscriptions: SubscriptionRow[] = subs ?? [];

  // Calculate stats
  const activeSubs = subscriptions.filter((s) => s.status === "active");
  const trialingSubs = subscriptions.filter((s) => s.status === "trialing");
  const pastDueSubs = subscriptions.filter((s) => s.status === "past_due");

  const mrr = activeSubs.reduce((sum, sub) => {
    const plan = PLANS[sub.plan_type as PlanType];
    return plan ? sum + plan.price : sum;
  }, 0);
  const mrrDisplay = `$${(mrr / 100).toLocaleString("en-AU", { minimumFractionDigits: 0 })}`;

  // Fetch org names for all subscriptions
  const orgIds = [...new Set(subscriptions.map((s) => s.organization_id))];
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
        <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
        <p className="text-muted-foreground">
          Subscription revenue and billing status
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="MRR"
          value={mrrDisplay}
          subtitle="AUD (active only)"
          icon={TrendingUp}
        />
        <StatCard
          title="Active Subscriptions"
          value={activeSubs.length}
          icon={CreditCard}
        />
        <StatCard
          title="Trialing"
          value={trialingSubs.length}
          icon={Clock}
        />
        <StatCard
          title="Past Due"
          value={pastDueSubs.length}
          icon={AlertTriangle}
        />
      </div>

      {/* Subscriptions Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All Subscriptions</CardTitle>
          <CardDescription>{subscriptions.length} total subscription(s)</CardDescription>
        </CardHeader>
        <CardContent>
          {subscriptions.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <CreditCard className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No subscriptions yet
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Calls Used / Limit</TableHead>
                  <TableHead>Period End</TableHead>
                  <TableHead>Trial End</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell className="font-medium">
                      {orgNameMap[sub.organization_id] || sub.organization_id}
                    </TableCell>
                    <TableCell className="capitalize">{sub.plan_type}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          sub.status === "active"
                            ? "success"
                            : sub.status === "trialing"
                              ? "warning"
                              : sub.status === "past_due"
                                ? "destructive"
                                : "secondary"
                        }
                      >
                        {sub.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {sub.calls_used ?? 0} / {sub.calls_limit ?? "--"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(sub.current_period_end).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {sub.trial_end
                        ? new Date(sub.trial_end).toLocaleDateString()
                        : "--"}
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
