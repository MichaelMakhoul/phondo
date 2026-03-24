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
  Building2,
  CreditCard,
  Bot,
  Phone,
  Users,
  PhoneCall,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatAdminDate, formatAdminDateShort } from "@/lib/admin/format";

interface OrgDetailProps {
  params: Promise<{ id: string }>;
}

interface AssistantRow {
  id: string;
  name: string;
  is_active: boolean;
  language: string;
  created_at: string;
}

interface PhoneNumberRow {
  id: string;
  phone_number: string;
  friendly_name: string | null;
  is_active: boolean;
  ai_enabled: boolean;
  created_at: string;
}

interface MemberRow {
  id: string;
  role: string;
  created_at: string;
  user_id: string;
}

interface CallRow {
  id: string;
  caller_name: string | null;
  caller_phone: string | null;
  duration_seconds: number | null;
  outcome: string | null;
  status: string;
  is_spam: boolean | null;
  created_at: string;
}

interface SubscriptionRow {
  id: string;
  plan_type: string;
  status: string;
  calls_used: number | null;
  calls_limit: number | null;
  current_period_start: string;
  current_period_end: string;
  trial_end: string | null;
}

export default async function AdminOrgDetailPage({ params }: OrgDetailProps) {
  const { id } = await params;

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(id)) notFound();

  const supabase = createAdminClient();

  const [orgResult, subsResult, assistantsResult, phoneNumbersResult, membersResult, callsResult] =
    await Promise.all([
      (supabase as any).from("organizations").select("*").eq("id", id).single(),
      (supabase as any)
        .from("subscriptions")
        .select("id, plan_type, status, calls_used, calls_limit, current_period_start, current_period_end, trial_end")
        .eq("organization_id", id),
      (supabase as any)
        .from("assistants")
        .select("id, name, is_active, language, created_at")
        .eq("organization_id", id)
        .order("created_at", { ascending: false }),
      (supabase as any)
        .from("phone_numbers")
        .select("id, phone_number, friendly_name, is_active, ai_enabled, created_at")
        .eq("organization_id", id)
        .order("created_at", { ascending: false }),
      (supabase as any)
        .from("org_members")
        .select("id, role, created_at, user_id")
        .eq("organization_id", id),
      (supabase as any)
        .from("calls")
        .select("id, caller_name, caller_phone, duration_seconds, outcome, status, is_spam, created_at")
        .eq("organization_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  if (!orgResult.data) {
    notFound();
  }

  const org = orgResult.data;
  const subscriptions: SubscriptionRow[] = subsResult.data ?? [];
  const assistants: AssistantRow[] = assistantsResult.data ?? [];
  const phoneNumbers: PhoneNumberRow[] = phoneNumbersResult.data ?? [];
  const members: MemberRow[] = membersResult.data ?? [];
  const calls: CallRow[] = callsResult.data ?? [];

  // Fetch user profiles for members
  const memberUserIds = members.map((m) => m.user_id);
  let userProfileMap: Record<string, { email: string; full_name: string | null }> = {};
  if (memberUserIds.length > 0) {
    const { data: profiles } = await (supabase as any)
      .from("user_profiles")
      .select("id, email, full_name")
      .in("id", memberUserIds);
    if (profiles) {
      userProfileMap = Object.fromEntries(
        (profiles as { id: string; email: string; full_name: string | null }[]).map((p) => [
          p.id,
          { email: p.email, full_name: p.full_name },
        ])
      );
    }
  }

  const activeSub = subscriptions.find((s) => s.status === "active" || s.status === "trialing");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/admin/organizations"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Organizations
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-3xl font-bold tracking-tight">{org.name}</h1>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Assistants"
          value={assistants.length}
          subtitle={`${assistants.filter((a) => a.is_active).length} active`}
          icon={Bot}
        />
        <StatCard
          title="Phone Numbers"
          value={phoneNumbers.length}
          subtitle={`${phoneNumbers.filter((p) => p.is_active).length} active`}
          icon={Phone}
        />
        <StatCard
          title="Team Members"
          value={members.length}
          icon={Users}
        />
        <StatCard
          title="Recent Calls"
          value={calls.length}
          subtitle="last 20"
          icon={PhoneCall}
        />
      </div>

      {/* Org Info + Subscription */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Building2 className="h-5 w-5 text-amber-600" />
              Organization Info
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">ID</dt>
                <dd className="font-mono text-xs">{org.id}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Slug</dt>
                <dd>{org.slug}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Industry</dt>
                <dd className="capitalize">{org.industry || "--"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Country</dt>
                <dd>{org.country}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Type</dt>
                <dd className="capitalize">{org.type}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Timezone</dt>
                <dd>{org.timezone || "--"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Created</dt>
                <dd>{formatAdminDate(org.created_at)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <CreditCard className="h-5 w-5 text-amber-600" />
              Subscription
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeSub ? (
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd className="capitalize font-medium">{activeSub.plan_type}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Status</dt>
                  <dd>
                    <Badge
                      variant={
                        activeSub.status === "active"
                          ? "success"
                          : activeSub.status === "trialing"
                            ? "warning"
                            : "secondary"
                      }
                    >
                      {activeSub.status}
                    </Badge>
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Calls Used</dt>
                  <dd>
                    {activeSub.calls_used ?? 0} / {activeSub.calls_limit ?? "--"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Period</dt>
                  <dd>
                    {formatAdminDateShort(activeSub.current_period_start)} -{" "}
                    {formatAdminDateShort(activeSub.current_period_end)}
                  </dd>
                </div>
                {activeSub.trial_end && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Trial Ends</dt>
                    <dd>{formatAdminDateShort(activeSub.trial_end)}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No active subscription</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Assistants */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Assistants</CardTitle>
          <CardDescription>{assistants.length} assistant(s)</CardDescription>
        </CardHeader>
        <CardContent>
          {assistants.length === 0 ? (
            <p className="text-sm text-muted-foreground">No assistants configured</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assistants.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell>{a.language}</TableCell>
                    <TableCell>
                      <Badge variant={a.is_active ? "success" : "secondary"}>
                        {a.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAdminDateShort(a.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Phone Numbers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Phone Numbers</CardTitle>
          <CardDescription>{phoneNumbers.length} phone number(s)</CardDescription>
        </CardHeader>
        <CardContent>
          {phoneNumbers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No phone numbers provisioned</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Friendly Name</TableHead>
                  <TableHead>Provisioned</TableHead>
                  <TableHead>AI Enabled</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {phoneNumbers.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-sm">{p.phone_number}</TableCell>
                    <TableCell>{p.friendly_name || "--"}</TableCell>
                    <TableCell>
                      <Badge variant={p.is_active ? "success" : "secondary"}>
                        {p.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.ai_enabled ? "success" : "secondary"}>
                        {p.ai_enabled ? "On" : "Off"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAdminDateShort(p.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Team Members */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Team Members</CardTitle>
          <CardDescription>{members.length} member(s)</CardDescription>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No team members</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => {
                  const profile = userProfileMap[m.user_id];
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">{profile?.email || m.user_id}</TableCell>
                      <TableCell>{profile?.full_name || "--"}</TableCell>
                      <TableCell className="capitalize">{m.role}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatAdminDateShort(m.created_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent Calls */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Calls</CardTitle>
          <CardDescription>Last 20 calls for this organization</CardDescription>
        </CardHeader>
        <CardContent>
          {calls.length === 0 ? (
            <p className="text-sm text-muted-foreground">No calls yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Caller</TableHead>
                  <TableHead>Phone</TableHead>
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
                    <TableCell className="font-medium">
                      {call.caller_name || "--"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {call.caller_phone || "--"}
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
                      {formatAdminDate(call.created_at)}
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
