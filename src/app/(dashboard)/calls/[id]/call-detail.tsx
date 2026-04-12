"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowLeft,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneForwarded,
  Clock,
  CheckCircle2,
  XCircle,
  DollarSign,
  AlertTriangle,
  ShieldAlert,
  FileText,
  Mic,
  BarChart3,
  Info,
  HelpCircle,
  User,
  Pencil,
  Save,
  X,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { formatPhoneNumber, formatDuration, formatCurrency } from "@/lib/utils";

interface Call {
  id: string;
  direction: string;
  status: string;
  caller_phone: string | null;
  caller_name: string | null;
  duration_seconds: number | null;
  recording_url: string | null;
  recording_storage_path: string | null;
  cleaned_transcript: { turns: Array<{ role: "user" | "assistant"; text: string; original?: string; language?: string }> } | null;
  summary: string | null;
  transcript: string | null;
  outcome: string | null;
  cost_cents: number | null;
  follow_up_required: boolean | null;
  ended_reason: string | null;
  sentiment: string | null;
  collected_data: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  is_spam: boolean | null;
  spam_score: number | null;
  created_at: string;
  assistants: { id: string; name: string } | null;
  phone_numbers: {
    id: string;
    phone_number: string;
    friendly_name: string | null;
  } | null;
}

function formatFieldLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getSuccessVariant(
  val: string | undefined
): "success" | "destructive" | "secondary" {
  if (!val) return "secondary";
  const lower = val.toLowerCase();
  if (lower === "pass" || lower === "passed" || lower === "success")
    return "success";
  if (lower === "fail" || lower === "failed") return "destructive";
  return "secondary";
}

function getSentimentVariant(
  val: string | undefined
): "success" | "destructive" | "secondary" {
  if (!val) return "secondary";
  const lower = val.toLowerCase();
  if (lower === "positive") return "success";
  if (lower === "negative") return "destructive";
  return "secondary";
}

function getStatusVariant(
  status: string
): "success" | "destructive" | "default" | "secondary" {
  switch (status) {
    case "completed": return "success";
    case "failed": return "destructive";
    case "in-progress": return "default";
    default: return "secondary";
  }
}

function getTransferOutcomeVariant(
  outcome: string | undefined
): "success" | "destructive" | "secondary" {
  switch (outcome) {
    case "initiated": return "success";
    case "outside_hours": return "secondary";
    default: return "destructive";
  }
}

function getTransferOutcomeLabel(outcome: string | undefined): string {
  switch (outcome) {
    case "initiated": return "Transferred";
    case "outside_hours": return "Outside Hours";
    default: return "Failed";
  }
}

function getUrgencyVariant(
  urgency: string | undefined
): "destructive" | "default" | "secondary" {
  switch (urgency) {
    case "high": return "destructive";
    case "medium": return "default";
    default: return "secondary";
  }
}

function getSpamScoreColor(score: number): string {
  if (score >= 70) return "bg-red-500";
  if (score >= 40) return "bg-orange-500";
  return "bg-yellow-500";
}

export function CallDetail({ call: initialCall }: { call: Call }) {
  const [call, setCall] = useState<Call>(initialCall);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [transcriptMode, setTranscriptMode] = useState<"raw" | "cleaned">(
    call.cleaned_transcript ? "cleaned" : "raw"
  );
  const [editCallerName, setEditCallerName] = useState(call.caller_name || "");
  const [editSummary, setEditSummary] = useState(call.summary || "");
  const [editCollectedData, setEditCollectedData] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(call.collected_data || {}).map(([k, v]) => [k, String(v ?? "")])
    )
  );
  const { toast } = useToast();

  function startEditing() {
    setEditCallerName(call.caller_name || "");
    setEditSummary(call.summary || "");
    setEditCollectedData(
      Object.fromEntries(
        Object.entries(call.collected_data || {}).map(([k, v]) => [k, String(v ?? "")])
      )
    );
    setIsEditing(true);
  }

  function cancelEditing() {
    setIsEditing(false);
  }

  async function saveEdits() {
    setIsSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (editCallerName !== (call.caller_name || "")) {
        body.callerName = editCallerName;
      }
      if (editSummary !== (call.summary || "")) {
        body.summary = editSummary;
      }
      const currentCollected = Object.fromEntries(
        Object.entries(call.collected_data || {}).map(([k, v]) => [k, String(v ?? "")])
      );
      if (JSON.stringify(editCollectedData) !== JSON.stringify(currentCollected)) {
        body.collectedData = editCollectedData;
      }

      if (Object.keys(body).length === 0) {
        setIsEditing(false);
        return;
      }

      const res = await fetch(`/api/v1/calls/${call.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to save" }));
        throw new Error(err.error || "Failed to save");
      }

      const updated = await res.json();
      setCall(updated);
      setIsEditing(false);
      toast({ title: "Saved", description: "Call details updated successfully." });
    } catch (err) {
      console.error("Error saving call edits:", err);
      toast({
        variant: "destructive",
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to save changes.",
      });
    } finally {
      setIsSaving(false);
    }
  }

  useEffect(() => {
    if (!call.recording_storage_path) return;
    let cancelled = false;
    setRecordingLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/v1/calls/${call.id}/recording-url`);
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && json.url) setRecordingUrl(json.url);
      } catch {
        // silent — UI shows fallback below
      } finally {
        if (!cancelled) setRecordingLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [call.id, call.recording_storage_path]);

  const ownerAnswered = (call.metadata?.answeredBy as string) === "owner";
  const successEval = call.metadata?.successEvaluation as string | undefined;
  const unansweredQuestions = Array.isArray(call.metadata?.unansweredQuestions)
    ? (call.metadata.unansweredQuestions as string[])
    : [];
  const collectedEntries = Object.entries(call.collected_data || {});
  const transferAttempt = call.metadata?.transferAttempt as {
    ruleId?: string;
    ruleName?: string;
    targetPhone?: string;
    targetName?: string;
    reason?: string;
    urgency?: string;
    outcome?: string;
    outsideBusinessHours?: boolean;
    timestamp?: string;
  } | undefined;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/calls"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Calls
        </Link>

        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">Call Details</h1>
          {!isEditing ? (
            <Button variant="ghost" size="sm" onClick={startEditing}>
              <Pencil className="h-4 w-4 mr-1" />
              Edit
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveEdits} disabled={isSaving}>
                {isSaving ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-1" />
                )}
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={isSaving}>
                <X className="h-4 w-4 mr-1" />
                Cancel
              </Button>
            </div>
          )}
          <Badge variant={getStatusVariant(call.status)}>
            {call.status}
          </Badge>
          {call.is_spam && (
            <Badge variant="destructive">
              <ShieldAlert className="h-3 w-3 mr-1" />
              Spam
            </Badge>
          )}
          {ownerAnswered && (
            <Badge variant="secondary">
              <User className="h-3 w-3 mr-1" />
              You Answered
            </Badge>
          )}
          {(call.metadata?.piiRedacted as boolean) && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="cursor-default">
                    <ShieldAlert className="h-3 w-3 mr-1" />
                    PII Redacted
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">
                    Sensitive data (Medicare, TFN, bank details, etc.) was
                    automatically redacted from this transcript.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        <p className="text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
          {call.direction === "inbound" ? (
            <PhoneIncoming className="h-4 w-4" />
          ) : (
            <PhoneOutgoing className="h-4 w-4" />
          )}
          <span className="capitalize">{call.direction}</span>
          {isEditing ? (
            <>
              <span>&middot;</span>
              <Input
                value={editCallerName}
                onChange={(e) => setEditCallerName(e.target.value)}
                placeholder="Caller name"
                className="h-7 w-48 text-sm"
                maxLength={200}
              />
            </>
          ) : call.caller_name ? (
            <>
              <span>&middot;</span>
              <span>{call.caller_name}</span>
            </>
          ) : null}
          {call.caller_phone && (
            <>
              <span>&middot;</span>
              <span>{formatPhoneNumber(call.caller_phone)}</span>
            </>
          )}
          <span>&middot;</span>
          <span>{format(new Date(call.created_at), "MMMM d, yyyy h:mm a")}</span>
        </p>
      </div>

      {/* Overview Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Clock className="h-4 w-4" />
              Duration
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {call.duration_seconds
                ? formatDuration(call.duration_seconds)
                : "-"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Outcome
            </CardTitle>
          </CardHeader>
          <CardContent>
            {call.outcome ? (
              <Badge variant="secondary" className="text-sm">
                {call.outcome}
              </Badge>
            ) : (
              <p className="text-2xl font-bold">-</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              {successEval &&
              getSuccessVariant(successEval) === "success" ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : successEval &&
                getSuccessVariant(successEval) === "destructive" ? (
                <XCircle className="h-4 w-4 text-red-600" />
              ) : null}
              Success
            </CardTitle>
          </CardHeader>
          <CardContent>
            {successEval ? (
              <Badge variant={getSuccessVariant(successEval)} className="text-sm">
                {successEval}
              </Badge>
            ) : (
              <p className="text-2xl font-bold">-</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-4 w-4" />
              Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {call.cost_cents != null
                ? formatCurrency(call.cost_cents, "USD")
                : "-"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Follow-up Alert */}
      {call.follow_up_required && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Follow-Up Required</AlertTitle>
          <AlertDescription>
            This call has been flagged as requiring follow-up. Please review the
            details and take appropriate action.
          </AlertDescription>
        </Alert>
      )}

      {/* Transfer Info */}
      {transferAttempt && (
        <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-blue-800 dark:text-blue-200">
              <PhoneForwarded className="h-5 w-5" />
              Transfer
              <Badge
                variant={getTransferOutcomeVariant(transferAttempt.outcome)}
                className="ml-auto"
              >
                {getTransferOutcomeLabel(transferAttempt.outcome)}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Target
                </p>
                <p className="mt-1 text-sm font-medium">
                  {transferAttempt.targetName || "-"}
                </p>
                {transferAttempt.targetPhone && (
                  <p className="text-xs text-muted-foreground">
                    {formatPhoneNumber(transferAttempt.targetPhone)}
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Reason
                </p>
                <p className="mt-1 text-sm">{transferAttempt.reason || "-"}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Urgency
                </p>
                <Badge
                  variant={getUrgencyVariant(transferAttempt.urgency)}
                  className="mt-1"
                >
                  {transferAttempt.urgency || "low"}
                </Badge>
              </div>
              {transferAttempt.ruleName && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Rule
                  </p>
                  <p className="mt-1 text-sm">{transferAttempt.ruleName}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Content Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Call Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <Textarea
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  placeholder="Call summary"
                  className="text-sm min-h-[100px]"
                  maxLength={2000}
                />
              ) : call.summary ? (
                <p className="text-sm leading-relaxed">{call.summary}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {ownerAnswered
                    ? "You answered this call directly \u2014 no AI summary available."
                    : "No summary available for this call."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Knowledge Gaps */}
          {unansweredQuestions.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
                  <HelpCircle className="h-5 w-5" />
                  Knowledge Gaps
                  <Badge variant="secondary" className="ml-auto">
                    {unansweredQuestions.length} question
                    {unansweredQuestions.length !== 1 ? "s" : ""}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-amber-700 dark:text-amber-300 mb-3">
                  Topics your AI couldn&apos;t fully address during this call. Add this
                  information to your knowledge base to improve future calls.
                </p>
                <ul className="space-y-2">
                  {unansweredQuestions.map((q, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400">?</span>
                      <span>{q}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/settings/knowledge"
                  className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
                >
                  Go to Knowledge Base
                  <ArrowLeft className="h-3 w-3 rotate-180" />
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Collected Data */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info className="h-5 w-5" />
                Collected Information
                {collectedEntries.length > 0 && (
                  <Badge variant="secondary" className="ml-auto">
                    {collectedEntries.length} field
                    {collectedEntries.length !== 1 ? "s" : ""}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {Object.entries(editCollectedData).map(([key, value]) => (
                    <div key={key} className="rounded-md border p-3">
                      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {formatFieldLabel(key)}
                      </label>
                      <Input
                        value={value}
                        onChange={(e) =>
                          setEditCollectedData((prev) => ({
                            ...prev,
                            [key]: e.target.value,
                          }))
                        }
                        className="mt-1 h-8 text-sm"
                      />
                    </div>
                  ))}
                  {Object.keys(editCollectedData).length === 0 && (
                    <div className="col-span-2 py-4 text-center">
                      <p className="text-sm text-muted-foreground">
                        No collected data fields to edit.
                      </p>
                    </div>
                  )}
                </div>
              ) : collectedEntries.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {collectedEntries.map(([key, value]) => (
                    <div
                      key={key}
                      className="rounded-md border p-3"
                    >
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {formatFieldLabel(key)}
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        {String(value ?? "-")}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center">
                  <Info className="mx-auto h-8 w-8 text-muted-foreground" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    No data was collected during this call.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Transcript */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Transcript
              </CardTitle>
            </CardHeader>
            <CardContent>
              {call.cleaned_transcript && (
                <div className="mb-3 flex gap-2">
                  <Button
                    size="sm"
                    variant={transcriptMode === "cleaned" ? "default" : "outline"}
                    onClick={() => setTranscriptMode("cleaned")}
                  >
                    Cleaned
                  </Button>
                  <Button
                    size="sm"
                    variant={transcriptMode === "raw" ? "default" : "outline"}
                    onClick={() => setTranscriptMode("raw")}
                  >
                    Raw
                  </Button>
                </div>
              )}

              {transcriptMode === "cleaned" && call.cleaned_transcript ? (
                <ScrollArea className="h-[400px]">
                  <div className="space-y-3 text-sm">
                    {call.cleaned_transcript.turns.map((turn, i) => (
                      <div key={i}>
                        <span className="font-semibold">
                          {turn.role === "user" ? "Caller" : "AI"}:
                        </span>{" "}
                        {turn.text}
                        {turn.original && turn.original !== turn.text && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            Original: {turn.original}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              ) : call.transcript ? (
                <ScrollArea className="h-[400px]">
                  <pre className="whitespace-pre-wrap font-sans text-sm">
                    {call.transcript}
                  </pre>
                </ScrollArea>
              ) : (
                <div className="py-8 text-center">
                  {ownerAnswered ? (
                    <User className="mx-auto h-8 w-8 text-muted-foreground" />
                  ) : (
                    <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
                  )}
                  <p className="mt-2 text-sm text-muted-foreground">
                    {ownerAnswered
                      ? "You answered this call directly \u2014 no AI transcript available."
                      : "No transcript available for this call."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Recording */}
          {(call.recording_storage_path || call.recording_url) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mic className="h-5 w-5" />
                  Recording
                </CardTitle>
              </CardHeader>
              <CardContent>
                {recordingUrl ? (
                  <audio controls className="w-full" src={recordingUrl}>
                    Your browser does not support the audio element.
                  </audio>
                ) : call.recording_storage_path ? (
                  <p className="text-sm text-muted-foreground">
                    {recordingLoading ? "Loading recording…" : "Recording unavailable."}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Legacy recording (stored with provider). This recording predates in-app playback.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Analysis */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Analysis
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Sentiment */}
              <div>
                <p className="text-sm text-muted-foreground mb-1">Sentiment</p>
                {call.sentiment ? (
                  <Badge variant={getSentimentVariant(call.sentiment)}>
                    {call.sentiment}
                  </Badge>
                ) : (
                  <span className="text-sm">-</span>
                )}
              </div>

              <Separator />

              {/* Spam Score */}
              {call.is_spam && call.spam_score != null && (
                <>
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">
                      Spam Score
                    </p>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${getSpamScoreColor(call.spam_score)}`}
                          style={{ width: `${call.spam_score}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium">
                        {call.spam_score}%
                      </span>
                    </div>
                  </div>
                  <Separator />
                </>
              )}

              {/* Ended Reason */}
              <div>
                <p className="text-sm text-muted-foreground mb-1">
                  Ended Reason
                </p>
                <p className="text-sm">
                  {call.ended_reason || "-"}
                </p>
              </div>

              <Separator />

              {/* Assistant */}
              <div>
                <p className="text-sm text-muted-foreground mb-1">Assistant</p>
                <p className="text-sm">
                  {call.assistants?.name || "-"}
                </p>
              </div>

              <Separator />

              {/* Phone Line */}
              <div>
                <p className="text-sm text-muted-foreground mb-1">Phone Line</p>
                <p className="text-sm">
                  {call.phone_numbers
                    ? call.phone_numbers.friendly_name ||
                      formatPhoneNumber(call.phone_numbers.phone_number)
                    : "-"}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
