"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  RotateCcw,
  Webhook,
} from "lucide-react";
import { format } from "date-fns";
import { EmptyState } from "@/components/ui/empty-state";

interface LogEntry {
  id: string;
  integration_id: string;
  integration_name: string;
  event_type: string;
  response_status: number | null;
  success: boolean;
  attempted_at: string;
  retry_count: number;
}

export function ActivityLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const limit = 20;
  const { toast } = useToast();

  const loadLogs = useCallback(async (pageOffset = 0) => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/v1/integrations/logs?limit=${limit}&offset=${pageOffset}`
      );
      if (!response.ok) throw new Error("Failed to load");
      const data = await response.json();
      setLogs(data.logs);
      setTotal(data.total);
      setOffset(pageOffset);
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Failed to load activity log" });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const handleRetry = async (log: LogEntry) => {
    setRetryingId(log.id);
    try {
      const response = await fetch(`/api/v1/integrations/${log.integration_id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logId: log.id }),
      });
      const result = await response.json();
      toast({
        variant: result.success ? "default" : "destructive",
        title: result.success ? "Retry Successful" : "Retry Failed",
        description: result.success
          ? `Delivered successfully (HTTP ${result.status})`
          : result.error || "Failed to retry",
      });
      loadLogs(offset);
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Failed to retry" });
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Delivery Log</CardTitle>
        <Button variant="ghost" size="sm" onClick={() => loadLogs(offset)}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title="No webhook deliveries yet"
            description="Create an integration and make a test call to see activity here."
            compact
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Integration</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Response</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      {log.success ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{log.integration_name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {log.event_type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {log.response_status !== null ? (
                        <Badge
                          variant={log.response_status < 400 ? "success" : "destructive"}
                          className="text-xs"
                        >
                          {log.response_status}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(log.attempted_at), "MMM d, HH:mm:ss")}
                    </TableCell>
                    <TableCell className="text-right">
                      {!log.success && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRetry(log)}
                          disabled={retryingId === log.id}
                        >
                          {retryingId === log.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3 w-3" />
                          )}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Pagination */}
            {total > limit && (
              <div className="flex items-center justify-between pt-4">
                <p className="text-xs text-muted-foreground">
                  Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => loadLogs(Math.max(0, offset - limit))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset + limit >= total}
                    onClick={() => loadLogs(offset + limit)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
