"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import {
  Plus,
  Loader2,
  Trash2,
  Play,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  Webhook,
  ArrowUpRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { PlatformIcon } from "./PlatformIcon";
import { IntegrationForm } from "./IntegrationForm";
import { format } from "date-fns";

interface Integration {
  id: string;
  name: string;
  platform: string;
  webhook_url_display: string;
  events: string[];
  is_active: boolean;
  created_at: string;
}

interface LogEntry {
  id: string;
  event_type: string;
  response_status: number | null;
  success: boolean;
  attempted_at: string;
  retry_count: number;
}

export function IntegrationList() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [canCreate, setCanCreate] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null);
  const { toast } = useToast();

  const loadIntegrations = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/integrations");
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load");
      }
      const data = await response.json();
      setIntegrations(data.integrations);
      setCanCreate(data.canCreate);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load integrations";
      toast({ variant: "destructive", title: "Error", description: message });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations]);

  const handleToggle = async (id: string, isActive: boolean) => {
    try {
      const response = await fetch(`/api/v1/integrations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update");
      }
      setIntegrations((prev) =>
        prev.map((i) => (i.id === id ? { ...i, is_active: isActive } : i))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update integration";
      toast({ variant: "destructive", title: "Error", description: message });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const response = await fetch(`/api/v1/integrations/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Failed to delete");
      }
      setIntegrations((prev) => prev.filter((i) => i.id !== id));
      toast({ title: "Deleted", description: "Integration removed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete integration";
      toast({ variant: "destructive", title: "Error", description: message });
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const response = await fetch(`/api/v1/integrations/${id}/test`, { method: "POST" });
      const result = await response.json();
      toast({
        variant: result.success ? "default" : "destructive",
        title: result.success ? "Test Successful" : "Test Failed",
        description: result.message,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send test webhook";
      toast({ variant: "destructive", title: "Error", description: message });
    } finally {
      setTestingId(null);
    }
  };

  const toggleLogs = async (id: string) => {
    if (expandedLogs === id) {
      setExpandedLogs(null);
      return;
    }
    setExpandedLogs(id);
    if (!logs[id]) {
      try {
        const response = await fetch(`/api/v1/integrations/${id}/logs?limit=10`);
        if (!response.ok) throw new Error("Failed to load logs");
        const data = await response.json();
        setLogs((prev) => ({ ...prev, [id]: data.logs }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load logs";
        toast({ variant: "destructive", title: "Error", description: message });
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {canCreate ? (
        <div className="flex justify-end">
          <Button onClick={() => setShowForm(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Integration
          </Button>
        </div>
      ) : (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
          <p className="text-sm text-blue-800 dark:text-blue-200">
            Webhook integrations are available on Professional and Business plans.{" "}
            <a href="/billing" className="inline-flex items-center font-medium underline underline-offset-2">
              Upgrade <ArrowUpRight className="ml-0.5 h-3 w-3" />
            </a>
          </p>
        </div>
      )}

      {integrations.length === 0 ? (
        <div className="py-12 text-center">
          <Webhook className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            No integrations yet. Add one to start sending call data to your tools.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {integrations.map((integration) => (
            <Card key={integration.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <PlatformIcon platform={integration.platform} className="shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium truncate">{integration.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {integration.webhook_url_display}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="hidden sm:flex items-center gap-1">
                      {integration.events.map((e) => (
                        <Badge key={e} variant="outline" className="text-xs">
                          {e}
                        </Badge>
                      ))}
                    </div>

                    <Badge variant={integration.is_active ? "success" : "secondary"}>
                      {integration.is_active ? "Active" : "Paused"}
                    </Badge>

                    <Switch
                      checked={integration.is_active}
                      onCheckedChange={(checked) => handleToggle(integration.id, checked)}
                    />

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTest(integration.id)}
                      disabled={testingId === integration.id || !integration.is_active}
                    >
                      {testingId === integration.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleLogs(integration.id)}
                    >
                      {expandedLogs === integration.id ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </Button>

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget(integration)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>

                {/* Expanded logs */}
                {expandedLogs === integration.id && (
                  <div className="mt-4 border-t pt-3">
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      Recent Deliveries
                    </p>
                    {logs[integration.id] && logs[integration.id].length > 0 ? (
                      <div className="space-y-1">
                        {logs[integration.id].map((log) => (
                          <div
                            key={log.id}
                            className="flex items-center justify-between text-xs py-1"
                          >
                            <div className="flex items-center gap-2">
                              {log.success ? (
                                <CheckCircle2 className="h-3 w-3 text-green-500" />
                              ) : (
                                <XCircle className="h-3 w-3 text-red-500" />
                              )}
                              <span className="text-muted-foreground">
                                {log.event_type}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {log.response_status !== null && (
                                <Badge variant="outline" className="text-xs">
                                  {log.response_status}
                                </Badge>
                              )}
                              <span className="text-muted-foreground">
                                {format(new Date(log.attempted_at), "MMM d, HH:mm")}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No deliveries yet</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Integration</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This will also
              remove all delivery logs. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  handleDelete(deleteTarget.id);
                  setDeleteTarget(null);
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <IntegrationForm
        open={showForm}
        onOpenChange={setShowForm}
        onCreated={() => {
          loadIntegrations();
        }}
      />
    </div>
  );
}
