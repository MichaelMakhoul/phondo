import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PhoneCall, PhoneIncoming, PhoneOutgoing, Play, ShieldAlert, ShieldCheck, AlertTriangle, ChevronRight } from "lucide-react";
import { formatPhoneNumber, formatDuration } from "@/lib/utils";
import { format } from "date-fns";
import { SpamActions } from "./spam-actions";
import { AnimatedStat } from "@/components/marketing/animated-stat";
import { EmptyState } from "@/components/ui/empty-state";
import { CallsScene } from "@/components/ui/empty-state-scenes";

interface Call {
  id: string;
  direction: string;
  status: string;
  caller_phone: string | null;
  caller_name: string | null;
  outcome: string | null;
  collected_data: Record<string, unknown> | null;
  metadata: { successEvaluation?: string } | null;
  duration_seconds: number | null;
  recording_url: string | null;
  created_at: string;
  is_spam: boolean | null;
  spam_score: number | null;
  assistants: { id: string; name: string } | null;
  phone_numbers: { id: string; phone_number: string } | null;
}

export default async function CallsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership } = await supabase
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single() as { data: { organization_id: string } | null };

  const orgId = membership?.organization_id || "";

  // Get calls
  const { data: calls, count } = orgId ? await supabase
    .from("calls")
    .select(`
      *,
      assistants (id, name),
      phone_numbers (id, phone_number)
    `, { count: "exact" })
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50) as { data: Call[] | null; count: number | null } : { data: null, count: 0 };

  // Get stats
  const { data: stats } = orgId ? await supabase
    .from("calls")
    .select("status, duration_seconds, is_spam")
    .eq("organization_id", orgId) as { data: { status: string; duration_seconds: number | null; is_spam: boolean | null }[] | null } : { data: null };

  const totalCalls = stats?.length || 0;
  const completedCalls = stats?.filter((c) => c.status === "completed").length || 0;
  const spamCalls = stats?.filter((c) => c.is_spam === true).length || 0;
  const totalMinutes = Math.round(
    (stats?.reduce((sum, c) => sum + (c.duration_seconds || 0), 0) || 0) / 60
  );

  // Separate spam and non-spam calls
  const legitimateCalls = calls?.filter((c) => !c.is_spam) || [];
  const spamCallsList = calls?.filter((c) => c.is_spam) || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Call History</h1>
        <p className="text-muted-foreground">
          View and analyze all your AI receptionist calls
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Calls
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AnimatedStat value={String(totalCalls)} className="text-2xl font-bold" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Completed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AnimatedStat value={String(completedCalls)} className="text-2xl font-bold" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Minutes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AnimatedStat value={String(totalMinutes)} className="text-2xl font-bold" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <ShieldAlert className="h-4 w-4" />
              Spam Blocked
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AnimatedStat value={String(spamCalls)} className="text-2xl font-bold text-orange-600" />
          </CardContent>
        </Card>
      </div>

      {/* Calls Table with Tabs */}
      <Tabs defaultValue="all" className="space-y-4">
        <TabsList>
          <TabsTrigger value="all" className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            All Calls ({legitimateCalls.length})
          </TabsTrigger>
          <TabsTrigger value="spam" className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            Spam ({spamCallsList.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all">
          <Card>
            <CardHeader>
              <CardTitle>Recent Calls</CardTitle>
              <CardDescription>
                {legitimateCalls.length} legitimate calls
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CallsTable calls={legitimateCalls} showSpamActions />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="spam">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-orange-500" />
                Spam Calls
              </CardTitle>
              <CardDescription>
                {spamCallsList.length} calls flagged as spam
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CallsTable calls={spamCallsList} showSpamActions isSpamView />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CallsTable({
  calls,
  showSpamActions = false,
  isSpamView = false
}: {
  calls: Call[];
  showSpamActions?: boolean;
  isSpamView?: boolean;
}) {
  if (!calls || calls.length === 0) {
    return (
      <EmptyState
        icon={isSpamView ? ShieldCheck : PhoneCall}
        title={isSpamView ? "No spam calls detected" : "No calls yet"}
        description={
          isSpamView
            ? "Your spam filter is working! Spam calls will appear here when detected."
            : "Set up an assistant and phone number to start receiving calls."
        }
        illustration={!isSpamView ? <CallsScene /> : undefined}
      />
    );
  }

  return (
    <>
      {/* Mobile card list */}
      <div className="space-y-2 md:hidden">
        {calls.map((call) => (
          <Link
            key={call.id}
            href={`/calls/${call.id}`}
            className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              {call.direction === "inbound" ? (
                <PhoneIncoming className="h-4 w-4 shrink-0 text-green-600" />
              ) : (
                <PhoneOutgoing className="h-4 w-4 shrink-0 text-blue-600" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {call.caller_name || (call.caller_phone
                    ? formatPhoneNumber(call.caller_phone)
                    : "Unknown")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {format(new Date(call.created_at), "MMM d, h:mm a")}
                  {call.duration_seconds ? ` · ${formatDuration(call.duration_seconds)}` : ""}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                variant={
                  call.status === "completed"
                    ? "success"
                    : call.status === "failed"
                    ? "destructive"
                    : "secondary"
                }
                className="text-xs"
              >
                {call.status}
              </Badge>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </Link>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Direction</TableHead>
              <TableHead>Caller</TableHead>
              <TableHead>Assistant</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Result</TableHead>
              {isSpamView && <TableHead>Spam Score</TableHead>}
              <TableHead>Duration</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.map((call) => (
              <TableRow key={call.id} className={call.is_spam ? "bg-orange-50 dark:bg-orange-950/20" : ""}>
                <TableCell>
                  {call.direction === "inbound" ? (
                    <PhoneIncoming className="h-4 w-4 text-green-600" />
                  ) : (
                    <PhoneOutgoing className="h-4 w-4 text-blue-600" />
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div>
                      <p className="font-medium">
                        {call.caller_name || (call.caller_phone
                          ? formatPhoneNumber(call.caller_phone)
                          : "Unknown")}
                      </p>
                      {call.caller_name && call.caller_phone && (
                        <p className="text-xs text-muted-foreground">
                          {formatPhoneNumber(call.caller_phone)}
                        </p>
                      )}
                      {!call.caller_name && call.phone_numbers && (
                        <p className="text-xs text-muted-foreground">
                          to {formatPhoneNumber(call.phone_numbers.phone_number)}
                        </p>
                      )}
                    </div>
                    {call.is_spam && !isSpamView && (
                      <Badge variant="destructive" className="text-xs">
                        <ShieldAlert className="h-3 w-3 mr-1" />
                        Spam
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>{call.assistants?.name || "-"}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      call.status === "completed"
                        ? "success"
                        : call.status === "failed"
                        ? "destructive"
                        : call.status === "in-progress"
                        ? "default"
                        : "secondary"
                    }
                  >
                    {call.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {call.metadata?.successEvaluation ? (
                    <Badge
                      variant={
                        call.metadata.successEvaluation.toLowerCase() === "pass" ||
                        call.metadata.successEvaluation.toLowerCase() === "passed" ||
                        call.metadata.successEvaluation.toLowerCase() === "success"
                          ? "success"
                          : call.metadata.successEvaluation.toLowerCase() === "fail" ||
                            call.metadata.successEvaluation.toLowerCase() === "failed"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {call.metadata.successEvaluation}
                    </Badge>
                  ) : (
                    "-"
                  )}
                </TableCell>
                {isSpamView && (
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${
                            (call.spam_score ?? 0) >= 70 ? 'bg-red-500' :
                            (call.spam_score ?? 0) >= 40 ? 'bg-orange-500' : 'bg-yellow-500'
                          }`}
                          style={{ width: `${call.spam_score ?? 0}%` }}
                        />
                      </div>
                      <span className="text-sm text-muted-foreground">{call.spam_score ?? 0}%</span>
                    </div>
                  </TableCell>
                )}
                <TableCell>
                  {call.duration_seconds
                    ? formatDuration(call.duration_seconds)
                    : "-"}
                </TableCell>
                <TableCell>
                  {format(new Date(call.created_at), "MMM d, h:mm a")}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    {call.recording_url && (
                      <Button variant="ghost" size="icon" asChild>
                        <a
                          href={call.recording_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Play className="h-4 w-4" />
                        </a>
                      </Button>
                    )}
                    {showSpamActions && (
                      <SpamActions
                        callId={call.id}
                        isSpam={call.is_spam ?? false}
                      />
                    )}
                    <Link href={`/calls/${call.id}`}>
                      <Button variant="ghost" size="sm">
                        View
                      </Button>
                    </Link>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
