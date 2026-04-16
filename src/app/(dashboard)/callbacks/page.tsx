import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PhoneForwarded, Clock, CheckCircle2, AlertTriangle, TimerOff } from "lucide-react";
import { formatPhoneNumber } from "@/lib/utils";
import { format } from "date-fns";

function safeFormatDate(dateStr: string | null, formatStr: string): string {
  if (!dateStr) return "N/A";
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "Invalid date";
    return format(date, formatStr);
  } catch {
    return "Invalid date";
  }
}
import { CallbackActions } from "./callback-list";
import { ExpandableText } from "./expandable-text";
import { AnimatedStat } from "@/components/marketing/animated-stat";
import { EmptyState } from "@/components/ui/empty-state";
import { CallbacksScene } from "@/components/ui/empty-state-scenes";

interface CallbackRequest {
  id: string;
  caller_name: string;
  caller_phone: string;
  reason: string;
  requested_time: string | null;
  urgency: string;
  status: string;
  notes: string | null;
  completion_notes: string | null;
  created_at: string;
  completed_at: string | null;
}

const URGENCY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function sortCallbacks(callbacks: CallbackRequest[]): CallbackRequest[] {
  const pending = callbacks
    .filter((c) => c.status === "pending")
    .sort((a, b) => {
      const urgencyDiff = (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3);
      if (urgencyDiff !== 0) return urgencyDiff;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  const rest = callbacks
    .filter((c) => c.status !== "pending")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return [...pending, ...rest];
}

export default async function CallbacksPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single() as { data: { organization_id: string } | null; error: any };

  if (membershipError || !membership?.organization_id) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Callbacks</h1>
          <div className="flex items-center gap-2 text-destructive mt-2">
            <AlertTriangle className="h-4 w-4" />
            <p className="text-sm">Unable to load your organization. Please try refreshing the page.</p>
          </div>
        </div>
      </div>
    );
  }

  const orgId = membership.organization_id;

  const { data: callbacks, error: callbacksError } = await (supabase as any)
    .from("callback_requests")
    .select("*")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50) as { data: CallbackRequest[] | null; error: any };

  if (callbacksError) {
    console.error("[Callbacks] Failed to load callbacks:", callbacksError);
  }

  const allCallbacks = callbacks || [];
  const pendingCallbacks = sortCallbacks(allCallbacks.filter((c) => c.status === "pending"));
  const completedCallbacks = allCallbacks
    .filter((c) => c.status === "completed")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const expiredCallbacks = allCallbacks
    .filter((c) => c.status === "expired")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const allSorted = sortCallbacks(allCallbacks);

  const pendingCount = pendingCallbacks.length;
  const completedCount = completedCallbacks.length;
  const expiredCount = expiredCallbacks.length;
  const highUrgency = pendingCallbacks.filter((c) => c.urgency === "high").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Callbacks</h1>
        <p className="text-muted-foreground">
          Manage callback requests from your callers
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Pending
            </CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Clock className="h-4 w-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <AnimatedStat value={String(pendingCount)} className="text-2xl font-bold" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Completed
            </CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </div>
          </CardHeader>
          <CardContent>
            <AnimatedStat value={String(completedCount)} className="text-2xl font-bold" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Urgent Pending
            </CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10">
              <PhoneForwarded className="h-4 w-4 text-red-500" />
            </div>
          </CardHeader>
          <CardContent>
            <AnimatedStat
              value={String(highUrgency)}
              className={`text-2xl font-bold ${highUrgency > 0 ? "text-red-600" : ""}`}
            />
          </CardContent>
        </Card>
      </div>

      {/* Callbacks Table with Tabs */}
      <Tabs defaultValue="pending" className="space-y-4">
        <div className="overflow-x-auto -mx-4 px-4">
          <TabsList>
            <TabsTrigger value="pending" className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Pending ({pendingCount})
            </TabsTrigger>
            <TabsTrigger value="completed" className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Completed ({completedCount})
            </TabsTrigger>
            <TabsTrigger value="expired" className="flex items-center gap-2">
              <TimerOff className="h-4 w-4" />
              Expired ({expiredCount})
            </TabsTrigger>
            <TabsTrigger value="all" className="flex items-center gap-2">
              All ({allCallbacks.length})
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="pending">
          <Card>
            <CardHeader>
              <CardTitle>Pending Callbacks</CardTitle>
              <CardDescription>
                {pendingCount} callbacks awaiting completion — high urgency shown first
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CallbacksTable callbacks={pendingCallbacks} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="completed">
          <Card>
            <CardHeader>
              <CardTitle>Completed Callbacks</CardTitle>
              <CardDescription>
                {completedCount} completed callbacks
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CallbacksTable callbacks={completedCallbacks} showCompletionNotes />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="expired">
          <Card>
            <CardHeader>
              <CardTitle>Expired Callbacks</CardTitle>
              <CardDescription>
                {expiredCount} callbacks expired after 48 hours without response
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CallbacksTable callbacks={expiredCallbacks} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="all">
          <Card>
            <CardHeader>
              <CardTitle>All Callback Requests</CardTitle>
              <CardDescription>
                {allCallbacks.length} total callback requests
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CallbacksTable callbacks={allSorted} showCompletionNotes />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function urgencyVariant(urgency: string) {
  switch (urgency) {
    case "high":
      return "destructive" as const;
    case "medium":
      return "default" as const;
    case "low":
      return "secondary" as const;
    default:
      return "secondary" as const;
  }
}

function statusVariant(status: string) {
  switch (status) {
    case "pending":
      return "default" as const;
    case "completed":
      return "success" as const;
    case "expired":
      return "outline" as const;
    default:
      return "secondary" as const;
  }
}

function CallbacksTable({
  callbacks,
  showCompletionNotes = false,
}: {
  callbacks: CallbackRequest[];
  showCompletionNotes?: boolean;
}) {
  if (callbacks.length === 0) {
    return (
      <EmptyState
        icon={PhoneForwarded}
        title="No callback requests yet"
        description="When callers request a callback through your AI receptionist, they'll appear here."
        illustration={<CallbacksScene />}
      />
    );
  }

  return (
    <>
      {/* Mobile card list */}
      <div className="space-y-2 md:hidden">
        {callbacks.map((cb) => (
          <div
            key={cb.id}
            className="rounded-lg border p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{cb.caller_name}</p>
                <a href={`tel:${cb.caller_phone}`} className="text-xs text-muted-foreground hover:text-primary">
                  {formatPhoneNumber(cb.caller_phone)}
                </a>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge variant={urgencyVariant(cb.urgency)} className="text-xs">
                  {cb.urgency}
                </Badge>
                <Badge variant={statusVariant(cb.status)} className="text-xs">
                  {cb.status}
                </Badge>
              </div>
            </div>
            <ExpandableText text={cb.reason} className="text-xs text-muted-foreground" />
            {(cb.requested_time || cb.notes) && (
              <p className="text-xs text-muted-foreground">
                Preferred: {cb.requested_time
                  ? safeFormatDate(cb.requested_time, "MMM d, h:mm a")
                  : cb.notes}
              </p>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {safeFormatDate(cb.created_at, "MMM d, h:mm a")}
              </span>
              {cb.status === "pending" && (
                <CallbackActions callbackId={cb.id} callerPhone={cb.caller_phone} />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Caller</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Preferred Time</TableHead>
              <TableHead>Urgency</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Requested At</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {callbacks.map((cb) => (
              <TableRow key={cb.id}>
                <TableCell>
                  <div>
                    <p className="font-medium">{cb.caller_name}</p>
                    <a href={`tel:${cb.caller_phone}`} className="text-xs text-muted-foreground hover:text-primary">
                      {formatPhoneNumber(cb.caller_phone)}
                    </a>
                  </div>
                </TableCell>
                <TableCell className="max-w-[200px]" title={cb.reason}>
                  <span className="block truncate">{cb.reason}</span>
                  {showCompletionNotes && cb.completion_notes && cb.status === "completed" && (
                    <span className="block text-xs text-muted-foreground mt-1 truncate" title={cb.completion_notes}>
                      Note: {cb.completion_notes}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {cb.requested_time
                    ? safeFormatDate(cb.requested_time, "MMM d, h:mm a")
                    : cb.notes || "No preference"}
                </TableCell>
                <TableCell>
                  <Badge variant={urgencyVariant(cb.urgency)}>
                    {cb.urgency}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(cb.status)}>
                    {cb.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {safeFormatDate(cb.created_at, "MMM d, h:mm a")}
                </TableCell>
                <TableCell className="text-right">
                  {cb.status === "pending" && (
                    <CallbackActions callbackId={cb.id} callerPhone={cb.caller_phone} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
